// Composite score + verdict + category logic for SWS-scraped per-stock JSONs.
// Pure-JS, deterministic, runs after Layer 1 scrape completes.
// Inputs: per-stock JSON written by sws-parse-capture.mjs.
// Outputs: { composite_score_100, verdict, categories[] } added to each stock,
//          and a leaderboard JSON written to data/sws/picks-latest.json.

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./sws-config.mjs";

// Surveillance lookup is optional — gracefully degrades if module not available.
// Loaded once at module init; the underlying snapshot is cached in surveillance.js.
let _getSurveillanceFlag = () => null;
try {
  const mod = await import("../surveillance.js");
  if (typeof mod.getSurveillanceFlag === "function") _getSurveillanceFlag = mod.getSurveillanceFlag;
} catch {}

// ---------- Composite score (0-100) ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export function computeCompositeScore(stock) {
  const ov = stock.overview || {};
  const snowTotal = num(ov.snowflake_total, 0); // 0-30
  const upside = num(ov.upside_pct, 0); // can be negative if overvalued
  const risks = (ov.risks || []).length;
  const netMargin = num(ov.net_margin_pct, 0);
  const ret5y = num((ov.returns_pct || {})["5Y"], 0);
  const fwdGrowth = num(ov.forward_earnings_growth_pct, null);
  // Forward growth is in rewards as "Earnings are forecast to grow X% per year" — extract here as fallback
  const fwdGrowthFromReward = (() => {
    if (fwdGrowth != null) return fwdGrowth;
    for (const r of (ov.rewards || [])) {
      const m = String(r).match(/forecast to grow ([\d.]+)\s*%\s*per year/i);
      if (m) return Number(m[1]);
    }
    return 0;
  })();
  const divYield = num(ov.dividend && ov.dividend.yield_pct, 0);
  const divPayout = num(ov.dividend && ov.dividend.payout_pct, 100);
  const divSnow = num((ov.snowflake || {}).dividends, 0);
  const insiderBuys = (ov.insider_activity || []).filter((x) => x.direction === "buy").length;

  // ---- Component points ----
  const pts_snowflake = (snowTotal / 30) * 35; // up to 35
  const pts_upside = clamp(upside, 0, 50) / 50 * 20; // up to 20
  const pts_risks = -clamp(risks, 0, 5) * 3; // -15 to 0
  const pts_margin = clamp(netMargin, 0, 30) / 30 * 10; // up to 10
  const pts_ret5y = clamp(ret5y, 0, 200) / 200 * 10; // up to 10
  const pts_growth = clamp(fwdGrowthFromReward, 0, 25) / 25 * 15; // up to 15
  const pts_dividend = (divSnow >= 5 && divPayout < 70 && divYield >= 1.5) ? 5 : 0;
  const pts_insider = insiderBuys >= 1 ? 5 : 0;

  const total = pts_snowflake + pts_upside + pts_risks + pts_margin + pts_ret5y + pts_growth + pts_dividend + pts_insider;
  const composite_score_100 = clamp(Math.round(total * 10) / 10, 0, 100);

  return {
    composite_score_100,
    breakdown: {
      pts_snowflake: Math.round(pts_snowflake * 10) / 10,
      pts_upside: Math.round(pts_upside * 10) / 10,
      pts_risks: Math.round(pts_risks * 10) / 10,
      pts_margin: Math.round(pts_margin * 10) / 10,
      pts_ret5y: Math.round(pts_ret5y * 10) / 10,
      pts_growth: Math.round(pts_growth * 10) / 10,
      pts_dividend,
      pts_insider,
    },
    forward_growth_used_pct: fwdGrowthFromReward,
  };
}

// ---------- Verdict tier (matches /fundamentals.js convention) ----------

export function verdictFromScore(score) {
  if (score >= 72) return "DEEP_VALUE";
  if (score >= 62) return "QUALITY_GROWTH";
  if (score >= 48) return "FAIR_VALUE";
  if (score >= 40) return "FULLY_VALUED";
  return "OVERVALUED";
}

