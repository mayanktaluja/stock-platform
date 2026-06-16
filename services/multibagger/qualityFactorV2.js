// Shadow analyst-quality factor for 5x Lab. This does not replace the
// heuristic rank score; it exposes quality evidence and blocks theme/story
// bonuses from being the last push into the top tier when fundamentals are
// too thin or weak.

const AUDIT_RISK_REGEX = /\b(qualified opinion|going concern|auditor resignation|audit qualification|restatement)\b/i;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function pctChange(latest, prior) {
  if (!isFiniteNumber(latest) || !isFiniteNumber(prior) || prior === 0) return null;
  return ((latest - prior) / Math.abs(prior)) * 100;
}

function latestPair(history, key) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((r) => r && isFiniteNumber(r.year))
    .sort((a, b) => a.year - b.year);
  if (rows.length < 2) return [null, null];
  return [rows[rows.length - 1]?.[key], rows[rows.length - 2]?.[key]];
}

function scoreTrend(history, key) {
  const [latest, prior] = latestPair(history, key);
  const change = pctChange(latest, prior);
  if (change === null) return { score: 0, value: null, reason: `${key}_missing` };
  if (change > 20) return { score: 2, value: Number(change.toFixed(1)), reason: `${key}_improving` };
  if (change >= 0) return { score: 1, value: Number(change.toFixed(1)), reason: `${key}_stable` };
  return { score: -1, value: Number(change.toFixed(1)), reason: `${key}_deteriorating` };
}

function auditRisk(news) {
  const hit = (Array.isArray(news) ? news : []).some((n) => {
    const text = `${n?.title || ""} ${n?.body || ""}`;
    return AUDIT_RISK_REGEX.test(text);
  });
  return hit ? { score: -2, reason: "audit_or_restatement_risk" } : { score: 1, reason: "no_audit_risk_seen" };
}

export function computeQualityFactorV2({ overview = {}, yearly_history = [], news = [] } = {}) {
  const revenue = scoreTrend(yearly_history, "revenue");
  const netIncome = scoreTrend(yearly_history, "netIncome");
  const operatingCashFlow = scoreTrend(yearly_history, "operatingCashFlow");
  const debt = scoreTrend(yearly_history, "totalDebt");
  const audit = auditRisk(news);
  const health = overview?.snowflake?.financial_health ?? overview?.snowflake?.health;
  const healthScore = isFiniteNumber(health) ? Math.round((health / 6) * 2 * 10) / 10 : 0;

  const growth_quality = Math.max(0, revenue.score) + Math.max(0, netIncome.score);
  const accounting_quality = Math.max(0, operatingCashFlow.score) + Math.max(0, audit.score);
  const balance_sheet_quality = healthScore + (debt.value !== null && debt.value <= 0 ? 1 : 0);
  const governance_quality = Math.max(0, audit.score);
  const observed = [revenue, netIncome, operatingCashFlow, debt].filter((x) => x.value !== null).length;
  const data_confidence = Number(((observed / 4) * 100).toFixed(0));
  const total_score = Number((growth_quality + accounting_quality + balance_sheet_quality + governance_quality).toFixed(1));
  const quality_gate_pass = data_confidence >= 50 && total_score >= 4 && audit.score >= 0;

  return {
    schema_version: "quality-factor-v2-shadow",
    growth_quality,
    balance_sheet_quality,
    accounting_quality,
    governance_quality,
    data_confidence,
    total_score,
    quality_gate_pass,
    reasons: [revenue.reason, netIncome.reason, operatingCashFlow.reason, debt.reason, audit.reason],
    metrics: {
      revenue_yoy_pct: revenue.value,
      net_income_yoy_pct: netIncome.value,
      operating_cash_flow_yoy_pct: operatingCashFlow.value,
      debt_yoy_pct: debt.value,
      snowflake_health: isFiniteNumber(health) ? health : null,
    },
  };
}
