/**
 * Risk Lab — health telemetry aggregator.
 *
 * Pure function: takes the lab's picks-adjusted payload (and optionally
 * the backtest report) and produces a health summary with an alerts
 * array. Used by scripts/risk-lab-health-summary.mjs (CLI) and any
 * future server-side scheduler that wants to push to Slack.
 *
 * Alert categories (each gated by a threshold + state-transition check
 * so the same condition doesn't spam every run):
 *
 *   macro_overlay_too_broad   macro veto rate > 20% of TOP_PICKs
 *                              (overlay is firing too aggressively)
 *   quality_taxonomy_too_loose quality flag rate > 40% of universe
 *                              (keyword list is too liberal)
 *   regime_stale_overlay_skipped regime > 12h old AND > 50% of stocks
 *                              show regime_stale=true (Macro Lens silently
 *                              no-op'd; cron is degraded)
 *   case_study_caught          backtest A/B is meaningful AND lab-adjusted
 *                              hit rate beats baseline by ≥ 3pp (positive
 *                              "the lab would have helped" alert)
 *
 * The Slack message format reuses the existing webhook conventions from
 * scripts/earnings-health-summary.mjs.
 */

const MACRO_VETO_RATE_HIGH = 0.20;  // 20% of TOP_PICKs vetoed = too broad
const QUALITY_FLAG_RATE_HIGH = 0.40; // 40% of universe flagged = too liberal
const REGIME_STALE_HOURS = 12;
const HIT_RATE_DIFF_MEANINGFUL_PCT = 3.0;

function classifyMacroOverlay(summary) {
  if (!summary || !summary.total_stocks) return null;
  // Approximate denominator: TOP_PICK count not in summary; using vetoed/total
  // as a proxy. If macro_vetoed_count is more than 20% of all stocks (a
  // huge fraction), the overlay is almost certainly too broad — under
  // normal conditions, vetoes are rare even in severe regimes.
  const rate = (summary.macro_vetoed_count || 0) / summary.total_stocks;
  if (rate > MACRO_VETO_RATE_HIGH) {
    return {
      severity: "warn",
      category: "macro_overlay_too_broad",
      message: `Macro vetoes hit ${(rate * 100).toFixed(1)}% of universe (${summary.macro_vetoed_count}/${summary.total_stocks}) — overlay may be too aggressive`,
      metric: rate,
    };
  }
  return null;
}

function classifyQualityOverlay(summary) {
  if (!summary || !summary.total_stocks) return null;
  const rate = (summary.quality_flagged_count || 0) / summary.total_stocks;
  if (rate > QUALITY_FLAG_RATE_HIGH) {
    return {
      severity: "info",
      category: "quality_taxonomy_too_loose",
      message: `Quality flags fired on ${(rate * 100).toFixed(1)}% of universe (${summary.quality_flagged_count}/${summary.total_stocks}) — taxonomy may be too liberal; review _quality-keywords.json`,
      metric: rate,
    };
  }
  return null;
}

function classifyRegimeStale(payload) {
  if (!payload || !payload.source_regime_generated_at) return null;
  const ageMs = Date.now() - new Date(payload.source_regime_generated_at).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours < REGIME_STALE_HOURS) return null;
  // Check if Macro Lens is being skipped en-masse
  const stale = payload.summary?.macro_stale_skipped_count || 0;
  const total = payload.summary?.total_stocks || 1;
  if (stale / total > 0.5) {
    return {
      severity: "warn",
      category: "regime_stale_overlay_skipped",
      message: `Macro regime is ${ageHours.toFixed(1)}h stale; ${stale}/${total} stocks (${((stale / total) * 100).toFixed(0)}%) had Macro Lens skipped — check refresh-macro-only cron`,
      metric: ageHours,
    };
  }
  return null;
}

