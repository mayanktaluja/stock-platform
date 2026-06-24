/**
 * Run with: node test/newsRouter.test.mjs
 */

import assert from "node:assert/strict";
import { routeMessage } from "../services/alerts/newsRouter.js";
import { compileWatchlist } from "../services/alerts/watchlistGate.js";

const compiledWatchlist = compileWatchlist({
  tickers: ["RELIANCE", "INFY"],
  aliases: { RELIANCE: ["Reliance"] },
});

// Fake macro gate (DI) — matches "fed"/"tariff" word-boundaried.
const macroGate = {
  match: (t) => ({
    matched: /\b(fed|tariff)\b/i.test(t),
    hits: t.match(/\b(fed|tariff)\b/i) || [],
  }),
};

const deps = { compiledWatchlist, macroGate };

// Empty / whitespace text → null.
assert.equal(routeMessage({ text: "" }, deps), null);
assert.equal(routeMessage({ text: "   " }, deps), null);
assert.equal(routeMessage(null, deps), null);

// Plain market headline — no ticker, no macro.
const plain = routeMessage(
  { text: "Markets open higher on light volume", channel: "MarketWire", category: "markets", link: "https://x.com/post" },
  deps,
);
assert.equal(plain.breaking, false);
assert.deepEqual(plain.tags, []);
assert.equal(plain.topic, "markets");
assert.ok(plain.key && typeof plain.key === "string");
assert.equal(plain.buttons.length, 1);
assert.equal(plain.buttons[0].text, "🔗 Source");
assert.equal(plain.buttons[0].url, "https://x.com/post");
assert.ok(plain.text.includes("<b>MarketWire</b>"));

// Watchlist hit → ⭐ tag, symbols, breaking.
const wl = routeMessage(
  { text: "Reliance posts profit beating estimates", channel: "ET", category: "india", link: "https://e.com/r" },
  deps,
);
assert.deepEqual(wl.tags, ["⭐"]);
assert.deepEqual(wl.symbols, ["RELIANCE"]);
assert.equal(wl.breaking, true);
assert.ok(wl.text.includes("⭐ <b>ET</b>"));
assert.ok(wl.text.includes("<i>RELIANCE</i>"));

// Macro hit → breaking even without a ticker.
const macro = routeMessage(
  { text: "Fed hikes rates by 50bps", channel: "WireMacro", category: "macro" },
  deps,
);
assert.equal(macro.breaking, true);
assert.deepEqual(macro.tags, []);
assert.equal(macro.buttons.length, 0); // no link

// Channel-agnostic key: same text via different channels → identical key.
const onA = routeMessage({ text: "Some generic headline today", channel: "A", category: "markets" }, deps);
const onB = routeMessage({ text: "Some generic headline today", channel: "B", category: "traders" }, deps);
assert.equal(onA.key, onB.key);

// HTML escaping of dynamic text.
const evil = routeMessage(
  { text: "Stocks <b>surge</b> & rally hard", channel: "Wire", category: "markets" },
  deps,
);
assert.ok(evil.text.includes("Stocks &lt;b&gt;surge&lt;/b&gt; &amp; rally hard"));

// Truncation: >350-char body gets an ellipsis.
const longText = "x".repeat(400);
const truncated = routeMessage({ text: longText, channel: "Wire", category: "markets" }, deps);
assert.ok(truncated.text.includes("…"));
assert.ok(truncated.text.includes("x".repeat(350)));
assert.ok(!truncated.text.includes("x".repeat(351)));

// Invalid / missing link → buttons empty.
const noLink = routeMessage({ text: "no link headline", channel: "Wire", category: "markets" }, deps);
assert.equal(noLink.buttons.length, 0);
const badLink = routeMessage({ text: "bad link headline", channel: "Wire", category: "markets", link: "ftp://x" }, deps);
assert.equal(badLink.buttons.length, 0);

console.log("newsRouter.test.mjs OK");
