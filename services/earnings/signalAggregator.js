/**
 * signalAggregator.js
 *
 * For each upcoming-result event from the calendar, joins all
 * **offline-available** data sources and emits a `signals` block:
 *
 *   - SWS deep snapshot         : returns_pct, snowflake, mcap, sector
 *   - fundamentalsHistory       : 4-quarter EPS / revenue trajectory
 *   - data/sws/picks-latest     : v3 score, verdict (when in universe)
 *   - sector momentum           : peer 1M return, peer count, signal sign
 *
 * Why offline-only in V1:
 *   stockNews.js holds its cache in NodeCache (process memory only).
 *   The refresh script cannot read it without standing up the live
 *   pipeline + GPT-classifier per stock — too slow for ~220 events
 *   per refresh and would tie the script to the LLM API.
 *
 *   News integration ships in a follow-up sub-milestone via a
 *   committed news-cache.json that the live process maintains.
 *
 * Sets `data_quality: HIGH | MEDIUM | LOW`. Downstream the
 * earningsPredictor (Milestone C) returns `INSUFFICIENT_DATA` whenever
 * data_quality === "LOW" — so this tier is the gate, not the score.
 *
 * Pure-ish: I/O is centralised at module load via a single context
 * object built by buildAggregatorContext(). Per-event aggregation is
 * a pure function of (event, context). Tests pass a hand-crafted
 * context.
 */

import fs from "node:fs";
import path from "node:path";

import {
  loadAnnouncementsRolling,
  buildPerSymbolAnnouncementIndex,
} from "./nseAnnouncementsIngester.js";
import {
  loadDealsRolling,
  buildPerSymbolDealIndex,
} from "./nseBulkBlockIngester.js";
import * as dal from "../swsDal/index.js";
import { extractV3SignalsForEvent } from "./v3SignalAdapter.js";
import { loadV3UniverseStats } from "./loadV3UniverseStats.js";

const ROOT = process.cwd();
const FUNDAMENTALS_HISTORY_PATH = path.join(ROOT, "fundamentalsHistory.json");

// ────────── Tiny utilities ──────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v) => (v == null ? null : Math.round(v * 100) / 100);

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * SWS deep files are keyed by NSE base symbol (no .NS suffix).
 * fundamentalsHistory uses the full Yahoo symbol (.NS suffix).
 * stockList drops .BO/.NS for display. Centralise the conversions
 * so a single place owns the mismatch.
 */
