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
import { nseGetDetailed } from "./nse.js";
import { fetchRegIndCsv, parseRegIndCsv } from "./services/surveillanceRegindFetcher.js";

const NSE_BASE = "https://www.nseindia.com";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SURVEILLANCE_PATH = path.join(__dirname, "surveillance.json");

export const KV_SURVEILLANCE_KEY = "surveillance:snapshot";

// ==================== IN-MEMORY CACHE ====================

let _cached = null;
let _cachedSource = null;

// `undefined` = not overridden (read env); any other value (client or null) is
// returned verbatim so tests can exercise the KV-present path hermetically
// without real @vercel/kv creds. See _setKVClientForTests.
let _kvClientOverride;

async function getKVClient() {
  if (_kvClientOverride !== undefined) return _kvClientOverride;
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

async function nseGetWithRetry(pathname, { referers = [], attempts = 3, baseDelayMs = 750 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    // Rotate the Referer across attempts — the report endpoints may enforce a
    // page-scoped referer the default market-data one doesn't satisfy.
    const referer = referers.length ? referers[Math.min(i, referers.length - 1)] : undefined;
    try {
      const r = await nseGetDetailed(pathname, referer);
      if (r.ok) return r.data;
      last = r;
    } catch (err) {
      last = { error: err.message, attempt: "throw" };
    }
    if (i < attempts - 1) await sleep(baseDelayMs * (i + 1));
  }
  // Surface the REAL failure (HTTP status / non-JSON / cookie) instead of a
  // bare null. A null was reported as "zero stocks flagged", letting a broken
  // endpoint masquerade as a healthy fetch for a full grace window
  // (2026-07-09 → 11 outage).
  const detail = last
    ? `${last.error || "no data"}${last.attempt ? ` (${last.attempt})` : ""}`
    : "no response";
  throw new Error(`NSE ${pathname} failed after ${attempts} attempts: ${detail}`);
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
  return parseAsmRows(await nseGetWithRetry("/api/reportASM", {
    referers: [`${NSE_BASE}/reports/asm`, undefined, `${NSE_BASE}/reports/asm`],
  }));
}

/**
 * Fetch GSM list. NSE has returned both a top-level array and
 * { data: [ { symbol, stage, series, ... } ] } across schema versions.
 * GSM stages run I → VI; IV+ is where trading becomes highly constrained.
 */
async function fetchGSM() {
  return parseGsmRows(await nseGetWithRetry("/api/reportGSM", {
    referers: [`${NSE_BASE}/reports/gsm`, undefined, `${NSE_BASE}/reports/gsm`],
  }));
}

// ==================== REG_IND CSV FALLBACK ADAPTER ====================

/**
 * Adapt REG_IND CSV records into the exact row shape parseAsmRows/parseGsmRows
 * emit, so the fallback path feeds the identical `flagged` builder. One record
 * can produce up to three rows (ASM long-term + ASM short-term + GSM).
 */
function regIndRecordsToRows(records, dateUsed) {
  const asmRows = [];
  const gsmRows = [];
  for (const rec of records || []) {
    const sym = toNseKey(rec.symbol);
    if (!sym) continue;
    const base = { symbol: sym, series: rec.series || null, source_time: dateUsed || null };
    if (rec.asmLtStage) {
      asmRows.push({ ...base, list: "ASM", ...normalizeStage(rec.asmLtStage), timeframe: "longterm" });
    }
    if (rec.asmStStage) {
      asmRows.push({ ...base, list: "ASM", ...normalizeStage(rec.asmStStage), timeframe: "shortterm" });
    }
    if (rec.gsmStage) {
      gsmRows.push({ ...base, list: "GSM", ...normalizeStage(rec.gsmStage), timeframe: null });
    }
  }
  return { asmRows, gsmRows };
}

/**
 * Fetch + parse the REG_IND CSV fallback. Throws (with a descriptive message)
 * on any failure so buildSurveillance can record it in fetchErrors; the caller
 * always wraps this in try/catch.
 */
async function fetchRegIndFallback() {
  const res = await fetchRegIndCsv();
  if (!res.ok) throw new Error(res.error || "REG_IND fetch failed");
  const parsed = parseRegIndCsv(res.csv);
  if (parsed.records.length === 0) {
    throw new Error(`REG_IND parsed 0 rows${parsed.error ? ` (${parsed.error})` : ""}`);
  }
  const { asmRows, gsmRows } = regIndRecordsToRows(parsed.records, res.dateUsed);
  return { asmRows, gsmRows, dateUsed: res.dateUsed, url: res.url };
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
export async function buildSurveillance({
  fetchAsm = fetchASM,
  fetchGsm = fetchGSM,
  fetchRegInd = fetchRegIndFallback,
} = {}) {
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
    result.source = result.ok ? "nse-api" : null;
  }

  // Fallback: if either report endpoint failed, try the REG_IND CSV once —
  // one file serves both lists. A failed list backfilled with >0 rows recovers.
  let regind = null;
  if (!asmResult.ok || !gsmResult.ok) {
    try {
      const fb = await fetchRegInd();
      regind = { dateUsed: fb.dateUsed, url: fb.url };
      const backfill = (result, rows, list) => {
        if (result.ok) return;
        if (rows && rows.length > 0) {
          result.rows = rows;
          result.ok = true;
          result.source = "nse-regind-csv";
          result.error = null;
        } else {
          result.error = `${result.error}; fallback REG_IND: 0 ${list} rows`;
        }
      };
      backfill(asmResult, fb.asmRows, "ASM");
      backfill(gsmResult, fb.gsmRows, "GSM");
    } catch (e) {
      console.warn("[SURVEILLANCE] REG_IND fallback failed:", e.message);
      if (!asmResult.ok) asmResult.error = `${asmResult.error}; fallback REG_IND: ${e.message}`;
      if (!gsmResult.ok) gsmResult.error = `${gsmResult.error}; fallback REG_IND: ${e.message}`;
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

  const usedFallback = asmResult.source === "nse-regind-csv" || gsmResult.source === "nse-regind-csv";

  return {
    fetchedAt: new Date().toISOString(),
    source: usedFallback ? "nse-regind-csv" : "nse",
    flagged,
    counts: { ASM: asm.length, GSM: gsm.length },
    fetchStatus: {
      ASM: asmResult.ok ? "ok" : "failed",
      GSM: gsmResult.ok ? "ok" : "failed",
    },
    sources: { ASM: asmResult.source, GSM: gsmResult.source },
    ...(regind ? { regind } : {}),
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

  // Always write the on-disk snapshot. surveillance.json is BOTH the artifact
  // the nightly commits (Vercel deploys the file) AND the freshness input the
  // publish health gate reads (scripts/check-snapshot-health.mjs, disk-only).
  // KV is an additional prod hot-read cache, never a substitute for disk.
  //
  // Writing ONLY to KV when creds are present (as this did before) froze
  // surveillance.json on disk from 2026-07-08 — when KV creds landed in .env —
  // and the nightly's health gate hard-failed 7 days later (2026-07-15,
  // hardFailHours=168), withholding the whole SWS rescan. Disk-first mirrors
  // the fundamentals pipeline and is the one pattern the gate can rely on.
  writeFileSync(SURVEILLANCE_PATH, JSON.stringify(snapshot, null, 2));
  _cached = snapshot;
  _cachedSource = "disk";

  const kv = await getKVClient();
  if (kv) {
    await kv.set(KV_SURVEILLANCE_KEY, snapshot);
    return { status: "saved", target: "kv+disk", path: SURVEILLANCE_PATH };
  }
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

// Inject a fake KV client (or null) so tests can exercise the KV-present save
// path without real @vercel/kv creds. Pass `undefined` to restore env-based
// resolution. Lets the disk-write regression assert both sinks receive the snapshot.
export function _setKVClientForTests(client) {
  _kvClientOverride = client;
}

export const _surveillanceParserForTests = {
  normalizeStage,
  parseAsmRows,
  parseGsmRows,
  regIndRecordsToRows,
};
