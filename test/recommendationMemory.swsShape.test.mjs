import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIssuedEvents,
  detectMaterialChange,
} from "../services/recommendationMemory.js";

test("cooldown material-change detection reads SWS v4 score and SWS surveillance", () => {
  const reason = detectMaterialChange({
    direction: "sell",
    candidate: {
      sws: {
        v4_score: 60,
        surveillance: { list: "GSM", stage: 1 },
      },
      ladderSeverity: 0.2,
    },
    executedEvent: {
      scoreAtExecution: 70,
      severityAtExecution: 0.2,
      surveillanceAtExecution: null,
    },
  });
  assert.equal(reason, "v3_drop_10pt");
});

test("issued recommendation events persist SWS v4 score, ladder severity, and surveillance", () => {
  const { events } = buildIssuedEvents({
    scoredHoldings: [{
      symbol: "AAA",
      isin: "INE000A01000",
      quantity: 10,
      action: "Reduction-25%",
      swsCovered: true,
      trimRupees: 12_500,
      positionWeight: 5,
      ladderSeverity: 0.42,
      sws: {
        ticker: "AAA",
        v4_score: 44,
        surveillance: { list: "ASM", stage: 2 },
      },
    }],
    newSnap: { asOfDateIso: "2026-05-26" },
    openRecsAfterReconcile: new Map(),
    ledgerEvents: [],
    reconcileEvents: [],
    now: new Date("2026-05-26T10:00:00Z"),
  });
  const issued = events.find((e) => e.type === "ISSUED");
  assert.ok(issued);
  assert.equal(issued.scoreAtIssue, 44);
  assert.equal(issued.severity, 0.42);
  assert.deepEqual(issued.surveillanceAtIssue, { list: "ASM", stage: 2 });
});