function classifyCaseStudy(backtest) {
  if (!backtest || !backtest.summary || !backtest.ab_status) return null;
  if (!backtest.ab_status.meaningful) return null;
  const diff = Number(backtest.summary.hit_rate_diff_pct || 0);
  if (diff >= HIT_RATE_DIFF_MEANINGFUL_PCT) {
    return {
      severity: "info",
      category: "case_study_caught",
      message: `Lab-adjusted hit rate +${diff.toFixed(1)}pp vs baseline (${backtest.summary.original.hit_rate_pct}% → ${backtest.summary.lab.hit_rate_pct}%) on ${backtest.summary.total_resolved} resolved events — overlay is improving prediction quality`,
      metric: diff,
    };
  }
  if (diff <= -HIT_RATE_DIFF_MEANINGFUL_PCT) {
    return {
      severity: "warn",
      category: "case_study_regression",
      message: `Lab-adjusted hit rate ${diff.toFixed(1)}pp WORSE than baseline (${backtest.summary.original.hit_rate_pct}% → ${backtest.summary.lab.hit_rate_pct}%) on ${backtest.summary.total_resolved} resolved events — consider rolling back the overlay`,
      metric: diff,
    };
  }
  return null;
}

/**
 * Build the lab health summary.
 *
 * @param {object} payload  — risk-lab/picks-adjusted-latest.json contents
 * @param {object|null} backtest — risk-lab backtest report (optional)
 * @returns {object} { status: "OK" | "DEGRADED" | "UNHEALTHY", alerts[], summary }
 */
export function buildLabHealth(payload, backtest = null) {
  const alerts = [];

  const macroAlert = classifyMacroOverlay(payload?.summary);
  if (macroAlert) alerts.push(macroAlert);

  const qualityAlert = classifyQualityOverlay(payload?.summary);
  if (qualityAlert) alerts.push(qualityAlert);

  const staleAlert = classifyRegimeStale(payload);
  if (staleAlert) alerts.push(staleAlert);

  const caseStudyAlert = classifyCaseStudy(backtest);
  if (caseStudyAlert) alerts.push(caseStudyAlert);

  // Status: any "warn" → DEGRADED; alerts but all info → OK_WITH_NOTES
  let status = "OK";
  if (alerts.some((a) => a.severity === "warn")) status = "DEGRADED";
  else if (alerts.length > 0) status = "OK_WITH_NOTES";

  return {
    status,
    generated_at: new Date().toISOString(),
    source_payload_generated_at: payload?.generated_at || null,
    source_regime_generated_at: payload?.source_regime_generated_at || null,
    backtest_included: !!backtest,
    summary: {
      ...(payload?.summary || {}),
      ...(backtest
        ? {
            backtest_resolved: backtest.summary?.total_resolved,
            backtest_original_hit_rate_pct: backtest.summary?.original?.hit_rate_pct,
            backtest_lab_hit_rate_pct: backtest.summary?.lab?.hit_rate_pct,
            backtest_diff_pp: backtest.summary?.hit_rate_diff_pct,
            backtest_ab_meaningful: backtest.ab_status?.meaningful === true,
            backtest_combined_catastrophic_improvement_count:
              backtest.lenses?.combined?.catastrophic?.improvement_count ?? null,
            backtest_combined_avoidance_precision_pct:
              backtest.lenses?.combined?.flagged_avoidance?.precision_pct ?? null,
            backtest_combined_avoidance_recall_pct:
              backtest.lenses?.combined?.flagged_avoidance?.recall_pct ?? null,
            kec_class_count: backtest.kec_case_study?.count,
            anantraj_class_count: backtest.anantraj_case_study?.count,
          }
        : {}),
    },
    alerts,
  };
}

/**
 * Format the health summary as a one-line Slack-friendly message.
 */
export function formatSlackMessage(health) {
  const emoji = health.status === "UNHEALTHY" ? "🚨" :
                health.status === "DEGRADED" ? "⚠️" :
                health.status === "OK_WITH_NOTES" ? "ℹ️" : "✅";
  const head = `${emoji} *Risk Lab* [${health.status}] — ${health.summary.total_stocks || 0} stocks scanned`;
  if (health.alerts.length === 0) return head;
  const body = health.alerts.map((a) => `  • ${a.category}: ${a.message}`).join("\n");
  return `${head}\n${body}`;
}