function nsSymbol(symbol) {
  if (typeof symbol !== "string") return null;
  return symbol.toUpperCase().endsWith(".NS")
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}.NS`;
}

// ────────── Context builder ──────────
// One disk-read pass at the top of a refresh. Per-event aggregation
// only re-reads the per-stock SWS deep file, which is small.

/**
 * Build the aggregator context once per refresh.
 *
 * @param {object} [opts]
 * @param {object} [opts.fundamentalsHistory] - inject for tests.
 * @param {object} [opts.picksLatest]         - inject for tests.
 * @param {function} [opts.readSwsDeep]       - inject for tests; default
 *                                              reads from disk.
 * @param {Map<string, number>} [opts.sectorMomentumMap] - inject for tests.
 *
 * @returns {AggregatorContext}
 */
export function buildAggregatorContext(opts = {}) {
  const fundamentalsHistory =
    opts.fundamentalsHistory ?? readJsonSafe(FUNDAMENTALS_HISTORY_PATH) ?? { stocks: {} };

  const picksLatest =
    opts.picksLatest ?? dal.getPicksLatest() ?? { sections: {} };

  // picks-latest-v2 is sectioned (top_ranked, deep_value, quality_growth,
  // upcoming_earnings, avoid, …). We need two lookups:
  //
  //   upcomingMap : sections.upcoming_earnings — the gold-standard row,
  //                 already carries counter_thesis + falsification_triggers
  //                 + audit_trail + data_completeness_pct. When present,
  //                 we forward this verbatim into the signals block.
  //
  //   picksMap    : flattened across ALL sections — gives us v3_score and
  //                 verdict for stocks in any tier (e.g. an `avoid` row
  //                 still gives us a valid v3 score that the predictor
  //                 can use; we just don't get the earnings-specific
  //                 reasoning blob).
  const sections = picksLatest.sections || {};
  const upcomingMap = new Map();
  const picksMap = new Map();
  const upcomingRows = Array.isArray(sections.upcoming_earnings) ? sections.upcoming_earnings : [];
  for (const row of upcomingRows) {
    if (row && row.ticker) upcomingMap.set(String(row.ticker).toUpperCase(), row);
  }
  for (const [, sectionRows] of Object.entries(sections)) {
    if (!Array.isArray(sectionRows)) continue;
    for (const row of sectionRows) {
      if (!row || !row.ticker) continue;
      const key = String(row.ticker).toUpperCase();
      // First-write wins; sections are listed top-quality-first in the
      // file, so this gives precedence to `top_ranked_30_v3` over
      // `avoid` for stocks that appear in multiple sections.
      if (!picksMap.has(key)) picksMap.set(key, row);
    }
  }

  // Default reader pulls through the DAL; tests can swap it for a mock.
  const readSwsDeep =
    opts.readSwsDeep ?? ((symbol) => dal.getStockByTicker(symbol));

  // ── Milestone D inputs ──
  // NSE corporate announcements (rolling 30 days) and bulk/block
  // deals (rolling 7 days). Both files are populated by the local
  // scripts/refresh-nse-corporate.mjs script and committed to disk —
  // empty-shape defaults if a script hasn't run yet.
  const announcementsRolling =
    opts.announcementsRolling ?? loadAnnouncementsRolling();
  const dealsRolling = opts.dealsRolling ?? loadDealsRolling();
  const announcementIndex = buildPerSymbolAnnouncementIndex(announcementsRolling);
  const dealIndex = buildPerSymbolDealIndex(dealsRolling);

  // SWS V3 universe percentile bands — feeds the inline computeV3Score
  // path in v3SignalAdapter for events not in any picks-latest section.
  // Tests inject `opts.v3UniverseStats`; null is fine (momentum imputed).
  const v3UniverseStats =
    opts.v3UniverseStats !== undefined ? opts.v3UniverseStats : loadV3UniverseStats();

  return {
    fundamentalsHistory,
    picksMap,
    upcomingMap,
    announcementIndex,
    dealIndex,
    announcementsRolling,
    dealsRolling,
    readSwsDeep,
    v3UniverseStats,
    // Sector momentum is computed lazily — see ensureSectorMomentum below
    // — and cached on the context. We don't want to scan all 5,400 SWS
    // deep files unless a caller actually needs it.
    _sectorMomentumMap: opts.sectorMomentumMap ?? null,
  };
}

/**
 * Sector momentum = simple average of 1M returns across all SWS deep
 * stocks in that sector. Computed once on first request, cached on
 * the context.
 *
 * This intentionally pulls from the FULL 5,400-stock SWS deep set —
 * not just the symbols on the upcoming calendar — so micro-cap-heavy
 * sectors don't get pulled around by 1-2 outliers from the calendar.
 *
 * Returns Map<sector, { avg_1m_pct: number, sample_size: number }>.
 */
export function ensureSectorMomentum(ctx) {
  if (ctx._sectorMomentumMap) return ctx._sectorMomentumMap;
  // Delegated to swsDal. In Phase 1 this is still an O(5,517) deep-file scan
  // behind the DAL — same cost, just a different file path. Phase 4 swaps
  // the backend for a single `SELECT sector, avg(returns_1m_pct) ... GROUP
  // BY sector` query, dropping this from seconds to milliseconds. The DAL
  // already applies the n<3 minimum-sample filter that lived here.
  const { map, scanned } = dal.getSectorMomentum();
  ctx._sectorMomentumMap = map;
  ctx._sectorMomentumScannedFiles = scanned;
  return map;
}

// ────────── Per-event aggregation ──────────

