/**
 * picksSectionBacktest.js — honest per-section hit-rate + alpha-vs-Nifty with CIs.
 *
 * Turns the paper-trade ledger into one row per SWS picks section: the share of
 * that section's RESOLVED picks that beat Nifty (hit-rate, Wilson CI) and their
 * mean/median alpha (percentile-bootstrap CI). Sections below `THIN_N` resolved
 * rows carry null metrics so the UI shows a muted "n=X · measuring" instead of a
 * noisy point estimate.
 *
 * Honesty posture (all disclosed in `honesty_note` + the pill tooltip):
 *   - The current ledger is 100% git-backfill: each pick is priced at its
 *     historical recommend date vs the next close. That is point-in-time (NOT
 *     the trailing-survivorship number the Track Record banner strips), but
 *     short-hold (median ~1 trading day) — a reconstruction, not a durable edge.
 *   - Alpha is GROSS of costs (computeReturns applies no friction) → biased up.
 *   - Positions close on section-exit (snapshotAndCloseSwsPicks), so long-riding
 *     winners are under-counted vs quick drop-outs → right-censoring bias.
 *   - Metrics pool across macro regimes.
 *
 * Pure + deterministic given an rng. No I/O — the script feeds it `readAllTrades`
 * output and writes the result; the route formats pills from it.
 */

import { computeReturns, filterPublicTrackTrades } from "../../paperTrades.js";
import { SWS_SECTION_PERFORMANCE_REGISTRY } from "./sectionPerformance.js";
import { _internals as calibrationInternals } from "./calibration.js";

const { wilsonCI } = calibrationInternals;

// Minimum resolved rows before a section shows a measured number. Mirrors the
// THIN_N=30 convention used by the calibration plot.
export const PICKS_SECTION_THIN_N = 30;

export const PICKS_SECTION_HONESTY_NOTE =
  "Backfilled point-in-time ledger (pick priced at its historical recommend " +
  "date vs next close). Short-hold reconstruction (~1 trading day), gross of " +
  "costs, positions close on section-exit, pooled across regimes. Alpha vs " +
  "Nifty 50 — historical evidence, not a durable forward edge or current call.";

function round(value, dp = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(dp)) : null;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Percentile bootstrap CI for an arbitrary statistic over `values`.
 * Same conventions as bootstrapHitRateCI in earningsHistoryArchive.js:
 * n < 5 → null bounds; default 1000 iterations at the 95% level.
 *
 * `rng` is injectable so tests stay deterministic where it matters. Properties
 * that don't depend on the draws (all-equal → lo==hi==stat; n<5 → null) are the
 * ones asserted in tests, so no seeding is required.
 */
export function bootstrapCI(values, statFn, { iterations = 1000, ciLevel = 0.95, rng = Math.random } = {}) {
  const n = values.length;
  if (n < 5) return { lo: null, hi: null };
  const stats = new Array(iterations);
  for (let it = 0; it < iterations; it += 1) {
    const sample = new Array(n);
    for (let i = 0; i < n; i += 1) sample[i] = values[Math.floor(rng() * n)];
    stats[it] = statFn(sample);
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - ciLevel) / 2;
  const loIdx = Math.floor(alpha * iterations);
  const hiIdx = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1);
  return { lo: round(stats[loIdx]), hi: round(stats[hiIdx]) };
}

export function bootstrapMeanCI(values, opts = {}) {
  return bootstrapCI(values, mean, opts);
}

export function bootstrapMedianCI(values, opts = {}) {
  return bootstrapCI(values, median, opts);
}

/**
 * Compute metrics for one section's raw ledger trades.
 * Partitions rows into resolved / open / excluded via computeReturns (which
 * returns alpha/returnPct in PERCENT — do NOT re-scale).
 */
export function computeSectionMetrics(rows, { minN = PICKS_SECTION_THIN_N, rng } = {}) {
  const alphas = [];
  const holds = [];
  let hits = 0;
  let nOpen = 0;
  let nAlphaExcluded = 0; // closed but no benchmark → no alpha
  let nBadPrice = 0; // computeReturns error (missing price)

  for (const t of rows) {
    // Classify open/closed from the trade itself. In a backtest there is no
    // live price, so computeReturns(t) with no currentPrice would return
    // `missing_price` for OPEN rows — we must not mislabel those as bad price.
    if (!t || !t.priceAtSnapshot) {
      nBadPrice += 1;
      continue;
    }
    const isClosed = !!t.closedAt && t.closingPrice != null;
    if (!isClosed) {
      nOpen += 1; // unresolved — no forward return to score yet
      continue;
    }
    const r = computeReturns(t); // closed → uses closingPrice/niftyAtClose
    if (r.error) {
      nBadPrice += 1;
      continue;
    }
    if (r.alpha == null) {
      nAlphaExcluded += 1; // closed but no benchmark at snapshot/close
      continue;
    }
    alphas.push(r.alpha);
    holds.push(r.daysHeld);
    if (r.beatsNifty) hits += 1;
  }

  const nResolved = alphas.length;
  const nTotal = rows.length;
  const thin = nResolved < minN;

  const base = {
    n_resolved: nResolved,
    n_open: nOpen,
    n_alpha_excluded: nAlphaExcluded,
    n_bad_price: nBadPrice,
    n_total: nTotal,
    thin,
    median_days_held: nResolved ? median(holds) : null,
  };

  if (thin) {
    // The JSON itself enforces "no number below N": null out every rate/alpha.
    return {
      ...base,
      hit_rate_pct: null,
      hit_rate_ci_pct: null,
      mean_alpha_pct: null,
      mean_alpha_ci_pct: null,
      median_alpha_pct: null,
      median_alpha_ci_pct: null,
      beats_nifty_rate_pct: null,
    };
  }

  const ci = wilsonCI(hits, nResolved); // {lo, hi} in percent
  const hitRate = (hits / nResolved) * 100;
  return {
    ...base,
    hit_rate_pct: round(hitRate, 1),
    hit_rate_ci_pct: { lo: round(ci.lo, 1), hi: round(ci.hi, 1) },
    mean_alpha_pct: round(mean(alphas)),
    mean_alpha_ci_pct: bootstrapMeanCI(alphas, { rng }),
    median_alpha_pct: round(median(alphas)),
    median_alpha_ci_pct: bootstrapMedianCI(alphas, { rng }),
    beats_nifty_rate_pct: round(hitRate, 1),
  };
}

