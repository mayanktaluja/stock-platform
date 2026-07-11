/**
 * NSE Surveillance Module  — Phase 0 (SEBI compliance foundation)
 *
 * Pulls the daily NSE surveillance lists:
 *   • ASM — Additional Surveillance Measure (long-term + short-term stages)
 *   • GSM — Graded Surveillance Measure (6 stages, most restrictive at VI)
 *
 * Why this matters for a SEBI-aware recommendation engine:
 *   Stocks under surveillance have elevated regulatory risk — circuit
 *   filter tightening, 100% margin, periodic call auction, delivery-only
 *   trading. SWS-style fundamentals can still look healthy even on a
 *   Stage IV GSM stock while the stock itself is effectively untradeable.
 *   Any "top picks" surface must exclude these, and every affected stock
 *   must show a warning banner.
 *
 * Data shape (what callers consume):
 *   {
 *     fetchedAt: ISO string,
 *     source:    "nse" | "kv" | "disk" | "empty",
 *     flagged:   { "RELIANCE.NS": { list, stage, timeframe, series }, ... },
 *     counts:    { ASM: n, GSM: n }
 *   }
 *
 * The caller lookup pattern is `flagged[symbolWithDotNS]`. Symbols are
 * normalised to the `.NS` suffix used throughout fundamentals.json so
 * the scorer / UI can check membership with a single map read.
 *
 * Refresh:
 *   • Canonical: local launchd nightly runs
 *                 `node scripts/refresh-surveillance.mjs --strict` from an
 *                 Indian-IP machine and commits surveillance.json.
 *   • Manual diagnostic: /api/cron/refresh-surveillance can still be hit by
 *                 an admin/CRON_SECRET caller, but it is not scheduled on
 *                 Vercel because NSE datacenter blocking makes it unreliable.
 *
 * Failure mode: ALWAYS defensive. A fetch failure never throws to the
 * caller — the getter returns the freshest last-known snapshot (KV or disk,
 * then empty). An empty snapshot means "no stocks flagged" which is the safe
 * default for the UI, but a stale-data warning is surfaced in diagnostics.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nseGet } from "./nse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SURVEILLANCE_PATH = path.join(__dirname, "surveillance.json");

export const KV_SURVEILLANCE_KEY = "surveillance:snapshot";

// ==================== IN-MEMORY CACHE ====================

let _cached = null;
let _cachedSource = null;

async function getKVClient() {
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  if (!hasKV) return null;
  const mod = await import("@vercel/kv");
  return mod.kv;
}

// ==================== NORMALISATION ====================

/**
 * NSE reports use the bare symbol ("RELIANCE"). Our fundamentals snapshot
 * keys on "RELIANCE.NS". Normalise so callers can do a single map lookup.
 */
function toNseKey(sym) {
  if (!sym) return null;
  const s = String(sym).trim().toUpperCase();
  if (!s) return null;
  return s.endsWith(".NS") ? s : `${s}.NS`;
}

// ==================== SNAPSHOT SELECTION ====================

function emptySnapshot() {
  return {
    fetchedAt: null,
    source: "empty",
    flagged: {},
    counts: { ASM: 0, GSM: 0 },
  };
}

