// Earnings inflection detector — turns 5y fiscal.yearly_history into
// a 0–17 score component for the multibagger composite.
//
// Two signal paths:
//   1. Loss-to-profit flip — strongest multibagger signal (Inox Wind
//      flipped 2024→2025: -₹0.3B → +₹4.5B; stock 5x'd). Worth full
//      points on its own.
//   2. Profit YoY growth — latest year netIncome growth vs prior:
//      >50% → 17, >25% → 12, >0% → 6, <0% → 0; +5 bonus if 3y CAGR >30%.
//
// One-off exclusion: scan SWS news[] for "exceptional item", "asset
// sale", "tax credit", "prior period" within ±90d of latest fiscal
// close → if hit, cap the inflection score at 6 (treat as suspicious).

const ONE_OFF_PATTERNS = /\b(exceptional item|one[\s-]?time|asset sale|asset disposal|tax credit|deferred tax|prior period|restatement|impair)/i;
const ONE_OFF_WINDOW_DAYS = 90;
const MAX_SCORE = 17;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.abs(Math.floor((b - a) / 86_400_000));
}

// Input: fiscal.yearly_history sorted (we accept any order, sort
// internally). news[] is optional — passes through one-off detection.
// Returns: { score, reasons, latest_growth_pct, three_year_cagr_pct,
//            loss_to_profit, one_off_flagged }.
export function scoreInflection({ yearly_history, news = [], most_recent_reported_date = null } = {}) {
  const reasons = [];
  if (!Array.isArray(yearly_history) || yearly_history.length === 0) {
    return { score: 0, reasons: ["no_history"], latest_growth_pct: null, three_year_cagr_pct: null, loss_to_profit: false, one_off_flagged: false };
  }

  const sorted = [...yearly_history]
    .filter((y) => y && isFiniteNumber(y.year))
    .sort((a, b) => a.year - b.year);

  if (sorted.length < 2) {
    return { score: 0, reasons: ["insufficient_history"], latest_growth_pct: null, three_year_cagr_pct: null, loss_to_profit: false, one_off_flagged: false };
  }

  const latest = sorted[sorted.length - 1];
  const prior = sorted[sorted.length - 2];
  const latestNi = latest.netIncome;
  const priorNi = prior.netIncome;

  let score = 0;
  let lossToProfit = false;
  let latestGrowthPct = null;
  let threeYearCagrPct = null;

  // Loss → profit flip — full points on its own.
  if (isFiniteNumber(latestNi) && isFiniteNumber(priorNi) && priorNi <= 0 && latestNi > 0) {
    score = MAX_SCORE;
    lossToProfit = true;
    reasons.push("loss_to_profit_flip");
  } else if (isFiniteNumber(latestNi) && isFiniteNumber(priorNi) && priorNi > 0) {
    latestGrowthPct = Number(((latestNi - priorNi) / priorNi * 100).toFixed(1));
    if (latestGrowthPct > 50) { score = 17; reasons.push(`ni_yoy_${latestGrowthPct}pct_>50`); }
    else if (latestGrowthPct > 25) { score = 12; reasons.push(`ni_yoy_${latestGrowthPct}pct_>25`); }
    else if (latestGrowthPct > 0) { score = 6; reasons.push(`ni_yoy_${latestGrowthPct}pct_>0`); }
    else { score = 0; reasons.push(`ni_yoy_${latestGrowthPct}pct_negative`); }
  } else if (isFiniteNumber(latestNi) && latestNi < 0) {
    score = 0;
    reasons.push("latest_loss");
  } else {
    score = 0;
    reasons.push("netincome_missing");
  }

  // 3-year CAGR bonus (only when fully positive)
  if (sorted.length >= 4 && !lossToProfit) {
    const tail = sorted.slice(-4);
    const first = tail[0]?.netIncome;
    const last = tail[tail.length - 1]?.netIncome;
    if (isFiniteNumber(first) && isFiniteNumber(last) && first > 0 && last > 0) {
      const cagr = Math.pow(last / first, 1 / 3) - 1;
      threeYearCagrPct = Number((cagr * 100).toFixed(1));
      if (threeYearCagrPct > 30) {
        const bonus = 5;
        score = Math.min(MAX_SCORE, score + bonus);
        reasons.push(`3y_cagr_${threeYearCagrPct}pct_bonus_+5`);
      }
    }
  }

  // One-off detection — cap score at 6 if exceptional items appear near
  // the latest fiscal close.
  let oneOffFlagged = false;
  if (most_recent_reported_date && Array.isArray(news) && news.length) {
    for (const n of news) {
      if (!n || !n.published_at_iso) continue;
      const age = daysBetween(n.published_at_iso, most_recent_reported_date);
      if (age === null || age > ONE_OFF_WINDOW_DAYS) continue;
      const text = String(n.title || "") + " " + String(n.body || "");
      if (ONE_OFF_PATTERNS.test(text)) {
        oneOffFlagged = true;
        break;
      }
    }
  }
  if (oneOffFlagged && score > 6) {
    reasons.push(`one_off_detected_cap_at_6`);
    score = 6;
  }

  return {
    score,
    reasons,
    latest_growth_pct: latestGrowthPct,
    three_year_cagr_pct: threeYearCagrPct,
    loss_to_profit: lossToProfit,
    one_off_flagged: oneOffFlagged,
  };
}

export const INFLECTION_CONFIG = Object.freeze({
  MAX_SCORE,
  ONE_OFF_WINDOW_DAYS,
});