/**
 * Build the full per-section backtest object from a flat list of ledger trades.
 * Groups by the section registry (canonical sectionKey ← ledger `type`), which
 * folds `sws_top30_v3` rows into the canonical `top_ranked_30_v4` key without
 * the SWS_SECTION_TO_TYPE inversion ambiguity.
 */
export function buildSectionBacktest(trades, { minN = PICKS_SECTION_THIN_N, region = "IN", generatedAt = null, rng } = {}) {
  const publicTrades = filterPublicTrackTrades(Array.isArray(trades) ? trades : []);

  // type → canonical sectionKey, straight from the forward registry.
  const typeToSectionKey = new Map();
  for (const entry of Object.values(SWS_SECTION_PERFORMANCE_REGISTRY)) {
    if (entry?.type && !typeToSectionKey.has(entry.type)) {
      typeToSectionKey.set(entry.type, entry.sectionKey);
    }
  }

  // Bucket trades by canonical sectionKey; track ledger types with no registry entry.
  const bySection = new Map();
  const unmapped = new Map();
  for (const t of publicTrades) {
    const sectionKey = typeToSectionKey.get(t?.type);
    if (!sectionKey) {
      unmapped.set(t.type, (unmapped.get(t.type) || 0) + 1);
      continue;
    }
    if (!bySection.has(sectionKey)) bySection.set(sectionKey, []);
    bySection.get(sectionKey).push(t);
  }

  // Emit an entry for every registry section (nulls when empty/thin) so the UI
  // always has a field to read.
  const sections = {};
  let anyResolved = false;
  for (const entry of Object.values(SWS_SECTION_PERFORMANCE_REGISTRY)) {
    const rows = bySection.get(entry.sectionKey) || [];
    const metrics = computeSectionMetrics(rows, { minN, rng });
    if (metrics.n_resolved > 0) anyResolved = true;
    sections[entry.sectionKey] = {
      ledger_type: entry.type,
      label: entry.label,
      ...metrics,
    };
  }

  const unmappedList = [...unmapped.entries()].map(([type, count]) => ({ type, count }));

  return {
    schema_version: "picks-section-backtest-v1",
    generated_at: generatedAt,
    generated_by: "scripts/backtest-picks-sections.mjs",
    region,
    benchmark: "Nifty 50",
    ledger_rows_total: Array.isArray(trades) ? trades.length : 0,
    thin_n: minN,
    all_backfill: true, // flips false once genuine forward (non-backfill) rows land
    honesty_note: PICKS_SECTION_HONESTY_NOTE,
    sections,
    unmapped_ledger_types: unmappedList,
    _has_any_resolved: anyResolved,
  };
}

// ──────────────────── Presentation (pure) ────────────────────

function fmtSigned(value) {
  if (!Number.isFinite(value)) return "0.0";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

const MEASURED_TITLE =
  "Median alpha vs Nifty 50 · backfilled point-in-time ledger · gross of " +
  "costs · positions close on section-exit · pooled across regimes · " +
  "historical evidence, not a current call";

/**
 * Format a section's metric entry into the header pill HTML.
 * Single source of truth for measured-vs-measuring — the route calls this so
 * the frontend just injects the returned string. Returns "" to render nothing.
 * All content is numeric/fixed copy → no untrusted data, no escaping needed.
 */
export function formatSectionPill(entry, { thinN = PICKS_SECTION_THIN_N } = {}) {
  if (!entry || entry.n_resolved == null) return "";
  const n = entry.n_resolved;

  if (entry.thin) {
    const title = `Measuring — need ≥${thinN} resolved picks; have ${n}`;
    return `<span class="sws-pick-section-measuring" title="${title}">n=${n} · measuring</span>`;
  }

  const alpha = entry.median_alpha_pct;
  const ci = entry.median_alpha_ci_pct || {};
  const hold = entry.median_days_held != null ? entry.median_days_held : "?";
  const sign = Number(alpha) >= 0 ? "pos" : "neg";
  const ciText = ci.lo != null && ci.hi != null ? ` (95% CI ${fmtSigned(ci.lo)}…${fmtSigned(ci.hi)})` : "";
  return (
    `<span class="sws-pick-section-alpha ${sign}" title="${MEASURED_TITLE}">` +
    `α ${fmtSigned(alpha)}%${ciText} · n=${n} · ~${hold}d hold</span>`
  );
}

/**
 * Attach a `pill_html` field to every section of a backtest payload.
 * Called by the route so the committed JSON stays pure metrics.
 */
export function withSectionPills(payload) {
  if (!payload || !payload.sections) return payload;
  const thinN = payload.thin_n || PICKS_SECTION_THIN_N;
  const sections = {};
  for (const [key, entry] of Object.entries(payload.sections)) {
    sections[key] = { ...entry, pill_html: formatSectionPill(entry, { thinN }) };
  }
  return { ...payload, sections };
}
