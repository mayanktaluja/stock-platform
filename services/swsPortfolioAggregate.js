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

const REDUCTION_ACTIONS = new Set(["EXIT", "Reduction-50%", "Reduction-25-33%"]);
const TOPUP_ACTIONS = new Set(["Top-up-modest", "Top-up", "STRONG Top-up"]);

function _reductionRupees(holding) {
  const cv = num(holding.currentValue, 0);
  if (holding.action === "EXIT") return cv;
  if (holding.action === "Reduction-50%") return cv * 0.5;
  if (holding.action === "Reduction-25-33%") return cv * 0.30;
  return 0;
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
      // v3 < 36 = ACCEPTABLE-band lower edge (universe p75≈39, p50≈29 per
      // swsHoldingEngine.js). Below that = HOLD-but-borderline → tier D watch.
      const isWatch = v3 < 36 || upside < 5 || (days != null && days >= 0 && days <= 7);
      if (isWatch) {
        tierD.push({
          ...h,
          watchReason: days != null && days >= 0 && days <= 7
            ? `Earnings in ${days}d — re-evaluate post-result.`
            : v3 < 36 ? `Borderline ACCEPTABLE (v3 ${v3.toFixed(1)}) — watch for catalyst.`
            : `Limited upside (${upside.toFixed(1)}%) — re-rate next quarter.`,
        });
      } else {
        tierC.push(h);
      }
    }
  }

  return { tierA, tierC, tierD, freedRupees: Math.round(freedRupees) };
}

function classifyBasket(rec) {
  const snow = rec.snowflake;
  if (!snow) return null;
  const beta = num(rec.beta, null);
  const upside = num(rec.upside_pct, 0);
  const verdict = rec.verdict;
  const risksFlag = rec.v2_breakdown?.risks_flag === true;

  const passesDefensive =
    snow.financial_health >= 5 &&
    snow.dividends >= 3 &&
    (beta == null || beta < 0.7) &&
    !risksFlag;

  const passesGrowth =
    snow.future_growth >= 4 &&
    upside >= 15 &&
    (verdict === "QUALITY_GROWTH" || verdict === "DEEP_VALUE");

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

export function buildSWSReport(scoredHoldings, opts = {}) {
  const freshCapitalInr = opts.freshCapitalInr ?? null;
  const freshPickLimit = opts.freshPickLimit ?? 8;

  const tiers = buildTiers(scoredHoldings);
  const baskets = buildBaskets({ scoredHoldings, freshCapitalInr, freshPickLimit });
  const sectorOverlay = buildSectorOverlay(scoredHoldings);
  const snapshot = buildSnapshot(scoredHoldings);

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
    tiers: {
      A: { label: "Reductions", rows: tiers.tierA, freedRupees: tiers.freedRupees },
      B: { label: "Top-ups (Two baskets + shared Core)", baskets },
      C: { label: "Hold as-is", rows: tiers.tierC },
      D: { label: "Watch (catalyst-driven)", rows: tiers.tierD },
    },
    sectorOverlay,
  };
}
