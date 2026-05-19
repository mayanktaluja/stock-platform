// Catalyst composite — joins three existing rolling JSON feeds into a
// single Pillar 2 trade-recommendation list:
//   1. data/catalysts/earnings-watch-latest.json    (BEAT predictions)
//   2. data/catalysts/dividends-upcoming.json       (dividend capture)
//   3. data/catalysts/nse-bulk-block-rolling.json   (smart-money mirror)
//
// Pure function — caller loads the three files and supplies them as
// inputs. Returns { earnings_beat[], dividend_capture[], block_deal[] }
// each capped at the Pillar-2 max-positions count from the strategy
// plan. Per the V3≥50 LLM-floor memory, earnings BEAT only fires when
// v3_score_100 ≥ 50.

const EARNINGS_MIN_CONFIDENCE_PCT = 60;
const EARNINGS_MIN_V3_SCORE = 50;
const DIVIDEND_MIN_YIELD_ON_COST_PCT = 4;
const DIVIDEND_MAX_DAYS_UNTIL_HOLDBY = 7;
const DIVIDEND_MIN_V3_SCORE = 40;
const BLOCK_MIN_DEAL_INR = 50e7; // ₹50 Cr
const BLOCK_MAX_MARKET_CAP_INR = 3000e7; // ₹3000 Cr
const BLOCK_MIN_V3_SCORE = 50;

const PILLAR2_MAX_TOTAL = 5;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function daysBetweenIso(aIso, bIso) {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b - a) / 86_400_000);
}

function filterEarningsBeat(earningsWatch, today_iso) {
  const events = earningsWatch?.events;
  if (!Array.isArray(events)) return [];
  return events
    .filter((e) => {
      const p = e?.prediction;
      const s = e?.signals;
      if (!p || p.verdict !== "BEAT") return false;
      if (!isFiniteNumber(p.confidence_pct) || p.confidence_pct < EARNINGS_MIN_CONFIDENCE_PCT) return false;
      const v3 = s?.v3?.v3_score_100;
      if (!isFiniteNumber(v3) || v3 < EARNINGS_MIN_V3_SCORE) return false;
      const days = daysBetweenIso(today_iso, e.event_iso_date);
      if (days === null || days < 0 || days > 7) return false;
      return true;
    })
    .map((e) => ({
      type: "earnings_beat",
      symbol: e.symbol,
      event_iso_date: e.event_iso_date,
      confidence_pct: e.prediction.confidence_pct,
      v3_score_100: e.signals?.v3?.v3_score_100 ?? null,
      sector: e.signals?.sector || null,
      reasons_top: e.prediction.reasons_top || [],
    }))
    .sort((a, b) => b.confidence_pct - a.confidence_pct);
}

function filterDividendCapture(dividendsFeed, holdingsByTicker, today_iso) {
  const dividends = dividendsFeed?.dividends;
  if (!Array.isArray(dividends)) return [];
  return dividends
    .map((d) => {
      const ticker = d.symbol;
      const h = holdingsByTicker[ticker];
      const yieldOnCost = h ? (d.dps / (h.avg_price_inr || 1)) * 100 : null;
      const exDate = new Date(d.ex_date);
      const holdByIso = isNaN(exDate.getTime())
        ? null
        : new Date(exDate.getTime() - 86_400_000).toISOString().slice(0, 10);
      const days = holdByIso ? daysBetweenIso(today_iso, holdByIso) : null;
      return { ticker, dps: d.dps, ex_date: d.ex_date, hold_by_iso: holdByIso, days_until_hold_by: days, yield_on_cost_pct: yieldOnCost };
    })
    .filter((r) =>
      isFiniteNumber(r.yield_on_cost_pct) &&
      r.yield_on_cost_pct >= DIVIDEND_MIN_YIELD_ON_COST_PCT &&
      isFiniteNumber(r.days_until_hold_by) &&
      r.days_until_hold_by >= 0 &&
      r.days_until_hold_by <= DIVIDEND_MAX_DAYS_UNTIL_HOLDBY
    )
    .map((r) => ({ ...r, type: "dividend_capture" }))
    .sort((a, b) => b.yield_on_cost_pct - a.yield_on_cost_pct);
}

function filterBlockDeals(deals, today_iso) {
  if (!Array.isArray(deals)) return [];
  return deals
    .filter((d) => {
      if (!d || d.side !== "BUY") return false;
      if (!isFiniteNumber(d.deal_value_inr) || d.deal_value_inr < BLOCK_MIN_DEAL_INR) return false;
      if (isFiniteNumber(d.market_cap_inr) && d.market_cap_inr > BLOCK_MAX_MARKET_CAP_INR) return false;
      if (isFiniteNumber(d.v3_score_100) && d.v3_score_100 < BLOCK_MIN_V3_SCORE) return false;
      const days = daysBetweenIso(d.deal_date_iso, today_iso);
      if (days === null || days < 0 || days > 7) return false;
      return true;
    })
    .map((d) => ({
      type: "block_deal",
      symbol: d.symbol,
      deal_value_inr: d.deal_value_inr,
      deal_date_iso: d.deal_date_iso,
      counterparty: d.counterparty || null,
      market_cap_inr: d.market_cap_inr || null,
    }))
    .sort((a, b) => b.deal_value_inr - a.deal_value_inr);
}

export function buildCatalystSlate({
  earnings_watch,
  dividends_upcoming,
  bulk_block,
  current_holdings = {},
  today_iso,
} = {}) {
  const today = today_iso || new Date().toISOString().slice(0, 10);
  const earnings_beat = filterEarningsBeat(earnings_watch, today);
  const dividend_capture = filterDividendCapture(dividends_upcoming, current_holdings, today);
  const deals = Array.isArray(bulk_block?.deals)
    ? bulk_block.deals
    : Array.isArray(bulk_block?.bulk_deals)
      ? bulk_block.bulk_deals
      : [];
  const block_deal = filterBlockDeals(deals, today);

  // Round-robin pick across copies of the three streams up to PILLAR2_MAX_TOTAL.
  // (Originals are returned to callers unchanged for full-list rendering.)
  const queues = [[...earnings_beat], [...dividend_capture], [...block_deal]];
  const slate = [];
  let idx = 0;
  let safety = 0;
  while (slate.length < PILLAR2_MAX_TOTAL && safety < 100) {
    const stream = queues[idx % 3];
    const next = stream.shift();
    if (next) slate.push(next);
    idx += 1;
    safety += 1;
    if (queues.every((s) => s.length === 0)) break;
  }

  return { schema_version: "catalyst-composite-v1", today_iso: today, slate, earnings_beat, dividend_capture, block_deal };
}

export const CATALYST_COMPOSITE_CONFIG = Object.freeze({
  EARNINGS_MIN_CONFIDENCE_PCT,
  EARNINGS_MIN_V3_SCORE,
  DIVIDEND_MIN_YIELD_ON_COST_PCT,
  DIVIDEND_MAX_DAYS_UNTIL_HOLDBY,
  DIVIDEND_MIN_V3_SCORE,
  BLOCK_MIN_DEAL_INR,
  BLOCK_MAX_MARKET_CAP_INR,
  BLOCK_MIN_V3_SCORE,
  PILLAR2_MAX_TOTAL,
});
