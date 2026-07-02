import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTopUpBadgeCap,
  computeTopUpCapK,
  isTopUpCapEnabled,
} from "../services/portfolio/topUpCapPolicy.js";
import { ALL_TOPUP_ACTIONS, CAPPED_TOPUP_ACTION } from "../services/actionLadder.js";
import { buildIssuedEvents } from "../services/recommendationMemory.js";

function holding({
  ticker,
  action = "Top-up-33%",
  v4 = 60,
  upside = 20,
  positionWeight = 3,
  swsCovered = true,
  reasons = ["existing reason"],
} = {}) {
  return {
    symbol: ticker,
    swsCovered,
    action,
    reasons: [...reasons],
    positionWeight,
    sws: { ticker, v4_score: v4, upside_pct: upside },
  };
}

test("computeTopUpCapK: strict min(5, ceil(10% of book))", () => {
  assert.equal(computeTopUpCapK(8), 1);
  assert.equal(computeTopUpCapK(20), 2);
  assert.equal(computeTopUpCapK(35), 4);
  assert.equal(computeTopUpCapK(60), 5);
  assert.equal(computeTopUpCapK(1), 1);
  assert.equal(computeTopUpCapK(0), 0);
});

test("cap keeps top-k by shared rank and demotes the rest to Top-up-if-funded", () => {
  const hs = [
    holding({ ticker: "AAA", v4: 80, upside: 30 }),
    holding({ ticker: "BBB", v4: 70, upside: 25 }),
    holding({ ticker: "CCC", v4: 60, upside: 20 }),
    holding({ ticker: "DDD", v4: 50, upside: 15 }),
    ...Array.from({ length: 16 }, (_, i) => holding({ ticker: `H${i}`, action: "HOLD" })),
  ];
  const summary = applyTopUpBadgeCap(hs, { enabled: true }); // book 20 → k 2
  assert.equal(summary.k, 2);
  assert.equal(summary.candidateCount, 4);
  assert.deepEqual(summary.kept.map((x) => x.ticker), ["AAA", "BBB"]);
  assert.deepEqual(summary.demotedByRank.map((x) => x.ticker), ["CCC", "DDD"]);

  const ccc = hs.find((h) => h.symbol === "CCC");
  assert.equal(ccc.action, CAPPED_TOPUP_ACTION);
  assert.equal(ccc.preCapAction, "Top-up-33%");
  assert.equal(ccc.displayActionIntent, "Top-up (if funded)");
  assert.equal(ccc.topUpCap.capped, true);
  assert.equal(ccc.topUpCap.stage, "rank");
  assert.equal(ccc.topUpCap.rank, 3);
  assert.match(ccc.reasons[0], /ranked #3 of 4 add candidates/);
  assert.match(ccc.reasons[0], /not a thesis downgrade/);
  assert.equal(ccc.reasons[1], "existing reason");

  const aaa = hs.find((h) => h.symbol === "AAA");
  assert.equal(aaa.action, "Top-up-33%");
  assert.equal(aaa.topUpCap.capped, false);
  assert.equal(aaa.topUpCap.rank, 1);
});

test("fewer candidates than k is a no-op; HOLDs are never promoted", () => {
  const hs = [
    holding({ ticker: "AAA" }),
    ...Array.from({ length: 39 }, (_, i) => holding({ ticker: `H${i}`, action: "HOLD" })),
  ];
  const summary = applyTopUpBadgeCap(hs, { enabled: true }); // book 40 → k 4
  assert.equal(summary.k, 4);
  assert.equal(summary.demotedByRank.length, 0);
  assert.equal(hs.filter((h) => h.action === "HOLD").length, 39);
  assert.equal(hs[0].action, "Top-up-33%");
});

test("zero candidates → clean empty summary", () => {
  const hs = Array.from({ length: 10 }, (_, i) => holding({ ticker: `H${i}`, action: "HOLD" }));
  const summary = applyTopUpBadgeCap(hs, { enabled: true });
  assert.equal(summary.candidateCount, 0);
  assert.deepEqual(summary.kept, []);
  assert.deepEqual(summary.demotedByRank, []);
});

test("tie determinism: equal rank falls back to upside, v4, then ticker asc", () => {
  // Same v4/upside/pw → identical rankScore; ticker asc breaks the tie.
  const mk = () => [
    holding({ ticker: "ZZZ", v4: 60, upside: 20 }),
    holding({ ticker: "AAA", v4: 60, upside: 20 }),
    ...Array.from({ length: 8 }, (_, i) => holding({ ticker: `H${i}`, action: "HOLD" })),
  ];
  const a = mk(); // book 10 → k 1
  const b = mk().reverse();
  const sa = applyTopUpBadgeCap(a, { enabled: true });
  const sb = applyTopUpBadgeCap(b, { enabled: true });
  assert.deepEqual(sa.kept.map((x) => x.ticker), ["AAA"]);
  assert.deepEqual(sb.kept.map((x) => x.ticker), ["AAA"]);
});

test("hard-override reductions and EXITs pass through byte-identical", () => {
  const red = holding({ ticker: "RED", action: "Reduction-50%" });
  const exi = holding({ ticker: "EXI", action: "EXIT-now" });
  const before = JSON.stringify([red, exi]);
  applyTopUpBadgeCap([red, exi, holding({ ticker: "AAA" })], { enabled: true });
  // strip the topUpCap stamp the kept candidate gets; reductions get none
  assert.equal(JSON.stringify([red, exi]), before);
});

test("uncovered holdings are ignored for both bookCount and candidacy", () => {
  const hs = [
    holding({ ticker: "AAA" }),
    holding({ ticker: "UNC", swsCovered: false }),
    ...Array.from({ length: 7 }, (_, i) => holding({ ticker: `H${i}`, action: "HOLD" })),
  ];
  const summary = applyTopUpBadgeCap(hs, { enabled: true });
  assert.equal(summary.bookCount, 8);
  assert.equal(hs.find((h) => h.symbol === "UNC").action, "Top-up-33%"); // untouched
});

test("SWS_TOPUP_CAP=0 disables the cap; default is enabled", () => {
  assert.equal(isTopUpCapEnabled({ SWS_TOPUP_CAP: "0" }), false);
  assert.equal(isTopUpCapEnabled({}), true);
  const hs = Array.from({ length: 10 }, (_, i) => holding({ ticker: `T${i}` }));
  const summary = applyTopUpBadgeCap(hs, { env: { SWS_TOPUP_CAP: "0" } });
  assert.equal(summary.enabled, false);
  assert.equal(hs.filter((h) => h.action === "Top-up-33%").length, 10);
});

test("CAPPED_TOPUP_ACTION is in ALL_TOPUP_ACTIONS (basket/candidate surfaces keep rows)", () => {
  assert.ok(ALL_TOPUP_ACTIONS.has(CAPPED_TOPUP_ACTION));
});

test("ledger: buildIssuedEvents never mints ISSUED for Top-up-if-funded", () => {
  const hs = [
    holding({ ticker: "AAA" }),
    holding({ ticker: "BBB", v4: 50 }),
    ...Array.from({ length: 8 }, (_, i) => holding({ ticker: `H${i}`, action: "HOLD" })),
  ];
  applyTopUpBadgeCap(hs, { enabled: true }); // k=1 → BBB demoted
  const demoted = hs.find((h) => h.symbol === "BBB");
  assert.equal(demoted.action, CAPPED_TOPUP_ACTION);
  const { events } = buildIssuedEvents({
    scoredHoldings: hs.map((h) => ({ ...h, isin: null })),
    newSnap: { asOfDateIso: "2026-07-02" },
    openRecsAfterReconcile: new Map(),
  });
  const symbols = events.map((e) => e.symbol);
  assert.ok(symbols.includes("AAA"), "kept top-up should mint ISSUED");
  assert.ok(!symbols.includes("BBB"), "capped candidate must not mint ISSUED");
});