// ---------- v2 score: multi-factor with risk overlay ----------
//
// v1 `composite_score_100` is a fundamentals-only roll-up. v2 sits on top of
// it and adds two things v1 doesn't see:
//   1) Regulatory risk (NSE ASM/GSM surveillance flag) — major red flag the
//      reader must see in the score, not buried in a sub-tab.
//   2) Catalyst bonus (imminent-earnings beat setup, recent insider buying).
//
// The breakdown is preserved on each card so the modal can show the reader
// exactly which components moved the score.
//
// Score band: same v1 verdict thresholds apply to v2 for backward compat.

export function computeV2Score(stock, opts = {}) {
  const v1 = num(stock.composite_score_100, 0);
  const ov = stock.overview || {};
  const surveillance = opts.surveillanceFlag ?? _getSurveillanceFlag(stock.ticker);

  // Catalyst bonus (max +5)
  let pts_catalyst = 0;
  const next = ov.next_earnings_date;
  if (next) {
    const days = Math.ceil((new Date(next + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 30 && ov.last_quarter_result === "beat") pts_catalyst += 3;
  }
  const insiderBuys = (ov.insider_activity || []).filter((x) => x.direction === "buy").length;
  if (insiderBuys >= 1) pts_catalyst += 2;
  const recentUpgrade = (ov.recent_analyst_revisions || []).some((r) => r.direction === "increased");
  if (recentUpgrade) pts_catalyst += 2;
  pts_catalyst = clamp(pts_catalyst, 0, 5);

  // Risk overlay (capped at -15, can be 0)
  let pts_risk_overlay = 0;
  if (surveillance) {
    if (surveillance.list === "GSM") pts_risk_overlay -= 10;
    else if (surveillance.list === "ASM") {
      pts_risk_overlay -= surveillance.timeframe === "shortterm" ? 8 : 5;
    }
  }
  const beta = num(ov.beta, null);
  if (beta != null && beta > 1.5) pts_risk_overlay -= 3;
  const risks = (ov.risks || []).length;
  if (risks >= 4) pts_risk_overlay -= 3;
  pts_risk_overlay = clamp(pts_risk_overlay, -15, 0);

  const v2_score_100 = clamp(Math.round((v1 + pts_catalyst + pts_risk_overlay) * 10) / 10, 0, 100);

  return {
    v2_score_100,
    v2_breakdown: {
      v1_fundamentals: Math.round(v1 * 10) / 10,
      pts_catalyst,
      pts_risk_overlay,
      surveillance: surveillance ? { list: surveillance.list, timeframe: surveillance.timeframe } : null,
      beta_flag: beta != null && beta > 1.5,
      risks_flag: risks >= 4,
    },
  };
}

// ---------- Category filters ----------

export function categoriseStock(stock) {
  const ov = stock.overview || {};
  const score = stock.composite_score_100 || 0;
  const verdict = stock.verdict;
  const snowTotal = num(ov.snowflake_total, 0);
  const upside = num(ov.upside_pct, 0);
  const ret1y = num((ov.returns_pct || {})["1Y"], -100);
  const ret5y = num((ov.returns_pct || {})["5Y"], 0);
  const epsGrowth5y = (() => {
    for (const r of (ov.rewards || [])) {
      const m = String(r).match(/grown? ([\d.]+)\s*%\s*per year over the past 5 years/i);
      if (m) return Number(m[1]);
    }
    return null;
  })();
  const fwdGrowth = num(stock.forward_growth_used_pct, 0);
  const risks = (ov.risks || []).length;
  const divYield = num(ov.dividend && ov.dividend.yield_pct, 0);
  const divPayout = num(ov.dividend && ov.dividend.payout_pct, 100);
  const divSnow = num((ov.snowflake || {}).dividends, 0);
  const valSnow = num((ov.snowflake || {}).valuation, 0);
  const healthSnow = num((ov.snowflake || {}).financial_health, 0);
  const mcap = num(ov.market_cap_inr, 0);
  const insiderBuys = (ov.insider_activity || []).filter((x) => x.direction === "buy").length;
  const nextEarnings = ov.next_earnings_date;

  const cats = [];

  // Note: "Best Stocks to Buy Now" is computed in a second pass globally (top 25 by score)
  if (verdict === "DEEP_VALUE" && valSnow >= 4 && upside >= 20) cats.push("deep_value");
  if (["DEEP_VALUE", "QUALITY_GROWTH"].includes(verdict) && healthSnow >= 5 && (epsGrowth5y == null ? ret5y > 0 : epsGrowth5y > 0)) {
    cats.push("quality_growth");
  }
  if (ret1y > 0 && upside >= 15 && risks === 0 && fwdGrowth >= 8) cats.push("midterm");
  if (divSnow >= 5 && divPayout < 70 && divYield >= 1.5) cats.push("dividend_aristocrats");
  if (mcap > 0 && mcap < 5e11 && snowTotal >= 22 && upside >= 15) cats.push("smallcap_gems");
  if (insiderBuys >= 1) cats.push("insider_buying");
  if (nextEarnings) {
    const days = Math.ceil((new Date(nextEarnings + "T00:00:00Z") - new Date()) / 86400000);
    if (days >= 0 && days <= 30) cats.push("upcoming_earnings");
  }
  if (snowTotal < 12 && risks >= 3) cats.push("avoid");

  return cats;
}

// ---------- Top-level: score one stock ----------

export function scoreStock(stock) {
  const sc = computeCompositeScore(stock);
  stock.composite_score_100 = sc.composite_score_100;
  stock.score_breakdown = sc.breakdown;
  stock.forward_growth_used_pct = sc.forward_growth_used_pct;
  stock.verdict = verdictFromScore(sc.composite_score_100);
  stock.categories = categoriseStock(stock);
  // v2 layered on top — needs v1 score in place first.
  const v2 = computeV2Score(stock);
  stock.v2_score_100 = v2.v2_score_100;
  stock.v2_breakdown = v2.v2_breakdown;
  return stock;
}

// ---------- Build leaderboard for picks-latest.json ----------

function shortReason(stock) {
  const ov = stock.overview || {};
  const bits = [];
  const pe = ov.multiples && ov.multiples.pe;
  if (pe != null) bits.push(`P/E ${pe.toFixed(1)}x`);
  if (ov.upside_pct != null) bits.push(`${ov.upside_pct > 0 ? "+" : ""}${ov.upside_pct.toFixed(1)}% to fair value`);
  const dY = ov.dividend && ov.dividend.yield_pct;
  if (dY != null && dY >= 1.5) bits.push(`${dY.toFixed(1)}% div`);
  const sn = ov.snowflake_total;
  if (sn != null) bits.push(`snow ${sn}/30`);
  return bits.slice(0, 4).join(" · ");
}

function pickCardFields(stock) {
  const ov = stock.overview || {};
  return {
    ticker: stock.ticker,
    name: stock.name || stock.ticker,
    sector: stock.sector || null,
    sws_url: stock.sws_url || null,
    score: stock.composite_score_100,
    v2_score: stock.v2_score_100,
    v2_breakdown: stock.v2_breakdown,
    verdict: stock.verdict,
    snowflake_total: ov.snowflake_total,
    snowflake: ov.snowflake,
    current_price_inr: ov.current_price_inr,
    fair_value_inr: ov.fair_value_inr,
    upside_pct: ov.upside_pct,
    market_cap_inr: ov.market_cap_inr,
    next_earnings_date: ov.next_earnings_date,
    last_quarter_result: ov.last_quarter_result,
    one_line: shortReason(stock),
    data_freshness_at: stock.parsed_at || null,
  };
}

export function buildLeaderboard(scoredStocks) {
  // Sort once, descending by v1 score (legacy compatibility for existing categories)
  const ordered = [...scoredStocks].sort((a, b) => (b.composite_score_100 || 0) - (a.composite_score_100 || 0));

  // Best to Buy Now = top 25 with no major risks and snow ≥ 18
  const bestToBuy = ordered
    .filter((s) => (s.overview?.risks?.length ?? 0) === 0 && (s.overview?.snowflake_total ?? 0) >= 18)
    .slice(0, 25)
    .map(pickCardFields);

  const cat = (key) => ordered.filter((s) => (s.categories || []).includes(key)).map(pickCardFields);

  // Upcoming earnings — sort by date ascending, not by score
  const upcoming = ordered
    .filter((s) => (s.categories || []).includes("upcoming_earnings"))
    .sort((a, b) => (a.overview?.next_earnings_date || "9999").localeCompare(b.overview?.next_earnings_date || "9999"))
    .map((s) => {
      const c = pickCardFields(s);
      const d = s.overview?.next_earnings_date;
      c.days_until = d ? Math.ceil((new Date(d + "T00:00:00Z") - new Date()) / 86400000) : null;
      c.recent_analyst_revisions = s.overview?.recent_analyst_revisions || [];
      return c;
    });

  // top_ranked_30: ranked desc by v2_score_100 across the WHOLE universe.
  // Hygiene filters: market cap >= ₹500cr (skip illiquid micro-caps that
  // need a different analysis frame), exclude GSM (heavy regulatory red
  // flag — score deduction is not enough; just filter them out).
  const MIN_MCAP_INR = 5_000_000_000; // ₹500cr
  const orderedV2 = [...scoredStocks].sort((a, b) => (b.v2_score_100 || 0) - (a.v2_score_100 || 0));
  const top30 = orderedV2
    .filter((s) => {
      const mcap = num(s.overview?.market_cap_inr, 0);
      if (mcap < MIN_MCAP_INR) return false;
      const surv = s.v2_breakdown?.surveillance;
      if (surv && surv.list === "GSM") return false;
      return true;
    })
    .slice(0, 30)
    .map(pickCardFields);

  return {
    top_ranked_30: top30,
    best_to_buy_now: bestToBuy,
    deep_value: cat("deep_value"),
    quality_growth: cat("quality_growth"),
    midterm: cat("midterm"),
    dividend_aristocrats: cat("dividend_aristocrats"),
    smallcap_gems: cat("smallcap_gems"),
    insider_buying: cat("insider_buying"),
    upcoming_earnings: upcoming,
    avoid: cat("avoid"),
  };
}

// ---------- Top-level: read all per-stock files, score, write picks-latest.json ----------

export function runFullScoring() {
  const files = fs.readdirSync(PATHS.deepDir).filter((f) => f.endsWith(".json"));
  const scored = [];
  let failed = 0;
  for (const f of files) {
    try {
      const stock = JSON.parse(fs.readFileSync(path.join(PATHS.deepDir, f), "utf-8"));
      scored.push(scoreStock(stock));
    } catch (e) {
      failed++;
      console.error(`Failed to score ${f}: ${e.message}`);
    }
  }
  const sections = buildLeaderboard(scored);

  // Compute scrape duration estimate from file mtimes if available
  let earliest = null, latest = null;
  for (const f of files) {
    const stat = fs.statSync(path.join(PATHS.deepDir, f));
    if (!earliest || stat.mtime < earliest) earliest = stat.mtime;
    if (!latest || stat.mtime > latest) latest = stat.mtime;
  }
  const durationHours = earliest && latest ? (latest - earliest) / 3600000 : null;

  const out = {
    scanned_at: new Date().toISOString(),
    scrape_duration_hours: durationHours ? Math.round(durationHours * 10) / 10 : null,
    model_split: { scrape: "claude-sonnet-4-6", score: "claude-opus-4-7" },
    universe_size: scored.length + failed,
    scored_count: scored.length,
    failed_count: failed,
    sections,
  };
  fs.writeFileSync(PATHS.picksLatest, JSON.stringify(out, null, 2));
  return out;
}

// CLI: `node scripts/sws-scoring.mjs` → score all + write picks-latest.json
// CLI: `node scripts/sws-scoring.mjs TICKER` → score one stock, print result
if (import.meta.url === `file://${process.argv[1]}`) {
  const ticker = process.argv[2];
  if (ticker) {
    const fp = path.join(PATHS.deepDir, `${ticker}.json`);
    if (!fs.existsSync(fp)) {
      console.error(`No such stock file: ${fp}`);
      process.exit(1);
    }
    const stock = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const scored = scoreStock(stock);
    console.log(JSON.stringify({
      ticker: scored.ticker,
      composite_score_100: scored.composite_score_100,
      verdict: scored.verdict,
      categories: scored.categories,
      breakdown: scored.score_breakdown,
    }, null, 2));
  } else {
    const out = runFullScoring();
    console.log(`Scored ${out.scored_count} stocks (${out.failed_count} failed). Wrote ${PATHS.picksLatest}`);
    console.log(`Sections:`);
    for (const [k, v] of Object.entries(out.sections)) {
      console.log(`  ${k}: ${v.length}`);
    }
  }
}
