/**
 * fundamentalsRefreshPlanner.js
 *
 * Pure planning logic for the quota-aware fundamentalsHistory.json
 * refresh. Kept separate from scripts/refresh-fundamentals-history.mjs
 * so the budget / staleness / drift / override rules are unit-testable
 * without touching Yahoo or the filesystem.
 *
 * The problem this solves: fundamentalsHistory.json was a one-time
 * snapshot — 494 stocks, only 10 with quarterly data fresher than 90
 * days, and 373 of the 488 Earnings Watch stocks not in it at all.
 * Component 4 of the predictor (YoY EPS trajectory, ±15 pts) was
 * therefore dead for ~95% of events. A blind full re-fetch is ~4 Yahoo
 * calls per stock and blows the ~2,000/day soft ceiling, so the refresh
 * has to be incremental and budgeted.
 */

const MS_PER_DAY = 86400000;

// Yahoo call cost per stock: a NEW stock needs annual + quarterly
// (financials + balance-sheet each) = 4 calls; a STALE existing stock
// only needs the two quarterly modules refreshed = 2 calls.
export const CALLS_NEW = 4;
export const CALLS_STALE = 2;

/* ─────────────────────────── helpers ────────────────────────────── */

/**
 * Bare NSE ticker → Yahoo symbol. Must match signalAggregator.js:nsSymbol
 * exactly (upper-cased, ".NS" suffix) — that's the key the predictor uses
 * to look a stock up in fundamentalsHistory.json, so a casing mismatch
 * here would silently orphan the data. ".BO" passes through for the
 * rare BSE-keyed manual override.
 */
export function toNseSymbol(sym) {
  if (!sym || typeof sym !== "string") return null;
  const up = sym.toUpperCase();
  return up.endsWith(".NS") || up.endsWith(".BO") ? up : `${up}.NS`;
}

function isoDateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The most recent statement end-date on a fundamentalsHistory entry.
 * Quarterly is preferred (that's what drives YoY EPS); annual is the
 * fallback. Returns an ISO date string or null.
 */
export function latestQuarterEndIso(entry) {
  if (!entry) return null;
  const q = Array.isArray(entry.quarterly) ? entry.quarterly : [];
  const a = Array.isArray(entry.annual) ? entry.annual : [];
  const dates = [...q, ...a].map((r) => r && r.endDate).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/* ────────────────────────── classify ────────────────────────────── */

/**
 * Decide what a single symbol needs.
 *
 * @param {string} symbol               Yahoo-form symbol
 * @param {object|undefined} entry      existing fundamentalsHistory entry
 * @param {object} opts
 * @param {string} opts.todayIso        IST today
 * @param {number} [opts.staleAfterDays] default 90
 * @param {number} [opts.nowMs]         clock for the 24h backoff check
 * @returns {{status:"new"|"stale"|"fresh"|"backoff", reason:string, estCalls:number}}
 */
export function classifyStock(symbol, entry, opts = {}) {
  const todayIso = opts.todayIso;
  const staleAfterDays = Number.isFinite(opts.staleAfterDays) ? opts.staleAfterDays : 90;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  if (!entry) {
    return { status: "new", reason: "not in fundamentalsHistory", estCalls: CALLS_NEW };
  }

  // Per-stock failure backoff — a fetch that errored in the last 24h is
  // skipped so a throttled or delisted symbol doesn't burn the budget
  // every run.
  const lastFailedAt = entry._meta && entry._meta.last_failed_at;
  if (lastFailedAt) {
    const ageMs = nowMs - new Date(lastFailedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < MS_PER_DAY) {
      return { status: "backoff", reason: `failed ${Math.round(ageMs / 3600000)}h ago`, estCalls: 0 };
    }
  }

  const latest = latestQuarterEndIso(entry);
  if (!latest) {
    return { status: "stale", reason: "no quarterly data", estCalls: CALLS_STALE };
  }
  const todayMs = new Date(todayIso + "T00:00:00Z").getTime();
  const cutoffIso = isoDateOf(todayMs - staleAfterDays * MS_PER_DAY);
  if (latest < cutoffIso) {
    return { status: "stale", reason: `latest quarter ${latest} < ${cutoffIso}`, estCalls: CALLS_STALE };
  }
  return { status: "fresh", reason: `latest quarter ${latest}`, estCalls: 0 };
}

/* ───────────────────── target selection ─────────────────────────── */

/**
 * Plan a refresh run: classify every universe symbol, then take NEW
 * stocks first (coverage) and STALE stocks next (freshness) until the
 * Yahoo call budget is spent.
 *
 * @param {object} args
 * @param {string[]} args.universe   Yahoo-form symbols to consider
 * @param {object}   args.stocks     existing fundamentalsHistory.stocks
 * @param {object}   args.opts
 * @param {string}   args.opts.todayIso
 * @param {number}   [args.opts.staleAfterDays]
 * @param {number}   [args.opts.maxFetches]   call budget (default 1800)
 * @param {number}   [args.opts.nowMs]
 * @returns {{targets, skipped, plannedCalls, budgetCapped}}
 */
export function selectRefreshTargets({ universe, stocks, opts = {} }) {
  const maxFetches = Number.isFinite(opts.maxFetches) ? opts.maxFetches : 1800;
  const stocksObj = stocks || {};

  const seen = new Set();
  const news = [];
  const stales = [];
  let freshCount = 0;
  let backoffCount = 0;

  for (const raw of universe || []) {
    const symbol = toNseSymbol(raw);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const c = classifyStock(symbol, stocksObj[symbol], opts);
    if (c.status === "new") news.push({ symbol, ...c });
    else if (c.status === "stale") stales.push({ symbol, ...c });
    else if (c.status === "fresh") freshCount += 1;
    else if (c.status === "backoff") backoffCount += 1;
  }

  // NEW before STALE — covering an Earnings Watch stock that has zero
  // data beats refreshing one that already has a usable (if old) quarter.
  const ordered = [...news, ...stales];
  const targets = [];
  let plannedCalls = 0;
  let budgetCapped = false;
  for (const t of ordered) {
    if (plannedCalls + t.estCalls > maxFetches) {
      budgetCapped = true;
      break;
    }
    plannedCalls += t.estCalls;
    targets.push(t);
  }

  return {
    targets,
    skipped: {
      fresh: freshCount,
      backoff: backoffCount,
      over_budget: ordered.length - targets.length,
    },
    plannedCalls,
    budgetCapped,
    counts: { new: news.length, stale: stales.length },
  };
}

/* ───────────────────── overrides + drift ────────────────────────── */

/**
 * Apply manual corrections from data/fundamentals-history-overrides.json.
 * An override entry fully replaces the Yahoo-derived one — overrides
 * always win, and are reapplied after every refresh so a re-fetch can
 * never clobber a hand-correction.
 *
 * Returns a NEW stocks object (does not mutate the input).
 */
export function mergeOverrides(stocks, overrides) {
  const out = { ...(stocks || {}) };
  if (!overrides || typeof overrides !== "object") return out;
  for (const [sym, entry] of Object.entries(overrides)) {
    if (!entry || typeof entry !== "object") continue;
    out[sym] = {
      ...entry,
      _meta: { ...(entry._meta || {}), source: "manual_override" },
    };
  }
  return out;
}

/**
 * Symbols present in fundamentalsHistory but no longer in any live
 * universe — reported for visibility, never deleted (the rows are still
 * valid point-in-time history for the backtest).
 */
export function computeDrift(stocks, universeSet) {
  const drift = [];
  for (const sym of Object.keys(stocks || {})) {
    if (!universeSet.has(sym)) drift.push(sym);
  }
  return drift.sort();
}
