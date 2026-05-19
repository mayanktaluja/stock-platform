// Compounder Lab — pure-logic filter + ranker.
//
// SAFE sleeve from ~/.claude/plans/sws-alpha-strategy-2026-05-19.md. The filter
// rejects everything that fails the Marcellus-style quality screen, then sorts
// the survivors by AnalystConsensus FV upside_pct DESC. Top BASKET_SIZE names
// become the basket.
//
// The adversarial pass (sub-plan -adversarial.md A2) killed the original
// "10y ROCE ≥ 15% + 10y revenue CAGR ≥ 10%" filter because `fiscal.yearly_history`
// has 5 rows max and no ROCE field. The Snowflake-pillar proxy below yields a
// ~658-name candidate pool empirically, which the upside-pct rank trims to
// BASKET_SIZE.

export const COMPOUNDER_FILTER = Object.freeze({
  min_snowflake_past: 5,
  min_snowflake_health: 4,
  min_snowflake_dividend: 4,
  // ADV data isn't on disk; market_cap_inr is the realistic proxy. ₹500Cr cap
  // ≈ ₹10Cr 20d ADV for liquid Indian large/midcaps. Raised from the original
  // ₹5Cr ADV gate per adversarial A7.
  min_market_cap_inr: 500_00_00_000,
  // Hard-rejection keyword list against SWS `risks[]`. These are the
  // balance-sheet flags Marcellus would never tolerate.
  forbidden_risk_keywords: Object.freeze([
    "interest payments are not well covered",
    "debt is not well covered",
    "high level of debt",
    "unprofitable",
    "shareholders have been diluted",
  ]),
  // Must be inside this band on fair-value reconcile (rejects FV-imputed or
  // mismatched entries).
  forbidden_fv_reconcile_reasons: Object.freeze(["fv_missing", "fv_imputed"]),
  basket_size: 20,
});

// Normalised entry shape this module consumes. The refresh script composes
// these from sws-scored-universe.json (ranking fields) + deep JSON
// (snowflake pillars + risks).
//
// {
//   ticker, name, sector, sws_url,
//   snowflake_past, snowflake_health, snowflake_dividend,
//   risks: string[],
//   market_cap_inr, current_price_inr, fair_value_inr, upside_pct,
//   fv_reconcile_reason
// }

function getRiskHit(entry, keywords) {
  const risks = Array.isArray(entry?.risks) ? entry.risks : [];
  const lowered = risks.map((r) => String(r || "").toLowerCase());
  for (const kw of keywords) {
    const hit = lowered.find((r) => r.includes(kw));
    if (hit) return hit;
  }
  return null;
}

export function applyCompounderFilter(entry, opts = COMPOUNDER_FILTER) {
  if (!entry || typeof entry !== "object") {
    return { passed: false, reasons: ["invalid-entry"] };
  }
  const reasons = [];

  const sfPast = Number(entry.snowflake_past);
  const sfHealth = Number(entry.snowflake_health);
  const sfDiv = Number(entry.snowflake_dividend);
  if (!Number.isFinite(sfPast) || sfPast < opts.min_snowflake_past) {
    reasons.push(`snowflake_past<${opts.min_snowflake_past} (got ${sfPast})`);
  }
  if (!Number.isFinite(sfHealth) || sfHealth < opts.min_snowflake_health) {
    reasons.push(`snowflake_health<${opts.min_snowflake_health} (got ${sfHealth})`);
  }
  if (!Number.isFinite(sfDiv) || sfDiv < opts.min_snowflake_dividend) {
    reasons.push(`snowflake_dividend<${opts.min_snowflake_dividend} (got ${sfDiv})`);
  }

  const mcap = Number(entry.market_cap_inr);
  if (!Number.isFinite(mcap) || mcap < opts.min_market_cap_inr) {
    reasons.push(`market_cap<₹${opts.min_market_cap_inr / 1e7}Cr (got ₹${mcap / 1e7}Cr)`);
  }

  // upside_pct must be a real number — Number(null) coerces to 0, which is
  // technically finite, so explicit null/undefined check first.
  if (entry.upside_pct == null || !Number.isFinite(Number(entry.upside_pct))) {
    reasons.push("upside_pct-missing");
  }

  const riskHit = getRiskHit(entry, opts.forbidden_risk_keywords);
  if (riskHit) reasons.push(`risk-keyword:${riskHit}`);

  const fvReason = String(entry.fv_reconcile_reason || "").toLowerCase();
  if (opts.forbidden_fv_reconcile_reasons.includes(fvReason)) {
    reasons.push(`fv_reconcile:${fvReason}`);
  }

  return { passed: reasons.length === 0, reasons };
}

// Ranks an array of normalised entries by upside_pct DESC and returns the
// top BASKET_SIZE that pass the filter, plus a tally of rejection reasons.
export function rankCompounderCandidates(entries, opts = COMPOUNDER_FILTER) {
  if (!Array.isArray(entries)) {
    throw new Error("rankCompounderCandidates: entries must be array");
  }
  const passed = [];
  const rejected = [];
  const rejection_tally = Object.create(null);
  for (const e of entries) {
    const v = applyCompounderFilter(e, opts);
    if (v.passed) {
      passed.push(e);
    } else {
      rejected.push({ ticker: e?.ticker, reasons: v.reasons });
      for (const r of v.reasons) {
        const key = r.split(":")[0].split("<")[0]; // bucket
        rejection_tally[key] = (rejection_tally[key] || 0) + 1;
      }
    }
  }
  passed.sort((a, b) => Number(b.upside_pct) - Number(a.upside_pct));
  const basket = passed.slice(0, opts.basket_size);
  return {
    basket,
    passed_count: passed.length,
    rejected_count: rejected.length,
    rejection_tally,
    rejected_sample: rejected.slice(0, 20),
  };
}
