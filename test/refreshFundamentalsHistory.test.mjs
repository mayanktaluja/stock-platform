// PR 2 — services/fundamentals/fundamentalsRefreshPlanner.js unit tests.
//
// Covers the pure planning logic behind the quota-aware fundamentals
// refresh: staleness classification, NEW-before-STALE ordering, the
// Yahoo call budget cap, 24h failure backoff, manual-override merge,
// and universe-drift detection. No Yahoo, no filesystem.

import assert from "node:assert/strict";
import {
  toNseSymbol,
  latestQuarterEndIso,
  classifyStock,
  selectRefreshTargets,
  mergeOverrides,
  computeDrift,
  CALLS_NEW,
  CALLS_STALE,
} from "../services/fundamentals/fundamentalsRefreshPlanner.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

const TODAY = "2026-05-14";
const NOW_MS = new Date(TODAY + "T12:00:00Z").getTime();

/* ─────────────────────────── toNseSymbol ────────────────────────── */

console.log("[1] toNseSymbol");
it("bare ticker → .NS", () => assert.equal(toNseSymbol("RELIANCE"), "RELIANCE.NS"));
it(".NS passes through", () => assert.equal(toNseSymbol("TCS.NS"), "TCS.NS"));
it(".BO passes through", () => assert.equal(toNseSymbol("500325.BO"), "500325.BO"));
it("garbage → null", () => assert.equal(toNseSymbol(null), null));

/* ──────────────────────── latestQuarterEndIso ───────────────────── */

console.log("[2] latestQuarterEndIso");
it("picks most recent quarterly endDate", () => {
  const e = { quarterly: [{ endDate: "2025-09-30" }, { endDate: "2025-12-31" }] };
  assert.equal(latestQuarterEndIso(e), "2025-12-31");
});
it("falls back to annual when no quarterly", () => {
  const e = { quarterly: [], annual: [{ endDate: "2025-03-31" }] };
  assert.equal(latestQuarterEndIso(e), "2025-03-31");
});
it("no data → null", () => {
  assert.equal(latestQuarterEndIso({ quarterly: [], annual: [] }), null);
  assert.equal(latestQuarterEndIso(undefined), null);
});

/* ───────────────────────── classifyStock ────────────────────────── */

console.log("[3] classifyStock");
it("absent entry → new (4 calls)", () => {
  const c = classifyStock("FOO.NS", undefined, { todayIso: TODAY });
  assert.equal(c.status, "new");
  assert.equal(c.estCalls, CALLS_NEW);
});
it("fresh quarterly (within 90d) → fresh (0 calls)", () => {
  const e = { quarterly: [{ endDate: "2026-03-31" }] };
  const c = classifyStock("FOO.NS", e, { todayIso: TODAY, staleAfterDays: 90 });
  assert.equal(c.status, "fresh");
  assert.equal(c.estCalls, 0);
});
it("old quarterly (> 90d) → stale (2 calls)", () => {
  const e = { quarterly: [{ endDate: "2025-09-30" }] };
  const c = classifyStock("FOO.NS", e, { todayIso: TODAY, staleAfterDays: 90 });
  assert.equal(c.status, "stale");
  assert.equal(c.estCalls, CALLS_STALE);
});
it("entry with no quarterly data → stale", () => {
  const c = classifyStock("FOO.NS", { annual: [], quarterly: [] }, { todayIso: TODAY });
  assert.equal(c.status, "stale");
});
it("failed < 24h ago → backoff (0 calls)", () => {
  const e = {
    quarterly: [{ endDate: "2025-09-30" }],
    _meta: { last_failed_at: new Date(NOW_MS - 3 * 3600000).toISOString() },
  };
  const c = classifyStock("FOO.NS", e, { todayIso: TODAY, nowMs: NOW_MS });
  assert.equal(c.status, "backoff");
  assert.equal(c.estCalls, 0);
});
it("failed > 24h ago → no longer backoff (stale again)", () => {
  const e = {
    quarterly: [{ endDate: "2025-09-30" }],
    _meta: { last_failed_at: new Date(NOW_MS - 30 * 3600000).toISOString() },
  };
  const c = classifyStock("FOO.NS", e, { todayIso: TODAY, nowMs: NOW_MS });
  assert.equal(c.status, "stale");
});

