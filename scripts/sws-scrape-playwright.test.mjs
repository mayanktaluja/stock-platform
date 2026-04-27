// Smoke tests for the Playwright SWS driver — covers anti-detection helpers,
// concurrency/pipeline locks, and the assemble path against a synthetic capture
// set. Does NOT touch Playwright (no browser launch, no network).
//
// Run: node scripts/sws-scrape-playwright.test.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  shuffleTabs,
  maybePickRevisitTab,
  pickSessionStockCount,
  withinCircadianWindow,
  isWeeklyRestDay,
} from "./sws-anti-detect.mjs";
import { SUB_TABS, HUMANISATION } from "./sws-config.mjs";
import { parseStock } from "./sws-parse-capture.mjs";

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function bad(label, msg) { fail++; console.log(`  ✗ ${label}\n      ${msg}`); }
function assert(label, cond) { cond ? ok(label) : bad(label, "assertion failed"); }
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  a === e ? ok(label) : bad(label, `\n      got:      ${a}\n      expected: ${e}`);
}

console.log("\n[anti-detect: shuffleTabs]");
{
  const out = shuffleTabs(SUB_TABS);
  assert("returns same length", out.length === SUB_TABS.length);
  assertEq("preserves set", [...out].sort(), [...SUB_TABS].sort());
  assert("does not mutate input", SUB_TABS.length === 7);
  // Eventually shuffles to something non-identity (probabilistic; allow up to 10 tries)
  let differs = false;
  for (let i = 0; i < 10; i++) {
    if (JSON.stringify(shuffleTabs(SUB_TABS)) !== JSON.stringify(SUB_TABS)) { differs = true; break; }
  }
  assert("eventually permutes (probabilistic)", differs || HUMANISATION.shuffleTabs === false);
}

console.log("\n[anti-detect: pickSessionStockCount]");
{
  for (let i = 0; i < 20; i++) {
    const n = pickSessionStockCount();
    if (n < HUMANISATION.sessionStockCountRange[0] || n > HUMANISATION.sessionStockCountRange[1]) {
      bad("session count in range", `got ${n}`);
      break;
    }
  }
  ok("session count always in range");
}

console.log("\n[anti-detect: maybePickRevisitTab]");
{
  // 1000 trials → fraction should be near tabRevisitProbability.
  let hits = 0;
  for (let i = 0; i < 1000; i++) {
    if (maybePickRevisitTab(SUB_TABS)) hits++;
  }
  const expected = HUMANISATION.tabRevisitProbability * 1000;
  assert(`revisit hit-rate near ${HUMANISATION.tabRevisitProbability * 100}% (got ${hits}/1000)`,
    Math.abs(hits - expected) < expected * 0.6 + 5);
  assert("returns null for empty input", maybePickRevisitTab([]) === null);
  assert("returns null for single tab", maybePickRevisitTab(["overview"]) === null);
}

console.log("\n[anti-detect: withinCircadianWindow]");
{
  // The function reads "now" and converts to IST. We can't easily mock Date here
  // without DI, but we can assert the return type and that two calls in the same
  // minute agree.
  const a = withinCircadianWindow();
  const b = withinCircadianWindow();
  assert("returns boolean", typeof a === "boolean");
  assert("stable within same call (no spurious random)", a === b);
}

console.log("\n[anti-detect: isWeeklyRestDay]");
{
  // Determinism per (week, shard): same input → same output, every time.
  const fixedDay = new Date("2026-04-27T03:00:00Z"); // a Monday
  for (const sid of [1, 2, 3]) {
    const r1 = isWeeklyRestDay(sid, fixedDay);
    const r2 = isWeeklyRestDay(sid, fixedDay);
    assert(`shard ${sid} deterministic for fixed date`, r1 === r2);
  }
  // Across all 7 ISO weekdays of one fixed week, exactly one should be the rest day per shard.
  for (const sid of [1, 2, 3]) {
    let rests = 0;
    for (let d = 0; d < 7; d++) {
      const dt = new Date("2026-04-27T03:00:00Z");
      dt.setUTCDate(dt.getUTCDate() + d);
      if (isWeeklyRestDay(sid, dt)) rests++;
    }
    assertEq(`shard ${sid} rests exactly 1 day this week`, rests, 1);
  }
}

