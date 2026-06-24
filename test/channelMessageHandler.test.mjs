/**
 * Run with: node test/channelMessageHandler.test.mjs
 */

import assert from "node:assert/strict";
import { compileWatchlist } from "../services/alerts/watchlistGate.js";
import { channelAlertFor } from "../services/alerts/channelMessageHandler.js";

const compiled = compileWatchlist({
  tickers: ["RELIANCE", "INFY"],
  aliases: { RELIANCE: ["Reliance", "RIL"], INFY: ["Infosys"] },
  sectorKeywords: ["banking"],
});

// Empty / no-match → null.
assert.equal(channelAlertFor({ text: "" }, compiled), null);
assert.equal(channelAlertFor({ text: "gm traders, big day ahead 🚀" }, compiled), null);

// Watchlist hit → alert, reusing the NEWS formatter.
const a = channelAlertFor(
  { text: "BREAKING: Reliance to demerge Jio, board meets today", channel: "VickyTrader", link: "https://t.me/x/1", date: "2026-06-24T05:00:00Z" },
  compiled,
);
assert.ok(a);
assert.equal(a.breaking, false); // NEWS class routine until LLM triage (P4)
assert.ok(a.text.includes("<code>RELIANCE</code>"));
assert.ok(a.text.includes("TG: VickyTrader")); // source labelled as the channel
assert.ok(a.text.includes("Reliance to demerge Jio"));
assert.equal(a.symbols[0], "RELIANCE");

// Multi-line message is collapsed to one line.
const ml = channelAlertFor({ text: "Infosys\n\n  large deal win\nsource: mgmt", channel: "Day Trading" }, compiled);
assert.ok(ml.text.includes("Infosys large deal win source: mgmt"));

// Same story from a channel and the RSS path share a dedup key (collapses).
import { formatNewsAlert } from "../services/alerts/newsAlert.js";
const viaChannel = channelAlertFor({ text: "Reliance to demerge Jio, board meets today", channel: "X" }, compiled);
const viaRss = formatNewsAlert({ title: "Reliance to demerge Jio, board meets today", source: "ET" }, { symbols: ["RELIANCE"] });
assert.equal(viaChannel.key, viaRss.key);

console.log("channelMessageHandler.test.mjs OK");
