// Multibagger scorer — the 0–100 composite that drives the 5x strategy
// candidate pipeline. Composes 12 component scores + 3 penalties + 5
// hard-reject gates over a SWS picks-latest row + overview.
//
// Hard gates auto-PASS regardless of score:
//   - Promoter pledge ≥25% or +10pp in 90d
//   - Liquidity ADV < 5 × tier_size_inr
//   - Audit-quality (qualified opinion / going concern in news[])
//   - Surveillance GSM listing
//   - Data completeness < 40%
//   - Snowflake financial_health < 3 caps total score at 50 (zombie filter)
//
// All callers must supply `position_size_inr` so the liquidity gate can
// reason about exit-trap risk for the chosen tier.

import { scoreInflection } from "./inflectionDetector.js";
import { tagStoryStock } from "./storyStockTagger.js";
import { computeSectorTailwind } from "./sectorTailwindMap.js";
import { evaluatePledge } from "./pledgeGate.js";
import { evaluateLiquidity, deriveAdvFromSws } from "./liquidityGate.js";
import { computeQualityFactorV2 } from "./qualityFactorV2.js";

const SCORE_MAX = 100;
const HEALTH_FLOOR = 3;
const HEALTH_FLOOR_CAP = 50;
const DATA_COMPLETENESS_HARD_REJECT = 40;
const FORWARD_GROWTH_REGEX = /\bforecast(?:ed)? to grow\s+([0-9.]+)%/i;
const AUDIT_QUALITY_REGEX = /\b(qualified opinion|going concern|auditor resignation|audit qualification)\b/i;
const MISS_KEY_DEV_TYPE_ID = 55;

