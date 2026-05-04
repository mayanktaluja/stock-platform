// SWS-driven portfolio aggregator: Tier A/B/C/D action grid + two-basket
// (Defensive vs Growth + shared Core) + outside-portfolio fresh picks.
//
// Inputs:
//   - scoredHoldings[]: each carries { sws, action, reasons, timing, ... }
//                       from services/swsHoldingEngine.scoreHolding()
//   - opts.freshCapitalInr (optional): for ₹ allocation in Tier B
//   - opts.freshPickLimit (default 8): cap on fresh-pick rows per basket
//
// Output: { tiers: { A, B, C, D }, baskets: { defensive, growth, core },
//           sectorOverlay, snapshot, banner }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { num } from "./swsScoring.js";
import { loadSWSDeep, pickSnowflake, scoreHolding, _reconcileFVUpside } from "./swsHoldingEngine.js";
import { detectSectorWipeout } from "./swsPeerLayer.js";
import {
  ALL_REDUCTION_ACTIONS,
  ALL_TOPUP_ACTIONS,
  parseTrimPct,
} from "./actionLadder.js";
import { bucketByDaysToExit } from "./liquidityTail.js";
import { buildSnapshot as buildDiffSnapshot, diffSnapshots, snapshotByTicker } from "./analyzerDiff.js";
import { applyPostTrimCooldown } from "./postTrimCooldown.js";

// Lazy macro-regime import — only used for basket tilt; failing import
// degrades gracefully (no tilt applied).
let _computeMacroDelta = null;
let _getCurrentRegimeOrNull = null;
try {
  const mod = await import("../macroRegime.js");
  if (typeof mod.computeMacroDelta === "function") _computeMacroDelta = mod.computeMacroDelta;
} catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKS_LATEST = path.resolve(__dirname, "..", "data", "sws", "picks-latest.json");
const DEEP_DIR = path.resolve(__dirname, "..", "data", "sws", "deep");