/* ──────────────────────── selectRefreshTargets ──────────────────── */

console.log("[4] selectRefreshTargets");
it("NEW stocks ordered before STALE stocks", () => {
  const stocks = {
    "STALE1.NS": { quarterly: [{ endDate: "2025-06-30" }] },
  };
  const plan = selectRefreshTargets({
    universe: ["STALE1", "NEW1", "NEW2"],
    stocks,
    opts: { todayIso: TODAY },
  });
  assert.deepEqual(plan.targets.map((t) => t.symbol), ["NEW1.NS", "NEW2.NS", "STALE1.NS"]);
  assert.equal(plan.counts.new, 2);
  assert.equal(plan.counts.stale, 1);
});
it("budget cap defers overflow (NEW kept, STALE deferred)", () => {
  // 2 NEW (4 calls each = 8) + 2 STALE (2 each = 4) = 12 calls total.
  // Budget 8 → both NEW fit, both STALE deferred.
  const stocks = {
    "S1.NS": { quarterly: [{ endDate: "2025-06-30" }] },
    "S2.NS": { quarterly: [{ endDate: "2025-06-30" }] },
  };
  const plan = selectRefreshTargets({
    universe: ["N1", "N2", "S1", "S2"],
    stocks,
    opts: { todayIso: TODAY, maxFetches: 8 },
  });
  assert.deepEqual(plan.targets.map((t) => t.symbol), ["N1.NS", "N2.NS"]);
  assert.equal(plan.budgetCapped, true);
  assert.equal(plan.skipped.over_budget, 2);
  assert.equal(plan.plannedCalls, 8);
});
it("fresh + backoff stocks are skipped, not queued", () => {
  const stocks = {
    "FRESH.NS": { quarterly: [{ endDate: "2026-04-30" }] },
    "BACK.NS": {
      quarterly: [{ endDate: "2025-01-31" }],
      _meta: { last_failed_at: new Date(NOW_MS - 60000).toISOString() },
    },
  };
  const plan = selectRefreshTargets({
    universe: ["FRESH", "BACK", "NEW"],
    stocks,
    opts: { todayIso: TODAY, nowMs: NOW_MS },
  });
  assert.deepEqual(plan.targets.map((t) => t.symbol), ["NEW.NS"]);
  assert.equal(plan.skipped.fresh, 1);
  assert.equal(plan.skipped.backoff, 1);
});
it("duplicate universe symbols are de-duped", () => {
  const plan = selectRefreshTargets({
    universe: ["DUP", "DUP.NS", "dup".toUpperCase()],
    stocks: {},
    opts: { todayIso: TODAY },
  });
  assert.equal(plan.targets.length, 1);
});

/* ───────────────────────── mergeOverrides ───────────────────────── */

console.log("[5] mergeOverrides");
it("override entry fully replaces the Yahoo-derived one", () => {
  const stocks = { "FOO.NS": { quarterly: [{ endDate: "2025-06-30", dilutedEPS: 1 }] } };
  const overrides = { "FOO.NS": { quarterly: [{ endDate: "2026-03-31", dilutedEPS: 9 }] } };
  const merged = mergeOverrides(stocks, overrides);
  assert.equal(merged["FOO.NS"].quarterly[0].dilutedEPS, 9);
  assert.equal(merged["FOO.NS"]._meta.source, "manual_override");
});
it("does not mutate input; passes through when no overrides", () => {
  const stocks = { "FOO.NS": { quarterly: [] } };
  const merged = mergeOverrides(stocks, null);
  assert.notEqual(merged, stocks);
  assert.deepEqual(Object.keys(merged), ["FOO.NS"]);
});

/* ────────────────────────── computeDrift ────────────────────────── */

console.log("[6] computeDrift");
it("flags file symbols absent from the live universe", () => {
  const stocks = { "LIVE.NS": {}, "GONE.NS": {}, "ALSOGONE.NS": {} };
  const drift = computeDrift(stocks, new Set(["LIVE.NS"]));
  assert.deepEqual(drift, ["ALSOGONE.NS", "GONE.NS"]);
});
it("no drift when universe covers everything", () => {
  assert.deepEqual(computeDrift({ "A.NS": {} }, new Set(["A.NS", "B.NS"])), []);
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