function snapshotTime(snapshot) {
  if (!snapshot?.fetchedAt) return null;
  const ts = new Date(snapshot.fetchedAt).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function flaggedCount(snapshot) {
  return Object.keys(snapshot?.flagged || {}).length;
}

function readDiskSnapshot() {
  if (!existsSync(SURVEILLANCE_PATH)) return null;
  try {
    const raw = readFileSync(SURVEILLANCE_PATH, "utf8");
    const snapshot = JSON.parse(raw);
    if (!snapshot || typeof snapshot !== "object" || !snapshot.flagged) return null;
    return { snapshot, source: "disk" };
  } catch (err) {
    console.warn("[SURVEILLANCE] disk read failed:", err.message);
    return null;
  }
}

function preferredSnapshot(a, b) {
  if (!a) return b;
  if (!b) return a;

  const aCount = flaggedCount(a.snapshot);
  const bCount = flaggedCount(b.snapshot);
  if ((aCount === 0 && bCount > 0) || (bCount === 0 && aCount > 0)) {
    return aCount > bCount ? a : b;
  }

  const aTime = snapshotTime(a.snapshot);
  const bTime = snapshotTime(b.snapshot);
  if (aTime != null && bTime != null && aTime !== bTime) {
    return aTime > bTime ? a : b;
  }
  if (aTime != null && bTime == null) return a;
  if (bTime != null && aTime == null) return b;

  if (aCount !== bCount) return aCount > bCount ? a : b;
  return a;
}

// ==================== FETCHERS ====================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nseGetWithRetry(pathname, { attempts = 3, baseDelayMs = 750 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await nseGet(pathname);
      if (data != null) return data;
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await sleep(baseDelayMs * (i + 1));
  }
  if (lastErr) throw lastErr;
  // nseGet swallows HTTP-level failures (404/500/blocked/cookie miss) into a
  // null return. A null here is a failed fetch, not "zero stocks flagged" —
  // reporting it as ok/empty let a broken endpoint masquerade as a healthy
  // fetch for a full grace window (2026-07-09 → 11 outage).
  throw new Error(`NSE returned no data for ${pathname} after ${attempts} attempts (blocked, non-OK status, or cookie failure)`);
}