/**
 * Compute YoY EPS / revenue growth from the most recent quarter vs the
 * same quarter one year prior.
 *
 * Returns null if either side is missing — fundamentalsHistory has many
 * symbols where dilutedEPS is null even though the row exists.
 */
function computeYoYTrajectory(quarters) {
  if (!Array.isArray(quarters) || quarters.length === 0) return null;
  // Sort ascending by endDate so the last item is the most recent.
  const sorted = quarters.slice().sort((a, b) => {
    const ax = a?.endDate || "";
    const bx = b?.endDate || "";
    return ax < bx ? -1 : ax > bx ? 1 : 0;
  });
  const latest = sorted[sorted.length - 1];
  if (!latest || !latest.endDate) return null;

  // Find the quarter ending ~365d before latest. Allow ±45d tolerance
  // because companies sometimes shift a fiscal-quarter end by a few weeks.
  const latestMs = new Date(latest.endDate + "T00:00:00Z").getTime();
  if (!Number.isFinite(latestMs)) return null;
  let yoyMatch = null;
  let bestDelta = Infinity;
  for (const q of sorted) {
    if (q === latest) continue;
    const ms = new Date(q.endDate + "T00:00:00Z").getTime();
    if (!Number.isFinite(ms)) continue;
    const delta = Math.abs(latestMs - ms - 365 * 86400 * 1000);
    if (delta < bestDelta && delta <= 45 * 86400 * 1000) {
      yoyMatch = q;
      bestDelta = delta;
    }
  }
  if (!yoyMatch) return { latest_end: latest.endDate, eps_yoy_pct: null, revenue_yoy_pct: null };

  const epsYoY =
    latest.dilutedEPS != null && yoyMatch.dilutedEPS != null && yoyMatch.dilutedEPS !== 0
      ? ((latest.dilutedEPS - yoyMatch.dilutedEPS) / Math.abs(yoyMatch.dilutedEPS)) * 100
      : null;
  const revYoY =
    latest.totalRevenue != null && yoyMatch.totalRevenue != null && yoyMatch.totalRevenue !== 0
      ? ((latest.totalRevenue - yoyMatch.totalRevenue) / Math.abs(yoyMatch.totalRevenue)) * 100
      : null;

  return {
    latest_end: latest.endDate,
    yoy_compare_end: yoyMatch.endDate,
    eps_yoy_pct: pct(epsYoY),
    revenue_yoy_pct: pct(revYoY),
    quarters_count: sorted.length,
  };
}

/**
 * Pre-runup signal = stock 1M return vs sector average.
 *
 *   "spike"   — stock is up >10% AND outpacing sector by >8%pts
 *   "smooth"  — outpacing sector by 3-8%pts (informed-flow shape)
 *   "lagging" — underperforming sector by >5%pts (room to surprise)
 *   "neutral" — within ±3%pts of sector
 *
 * The 30d window is the most relevant for pre-result positioning;
 * 3M / 6M baselines are reported separately for context but not used
 * to bucket the signal.
 */
function classifyRunup(stockRet1m, sectorAvg1m) {
  if (stockRet1m == null) return "neutral";
  if (sectorAvg1m == null) {
    if (stockRet1m > 12) return "spike";
    if (stockRet1m < -8) return "lagging";
    return "neutral";
  }
  const delta = stockRet1m - sectorAvg1m;
  if (delta > 8 && stockRet1m > 10) return "spike";
  if (delta > 3) return "smooth";
  if (delta < -5) return "lagging";
  return "neutral";
}

/**
 * Decide HIGH / MEDIUM / LOW based on input completeness.
 *
 * The bar reflects what the predictor can DO with the data:
 *   HIGH   — full SWS reasoning blob present (counter_thesis,
 *            falsification, audit_trail) AND we have either a quarterly
 *            trajectory or returns. Predictor can score with real
 *            confidence; price band can be grounded.
 *   MEDIUM — SWS deep + sector + returns (but no upcoming_earnings row).
 *            Predictor can still score on momentum + snowflake +
 *            sector flow, just without the earnings-specific reasoning.
 *   LOW    — missing SWS deep or sector. Predictor returns
 *            INSUFFICIENT_DATA.
 *
 * The thresholds are encoded in code (not config) so a reviewer can
 * audit them without indirection.
 */
