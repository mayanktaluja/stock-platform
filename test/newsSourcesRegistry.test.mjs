// Guard rails for data/alerts/news-sources.json.
//
// The poller reads whatever slugs live in this registry and pipes them into the
// Telegram topics, the wire buffer, and the LLM triage. A bad slug is not a
// cosmetic error — it is untrusted content with a budget attached.
//
// The obvious safety check ("does t.me/s/<slug> render?") is NOT sufficient:
// verified on 2026-07-08, `zerodha` renders 20 message-wraps and has 1.55M
// subscribers, but it is a binary-options scam ("Quotex Trading") squatting
// India's most-trusted broker name. `etmarkets` is an Ethiopian marketplace.
// `Faytuks` is a Persian channel. All three pass a naive wrap-count check.
//
// So the registry is defended by an explicit denylist instead.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(__dirname, "..", "data", "alerts", "news-sources.json");
const TOPIC_MAP = path.join(__dirname, "..", "data", "alerts", "topic-map.json");

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); pass++; }
  catch (err) { console.log(`  not ok - ${name}\n      ${err.message}`); fail++; }
}

const cfg = JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));
const channels = cfg.channels || [];
const enabled = channels.filter((c) => c.enabled !== false);

const VALID_CATEGORIES = new Set(["markets", "macro", "trump", "geopolitics", "traders", "crypto", "india"]);

// Handles verified to render a working t.me/s preview while being something OTHER
// than what the name implies. Adding any of these is a security/cost incident.
const KNOWN_SQUATS = ["zerodha", "etmarkets", "faytuks"];

test("registry parses and has enabled channels", () => {
  assert.ok(Array.isArray(channels) && channels.length > 0);
  assert.ok(enabled.length > 0);
});

test("every channel has name + slug + a valid category", () => {
  for (const c of channels) {
    assert.ok(c.name, `channel missing name: ${JSON.stringify(c)}`);
    assert.ok(c.slug, `channel missing slug: ${c.name}`);
    assert.ok(VALID_CATEGORIES.has(c.category), `${c.name}: invalid category "${c.category}"`);
  }
});

test("[security] no known squatted handle appears in the registry", () => {
  for (const c of channels) {
    assert.ok(
      !KNOWN_SQUATS.includes(String(c.slug).toLowerCase()),
      `"${c.slug}" is a VERIFIED SQUAT (renders fine, is not who it claims). Never add it.`,
    );
  }
});

test("no unresolved REPLACE_WITH_ placeholder slugs", () => {
  for (const c of channels) {
    assert.ok(!/REPLACE_WITH/i.test(c.slug), `${c.name} still has a placeholder slug: ${c.slug}`);
  }
});

test("no duplicate slugs (a dupe would double-count sources in the wire)", () => {
  const seen = new Set();
  for (const c of channels) {
    const k = String(c.slug).toLowerCase();
    assert.ok(!seen.has(k), `duplicate slug: ${c.slug}`);
    seen.add(k);
  }
});

test("every ENABLED channel's category has a Telegram topic thread", () => {
  if (!fs.existsSync(TOPIC_MAP)) return; // topic map is optional until configured
  const topics = JSON.parse(fs.readFileSync(TOPIC_MAP, "utf-8")).topics || {};
  for (const c of enabled) {
    assert.ok(topics[c.category] != null, `enabled channel "${c.name}" routes to category "${c.category}" which has no topic thread — it would post to the chat root`);
  }
});

test("a channel flagged with an impostor/staleness note is NOT enabled", () => {
  for (const c of enabled) {
    if (!c.note) continue;
    assert.ok(
      !/impostor risk medium|impostor risk high|stale|unregistered|squat/i.test(c.note),
      `"${c.name}" is enabled but its note flags it as risky/stale: ${c.note}`,
    );
  }
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
