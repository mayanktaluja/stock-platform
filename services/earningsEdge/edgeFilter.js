// Earnings Edge — deterministic filter built from the KEC bug list (per
// `feedback_kec_is_structural_not_raise` memory). Every gate is on-disk
// data; no LLM dependency. Filters a resolved BEAT event for entry into
// the AGGRESSIVE sleeve.
//
// Spec reference: ~/.claude/plans/sws-alpha-strategy-2026-05-19.md
// (Earnings Edge section + adversarial sub-plan finding A3).

export const EARNINGS_EDGE_FILTER = Object.freeze({
  required_verdict: "BEAT",
  // KEC bug #1 — prior-quarter MISS regex over news[] titles. Rejects names
  // whose most-recent prior-quarter brief flagged a miss.
  prior_miss_keywords: Object.freeze([
    "miss analyst expectations",
    "miss analyst estimates",
    "missed analyst expectations",
    "missed analyst estimates",
    "below estimates",
    "below analyst expectations",
    "eps miss",
    "missed by",
  ]),
  // Look back this many days for the prior-quarter brief.
  prior_miss_lookback_days: 120,
  // KEC bug #3 — debt / working-capital risk keywords.
  forbidden_risk_keywords: Object.freeze([
    "interest payments are not well covered",
    "debt is not well covered",
    "high level of debt",
    "unprofitable",
  ]),
  // KEC bug #4 — sector watchlist. Seeded with sectors that have produced
  // false-positive BEATs in the past; extend after each post-mortem.
  problem_sectors: Object.freeze([
    "Power T&D",
    "Construction-Civil",
    "EPC",
  ]),
  min_snowflake_health: 3,
  min_market_cap_inr: 1000_00_00_000, // ₹1000Cr ≈ ₹10Cr 20d ADV proxy
  // Position sizing — % of 20d ADV (we use market_cap as proxy). 0.25% of
  // ₹1000Cr → ₹2.5Cr → way over our cap, so the per-trade cap (₹1L) wins
  // for small caps and the ADV gate wins for liquidity discipline.
  position_pct_of_adv: 0.0025,
  max_position_inr: 100_000,
  hold_days: 30,
  trailing_stop_pct: -8,
  hard_stop_pct: -12,
});

function hasKeywordHit(strings, keywords) {
  const arr = Array.isArray(strings) ? strings : [];
  const lowered = arr.map((s) => String(s || "").toLowerCase());
  for (const kw of keywords) {
    const hit = lowered.find((s) => s.includes(kw));
    if (hit) return hit;
  }
  return null;
}

function findPriorMissInNews(news, eventIsoDate, lookbackDays, keywords) {
  if (!Array.isArray(news) || !eventIsoDate) return null;
  const eventDate = new Date(eventIsoDate);
  if (Number.isNaN(eventDate.getTime())) return null;
  const cutoff = new Date(eventDate.getTime() - lookbackDays * 86_400_000);
  for (const n of news) {
    if (!n || !n.date) continue;
    const d = new Date(n.date);
    if (Number.isNaN(d.getTime())) continue;
    // Strictly prior to the event date (don't count the current result's own brief)
    if (d >= eventDate || d < cutoff) continue;
    const haystack = `${n.title || ""} ${n.body || ""}`.toLowerCase();
    const hit = keywords.find((kw) => haystack.includes(kw));
    if (hit) return { hit, news_date: n.date, title: n.title };
  }
  return null;
}