function classifyDataQuality({
  hasSwsDeep,
  quartersWithEps,
  hasReturns,
  hasSector,
  inPicksUniverse,
  inUpcomingEarnings,
}) {
  if (
    inUpcomingEarnings &&
    hasSwsDeep &&
    hasSector &&
    (quartersWithEps >= 2 || hasReturns)
  ) {
    return "HIGH";
  }
  if (hasSwsDeep && hasSector && hasReturns) {
    return "MEDIUM";
  }
  return "LOW";
}

/**
 * Aggregate signals for one calendar event.
 *
 * @param {EarningsCalendarRow} event   - from earningsCalendarBuilder.
 * @param {AggregatorContext}    ctx    - from buildAggregatorContext.
 * @param {object}              [opts]
 * @param {boolean}             [opts.includeSectorMomentum=true] - skip the
 *                                       full-universe sector scan in tests.
 *
 * @returns {EarningsCalendarRow & { signals: SignalsBlock }}
 */
export function aggregateSignalsForEvent(event, ctx, opts = {}) {
  if (!event || !event.symbol) return event;
  const includeSectorMomentum = opts.includeSectorMomentum !== false;

  const symbol = event.symbol.toUpperCase();
  const swsDeep = ctx.readSwsDeep(symbol);

  // ── Stock-level returns + snowflake from SWS deep ──
  const overview = swsDeep?.overview || {};
  const r = overview.returns_pct || {};
  const returns = {
    ret_1m_pct: pct(num(r["1M"])),
    ret_3m_pct: pct(num(r["3M"])),
    ret_6m_pct: pct(num(r["6M"])),
    ret_1y_pct: pct(num(r["1Y"])),
  };
  const hasReturns = returns.ret_1y_pct != null || returns.ret_1m_pct != null;
  const sector = swsDeep?.sector || null;

  // ── Sector momentum ──
  // If the context has an injected map (test fixture), use it
  // unconditionally. Otherwise the includeSectorMomentum flag gates
  // the (relatively expensive) disk scan.
  let sectorMom = null;
  if (sector) {
    if (ctx._sectorMomentumMap) {
      sectorMom = ctx._sectorMomentumMap.get(sector) || null;
    } else if (includeSectorMomentum) {
      const map = ensureSectorMomentum(ctx);
      sectorMom = map.get(sector) || null;
    }
  }
  const preRunup = classifyRunup(returns.ret_1m_pct, sectorMom?.avg_1m_pct ?? null);

  // ── Trajectory from fundamentalsHistory ──
  const yahooSym = nsSymbol(symbol);
  const histEntry = ctx.fundamentalsHistory?.stocks?.[yahooSym] || null;
  const quarters = Array.isArray(histEntry?.quarterly) ? histEntry.quarterly : [];
  const trajectory = computeYoYTrajectory(quarters);
  const quartersWithEps = quarters.filter((q) => q && q.dilutedEPS != null).length;

  // ── Picks universe enrichment (optional) ──
  const inPicksUniverse = ctx.picksMap.has(symbol);
  const pickRow = ctx.picksMap.get(symbol) || null;
  const upcomingRow = ctx.upcomingMap.get(symbol) || null;
  const inUpcomingEarnings = !!upcomingRow;

  // ── SWS V3 100-pt breakdown ──
  // The predictor scores on the decomposed V3 pillars (future, past,
  // valuation, overlay) rather than echoing the blunt composite verdict
  // — that echo is what made 73% of predictions cluster on INLINE.
  // Resolution: upcoming_earnings row → any picks row → inline compute
  // off the SWS deep file (see v3SignalAdapter.js).
  const v3Signal = extractV3SignalsForEvent({
    swsDeep,
    pickRow,
    upcomingRow,
    universe: ctx.v3UniverseStats,
  });

  // ── Milestone D: NSE corporate-activity signals ──
  // Announcements within last 30 days (rolling window), already
  // pre-classified by nseAnnouncementsIngester. We summarise the
  // most-material 3 for the predictor and keep up to 10 for the UI
  // detail modal.
  const announcementsAll = ctx.announcementIndex?.get(symbol) || [];
  const announcementsTop3 = announcementsAll.slice(0, 3);
  const announcementsForUi = announcementsAll.slice(0, 10);
  const annMaterialityScore = announcementsTop3.reduce(
    (acc, a) => acc + (num(a.materiality_score) || 0),
    0,
  );
  const annClassifications = Array.from(
    new Set(announcementsAll.map((a) => a.classification).filter(Boolean)),
  );

  // Bulk/block deal flow within last 7 days. Net notional sign is
  // the V1 signal — positive = institutional accumulation, negative
  // = distribution. Magnitude is informational; the predictor
  // discretises it into bands so a single billion-rupee deal doesn't
  // dominate the score.
  const dealSummary = ctx.dealIndex?.get(symbol) || null;
  const data_quality = classifyDataQuality({
    hasSwsDeep: !!swsDeep,
    quartersWithEps,
    hasReturns,
    hasSector: !!sector,
    inPicksUniverse,
    inUpcomingEarnings,
  });

  // ── Compose signals block ──
  const signals = {
    data_quality,
    data_quality_inputs: {
      sws_deep: !!swsDeep,
      quarters_with_eps: quartersWithEps,
      total_quarters: quarters.length,
      has_returns: hasReturns,
      has_sector: !!sector,
      in_picks_universe: inPicksUniverse,
    },
    sector,
    market_cap_inr: num(overview.market_cap_inr),
    market_cap_band: overview.market_cap_band || null,
    snowflake_total: num(overview.snowflake_total),
    multiples: {
      pe: pct(num(overview.multiples?.pe)),
      pb: pct(num(overview.multiples?.pb)),
      ps: pct(num(overview.multiples?.ps)),
      ev_ebitda: pct(num(overview.multiples?.ev_ebitda)),
    },
    upside_pct: pct(num(overview.upside_pct)),
    momentum: {
      ...returns,
      sector_avg_1m_pct: sectorMom?.avg_1m_pct ?? null,
      sector_sample_size: sectorMom?.sample_size ?? null,
      pre_runup_signal: preRunup,
      runup_vs_sector_pct:
        returns.ret_1m_pct != null && sectorMom?.avg_1m_pct != null
          ? pct(returns.ret_1m_pct - sectorMom.avg_1m_pct)
          : null,
    },
    trajectory: trajectory || {
      latest_end: null,
      eps_yoy_pct: null,
      revenue_yoy_pct: null,
      quarters_count: quarters.length,
    },
    picks_universe: pickRow
      ? {
          v3_score_100: num(pickRow.v3_score_100),
          v3_verdict: pickRow.v3_verdict || null,
          composite_verdict: pickRow.composite_verdict || null,
          // Convey the broad section the picks pipeline filed this stock
          // under (audit_trail.categories_assigned). Useful in the UI as
          // an "already classified as: deep_value, quality_growth" pill.
          categories: Array.isArray(pickRow.audit_trail?.categories_assigned)
            ? pickRow.audit_trail.categories_assigned
            : [],
        }
      : null,
    // SWS V3 100-pt breakdown — the predictor's strongest signal post-v2.
    // `source` records how it was resolved (upcoming | picks | computed)
    // so the UI's audit-trail expander can show provenance.
    v3: v3Signal
      ? {
          v3_score_100: v3Signal.v3_score_100,
          v3_verdict: v3Signal.v3_verdict,
          source: v3Signal.source,
          breakdown: v3Signal.v3_breakdown,
        }
      : null,
    // ── Milestone D fields ──
    announcements: {
      count_30d: announcementsAll.length,
      top_classifications: annClassifications.slice(0, 5),
      materiality_score_top3: annMaterialityScore,
      top3: announcementsTop3.map((a) => ({
        announced_at_iso: a.announced_at_iso,
        classification: a.classification,
        materiality_score: a.materiality_score,
        subject: a.subject ? a.subject.slice(0, 200) : null,
      })),
      // Larger list reserved for the detail modal — kept compact.
      recent_for_ui: announcementsForUi.map((a) => ({
        announced_at_iso: a.announced_at_iso,
        classification: a.classification,
        materiality_score: a.materiality_score,
        subject: a.subject ? a.subject.slice(0, 240) : null,
        pdf_url: a.pdf_url,
      })),
    },
    deals_7d: dealSummary
      ? {
          net_buys: dealSummary.net_buys,
          net_sells: dealSummary.net_sells,
          net_qty: dealSummary.net_qty,
          net_notional_inr: dealSummary.net_notional_inr,
          bulk_count: dealSummary.bulk_count,
          block_count: dealSummary.block_count,
          last_deal_date_iso: dealSummary.last_deal_date_iso,
          // Cap the deal-list shipped to UI at 5 — modal can lazy-load
          // the rest.
          recent_for_ui: dealSummary.deals.slice(0, 5),
        }
      : null,
    // When the SWS picks pipeline has placed this stock in its own
    // `upcoming_earnings` section, forward the full reasoning blob.
    // The predictor (Milestone C) leans on this when present and falls
    // back to scoring from raw signals when not.
    sws_upcoming_earnings: upcomingRow
      ? {
          v3_verdict: upcomingRow.v3_verdict || null,
          composite_verdict: upcomingRow.composite_verdict || null,
          v3_score_100: num(upcomingRow.v3_score_100),
          snowflake_total: num(upcomingRow.snowflake_total),
          fair_value_inr: num(upcomingRow.fair_value_inr),
          current_price_inr: num(upcomingRow.current_price_inr),
          upside_pct: pct(num(upcomingRow.upside_pct)),
          one_line: upcomingRow.one_line || null,
          data_completeness_pct: num(upcomingRow.data_completeness_pct),
          // counter_thesis ↦ V1 falsification triggers + opposing signal.
          // Mirrors the schema we'll mirror in earningsPredictor's output.
          counter_thesis: upcomingRow.counter_thesis || null,
          last_quarter_result: upcomingRow.last_quarter_result || null,
          recent_analyst_revisions: Array.isArray(upcomingRow.recent_analyst_revisions)
            ? upcomingRow.recent_analyst_revisions
            : [],
          // Forward the audit trail so the UI's "How this prediction was
          // built" expander has source-of-truth provenance — we reuse
          // SWS's audit_trail rather than reinvent it for V1.
          sws_audit_trail: upcomingRow.audit_trail || null,
        }
      : null,
  };

  return { ...event, signals };
}

