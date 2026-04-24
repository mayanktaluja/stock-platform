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
 *   • Local dev:  `node scripts/refresh-surveillance.mjs` → writes
 *                 surveillance.json on disk.
 *   • Production: Vercel cron hits /api/cron/refresh-surveillance daily;
 *                 writes to KV under `surveillance:snapshot`.
 *
 * Failure mode: ALWAYS defensive. A fetch failure never throws to the
 * caller — the getter returns the last-known snapshot (KV → disk → empty).
 * An empty snapshot means "no stocks flagged" which is the safe default
 * for the UI, but a stale-data warning is surfaced in diagnostics.
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

// ==================== FETCHERS ====================

/**
 * Fetch ASM list. NSE returns { longterm: {data}, shortterm: {data} }.
 * Each row typically has symbol, series, stage. Schema drift is possible,
 * so we pull fields defensively.
 */
async function fetchASM() {
  const data = await nseGet("/api/reportASM");
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
      out.push({
        symbol: sym,
        list: "ASM",
        stage: r.asmStage || r.stage || r.Stage || null,
        timeframe,
        series: r.series || r.Series || null,
      });
    }
  }
  return out;
}

/**
 * Fetch GSM list. NSE shape: { data: [ { symbol, stage, series, ... } ] }.
 * GSM stages run I → VI; IV+ is where trading becomes highly constrained.
 */
async function fetchGSM() {
  const data = await nseGet("/api/reportGSM");
  if (!data || typeof data !== "object") return [];
  const rows = Array.isArray(data.data) ? data.data : [];
  const out = [];
  for (const r of rows) {
    const sym = toNseKey(r.symbol || r.Symbol);
    if (!sym) continue;
    out.push({
      symbol: sym,
      list: "GSM",
      stage: r.gsmStage || r.stage || r.Stage || null,
      timeframe: null,
      series: r.series || r.Series || null,
    });
  }
  return out;
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
export async function buildSurveillance() {
  const [asm, gsm] = await Promise.all([
    fetchASM().catch((e) => {
      console.warn("[SURVEILLANCE] ASM fetch failed:", e.message);
      return [];
    }),
    fetchGSM().catch((e) => {
      console.warn("[SURVEILLANCE] GSM fetch failed:", e.message);
      return [];
    }),
  ]);

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
  };
}

/**
 * Save a snapshot to KV (production) or disk (local dev). Mirrors the
 * fundamentals pipeline so we have one persistence pattern to reason about.
 */
export async function saveSurveillance(snapshot) {
  const kv = await getKVClient();
  if (kv) {
    await kv.set(KV_SURVEILLANCE_KEY, snapshot);
    _cached = snapshot;
    _cachedSource = "kv";
    return { target: "kv" };
  }
  writeFileSync(SURVEILLANCE_PATH, JSON.stringify(snapshot, null, 2));
  _cached = snapshot;
  _cachedSource = "disk";
  return { target: "disk", path: SURVEILLANCE_PATH };
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
  if (_cached) return _cached;
  if (existsSync(SURVEILLANCE_PATH)) {
    try {
      const raw = readFileSync(SURVEILLANCE_PATH, "utf8");
      _cached = JSON.parse(raw);
      _cachedSource = "disk";
      return _cached;
    } catch (err) {
      console.warn("[SURVEILLANCE] disk read failed:", err.message);
    }
  }
  return {
    fetchedAt: null,
    source: "empty",
    flagged: {},
    counts: { ASM: 0, GSM: 0 },
  };
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
  if (!snap.fetchedAt) {
    return { age_hours: null, source: snap.source, stale: true, counts: snap.counts };
  }
  const ageMs = Date.now() - new Date(snap.fetchedAt).getTime();
  const age_hours = +(ageMs / 3_600_000).toFixed(1);
  return {
    age_hours,
    source: _cachedSource || snap.source,
    stale: age_hours > 36,
    counts: snap.counts || { ASM: 0, GSM: 0 },
  };
}
