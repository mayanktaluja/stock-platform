/**
 * Tests for recommendationLedgerStorage pure helpers.
 *
 * Run with: node test/recommendationLedger.test.mjs
 */

import {
  isClosedTerminal,
  evictExpiredClosedEvents,
  LEDGER_TTL_MONTHS,
} from "../recommendationLedgerStorage.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

console.log("\nisClosedTerminal\n");

{
  assert("EXECUTED is terminal", isClosedTerminal("EXECUTED") === true, false);
  assert("EXECUTED_OVER is terminal", isClosedTerminal("EXECUTED_OVER") === true, false);
  assert("SUPERSEDED is terminal", isClosedTerminal("SUPERSEDED") === true, false);
  assert("RESOLVED_NATURAL is terminal", isClosedTerminal("RESOLVED_NATURAL") === true, false);
  assert("RESOLVED_THESIS_INVERTED is terminal", isClosedTerminal("RESOLVED_THESIS_INVERTED") === true, false);
  assert("RESOLVED_NO_DATA is terminal", isClosedTerminal("RESOLVED_NO_DATA") === true, false);
  assert("ORPHANED is terminal", isClosedTerminal("ORPHANED") === true, false);
  assert("ISSUED is NOT terminal", isClosedTerminal("ISSUED") === false, true);
  assert("EXECUTED_PARTIAL is NOT terminal", isClosedTerminal("EXECUTED_PARTIAL") === false, true);
}

console.log("\nevictExpiredClosedEvents — closed-rec eviction with open guard\n");

const NOW = new Date("2026-05-08T00:00:00.000Z");
function isoMonthsAgo(months) {
  const d = new Date(NOW);
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

{
  const events = [
    { type: "ISSUED",   recId: "R1", at: isoMonthsAgo(LEDGER_TTL_MONTHS + 6), symbol: "TCS" },
    { type: "EXECUTED", recId: "R1", at: isoMonthsAgo(LEDGER_TTL_MONTHS + 5) },
    { type: "ISSUED",   recId: "R2", at: isoMonthsAgo(LEDGER_TTL_MONTHS + 6), symbol: "ITC" },
    { type: "ISSUED",   recId: "R3", at: isoMonthsAgo(2), symbol: "INFY" },
    { type: "EXECUTED", recId: "R3", at: isoMonthsAgo(1) },
  ];
  const after = evictExpiredClosedEvents(events, NOW);
  assert("R1 (closed + expired) is dropped", !after.some((e) => e.recId === "R1"), after.map((e) => e.recId));
  assert("R2 (open + expired) is RETAINED — open-state guard",
    after.some((e) => e.recId === "R2"), after.map((e) => e.recId));
  assert("R3 (closed + recent) is retained",
    after.filter((e) => e.recId === "R3").length === 2, after.filter((e) => e.recId === "R3").length);
}

{
  const events = [
    { type: "ISSUED", recId: "R-OLD-OPEN", at: isoMonthsAgo(LEDGER_TTL_MONTHS + 12), symbol: "ABC" },
  ];
  const after = evictExpiredClosedEvents(events, NOW);
  assert("ancient open ISSUED never evicted",
    after.some((e) => e.recId === "R-OLD-OPEN"), after.map((e) => e.recId));
}

{
  const events = [
    { type: "ISSUED",          recId: "R-PARTIAL", at: isoMonthsAgo(LEDGER_TTL_MONTHS + 6), symbol: "XYZ" },
    { type: "EXECUTED_PARTIAL", recId: "R-PARTIAL", at: isoMonthsAgo(LEDGER_TTL_MONTHS + 5) },
  ];
  const after = evictExpiredClosedEvents(events, NOW);
  assert("EXECUTED_PARTIAL chain not evicted (still open)",
    after.length === 2, after.length);
}

{
  const events = [
    { type: "ISSUED",     recId: "R-MULTI", at: isoMonthsAgo(LEDGER_TTL_MONTHS + 6), symbol: "MMM" },
    { type: "SUPERSEDED", recId: "R-MULTI", at: isoMonthsAgo(LEDGER_TTL_MONTHS + 5), bySupersedingRecId: "R-NEW" },
    { type: "ISSUED",     recId: "R-NEW",   at: isoMonthsAgo(LEDGER_TTL_MONTHS + 5), symbol: "MMM" },
  ];
  const after = evictExpiredClosedEvents(events, NOW);
  assert("superseded recId fully evicted",
    !after.some((e) => e.recId === "R-MULTI"), after.map((e) => e.recId));
  assert("superseder (still open) retained",
    after.some((e) => e.recId === "R-NEW"), after.map((e) => e.recId));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