console.log("\n[deep-scrape CLI: claim-active-shard / release / pipeline-lock]");
{
  // Use a sandbox repo dir so we don't pollute real state.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sws-test-"));
  const dataDir = path.join(sandbox, "data", "sws");
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, SWS_REPO_ROOT_OVERRIDE: sandbox };

  // Spawn the CLI via child_process — it'll use real PATHS so we'd contaminate
  // ./data/sws. Instead, we test the exported functions directly.
  const mod = await import("./sws-deep-scrape.mjs");

  // Pipeline lock: claim once → succeeds; claim again → fails.
  const a = mod.claimPipelineLock();
  assert("pipeline lock first claim acquires", a.acquired === true);
  const b = mod.claimPipelineLock();
  assert("pipeline lock second claim is rejected", b.acquired === false);
  mod.releasePipelineLock();
  const c = mod.claimPipelineLock();
  assert("pipeline lock can be re-claimed after release", c.acquired === true);
  mod.releasePipelineLock();

  // Active-shard cap is HUMANISATION.maxActiveShardsConcurrent (currently 1).
  // Verify the cap by claiming shards in order until one is rejected, then
  // releasing one and re-claiming the next.
  const cap = HUMANISATION.maxActiveShardsConcurrent;
  for (const sid of [1, 2, 3]) mod.releaseActiveShard(sid);
  const claims = [1, 2, 3].map((sid) => mod.claimActiveShard(sid));
  const acquiredCount = claims.filter((r) => r.acquired).length;
  assertEq(`exactly cap=${cap} shards acquire on parallel claim`, acquiredCount, cap);
  // Release the first acquired and verify another can take its slot.
  const firstAcquiredIdx = claims.findIndex((r) => r.acquired);
  mod.releaseActiveShard(firstAcquiredIdx + 1);
  const firstRejectedIdx = claims.findIndex((r) => !r.acquired);
  if (firstRejectedIdx >= 0) {
    const retry = mod.claimActiveShard(firstRejectedIdx + 1);
    assert(`shard ${firstRejectedIdx + 1} acquires after another releases`, retry.acquired === true);
  } else {
    ok("(no rejected shard to retry — cap >= 3)");
  }
  for (const sid of [1, 2, 3]) mod.releaseActiveShard(sid);
}

console.log("\n[parseStock assemble path with synthetic captures]");
{
  // Minimal synthetic capture set — exercises the parseStock orchestration.
  // Real text fidelity is covered by sws-parse-capture.test.mjs.
  const minimalOverview = `
    Reliance Industries
    Snowflake Analysis Solid track record with excellent balance sheet and pays a dividend.
    Valuation 4/6 Future Growth 2/6 Past Performance 3/6 Financial Health 5/6 Dividends 3/6
    Current Share Price ₹1,327.80
    52 Week High ₹1,500.00
    52 Week Low ₹1,100.00
    Beta 1.05
    Market cap ₹17.97t
    1 Month Change 2.5 % 3 Month Change -1.2 % 1 Year Change 12.0 % 3 Year Change 25.0 % 5 Year Change 80.0 %
    23.3% undervalued AnalystConsensusTarget ₹1.73k
    21.6x P/E Ratio 2.1x P/B Ratio 1.5x P/S Ratio
    Earnings per share (EPS) 61.50
    Gross Margin 38.0 % Net Profit Margin 7.5 % Debt/Equity Ratio 35.0 %
    Dividends 0.7 % Current Dividend Yield
    18 % Payout Ratio
    Founded Employees CEO Website 1966 350,000 Mukesh D. Ambani www.ril.com
    Next Earnings Date Apr 30, 2026
    Rewards Trading at 23.3% below estimate of fair value Earnings are forecast to grow 8% per year Pays a reliable dividend
    Risk Analysis No risks detected
  `;
  const captures = {
    overview: minimalOverview,
    valuation: "Valuation 4/6 Rewards Trading at 23.3% below Risk Analysis No risks detected",
    "future-growth": "Future Growth 2/6 Rewards Earnings are forecast to grow 8% per year Risk Analysis No risks detected",
    "past-performance": "Past Performance 3/6 Return on Equity 9.2 % Risk Analysis No risks detected",
    "financial-health": "Financial Health 5/6 Operating cash flow 35 % Risk Analysis No risks detected",
    dividend: "Dividends 3/6 stable and growing over the past Rewards Pays a reliable dividend Risk Analysis No risks detected",
    management: "CEO tenure 25 year independent 60 % Rewards Risk Analysis No risks detected",
    ownership: "Institutional 50 % Insider 49 % Rewards Risk Analysis No risks detected",
  };
  const parsed = parseStock(captures, "RELIANCE");

  assertEq("ticker preserved", parsed.ticker, "RELIANCE");
  assert("parsed_at ISO timestamp", typeof parsed.parsed_at === "string" && parsed.parsed_at.includes("T"));
  assertEq("snowflake values", parsed.overview.snowflake, {
    valuation: 4, future_growth: 2, past_performance: 3, financial_health: 5, dividends: 3,
  });
  assertEq("snowflake_total = 17", parsed.overview.snowflake_total, 17);
  assertEq("current_price_inr", parsed.overview.current_price_inr, 1327.80);
  assertEq("market_cap_inr", parsed.overview.market_cap_inr, 17.97e12);
  assertEq("upside_pct", parsed.overview.upside_pct, 23.3);
  assertEq("multiples.pe", parsed.overview.multiples.pe, 21.6);
  assertEq("multiples.pb", parsed.overview.multiples.pb, 2.1);
  assertEq("next_earnings_date", parsed.overview.next_earnings_date, "2026-04-30");
  assert("rewards is array", Array.isArray(parsed.overview.rewards));
  assert("rewards has at least one item", parsed.overview.rewards.length > 0);

  // Sub-tab keys all present and well-shaped.
  for (const key of ["valuation", "future_growth", "past_performance", "financial_health", "dividend", "management", "ownership"]) {
    assert(`sub-tab block ${key} present`, parsed[key] && typeof parsed[key] === "object");
  }
  assertEq("past_performance.roe_pct", parsed.past_performance.roe_pct, 9.2);
  assertEq("dividend.is_growing", parsed.dividend.is_growing, true);
  assertEq("ownership.institutional_pct", parsed.ownership.institutional_pct, 50);
}

console.log(`\nResult: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