// event:  { symbol, sector, actual_verdict, event_iso_date, signals: { v3.breakdown.fv_imputed, snowflake_total, market_cap_inr } }
// ctx:    { deep: { overview: { snowflake.health, risks[] }, news: [...] }, surveillance: { ASM: Set, GSM: Set } }
export function applyEarningsEdgeFilter(event, ctx, opts = EARNINGS_EDGE_FILTER) {
  if (!event || typeof event !== "object") {
    return { passed: false, reasons: ["invalid-event"] };
  }
  const reasons = [];

  if (event.actual_verdict !== opts.required_verdict) {
    reasons.push(`verdict-not-BEAT (got ${event.actual_verdict || "unresolved"})`);
  }

  const deep = (ctx && ctx.deep) || null;
  const news = deep?.news;
  const priorMiss = findPriorMissInNews(
    news,
    event.event_iso_date,
    opts.prior_miss_lookback_days,
    opts.prior_miss_keywords,
  );
  if (priorMiss) {
    reasons.push(`prior-Q-miss:${priorMiss.news_date}:${priorMiss.hit}`);
  }

  // KEC bug #2 — fv_imputed haircut. Reject when the prediction was built
  // on imputed forecasts (the predictor falsely scored KEC +9 pts here).
  const fvImputed = event?.signals?.v3?.breakdown?.fv_imputed === true;
  if (fvImputed) reasons.push("fv-imputed");

  const risks = deep?.overview?.risks;
  const riskHit = hasKeywordHit(risks, opts.forbidden_risk_keywords);
  if (riskHit) reasons.push(`risk:${riskHit}`);

  const sector = event.sector || deep?.sector || "";
  if (opts.problem_sectors.some((s) => sector.toLowerCase().includes(s.toLowerCase()))) {
    reasons.push(`problem-sector:${sector}`);
  }

  const sfHealth =
    deep?.overview?.snowflake?.health ??
    deep?.overview?.snowflake?.financial_health;
  if (!Number.isFinite(Number(sfHealth)) || Number(sfHealth) < opts.min_snowflake_health) {
    reasons.push(`snowflake_health<${opts.min_snowflake_health} (got ${sfHealth})`);
  }

  const mcap =
    Number(event?.signals?.market_cap_inr) ||
    Number(deep?.overview?.market_cap_inr) ||
    0;
  if (mcap < opts.min_market_cap_inr) {
    reasons.push(`market_cap<₹${opts.min_market_cap_inr / 1e7}Cr (got ₹${(mcap / 1e7).toFixed(0)}Cr)`);
  }

  const surveillance = (ctx && ctx.surveillance) || {};
  const symbol = event.symbol;
  const asm = surveillance.ASM instanceof Set ? surveillance.ASM : new Set(surveillance.ASM || []);
  const gsm = surveillance.GSM instanceof Set ? surveillance.GSM : new Set(surveillance.GSM || []);
  if (asm.has(symbol) || gsm.has(symbol)) {
    reasons.push("on-asm-gsm");
  }

  return { passed: reasons.length === 0, reasons };
}

// Compute position size in INR given market_cap (ADV proxy). Capped at
// max_position_inr per the adversarial A7 patch.
export function sizePosition(marketCapInr, opts = EARNINGS_EDGE_FILTER) {
  const mcap = Number(marketCapInr);
  if (!Number.isFinite(mcap) || mcap <= 0) return 0;
  // 20d ADV ≈ mcap × 1% as a rough proxy. 0.25% of ADV = 0.0025% of mcap.
  const adv_proxy = mcap * 0.01;
  const raw = adv_proxy * opts.position_pct_of_adv;
  return Math.min(raw, opts.max_position_inr);
}

// Evaluate exit signal for an open trade.
// trade:  { entry_date, entry_price_inr }
// current: { close_price_inr, peak_close_inr, days_held }
export function evaluateExit(trade, current, opts = EARNINGS_EDGE_FILTER) {
  if (!trade || !current) return { action: "HOLD", reason: "insufficient-data" };
  const days = Number(current.days_held);
  const entry = Number(trade.entry_price_inr);
  const close = Number(current.close_price_inr);
  const peak = Number(current.peak_close_inr ?? close);

  if (Number.isFinite(entry) && Number.isFinite(close) && entry > 0) {
    const ret_from_entry_pct = ((close - entry) / entry) * 100;
    if (ret_from_entry_pct <= opts.hard_stop_pct) {
      return { action: "EXIT", reason: `hard-stop ${ret_from_entry_pct.toFixed(1)}% ≤ ${opts.hard_stop_pct}%` };
    }
  }

  if (Number.isFinite(peak) && Number.isFinite(close) && peak > 0) {
    const ret_from_peak_pct = ((close - peak) / peak) * 100;
    if (ret_from_peak_pct <= opts.trailing_stop_pct) {
      return { action: "EXIT", reason: `trail ${ret_from_peak_pct.toFixed(1)}% ≤ ${opts.trailing_stop_pct}% from peak` };
    }
  }

  if (Number.isFinite(days) && days >= opts.hold_days) {
    return { action: "EXIT", reason: `hold-${opts.hold_days}d-reached` };
  }

  return { action: "HOLD", reason: "ok" };
}
