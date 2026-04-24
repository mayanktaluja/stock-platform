/**
 * Governance Module — Phase 1 STUB (Apr 2026)
 *
 * Provides the interface that the V2 "Snowflake" scorer will use for the
 * India-specific Governance pillar. The actual NSE/BSE fetchers are
 * deliberately stubs in this iteration — the contract (data shape + getter
 * signatures) is what the V2 scorer needs locked down so we can build the
 * pillar scoring logic in parallel.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Why a governance pillar is India-specific
 * ───────────────────────────────────────────────────────────────────────
 *
 * Simply Wall St uses five pillars globally (Value/Future/Past/Health/Dividend).
 * Indian equities need a sixth — Governance — because the single biggest
 * predictor of multi-year underperformance in NSE smallcaps is NOT valuation
 * or growth but governance risk:
 *
 *   • Pledged promoter holding — a promoter who has pledged >30% of their
 *     stake has personal balance-sheet leverage that can force forced-selling
 *     cascades (Yes Bank 2019, Reliance Capital 2020, Zee 2023).
 *   • Falling promoter holding over time — promoters trimming their stake
 *     via open market sales is the strongest single leading indicator of
 *     future earnings disappointment (SEBI cohort studies 2018-2024).
 *   • Low DII / high FII dependence — FII flows are reflexive; smallcaps
 *     held predominantly by FIIs see 2-3× the drawdown in risk-off phases.
 *   • Related-party transactions as % of revenue — a red flag for earnings
 *     quality manipulation. SEBI LODR requires disclosure, but the data is
 *     locked in PDFs (annual reports) and needs NLP extraction.
 *
 * The scorer in Phase 2 will weight these signals within a Governance pillar
 * that can dock up to 25% off a stock's composite score for red flags.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Data shape (what the V2 scorer consumes)
 * ───────────────────────────────────────────────────────────────────────
 *
 *   {
 *     fetchedAt: ISO string,
 *     source:    "bse-xbrl" | "nse-shareholding" | "kv" | "disk" | "empty",
 *     bySymbol: {
 *       "RELIANCE.NS": {
 *         asOfQuarter:      "Q4FY26",
 *         promoterHolding:  0.5031,   // ratio; SEBI max is 0.75 for listed cos
 *         promoterPledge:   0.00,     // ratio of promoter stake pledged
 *         pledgeOfTotal:    0.00,     // pledge * promoter = % of total shares
 *         fiiHolding:       0.2294,
 *         diiHolding:       0.1635,
 *         retailHolding:    0.1040,   // ratio — the residual
 *         rptAsPctRevenue:  null,     // thin; from annual report NLP (Phase 3)
 *         promoterHoldingQoQDelta: -0.0012,  // deriv: this Q − prior Q
 *         pledgeQoQDelta:          0.00,
 *       },
 *       ...
 *     }
 *   }
 *
 * Call site pattern (Phase 2 scorer):
 *   import { getGovernance } from "./governance.js";
 *   const g = getGovernance("RELIANCE.NS");
 *   if (g?.pledgeOfTotal > 0.10) warnings.push("High pledged promoter stake");
 *
 * ───────────────────────────────────────────────────────────────────────
 * Where the data will come from (STUB — not implemented yet)
 * ───────────────────────────────────────────────────────────────────────
 *
 * Primary source: BSE XBRL shareholding filings.
 *   URL pattern: https://www.bseindia.com/corporates/shpSecurities.aspx?scripcd=XXXXXX
 *   Format:      Regulation 31(1)(b) quarterly XBRL. Structured XML, NO
 *                scraping. Company maps via ISIN → BSE scrip code.
 *   Cadence:     Quarterly within 21 days of quarter end.
 *   Licensing:   Public disclosure regime, no commercial restriction.
 *
 * Fallback: NSE shareholding-pattern JSON.
 *   URL: /api/corp-shareholdings-master?index=equities&symbol=RELIANCE
 *   Less structured, but faster for one-off lookups during dev.
 *
 * Out-of-scope for Phase 1: RPT as % of revenue requires annual-report PDF
 * parsing (150+ pages each) and is deferred to Phase 3 when the governance
 * pillar matures.
 *
 * ───────────────────────────────────────────────────────────────────────
 * Current behaviour (stub)
 * ───────────────────────────────────────────────────────────────────────
 *
 * getGovernance(symbol) returns null until the fetcher is built. The V2
 * scorer must tolerate null — it should down-weight (not score 0) a pillar
 * when its inputs are missing. This aligns with Simply Wall St's behaviour
 * when annual reports are delayed for a newly-listed company.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GOVERNANCE_PATH = path.join(__dirname, "governance.json");

export const KV_GOVERNANCE_KEY = "governance:snapshot";

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

function toNseKey(sym) {
  if (!sym) return null;
  const s = String(sym).trim().toUpperCase();
  if (!s) return null;
  return s.endsWith(".NS") ? s : `${s}.NS`;
}

// ==================== EMPTY SNAPSHOT ====================

function emptySnapshot() {
  return {
    fetchedAt: null,
    source: "empty",
    bySymbol: {},
  };
}

// ==================== BUILD (STUB) ====================

/**
 * Build a governance snapshot by fetching shareholding data from BSE XBRL.
 *
 * STUB: currently returns an empty snapshot. Implementing this is a Phase 2
 * deliverable — see the data-source notes at the top of this file.
 *
 * When implemented, this function should:
 *   1. Load the ISIN → BSE scripcode map (ISINs already live in fundamentals.json)
 *   2. For each stock, fetch the latest XBRL filing
 *   3. Parse promoter / FII / DII / retail blocks
 *   4. Derive QoQ deltas by comparing to the prior quarter filing
 *   5. Return the shape documented above
 *
 * Until then, callers get null from getGovernance() and the V2 scorer
 * degrades gracefully.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.symbols]  Limit to a specific list of symbols.
 *                                   Useful for smoke tests before running
 *                                   the full NSE universe (~2100 stocks).
 */