let _picksCache = null;
function loadPicksLatest() {
  try {
    const stat = fs.statSync(PICKS_LATEST);
    if (_picksCache && _picksCache.mtimeMs === stat.mtimeMs) return _picksCache.data;
    const raw = fs.readFileSync(PICKS_LATEST, "utf-8");
    const data = JSON.parse(raw);
    _picksCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

// Action sets from actionLadder cover both legacy (EXIT / Reduction-50% /
// Reduction-25-33% / Top-up-modest / Top-up / STRONG Top-up) and ladder-v2
// (EXIT-now / EXIT-staged / Reduction-66/50/33/25% / Top-up-25/33/50/100%)
// labels. Aggregator behaviour stays identical for legacy callers; v2 labels
// flow through naturally because parseTrimPct understands every rung.
const REDUCTION_ACTIONS = ALL_REDUCTION_ACTIONS;
const TOPUP_ACTIONS = ALL_TOPUP_ACTIONS;

function _reductionRupees(holding) {
  const cv = num(holding.currentValue, 0);
  // parseTrimPct handles every label in the system: EXIT/EXIT-now → 1.0,
  // EXIT-staged → 0.5 (only the today-half is realised), Reduction-* fixed
  // tiers, plus the legacy Reduction-25-33% → 0.30 mapping kept for
  // backward compat with v1 outputs.
  return cv * parseTrimPct(holding.action);
}

function buildTiers(scoredHoldings) {
  const tierA = []; // Reductions
  const tierC = []; // HOLD
  const tierD = []; // Watch (HOLD with weak signal — borderline)

  let freedRupees = 0;

  for (const h of scoredHoldings) {
    if (!h.swsCovered) {
      tierD.push({ ...h, watchReason: "No SWS data — verify ticker / treat as out-of-universe." });
      continue;
    }
    // Cooldown softeners (action was Reduction-* but the user already
    // trimmed) come through with action="HOLD" + recentlyTrimmedReason.
    // Route them to Tier C so the user sees them as "no further action
    // needed" with a clear badge — not as a fresh HOLD recommendation.
    if (h.recentlyTrimmedReason) {
      tierC.push(h);
      continue;
    }
    if (REDUCTION_ACTIONS.has(h.action)) {
      const freed = _reductionRupees(h);
      freedRupees += freed;
      tierA.push({ ...h, freedRupees: Math.round(freed) });
    } else if (h.action === "HOLD") {
      const v3 = num(h.sws.v3_score, 0);
      const upside = num(h.sws.upside_pct, 0);
      const days = h.sws.next_earnings_date
        ? Math.ceil((new Date(h.sws.next_earnings_date + "T00:00:00Z") - Date.now()) / 86400000)
        : null;
      // PR 7 calibration: original watch rule (v3 < 36 OR upside < 5 OR
      // earnings ≤7d) was so strict that EVERY HOLD on a real personal
      // book landed in Tier D, leaving Tier C empty (real-portfolio
      // diagnostic gap #3). New rule:
      //   • v3 < 25  → genuinely borderline (universe p25 zone)
      //   • upside < -5 (significantly overvalued, not just modest)
      //   • earnings ≤3d (true imminent catalyst, not 7d window)
      // Anything else stays in Tier C.
      const isWatch = v3 < 25 || upside < -5 || (days != null && days >= 0 && days <= 3);
      if (isWatch) {
        tierD.push({
          ...h,
          watchReason: days != null && days >= 0 && days <= 3
            ? `Earnings in ${days}d — re-evaluate post-result.`
            : v3 < 25 ? `Low score (v3 ${v3.toFixed(1)}) — watch for catalyst.`
            : `Notable overvaluation (${upside.toFixed(1)}%) — re-rate next quarter.`,
        });
      } else {
        tierC.push(h);
      }
    }
  }

  return { tierA, tierC, tierD, freedRupees: Math.round(freedRupees) };
}

// PR 7 calibration: the v1 filter required v1-verdict ∈ {QUALITY_GROWTH,
// DEEP_VALUE} which gate at composite ≥ 62. v3-aware filter uses v3_verdict
// (TOP_PICK ≥60, STRONG ≥45) which is the score the action engine
// authoritatively drives off. Real-portfolio symptom: Tier B Growth basket
// was empty despite 30 Top-up candidates because v1 verdict bands almost
// never matched on a personal book (pre-selected → distribution skewed).
//
// Defensive filter is also relaxed slightly: dividends ≥ 2 (was ≥ 3) so
// growth-oriented quality names (HDFCBANK Snowflake-div=5, SBIN div=4)
// still pass, while pure growth no-divs (NETWEB) correctly don't.
function classifyBasket(rec) {
  const snow = rec.snowflake;
  if (!snow) return null;
  const beta = num(rec.beta, null);
  const upside = num(rec.upside_pct, 0);
  const v3Verdict = rec.v3_verdict || rec.verdict;
  const v3Score = num(rec.v3_score, 0);
  const risksFlag = rec.v2_breakdown?.risks_flag === true;

  const passesDefensive =
    snow.financial_health >= 4 &&
    snow.dividends >= 2 &&
    (beta == null || beta < 0.9) &&
    !risksFlag;

  // Growth: any of (a) v3 verdict says STRONG/TOP_PICK, OR (b) future
  // pillar high + meaningful upside. Either gate is sufficient — no
  // longer requires the v1 verdict label.
  const passesGrowth =
    !risksFlag && (
      ["TOP_PICK", "STRONG"].includes(v3Verdict) ||
      (snow.future_growth >= 4 && upside >= 10) ||
      v3Score >= 50
    );

  return { defensive: passesDefensive, growth: passesGrowth };
}

function holdingToBasketRow(h) {
  const snow = h.sws.snowflake;
  const ov = h.sws;
  return {
    source: "holding",
    ticker: h.sws.ticker,
    name: h.sws.name,
    sector: h.sws.sector,
    snowflake: snow,
    snowflake_total: snow.total,
    verdict: h.sws.verdict,
    v3_score: h.sws.v3_score,
    v2_score: h.sws.v2_score,
    current_price_inr: ov.current_price_inr,
    fair_value_inr: ov.fair_value_inr,
    upside_pct: ov.upside_pct,
    beta: ov.beta ?? null,
    market_cap_inr: ov.market_cap_inr,
    multiples: ov.multiples,
    dividend_yield_pct: ov.dividend_yield_pct,
    net_margin_pct: ov.net_margin_pct,
    earnings_growth_pct: ov.earnings_growth_pct,
    returns_pct: ov.returns_pct,
    next_earnings_date: ov.next_earnings_date,
    v2_breakdown: ov.v2_breakdown,
    surveillance: ov.surveillance,
    timing: h.timing,
    action: h.action,
    sws_url: h.sws.sws_url,
  };
}

function pickToBasketRow(pick) {
  const deep = loadSWSDeep(pick.ticker);
  const snow = deep ? pickSnowflake(deep) : pick.snowflake;
  const ov = deep?.overview || {};
  const fiscal = deep?.fiscal || {};
  // Run the same FV/upside reconciliation as in-portfolio holdings so fresh
  // picks (CARERATING, CEINSYS, etc.) don't surface raw scraper values
  // ("65.68440275587282%") in the basket UI. Falls back to picks-latest
  // values when the deep file is missing.
  const reconciled = _reconcileFVUpside({
    current_price_inr: ov.current_price_inr ?? pick.current_price_inr,
    fair_value_inr: ov.fair_value_inr ?? pick.fair_value_inr,
    upside_pct: ov.upside_pct ?? pick.upside_pct,
  });
  return {
    source: "fresh",
    ticker: pick.ticker,
    name: pick.name,
    sector: pick.sector,
    snowflake: snow,
    snowflake_total: snow?.total ?? pick.snowflake_total,
    verdict: pick.verdict,
    v3_score: pick.v3_score_100 ?? pick.v3_score ?? null,
    v2_score: pick.v2_score,
    current_price_inr: ov.current_price_inr ?? pick.current_price_inr,
    fair_value_inr: reconciled.fair_value_inr,
    upside_pct: reconciled.upside_pct,
    beta: ov.beta ?? null,
    market_cap_inr: ov.market_cap_inr ?? pick.market_cap_inr,
    multiples: ov.multiples ?? null,
    dividend_yield_pct: ov.dividend?.yield_pct ?? ov.dividend_yield_pct ?? null,
    net_margin_pct: fiscal.net_margin_pct ?? ov.net_margin_pct ?? null,
    earnings_growth_pct: fiscal.earnings_growth_pct ?? null,
    returns_pct: ov.returns_pct ?? null,
    next_earnings_date: ov.next_earnings_date ?? pick.next_earnings_date,
    v2_breakdown: pick.v2_breakdown,
    surveillance: pick.v2_breakdown?.surveillance ?? null,
    sws_url: pick.sws_url ?? null,
  };
}

// Outside-portfolio fresh picks — surfaces a structured list of
// candidates from 4 picks-latest buckets, set-diffed against the user's
// held tickers, split into defensive (quality_growth + deep_value) and
// growth (top_ranked_30_v3 + smallcap_gems).
//
// Trigger: fires when fresh capital > 0 OR top-5 holdings > 50% of book
// (concentration risk). Allocates 15-35% of fresh capital depending on
// concentration severity — heavier concentration → larger fresh-picks
// allocation to dilute single-name risk.
//
// Gated by OUTSIDE_PICKS=1 env flag per PR-4 plan.
function surfaceOutsidePicks({ scoredHoldings, freshCapitalInr, limit = 12 }) {
  if (process.env.OUTSIDE_PICKS !== "1") {
    return { available: false, reason: "OUTSIDE_PICKS feature flag disabled" };
  }

  const totalValue = scoredHoldings.reduce((s, h) => s + (num(h.currentValue, 0) || 0), 0);
  if (totalValue <= 0) {
    return { available: false, reason: "No portfolio value to compute concentration." };
  }

  // Concentration score = top-5 holdings as % of book. ≥50% = trigger.
  const sortedByValue = [...scoredHoldings]
    .filter((h) => num(h.currentValue, 0) > 0)
    .sort((a, b) => num(b.currentValue, 0) - num(a.currentValue, 0));
  const top5Value = sortedByValue.slice(0, 5).reduce((s, h) => s + num(h.currentValue, 0), 0);
  const concentrationPct = +((top5Value / totalValue) * 100).toFixed(1);

  const hasFreshCapital = num(freshCapitalInr, 0) > 0;
  const isOverConcentrated = concentrationPct >= 50;
  if (!hasFreshCapital && !isOverConcentrated) {
    return {
      available: false,
      reason: "No fresh capital and concentration < 50% — outside picks not surfaced.",
      concentrationPct,
    };
  }

  const heldTickers = new Set(
    scoredHoldings.filter((h) => h.swsCovered && h.sws?.ticker).map((h) => h.sws.ticker),
  );
  const picks = loadPicksLatest();
  const sections = picks?.sections || {};

  // Pull from 4 buckets, set-diff against held. The plan calls out
  // top_ranked_30_v3 (the v3-aware ranking) — we fall back to
  // top_ranked_30 if the v3 variant isn't populated.
  const growthSrc = [
    ...(sections.top_ranked_30_v3 || sections.top_ranked_30 || []),
    ...(sections.smallcap_gems || []),
  ].filter((p) => p?.ticker && !heldTickers.has(p.ticker));

  const defensiveSrc = [
    ...(sections.quality_growth || []),
    ...(sections.deep_value || []),
  ].filter((p) => p?.ticker && !heldTickers.has(p.ticker));

  // Dedupe within each list, then take top by v3_score. Cross-bucket
  // dedupe runs after — if a ticker qualifies for both growth and
  // defensive buckets (common: a top-ranked v3 name with strong
  // quality_growth metrics), it stays in growth (the higher-priority
  // surface) and is removed from defensive so the user doesn't see
  // duplicates.
  const dedupe = (arr) => {
    const seen = new Set();
    const out = [];
    for (const p of arr.sort((a, b) => num(b.v3_score, 0) - num(a.v3_score, 0))) {
      if (seen.has(p.ticker)) continue;
      seen.add(p.ticker);
      out.push(p);
    }
    return out;
  };
  const growth = dedupe(growthSrc).slice(0, Math.ceil(limit / 2));
  const growthTickers = new Set(growth.map((p) => p.ticker));
  const defensive = dedupe(defensiveSrc)
    .filter((p) => !growthTickers.has(p.ticker))
    .slice(0, Math.floor(limit / 2));

  // Allocation pct of fresh capital — scales 15-35% by concentration:
  //   ≥ 70% concentrated → 35% to fresh picks (heaviest dilution)
  //   60-70% → 25%
  //   50-60% → 20%
  //   < 50% (only fires when freshCapital > 0) → 15% (gentle outward push)
  let allocPct;
  if (concentrationPct >= 70) allocPct = 35;
  else if (concentrationPct >= 60) allocPct = 25;
  else if (concentrationPct >= 50) allocPct = 20;
  else allocPct = 15;

  const allocInr = hasFreshCapital ? Math.round(freshCapitalInr * (allocPct / 100)) : 0;
  const totalPicks = growth.length + defensive.length;
  const perPickInr = totalPicks > 0 && allocInr > 0
    ? Math.round(allocInr / totalPicks)
    : 0;

  // Annotate each row with source + suggested ₹ + the basket-row shape
  // the UI already renders.
  const annotateBucket = (rows, basketLabel) => rows.map((p) => {
    const baseRow = pickToBasketRow(p);
    return {
      ...baseRow,
      source: "fresh",
      basket: basketLabel,
      suggested_inr: perPickInr,
    };
  });

  return {
    available: true,
    concentrationPct,
    triggerReasons: [
      hasFreshCapital ? `Fresh capital ₹${freshCapitalInr.toLocaleString("en-IN")} available` : null,
      isOverConcentrated ? `Top-5 holdings = ${concentrationPct}% of book (≥50% trigger)` : null,
    ].filter(Boolean),
    allocPct,
    allocInr,
    perPickInr,
    growth: annotateBucket(growth, "growth"),
    defensive: annotateBucket(defensive, "defensive"),
    counts: {
      growth: growth.length,
      defensive: defensive.length,
      total: totalPicks,
    },
    methodology:
      `Picks: top_ranked_30_v3 + smallcap_gems (growth) and quality_growth + deep_value (defensive), ` +
      `set-diffed against your ${heldTickers.size} held ticker(s). Allocation ${allocPct}% scales with ` +
      `concentration: ≥70% → 35%, 60-70% → 25%, 50-60% → 20%, else 15%. Always opt-in via OUTSIDE_PICKS=1.`,
  };
}

function buildBaskets({ scoredHoldings, freshCapitalInr, freshPickLimit }) {
  const heldTickers = new Set(scoredHoldings.filter((h) => h.swsCovered).map((h) => h.sws.ticker));

  // Source 1: in-portfolio top-up candidates
  const topupHoldings = scoredHoldings
    .filter((h) => h.swsCovered && TOPUP_ACTIONS.has(h.action))
    .map(holdingToBasketRow);

  // Source 2: outside-portfolio fresh picks
  const picks = loadPicksLatest();
  const sections = picks?.sections || {};
  const seedGrowth = (sections.top_ranked_30 || []).filter((p) => !heldTickers.has(p.ticker));
  const seedDefensive = (sections.dividend_aristocrats || []).filter((p) => !heldTickers.has(p.ticker));

  const candidatePicks = new Map();
  for (const p of seedGrowth) candidatePicks.set(p.ticker, p);
  for (const p of seedDefensive) if (!candidatePicks.has(p.ticker)) candidatePicks.set(p.ticker, p);

  // Defensive fallback: scan deep/ for high-health + dividend stocks if seed is thin
  if (seedDefensive.length < freshPickLimit) {
    let scanned = 0;
    try {
      const files = fs.readdirSync(DEEP_DIR).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        if (scanned >= 200) break; // soft cap to keep this quick
        scanned++;
        const ticker = f.replace(/\.json$/, "");
        if (heldTickers.has(ticker) || candidatePicks.has(ticker)) continue;
        const deep = loadSWSDeep(ticker);
        if (!deep) continue;
        const snow = pickSnowflake(deep);
        if (snow.financial_health < 5 || snow.dividends < 3) continue;
        const ov = deep.overview || {};
        const beta = num(ov.beta, null);
        if (beta != null && beta >= 0.7) continue;
        // Fabricate a pick-shaped record
        const scored = scoreHolding({ symbol: ticker, positionWeight: 0, sectorWeight: 0, pnlPercent: 0 }, { sectorWeights: {} });
        if (!scored.swsCovered) continue;
        candidatePicks.set(ticker, {
          ticker,
          name: scored.sws.name,
          sector: scored.sws.sector,
          verdict: scored.sws.verdict,
          v3_score: scored.sws.v3_score,
          v2_score: scored.sws.v2_score,
          snowflake_total: snow.total,
          snowflake: snow,
          current_price_inr: scored.sws.current_price_inr,
          fair_value_inr: scored.sws.fair_value_inr,
          upside_pct: scored.sws.upside_pct,
          market_cap_inr: scored.sws.market_cap_inr,
          v2_breakdown: scored.sws.v2_breakdown,
          sws_url: scored.sws.sws_url,
        });
      }
    } catch {}
  }

  const freshRows = [...candidatePicks.values()].map(pickToBasketRow);

  // Combine and classify
  const combined = [...topupHoldings, ...freshRows];
  const passesDefensive = [];
  const passesGrowth = [];
  const passesBoth = [];

  for (const row of combined) {
    const c = classifyBasket(row);
    if (!c) continue;
    if (c.defensive && c.growth) passesBoth.push(row);
    else if (c.defensive) passesDefensive.push(row);
    else if (c.growth) passesGrowth.push(row);
  }

  // Sort each by v3_score desc (action engine uses v3 as authoritative)
  const byV3 = (a, b) => num(b.v3_score, 0) - num(a.v3_score, 0);
  passesDefensive.sort(byV3);
  passesGrowth.sort(byV3);
  passesBoth.sort(byV3);

  // Shared Core: top 3 from passesBoth
  const core = passesBoth.slice(0, 3);
  const coreTickers = new Set(core.map((r) => r.ticker));

  // Each basket: prefer pure-bucket passes, then fall through to passesBoth (excluding core)
  const defensive = [
    ...passesDefensive,
    ...passesBoth.filter((r) => !coreTickers.has(r.ticker)),
  ].slice(0, freshPickLimit);

  const growth = [
    ...passesGrowth,
    ...passesBoth.filter((r) => !coreTickers.has(r.ticker)),
  ].slice(0, freshPickLimit);

  // ₹ allocation per basket (65% in-portfolio top-ups, 35% fresh picks)
  const basketBudget = freshCapitalInr ? Math.round(freshCapitalInr / 2) : null;
  const allocBasket = (rows) => {
    if (!basketBudget) return rows;
    const holdingRows = rows.filter((r) => r.source === "holding");
    const freshRowsB = rows.filter((r) => r.source === "fresh");
    const holdingPool = Math.round(basketBudget * 0.65);
    const freshPool = Math.round(basketBudget * 0.35);
    const perHolding = holdingRows.length ? Math.round(holdingPool / holdingRows.length) : 0;
    const perFresh = freshRowsB.length ? Math.round(freshPool / freshRowsB.length) : 0;
    return rows.map((r) => ({ ...r, suggested_inr: r.source === "holding" ? perHolding : perFresh }));
  };

  return {
    defensive: allocBasket(defensive),
    growth: allocBasket(growth),
    core: allocBasket(core),
    counts: {
      topup_in_portfolio: topupHoldings.length,
      fresh_picks_seed: freshRows.length,
      passes_defensive: passesDefensive.length,
      passes_growth: passesGrowth.length,
      passes_both: passesBoth.length,
    },
  };
}

function buildSectorOverlay(scoredHoldings) {
  const bySector = new Map();
  let totalCV = 0;
  for (const h of scoredHoldings) {
    const cv = num(h.currentValue, 0);
    totalCV += cv;
    // Same precedence as server.js's first pass: prefer the curated
    // stockList sector (proper case, consistent vocabulary) over the SWS
    // deep-file sector to keep the overlay from fragmenting into
    // case-variant duplicates ("energy" vs "Energy", "utilities" vs
    // "Utilities"). SWS only fills in when stockList has none.
    const sector = h.sector || (h.swsCovered ? h.sws.sector : null) || "Unclassified";
    if (!bySector.has(sector)) bySector.set(sector, { sector, currentValue: 0, holdings: [], avgSnowflake: 0, avgV3: 0, _snowSum: 0, _v3Sum: 0, _n: 0 });
    const row = bySector.get(sector);
    row.currentValue += cv;
    row.holdings.push(h.sws?.ticker || h.symbol);
    if (h.swsCovered) {
      row._snowSum += num(h.sws.snowflake_total, 0);
      row._v3Sum += num(h.sws.v3_score, 0);
      row._n += 1;
    }
  }
  const out = [];
  for (const row of bySector.values()) {
    out.push({
      sector: row.sector,
      currentValue: Math.round(row.currentValue),
      pct: totalCV > 0 ? Math.round((row.currentValue / totalCV) * 1000) / 10 : 0,
      holdings: row.holdings,
      avgSnowflake: row._n ? Math.round(row._snowSum / row._n * 10) / 10 : null,
      avgV3: row._n ? Math.round(row._v3Sum / row._n * 10) / 10 : null,
    });
  }
  out.sort((a, b) => b.currentValue - a.currentValue);
  return out;
}

function buildSnapshot(scoredHoldings) {
  let totalCV = 0;
  let totalInv = 0;
  let snowSum = 0;
  let snowN = 0;
  let v3Sum = 0;
  let v3N = 0;
  const verdictMix = {};
  const actionMix = {};
  let coveredCount = 0;

  for (const h of scoredHoldings) {
    totalCV += num(h.currentValue, 0);
    totalInv += num(h.invested, 0);
    if (h.action) actionMix[h.action] = (actionMix[h.action] || 0) + 1;
    if (h.swsCovered) {
      coveredCount++;
      snowSum += num(h.sws.snowflake_total, 0);
      snowN++;
      v3Sum += num(h.sws.v3_score, 0);
      v3N++;
      const verdict = h.sws.verdict || "n/a";
      verdictMix[verdict] = (verdictMix[verdict] || 0) + 1;
    }
  }

  return {
    totalInvested: Math.round(totalInv),
    totalCurrent: Math.round(totalCV),
    totalPnL: Math.round(totalCV - totalInv),
    totalPnLPct: totalInv > 0 ? Math.round((totalCV - totalInv) / totalInv * 1000) / 10 : 0,
    coveredCount,
    holdingsCount: scoredHoldings.length,
    avgSnowflake: snowN ? Math.round(snowSum / snowN * 10) / 10 : null,
    avgV3Score: v3N ? Math.round(v3Sum / v3N * 10) / 10 : null,
    verdictMix,
    actionMix,
  };
}

// Apply macro-regime tilt to a list of basket rows. Each row's v3_score
// is shifted by half the regime delta (portfolio scores move less than
// scanner scores per the legacy convention). Pure transform; mutates a
// copy, not the input.
function _applyMacroTilt(rows, regime) {
  if (!regime || !_computeMacroDelta) return rows.map((r) => ({ ...r }));
  return rows.map((r) => {
    const tilt = _computeMacroDelta(regime, r.sector);
    if (!tilt || !tilt.delta) return { ...r, macro_delta: 0, macro_reason: null };
    return {
      ...r,
      macro_delta: +(tilt.delta * 0.5).toFixed(2),
      macro_reason: tilt.reason,
      v3_score: num(r.v3_score, 0) + tilt.delta * 0.5,
    };
  });
}

export function buildSWSReport(scoredHoldings, opts = {}) {
  const freshCapitalInr = opts.freshCapitalInr ?? null;
  const freshPickLimit = opts.freshPickLimit ?? 8;
  const macroRegime = opts.macroRegime ?? null;
  const priorSnapshot = opts.priorSnapshot ?? null;

  // Post-trim cooldown — softens any Reduction-* call on a holding the
  // user already trimmed (qty drop ≥ 10% vs prior snapshot, or
  // lastTrimmedAt within the cooldown window). The engine's underlying
  // recommendation still rides through as `originalAction` on the row so
  // the UI can show "engine wanted Reduction-25%, suppressed because you
  // trimmed N days ago". Pure when priorSnapshot is null (first run /
  // ANALYZER_DIFF off) — cooledCount = 0, holdings unchanged.
  const cooled = applyPostTrimCooldown(scoredHoldings, priorSnapshot);
  const effectiveHoldings = cooled.holdings;

  const tiers = buildTiers(effectiveHoldings);
  const baskets = buildBaskets({ scoredHoldings: effectiveHoldings, freshCapitalInr, freshPickLimit });
  const sectorOverlay = buildSectorOverlay(effectiveHoldings);
  const snapshot = buildSnapshot(effectiveHoldings);

  // PR-4: liquidity-tail bucketing — % of book in <1d / 1-5d / 5-10d /
  // >10d / no-data buckets via market-cap proxy + surveillance escalation.
  const liquidityTail = bucketByDaysToExit(effectiveHoldings);

  // PR-4: outside-portfolio fresh picks — surface 10-12 candidates from
  // picks-latest.json (set-diffed against held tickers) when fresh
  // capital is available OR top-5 holdings dominate the book. Gated by
  // OUTSIDE_PICKS=1 env flag (returns { available: false } otherwise).
  const outsidePicks = surfaceOutsidePicks({ scoredHoldings: effectiveHoldings, freshCapitalInr });

  // PR-4: diff vs prior analyzer run. buildDiffSnapshot strips the heavy
  // SWS payload to a per-row tuple (~100 bytes × N) so persisted state
  // stays small. priorSnapshot is null on first run → diff returns
  // hasChanges:false with the "first run" summary.
  // Pass priorByTicker so lastTrimmedAt carries forward — cooldown
  // memory persists across multiple runs without the user trimming again.
  const priorByTicker = snapshotByTicker(priorSnapshot);
  const diffSnapshot = buildDiffSnapshot(effectiveHoldings, { priorByTicker });
  const diff = diffSnapshots(priorSnapshot, diffSnapshot);

  // Macro tilt — only applied to Tier B baskets (the recommendations
  // surface). The per-stock action grid (Tier A / C / D) shows the
  // un-tilted SWS view to keep the user-facing verdict deterministic.
  if (macroRegime) {
    baskets.defensive = _applyMacroTilt(baskets.defensive, macroRegime);
    baskets.growth = _applyMacroTilt(baskets.growth, macroRegime);
    baskets.core = _applyMacroTilt(baskets.core, macroRegime);
    baskets.macro_regime = {
      regime: macroRegime.regime || null,
      severity: macroRegime.severity || null,
      confidence: macroRegime.confidence || null,
    };
  }

  // Sector-wipeout guard — flag any sector that would be left at zero
  // exposure if all reductions executed. Surfaces gap #7 from the real
  // portfolio diagnostic (CIPLA Reduction-50% leaves zero pharma).
  // Reads from cooled holdings so cooldown-suppressed reductions don't
  // count toward a "wipeout" (the user isn't planning to trim those
  // again — the engine already deferred the call).
  const reductionTickers = new Set(
    tiers.tierA.map((h) => h.sws?.ticker || h.symbol).filter(Boolean),
  );
  const sectorWipeouts = detectSectorWipeout({ scoredHoldings: effectiveHoldings, reductionTickers });

  const picks = loadPicksLatest();
  const banner = {
    engine: "SWS Engine (Beta)",
    snapshot_at: picks?.scanned_at ?? null,
    universe_size: picks?.universe_size ?? null,
    coverage_text: `${snapshot.coveredCount}/${snapshot.holdingsCount} holdings have SWS data`,
  };

  return {
    engine: "sws",
    banner,
    snapshot,
    diff,
    liquidityTail,
    outsidePicks,
    // The lightweight snapshot to persist for next run's diff.
    // Server.js writes this to portfolio.analyzerSnapshot post-render.
    analyzerSnapshotForNextRun: diffSnapshot,
    tiers: {
      A: { label: "Reductions", rows: tiers.tierA, freedRupees: tiers.freedRupees, sector_wipeouts: sectorWipeouts },
      B: { label: "Top-ups (Two baskets + shared Core)", baskets },
      C: { label: "Hold as-is", rows: tiers.tierC },
      D: { label: "Watch (catalyst-driven)", rows: tiers.tierD },
    },
    sectorOverlay,
    cooldownSummary: {
      cooledCount: cooled.cooledCount,
    },
  };
}