/**
 * Aggregate signals for an entire calendar (the events array from
 * earnings-watch-latest.json). Returns a new array — never mutates.
 */
export function aggregateSignalsForCalendar(events, ctx, opts = {}) {
  if (!Array.isArray(events)) return [];
  // Trigger sector-momentum scan once, up front, so all events share
  // the same Map and we don't pay the disk-walk on every call.
  if (opts.includeSectorMomentum !== false) ensureSectorMomentum(ctx);
  return events.map((e) => aggregateSignalsForEvent(e, ctx, opts));
}

/**
 * Roll up signals into a stats sidecar — counts of each data_quality
 * tier, sector breakdown, etc. Tab header chips read this.
 */
export function summariseSignals(eventsWithSignals) {
  const tiers = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const sectors = new Map();
  const runup = { spike: 0, smooth: 0, lagging: 0, neutral: 0 };
  for (const e of eventsWithSignals || []) {
    const s = e.signals;
    if (!s) continue;
    if (tiers[s.data_quality] != null) tiers[s.data_quality] += 1;
    if (s.sector) sectors.set(s.sector, (sectors.get(s.sector) || 0) + 1);
    const r = s.momentum?.pre_runup_signal;
    if (runup[r] != null) runup[r] += 1;
  }
  return {
    by_data_quality: tiers,
    by_pre_runup: runup,
    sector_count: sectors.size,
    top_sectors: Array.from(sectors.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sector, count]) => ({ sector, count })),
  };
}
