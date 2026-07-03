// entryAlert — pure formatter for entry-timing transition alerts (Two-Key Entry PR-3).
import assert from "node:assert";
import { formatEntryTransition, stateLabel } from "../services/alerts/entryAlert.js";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (e) {
    failed++;
    console.error(`  not ok ${name}\n    ${e.message}`);
  }
}

const CONFIRMED = {
  ticker: "HINDCOPPER",
  from: "STABILIZING",
  to: "ENTRY_CONFIRMED",
  price_inr: 494.95,
  state_nights: 2,
  no_chase_inr: 643.76,
  invalidation_inr: 455,
  tranches: [
    { pct: 0.4, trigger_price_inr: 495, label: "Initiate at anchor" },
    { pct: 0.35, trigger_price_inr: 470, label: "Add on measured pullback" },
    { pct: 0.25, trigger_price_inr: 446, label: "Final add at deep-value level" },
  ],
};

check("→ENTRY_CONFIRMED: breaking, ladder + levels + key", () => {
  const a = formatEntryTransition(Object.freeze({ ...CONFIRMED }));
  assert.ok(a, "alert expected");
  assert.equal(a.breaking, true);
  // ledgerKey hashes ["entry", ticker, to] → 24-hex (repo convention); assert
  // shape + determinism + ticker-sensitivity rather than substring content.
  assert.match(a.key, /^[0-9a-f]{24}$/);
  const again = formatEntryTransition({ ...CONFIRMED });
  assert.equal(again.key, a.key, "same transition → same dedup key");
  const other = formatEntryTransition({ ...CONFIRMED, ticker: "OTHER" });
  assert.notEqual(other.key, a.key, "different ticker → different key");
  for (const frag of ["HINDCOPPER", "entry window opened", "T1 40% @ ₹495", "T2 35% @ ₹470", "T3 25% @ ₹446", "No-chase above ₹644", "Invalidation ₹455"]) {
    assert.ok(a.text.includes(frag), `text missing "${frag}" — got:\n${a.text}`);
  }
  assert.ok(!a.text.includes("undefined"));
});

check("→ENTRY_CONFIRMED without tranches degrades to flag price, no 'undefined'", () => {
  const a = formatEntryTransition({ ticker: "X", from: "FALLING_KNIFE", to: "ENTRY_CONFIRMED", price_inr: 101.5 });
  assert.ok(a && a.breaking);
  assert.ok(a.text.includes("₹102") || a.text.includes("₹101.5"), a.text);
  assert.ok(!a.text.includes("undefined"));
});

check("non-knife → FALLING_KNIFE: routine (not breaking), 'was' label", () => {
  const a = formatEntryTransition({ ticker: "FLAIR", from: "STABILIZING", to: "FALLING_KNIFE", price_inr: 267.5 });
  assert.ok(a);
  assert.equal(a.breaking, false);
  assert.ok(a.text.includes("falling knife"));
  assert.ok(a.text.includes(stateLabel("STABILIZING")));
});

check("first sighting (from=null) → FALLING_KNIFE still alerts", () => {
  const a = formatEntryTransition({ ticker: "NEWCO", from: null, to: "FALLING_KNIFE" });
  assert.ok(a);
  assert.ok(!a.text.includes("(was"), "no 'was' clause when from is null");
});

check("FALLING_KNIFE → STABILIZING: base forming", () => {
  const a = formatEntryTransition({ ticker: "Y", from: "FALLING_KNIFE", to: "STABILIZING" });
  assert.ok(a);
  assert.equal(a.breaking, false);
  assert.ok(a.text.includes("base forming"));
});

check("non-alertable transitions → null", () => {
  assert.equal(formatEntryTransition({ ticker: "A", from: "STABILIZING", to: "MACRO_DEFER" }), null);
  assert.equal(formatEntryTransition({ ticker: "A", from: "ENTRY_CONFIRMED", to: "STABILIZING" }), null);
  assert.equal(formatEntryTransition({ ticker: "A", from: "ENTRY_CONFIRMED", to: "NO_DATA" }), null);
  assert.equal(formatEntryTransition({ ticker: "A", from: "FALLING_KNIFE", to: "FALLING_KNIFE" }), null);
  assert.equal(formatEntryTransition({ ticker: "", to: "ENTRY_CONFIRMED" }), null);
  assert.equal(formatEntryTransition(null), null);
});

check("HTML escaping: M&M ticker renders escaped, never raw &", () => {
  const a = formatEntryTransition({ ticker: "M&M", from: "STABILIZING", to: "FALLING_KNIFE" });
  assert.ok(a.text.includes("M&amp;M"), a.text);
});

console.log(`\nentryAlert result: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