function romanToNumber(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const current = values[s[i]] || 0;
    const next = values[s[i + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

function normalizeStage(raw) {
  if (raw == null || raw === "") return { stage: null, stage_num: null };
  const label = String(raw).trim();
  const withoutPrefix = label.replace(/^stage\s+/i, "").trim();
  const directNumber = Number(withoutPrefix);
  if (Number.isFinite(directNumber)) {
    return { stage: withoutPrefix, stage_num: directNumber, stage_label: label };
  }
  const roman = romanToNumber(withoutPrefix);
  if (roman != null) {
    return { stage: withoutPrefix.toUpperCase(), stage_num: roman, stage_label: label };
  }
  const token = withoutPrefix.match(/\b([IVXLCDM]+)\b/i)?.[1] || null;
  const tokenRoman = token ? romanToNumber(token) : null;
  if (tokenRoman != null) {
    return { stage: token.toUpperCase(), stage_num: tokenRoman, stage_label: label };
  }
  const embeddedNumber = label.match(/\b(\d+)\b/)?.[1] || null;
  if (embeddedNumber != null) {
    return { stage: embeddedNumber, stage_num: Number(embeddedNumber), stage_label: label };
  }
  return { stage: label, stage_num: null, stage_label: label };
}

function parseAsmRows(data) {
  if (!data || typeof data !== "object") return [];
  const out = [];
  const timeframes = [
    ["longterm", data.longterm?.data],
    ["shortterm", data.shortterm?.data],
  ];
  for (const [timeframe, rows] of timeframes) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const sym = toNseKey(r.symbol || r.Symbol);
      if (!sym) continue;
      const stage = normalizeStage(r.asmSurvIndicator || r.asmStage || r.stage || r.Stage);
      out.push({
        symbol: sym,
        list: "ASM",
        ...stage,
        timeframe,
        series: r.series || r.Series || null,
        source_time: r.asmTime || r.time || r.Time || null,
      });
    }
  }
  return out;
}

function parseGsmRows(data) {
  if (!data || typeof data !== "object") return [];
  const rows = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
  const out = [];
  for (const r of rows) {
    const sym = toNseKey(r.symbol || r.Symbol);
    if (!sym) continue;
    const stage = normalizeStage(r.gsmStage || r.stage || r.Stage);
    out.push({
      symbol: sym,
      list: "GSM",
      ...stage,
      timeframe: null,
      series: r.series || r.Series || null,
      source_time: r.gsmTime || r.time || r.Time || null,
    });
  }
  return out;
}

/**
 * Fetch ASM list. NSE returns { longterm: {data}, shortterm: {data} }.
 * Each row typically has symbol, series, stage. Schema drift is possible,
 * so we pull fields defensively.
 */
async function fetchASM() {
  return parseAsmRows(await nseGetWithRetry("/api/reportASM"));
}

/**
 * Fetch GSM list. NSE has returned both a top-level array and
 * { data: [ { symbol, stage, series, ... } ] } across schema versions.
 * GSM stages run I → VI; IV+ is where trading becomes highly constrained.
 */
async function fetchGSM() {
  return parseGsmRows(await nseGetWithRetry("/api/reportGSM"));
}

// ==================== BUILD + LOAD ====================

/**
 * Build a surveillance snapshot by fetching both lists from NSE.
 * Returns the snapshot shape documented at the top of this file.
 *
 * If BOTH fetches fail or return empty, the caller should prefer the
 * last-known snapshot rather than trusting an empty result (NSE had
 * an outage, not zero surveillance).
 */
export async function buildSurveillance({ fetchAsm = fetchASM, fetchGsm = fetchGSM } = {}) {
  const [asmResult, gsmResult] = await Promise.all([
    fetchAsm()
      .then((rows) => ({ ok: true, rows, error: null }))
      .catch((e) => {
        console.warn("[SURVEILLANCE] ASM fetch failed:", e.message);
        return { ok: false, rows: [], error: e.message };
      }),
    fetchGsm()
      .then((rows) => ({ ok: true, rows, error: null }))
      .catch((e) => {
        console.warn("[SURVEILLANCE] GSM fetch failed:", e.message);
        return { ok: false, rows: [], error: e.message };
      }),
  ]);
  // Zero parsed rows from a "successful" fetch is an outage or schema drift,
  // never reality — NSE always has hundreds of stocks under ASM/GSM. Count it
  // as a failed source so --strict refuses to call the refresh healthy.
  for (const result of [asmResult, gsmResult]) {
    if (result.ok && result.rows.length === 0) {
      result.ok = false;
      result.error = "parsed 0 rows (empty payload or NSE schema drift)";
    }
  }
  const asm = asmResult.rows;
  const gsm = gsmResult.rows;
  const fetchErrors = {};
  if (!asmResult.ok) fetchErrors.ASM = asmResult.error;
  if (!gsmResult.ok) fetchErrors.GSM = gsmResult.error;

  const flagged = {};
  for (const row of [...asm, ...gsm]) {
    // A stock can appear on both ASM and GSM. GSM is the stricter regime,
    // so it wins for the display label. But we keep both entries visible
    // via a secondary `alsoOn` field so the UI can show both reasons.
    const existing = flagged[row.symbol];
    if (!existing) {
      flagged[row.symbol] = { ...row };
    } else {
      const keepGSM = existing.list === "GSM" || row.list === "GSM";
      const primary = existing.list === "GSM" ? existing : row;
      const secondary = primary === existing ? row : existing;
      flagged[row.symbol] = {
        ...primary,
        alsoOn: secondary.list,
      };
      // suppress unused-var lint concerns
      void keepGSM;
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    source: "nse",
    flagged,
    counts: { ASM: asm.length, GSM: gsm.length },
    fetchStatus: {
      ASM: asmResult.ok ? "ok" : "failed",
      GSM: gsmResult.ok ? "ok" : "failed",
    },
    fetchErrors: Object.keys(fetchErrors).length ? fetchErrors : undefined,
  };
}

/**
 * Save a snapshot to KV (production) or disk (local dev). Mirrors the
 * fundamentals pipeline so we have one persistence pattern to reason about.
 */
export async function saveSurveillance(snapshot) {
  if (flaggedCount(snapshot) === 0) {
    const existing = getSurveillance();
    const existingTotal = flaggedCount(existing);
    if (existingTotal > 0) {
      const priorDate = existing?.fetchedAt || "unknown";
      const priorTime = snapshotTime(existing);
      const priorAgeHours = priorTime == null
        ? null
        : +((Date.now() - priorTime) / 3_600_000).toFixed(1);
      const stale = priorAgeHours == null || priorAgeHours > 36;
      console.warn(
        `[SURVEILLANCE] refusing to overwrite last-good snapshot with zero rows; ` +
        `preserving ${existingTotal} entries from ${priorDate}.`
      );
      return {
        status: stale ? "preserved-stale" : "preserved-fresh",
        skipped: true,
        reason: "zero_rows_preserved_existing",
        fetched: 0,
        existingCount: existingTotal,
        priorDate,
        priorAgeHours,
        stale,
      };
    }
  }

  const kv = await getKVClient();
  if (kv) {
    await kv.set(KV_SURVEILLANCE_KEY, snapshot);
    _cached = snapshot;
    _cachedSource = "kv";
    return { status: "saved", target: "kv" };
  }
  writeFileSync(SURVEILLANCE_PATH, JSON.stringify(snapshot, null, 2));
  _cached = snapshot;
  _cachedSource = "disk";
  return { status: "saved", target: "disk", path: SURVEILLANCE_PATH };
}

/**
 * Prime the in-memory cache from KV at server startup. Silent on failure
 * because disk fallback in getSurveillance() covers any miss.
 */
export async function primeSurveillanceFromKV() {
  try {
    const kv = await getKVClient();
    if (!kv) return null;
    const data = await kv.get(KV_SURVEILLANCE_KEY);
    if (!data || !data.flagged) return null;
    _cached = data;
    _cachedSource = "kv";
    console.log(
      `[SURVEILLANCE] primed from KV: ${Object.keys(data.flagged).length} flagged, ` +
      `fetchedAt=${data.fetchedAt || "unknown"}`
    );
    return data;
  } catch (err) {
    console.warn("[SURVEILLANCE] KV prime failed:", err.message);
    return null;
  }
}

/**
 * Synchronous getter. Returns the cached snapshot, falling back to disk.
 * If nothing is available, returns an empty (but well-formed) snapshot so
 * UI code can always call `.flagged[symbol]` safely.
 *
 * Call primeSurveillanceFromKV() at server startup for production use.
 */
export function getSurveillance() {
  const cached = _cached ? { snapshot: _cached, source: _cachedSource || _cached.source || "cache" } : null;
  const disk = readDiskSnapshot();
  const chosen = preferredSnapshot(cached, disk);
  if (chosen) {
    _cached = chosen.snapshot;
    _cachedSource = chosen.source;
    return _cached;
  }
  return emptySnapshot();
}

/**
 * Fast membership check — returns the flag entry if the symbol is under
 * any surveillance regime, null otherwise.
 *
 * Accepts both "RELIANCE" and "RELIANCE.NS" forms.
 */
export function getSurveillanceFlag(symbol) {
  const key = toNseKey(symbol);
  if (!key) return null;
  const snap = getSurveillance();
  return snap.flagged?.[key] || null;
}

/**
 * Diagnostics for the UI / admin surface. Returns {age_hours, source,
 * stale, counts}. `stale` is true if the snapshot is >36h old (NSE
 * publishes daily; 36h gives a 12h grace window across weekends).
 */
export function getSurveillanceStatus() {
  const snap = getSurveillance();
  const total = flaggedCount(snap);
  if (!snap.fetchedAt) {
    return {
      fetchedAt: null,
      age_hours: null,
      source: snap.source,
      stale: true,
      counts: snap.counts,
      total,
    };
  }
  const ageMs = Date.now() - new Date(snap.fetchedAt).getTime();
  const age_hours = +(ageMs / 3_600_000).toFixed(1);
  return {
    fetchedAt: snap.fetchedAt,
    age_hours,
    source: _cachedSource || snap.source,
    stale: age_hours > 36,
    counts: snap.counts || { ASM: 0, GSM: 0 },
    total,
  };
}

/**
 * TEST-ONLY: reset or seed the in-memory cache so tests can exercise
 * disk-vs-KV precedence without touching remote KV.
 */
export function _resetSurveillanceCacheForTests() {
  _cached = null;
  _cachedSource = null;
}

export function _setSurveillanceCacheForTests(snapshot, source = "test") {
  _cached = snapshot;
  _cachedSource = source;
}

export const _surveillanceParserForTests = {
  normalizeStage,
  parseAsmRows,
  parseGsmRows,
};
