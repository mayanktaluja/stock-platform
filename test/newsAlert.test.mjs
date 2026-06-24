/**
 * Run with: node test/newsAlert.test.mjs
 */

import assert from "node:assert/strict";
import { formatNewsAlert } from "../services/alerts/newsAlert.js";

// Invalid input → null.
assert.equal(formatNewsAlert(null, null), null);
assert.equal(formatNewsAlert({ title: "" }, { symbols: ["X"] }), null);
assert.equal(formatNewsAlert({ title: "hi" }, { symbols: [] }), null);

const headline = {
  title: "Reliance Industries Q1 profit beats estimates",
  source: "Moneycontrol",
  url: "https://www.moneycontrol.com/news/ril-q1",
  publishedAt: "2026-06-24T05:00:00Z",
};
const a = formatNewsAlert(headline, { symbols: ["RELIANCE"], sectors: [] });

assert.equal(a.breaking, false); // NEWS class is routine until LLM triage (P4)
assert.ok(a.text.includes("<code>RELIANCE</code>"));
assert.ok(a.text.includes("Moneycontrol"));
assert.ok(a.text.includes("Reliance Industries Q1 profit"));
assert.equal(a.symbols.length, 1);

// Buttons: Source (valid http url) + platform deep-link to first symbol.
assert.equal(a.buttons.length, 2);
assert.equal(a.buttons[0].text, "📰 Source");
assert.ok(a.buttons[1].url.includes("t=RELIANCE"));

// Stable dedup key, independent of source/url (collapses same story across wires).
const b = formatNewsAlert({ ...headline, source: "ET", url: "https://e.com" }, { symbols: ["RELIANCE"], sectors: [] });
assert.equal(a.key, b.key);

// Missing/invalid url → only the platform button.
const noUrl = formatNewsAlert({ ...headline, url: null }, { symbols: ["RELIANCE"] });
assert.equal(noUrl.buttons.length, 1);
assert.ok(noUrl.buttons[0].url.includes("t=RELIANCE"));

// HTML in the title is escaped.
const evil = formatNewsAlert({ ...headline, title: "INFY <b>up</b> & out" }, { symbols: ["INFY"] });
assert.ok(evil.text.includes("&lt;b&gt;up&lt;/b&gt; &amp; out"));

console.log("newsAlert.test.mjs OK");