const VERDICT_BANDS = Object.freeze({
  FIVEX_CANDIDATE: 70,
  HIGH_CONVICTION: 55,
  WATCH: 40,
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  if (!isFiniteNumber(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function mcapBandPts(market_cap_inr) {
  if (!isFiniteNumber(market_cap_inr) || market_cap_inr <= 0) return 0;
  const cr = market_cap_inr / 1e7;
  if (cr < 500) return 10;
  if (cr < 5_000) return 8;
  if (cr < 20_000) return 4;
  return 0;
}

function fvUpsidePts(upside_pct, fv_imputed) {
  if (!isFiniteNumber(upside_pct)) return 0;
  let raw;
  if (upside_pct >= 50) raw = 10;
  else if (upside_pct >= 30) raw = 8;
  else if (upside_pct >= 15) raw = 5;
  else if (upside_pct >= 0) raw = 3;
  else raw = 0;
  return fv_imputed ? Math.round((raw / 3) * 10) / 10 : raw;
}

function momentumPts(v4_breakdown, has_one_year_close) {
  if (!has_one_year_close) {
    // No reachable 1y return → cap momentum at 3 pts (rewritten rule per
    // adversarial; was based on momentum_imputed flag which doesn't exist
    // in picks-latest).
    return 3;
  }
  const m1y = clamp(v4_breakdown?.pts_mom_1y, 0, 7);
  const m3m = clamp(v4_breakdown?.pts_mom_3m, 0, 3);
  const m1m = clamp(v4_breakdown?.pts_mom_1m, 0, 2);
  // Target weights 5+3+2 = 10 total. V4 momentum maxes are 7+3+2 = 12;
  // rescale 7→5, keep 3, keep 2.
  return Math.round(((m1y * 5 / 7) + m3m + m1m) * 10) / 10;
}

function liquidityBonusPts(adv_inr_30d) {
  if (!isFiniteNumber(adv_inr_30d)) return 0;
  if (adv_inr_30d >= 5e7) return 5;
  if (adv_inr_30d >= 1e7) return 3;
  if (adv_inr_30d >= 5e6) return 1;
  return 0;
}

function snowflakeHealthPts(snowflake) {
  const h = snowflake?.financial_health ?? snowflake?.health;
  if (!isFiniteNumber(h)) return 0;
  return Math.round((h / 6) * 5 * 10) / 10;
}

function forwardGrowthPts(rewards) {
  if (!Array.isArray(rewards)) return 0;
  for (const r of rewards) {
    const m = FORWARD_GROWTH_REGEX.exec(String(r ?? ""));
    if (m) {
      const pct = parseFloat(m[1]);
      if (!Number.isFinite(pct)) continue;
      if (pct >= 30) return 5;
      if (pct >= 20) return 3;
      if (pct >= 10) return 1;
      return 0;
    }
  }
  return 0;
}

function surveillancePenalty(surveillance) {
  const list = String(surveillance?.list || "").toUpperCase();
  const timeframe = String(surveillance?.timeframe || "").toLowerCase();
  if (list === "GSM") return -15;
  if (list === "ASM" && timeframe === "shortterm") return -10;
  if (list === "ASM") return -5;
  return 0;
}

function dataCompletenessPenalty(pct) {
  if (!isFiniteNumber(pct)) return 0;
  if (pct < 40) return -10;
  if (pct < 60) return -5;
  return 0;
}

function priorMissStreakPenalty(news) {
  if (!Array.isArray(news)) return 0;
  const earningsEvents = news
    .filter((n) => n && n.keyDevTypeId === MISS_KEY_DEV_TYPE_ID)
    .slice(0, 4); // last 4 quarters
  let streak = 0;
  for (const e of earningsEvents) {
    const text = String(e.title || "") + " " + String(e.body || "");
    if (/\bmiss(ed|es)?\b/i.test(text)) streak += 1;
    else break;
  }
  return streak >= 2 ? -5 : 0;
}

function auditQualityFlag(news) {
  if (!Array.isArray(news)) return false;
  return news.some((n) => {
    if (!n) return false;
    const text = String(n.title || "") + " " + String(n.body || "");
    return AUDIT_QUALITY_REGEX.test(text);
  });
}

function verdictFromScore(score, gateBlocked) {
  if (gateBlocked) return "HARD_REJECT";
  if (score >= VERDICT_BANDS.FIVEX_CANDIDATE) return "5X_CANDIDATE";
  if (score >= VERDICT_BANDS.HIGH_CONVICTION) return "HIGH_CONVICTION";
  if (score >= VERDICT_BANDS.WATCH) return "WATCH";
  return "PASS";
}

// Main entry. Returns the full composite + hard-gate verdict.
// Input fields are documented inline.
export function scoreCandidate({
  ticker,
  sector,
  overview = {},
  v4_breakdown = {},
  data_completeness_pct = null,
  news = [],
  yearly_history = [],
  most_recent_reported_date = null,
  macroRegime = null,
  sector_ttm_return_pct = null,
  pledge_events = [],
  pledge_announcements = [],
  position_size_inr = null,
  now_iso = null,
} = {}) {
  const market_cap_inr = overview.market_cap_inr;
  const upside_pct = overview.upside_pct;
  const fv_imputed = !!v4_breakdown.fv_imputed;
  const has_one_year_close = isFiniteNumber(overview?.returns_pct?.["1Y"]);
  const adv_inr_30d = isFiniteNumber(overview.adv_inr_30d)
    ? overview.adv_inr_30d
    : deriveAdvFromSws(overview);

  // Components (additive)
  const c_mcap = mcapBandPts(market_cap_inr);
  const c_future = isFiniteNumber(v4_breakdown.pts_future) ? Math.round(v4_breakdown.pts_future / 22 * 12 * 10) / 10 : 0; // v4.1: Future pillar is now 0–22
  const c_valuation = isFiniteNumber(v4_breakdown.pts_valuation) ? Math.round(v4_breakdown.pts_valuation / 18 * 10 * 10) / 10 : 0;
  const c_fv_upside = fvUpsidePts(upside_pct, fv_imputed);
  const inflection = scoreInflection({ yearly_history, news, most_recent_reported_date });
  const c_inflection = inflection.score;
  const tailwind = computeSectorTailwind({ sector, macroRegime, ttmReturnPct: sector_ttm_return_pct });
  const c_tailwind = tailwind.pts;
  const c_momentum = momentumPts(v4_breakdown, has_one_year_close);
  const c_liquidity_bonus = liquidityBonusPts(adv_inr_30d);
  const c_health = snowflakeHealthPts(overview.snowflake);
  const story = tagStoryStock(overview);
  const c_forward = forwardGrowthPts(overview.rewards);
  const c_story_bonus = story.score_bonus;
  const quality_factor_v2 = computeQualityFactorV2({ overview, yearly_history, news });

  // Penalties (subtractive)
  const p_surveillance = surveillancePenalty(v4_breakdown.surveillance);
  const p_completeness = dataCompletenessPenalty(data_completeness_pct);
  const p_miss_streak = priorMissStreakPenalty(news);

  // Raw composite
  let score = c_mcap + c_future + c_valuation + c_fv_upside + c_inflection
    + c_tailwind + c_momentum + c_liquidity_bonus + c_health + c_forward
    + c_story_bonus + p_surveillance + p_completeness + p_miss_streak;
  let qualityCapApplied = false;
  if (!quality_factor_v2.quality_gate_pass && c_story_bonus > 0 && c_inflection <= 0 && score >= VERDICT_BANDS.FIVEX_CANDIDATE && (score - c_story_bonus) < VERDICT_BANDS.FIVEX_CANDIDATE) {
    score = VERDICT_BANDS.FIVEX_CANDIDATE - 0.1;
    qualityCapApplied = true;
  }

  // Health floor — zombies (health < 3) capped at 50 even with strong other signals
  const healthRaw = overview.snowflake?.financial_health ?? overview.snowflake?.health;
  let healthCapApplied = false;
  if (isFiniteNumber(healthRaw) && healthRaw < HEALTH_FLOOR && score > HEALTH_FLOOR_CAP) {
    score = HEALTH_FLOOR_CAP;
    healthCapApplied = true;
  }

  score = Math.max(0, Math.min(SCORE_MAX, Math.round(score * 10) / 10));

  // Hard reject gates
  const gateReasons = [];
  const pledge = evaluatePledge({
    symbol: ticker,
    events: pledge_events,
    announcements: pledge_announcements,
    now_iso: now_iso || new Date().toISOString(),
  });
  if (!pledge.pass) gateReasons.push(...pledge.reasons.map((r) => `pledge_${r}`));

  if (isFiniteNumber(position_size_inr) && position_size_inr > 0) {
    const liq = evaluateLiquidity({ position_size_inr, adv_inr_30d, allow_unknown: false });
    if (!liq.pass) gateReasons.push(`liquidity_${liq.reason}`);
  }

  if (auditQualityFlag(news)) gateReasons.push("audit_quality_flag");
  if (String(v4_breakdown.surveillance?.list || "").toUpperCase() === "GSM") gateReasons.push("surveillance_gsm");
  if (isFiniteNumber(data_completeness_pct) && data_completeness_pct < DATA_COMPLETENESS_HARD_REJECT) {
    gateReasons.push("data_completeness_below_40pct");
  }

  const gateBlocked = gateReasons.length > 0;
  const verdict = verdictFromScore(score, gateBlocked);

  return {
    ticker,
    sector,
    score_0_100: score,
    verdict,
    gate_blocked: gateBlocked,
    gate_reasons: gateReasons,
    breakdown: {
      mcap: c_mcap,
      v3_future: c_future,
      v3_valuation: c_valuation,
      fv_upside: c_fv_upside,
      inflection: c_inflection,
      sector_tailwind: c_tailwind,
      momentum: c_momentum,
      liquidity_bonus: c_liquidity_bonus,
      health: c_health,
      forward_growth: c_forward,
      story_bonus: c_story_bonus,
      penalty_surveillance: p_surveillance,
      penalty_data_completeness: p_completeness,
      penalty_miss_streak: p_miss_streak,
    },
    diagnostics: {
      inflection,
      tailwind,
      story,
      pledge,
      adv_inr_30d,
      health_cap_applied: healthCapApplied,
      quality_cap_applied: qualityCapApplied,
    },
    quality_factor_v2,
  };
}

export const MULTIBAGGER_SCORER_CONFIG = Object.freeze({
  SCORE_MAX,
  VERDICT_BANDS,
  HEALTH_FLOOR,
  HEALTH_FLOOR_CAP,
  DATA_COMPLETENESS_HARD_REJECT,
});