// eslint-disable-next-line no-unused-vars
export async function buildGovernance(opts = {}) {
  console.warn(
    "[GOVERNANCE] buildGovernance() is a stub. BSE XBRL fetcher not yet " +
    "implemented — returning empty snapshot. See governance.js comment block."
  );
  return {
    fetchedAt: new Date().toISOString(),
    source: "stub",
    bySymbol: {},
  };
}

// ==================== PERSISTENCE ====================

export async function saveGovernance(snapshot) {
  const kv = await getKVClient();
  if (kv) {
    await kv.set(KV_GOVERNANCE_KEY, snapshot);
    _cached = snapshot;
    _cachedSource = "kv";
    return { target: "kv" };
  }
  writeFileSync(GOVERNANCE_PATH, JSON.stringify(snapshot, null, 2));
  _cached = snapshot;
  _cachedSource = "disk";
  return { target: "disk", path: GOVERNANCE_PATH };
}

/**
 * Prime the in-memory cache from KV at server startup. Silent on failure
 * because getGovernance() falls through to disk + empty.
 */
export async function primeGovernanceFromKV() {
  try {
    const kv = await getKVClient();
    if (!kv) return null;
    const data = await kv.get(KV_GOVERNANCE_KEY);
    if (!data || !data.bySymbol) return null;
    _cached = data;
    _cachedSource = "kv";
    console.log(
      `[GOVERNANCE] primed from KV: ${Object.keys(data.bySymbol).length} records, ` +
      `fetchedAt=${data.fetchedAt || "unknown"}`
    );
    return data;
  } catch (err) {
    console.warn("[GOVERNANCE] KV prime failed:", err.message);
    return null;
  }
}

// ==================== GETTERS ====================

/**
 * Return the full snapshot (cached → disk → empty).
 */
export function getGovernanceSnapshot() {
  if (_cached) return _cached;
  if (existsSync(GOVERNANCE_PATH)) {
    try {
      const raw = readFileSync(GOVERNANCE_PATH, "utf8");
      _cached = JSON.parse(raw);
      _cachedSource = "disk";
      return _cached;
    } catch (err) {
      console.warn("[GOVERNANCE] disk read failed:", err.message);
    }
  }
  return emptySnapshot();
}

/**
 * Fast per-symbol lookup. Returns null if the snapshot is empty or the
 * symbol isn't covered. Callers (V2 scorer) MUST tolerate null and
 * degrade the Governance pillar weight accordingly.
 *
 * Accepts both "RELIANCE" and "RELIANCE.NS" forms.
 */
export function getGovernance(symbol) {
  const key = toNseKey(symbol);
  if (!key) return null;
  const snap = getGovernanceSnapshot();
  return snap.bySymbol?.[key] || null;
}

/**
 * Diagnostics for the UI / admin surface. Follows the same shape as
 * getSurveillanceStatus() for pattern consistency.
 */
export function getGovernanceStatus() {
  const snap = getGovernanceSnapshot();
  const count = Object.keys(snap.bySymbol || {}).length;
  if (!snap.fetchedAt) {
    return { age_hours: null, source: snap.source, stale: true, count };
  }
  const ageMs = Date.now() - new Date(snap.fetchedAt).getTime();
  const age_hours = +(ageMs / 3_600_000).toFixed(1);
  // Governance data refreshes quarterly (within 21 days of quarter end).
  // 100 days = ~3.3 months — after this, the data is stale because a new
  // quarter should have been published.
  return {
    age_hours,
    source: _cachedSource || snap.source,
    stale: age_hours > 100 * 24,
    count,
  };
}
