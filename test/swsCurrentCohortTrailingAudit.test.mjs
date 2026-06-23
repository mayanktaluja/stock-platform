/**
 * SWS current-cohort trailing audit regression.
 *
 * Run with: node test/swsCurrentCohortTrailingAudit.test.mjs
 */

import {
  CURRENT_COHORT_EVIDENCE_BASIS,
  auditCohortTrailingReturn,
  buildCurrentCohortRows,
  computeTrailingReturn,
  normalizeTrailingCohorts,
  normalizeTrailingHorizons,
} from "../services/swsCurrentCohortTrailingAudit.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "-> got", JSON.stringify(got));
  }
}

function pick(ticker, score = 60) {
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: "Industrials",
    current_price_inr: 100,
    v4_score_100: score,
    returns_pct: { "7D": 1, "1M": 2, "3M": 3, "1Y": 4 },
  };
}

function bars(entry, exit) {
  return [
    { date: "2021-06-10", close: entry },
    { date: "2024-06-10", close: exit },
    { date: "2026-06-10", close: exit },
  ];
}

console.log("swsCurrentCohortTrailingAudit.js regression\n");

{
  assert("normalizes supported horizons", JSON.stringify(normalizeTrailingHorizons("3y,5y")) === JSON.stringify(["3y", "5y"]), normalizeTrailingHorizons("3y,5y"));
  let threw = false;
  try { normalizeTrailingHorizons("1y"); } catch { threw = true; }
  assert("rejects unsupported horizon", threw, threw);
  assert("normalizes official cohorts", JSON.stringify(normalizeTrailingCohorts("20,3,5,10")) === JSON.stringify([3, 5, 10, 20]), normalizeTrailingCohorts("20,3,5,10"));
}

{
  const rows = buildCurrentCohortRows({
    scanned_at: "2026-06-10T09:00:00.000Z",
    sections: {
      top_ranked_30_v4: [pick("AAA", 90), pick("BBB", 80), pick("CCC", 70), pick("DDD", 60)],
      best_to_buy_now: [],
      upcoming_earnings: [pick("EVENT", 50)],
      avoid: [pick("AVOID", 10)],
      insider_buying: [],
    },
  }, { cohorts: [3, 20] });
  const top3 = rows.find((r) => r.requested_cohort_size === 3);
  const top20 = rows.find((r) => r.requested_cohort_size === 20);
  const sectionKeys = new Set(rows.map((r) => r.sectionKey));
  assert("cohort extraction reuses section registry", rows.every((r) => r.type === "sws_top30_v3"), rows);
  assert("top 3 takes first three ranked names", top3.constituents.map((c) => c.ticker).join(",") === "AAA,BBB,CCC", top3.constituents);
  assert("partial top 20 is honestly labeled", top20.actual_cohort_size === 4 && top20.cohort_label === "top 4 available", top20);
  assert("default audit excludes context and empty sections", !sectionKeys.has("upcoming_earnings") && !sectionKeys.has("avoid") && !sectionKeys.has("best_to_buy_now") && !sectionKeys.has("insider_buying"), [...sectionKeys]);
}

{
  const result = computeTrailingReturn(bars(100, 160), "5y", "2026-06-10");
  assert("5y trailing return uses start and end close", result.status === "ok" && result.return_pct === 60, result);
}

{
  const row = buildCurrentCohortRows({
    scanned_at: "2026-06-10T09:00:00.000Z",
    sections: {
      top_ranked_30_v4: [pick("AAA", 90), pick("BBB", 80), pick("CCC", 70)],
    },
  }, { sections: "top_ranked_30_v4", cohorts: [3] })[0];
  const histories = new Map([
    ["AAA.NS", bars(100, 160)],
    ["BBB.NS", bars(100, 140)],
    ["CCC.NS", bars(100, 130)],
  ]);
  const out = auditCohortTrailingReturn(row, histories, bars(100, 120), "5y", { endDate: "2026-06-10", minCoveragePct: 80 });
  assert("positive proxy alpha still suppresses claims", out.alpha_pct > 0 && out.claim_allowed === false && out.evidence_basis === CURRENT_COHORT_EVIDENCE_BASIS, out);
  assert("coverage-passing proxy gets low evidence quality, not a proof score", out.coverage_pct === 100 && out.evidence_quality_score === 2, out);
  assert("proxy score is separate from evidence quality", out.performance_proxy_score > out.evidence_quality_score, out);
}

{
  const row = buildCurrentCohortRows({
    scanned_at: "2026-06-10T09:00:00.000Z",
    sections: {
      top_ranked_30_v4: [pick("AAA", 90), pick("BBB", 80), pick("CCC", 70)],
    },
  }, { sections: "top_ranked_30_v4", cohorts: [3] })[0];
  const histories = new Map([["AAA.NS", bars(100, 200)]]);
  const out = auditCohortTrailingReturn(row, histories, bars(100, 120), "5y", { endDate: "2026-06-10", minCoveragePct: 80 });
  assert("coverage below threshold blocks proxy score", out.coverage_pass === false && out.performance_proxy_score === null, out);
  assert("missing returns are explicit quality flags", out.quality_flags.includes("missing_symbol_returns:2"), out.quality_flags);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
