// The router gained an OPTIONAL `loudGate` dep. These specs pin both halves of
// that contract: legacy behaviour when it's absent (so every existing caller and
// spec keeps working), and severity-aware loudness when it's injected.

import { strict as assert } from "node:assert";
import { routeMessage } from "../services/alerts/newsRouter.js";
import { compileWatchlist } from "../services/alerts/watchlistGate.js";
import { makeLoudGate } from "../services/alerts/loudGate.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); pass++; }
  catch (err) { console.log(`  not ok - ${name}\n      ${err.message}`); fail++; }
}

const compiledWatchlist = compileWatchlist({
  tickers: ["RELIANCE"],
  aliases: { RELIANCE: ["Reliance Industries", "RIL"] },
  sectorKeywords: [],
});
const macroGateFor = (hits) => ({ match: () => ({ matched: hits.length > 0, hits }) });
const msg = (text) => ({ text, channel: "FinancialJuice", category: "markets", link: "https://t.me/x/1", date: "2026-07-08T12:00:00Z" });

test("[backwards compat] no loudGate → any macro hit is breaking, exactly as before", () => {
  const a = routeMessage(msg("Trump speaks at the White House today"), {
    compiledWatchlist, macroGate: macroGateFor(["trump", "white house"]),
  });
  assert.equal(a.breaking, true, "legacy semantics preserved");
  assert.equal(a.impact, null);
  assert.equal(a.severity, null);
  assert.ok(a.text.startsWith("🔴"));
});

test("with loudGate → a bare Trump remark is NOT breaking and loses the 🔴", () => {
  const a = routeMessage(msg("Trump speaks at the White House today"), {
    compiledWatchlist, macroGate: macroGateFor(["trump", "white house"]), loudGate: makeLoudGate(),
  });
  assert.equal(a.breaking, false);
  assert.equal(a.severity, "LOW");
  assert.ok(typeof a.impact === "number");
  assert.ok(!a.text.startsWith("🔴"), "no loud marker on a quiet message");
});

test("with loudGate → a missile strike stays breaking + 🔴", () => {
  const a = routeMessage(msg("Missile strike on oil facility, crude surges"), {
    compiledWatchlist, macroGate: macroGateFor(["missile", "crude oil"]), loudGate: makeLoudGate(),
  });
  assert.equal(a.breaking, true);
  assert.equal(a.severity, "HIGH");
  assert.ok(a.text.startsWith("🔴"));
});

test("with loudGate → a watchlist ticker is always breaking, quiet headline or not", () => {
  const a = routeMessage(msg("Reliance Industries to hold a board meeting"), {
    compiledWatchlist, macroGate: macroGateFor([]), loudGate: makeLoudGate(),
  });
  assert.equal(a.breaking, true);
  assert.deepEqual(a.symbols, ["RELIANCE"]);
  assert.ok(a.tags.includes("⭐"));
});

test("a non-loud message still routes to its topic (coverage preserved)", () => {
  const a = routeMessage(msg("Nifty edges up in a quiet session"), {
    compiledWatchlist, macroGate: macroGateFor(["nifty"]), loudGate: makeLoudGate(),
  });
  assert.ok(a, "message is NOT dropped");
  assert.equal(a.topic, "markets");
  assert.equal(a.breaking, false, "posts silently, but it posts");
});

test("dedup key is unchanged by the loudGate (ledger continuity)", () => {
  const withGate = routeMessage(msg("Fed cuts rates by 25bps"), {
    compiledWatchlist, macroGate: macroGateFor(["fed", "rate cut"]), loudGate: makeLoudGate(),
  });
  const without = routeMessage(msg("Fed cuts rates by 25bps"), {
    compiledWatchlist, macroGate: macroGateFor(["fed", "rate cut"]),
  });
  assert.equal(withGate.key, without.key);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
