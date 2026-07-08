import { strict as assert } from "node:assert";
import { buildWire, rankClusters, DEFAULT_WIRE_PATH } from "../services/newsWire/wireBuilder.js";

let pass = 0;
let fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NOW = new Date("2026-07-08T18:00:00Z").getTime();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const rec = (channel, text, msAgo, over = {}) => ({
  channel, category: "markets", text, url: `https://t.me/${channel}/1`,
  publishedAt: iso(msAgo), breaking: false, symbols: [], tags: [], routerKey: `${channel}:${text.slice(0, 6)}`,
  ...over,
});

test("rankClusters: more sources ranks higher at equal impact/recency", () => {
  const a = { cluster: { key: "a", source_count: 4, last_seen: iso(0), breaking: false }, signal: { impact: 5 } };
  const b = { cluster: { key: "b", source_count: 1, last_seen: iso(0), breaking: false }, signal: { impact: 5 } };
  const ranked = rankClusters([b, a], { now: NOW });
  assert.equal(ranked[0].cluster.key, "a");
});

test("rankClusters: fresher ranks higher at equal impact/sources", () => {
  const fresh = { cluster: { key: "f", source_count: 1, last_seen: iso(0), breaking: false }, signal: { impact: 6 } };
  const old = { cluster: { key: "o", source_count: 1, last_seen: iso(6 * 3600 * 1000), breaking: false }, signal: { impact: 6 } };
  const ranked = rankClusters([old, fresh], { now: NOW });
  assert.equal(ranked[0].cluster.key, "f");
});

test("[H2] corroboration lifts rank with NO change to the signal (no LLM re-call)", () => {
  const signal = { impact: 5 }; // identical cached content signal
  const one = rankClusters([{ cluster: { key: "x", source_count: 1, last_seen: iso(0) }, signal }], { now: NOW })[0].rank;
  const three = rankClusters([{ cluster: { key: "x", source_count: 3, last_seen: iso(0) }, signal }], { now: NOW })[0].rank;
  assert.ok(three > one, "extra sources raise rank via the multiplier, not a re-score");
});

test("buildWire (skipLlm) clusters cross-channel + emits bucketed schema", async () => {
  const { wire, stats } = await buildWire({
    records: [
      rec("FinancialJuice", "Fed slashes rates, markets plunge on deep recession fears", 120000, { breaking: true }),
      rec("Walter Bloomberg", "Fed cuts rates, markets plunge on deep recession fears", 60000, { breaking: true }),
      rec("Watcher", "Small cap ABC rallies on a minor order win today", 180000),
    ],
    skipLlm: true, writeMirror: false, publish: false, now: NOW,
  });
  assert.equal(wire.schema_version, "news-wire-v1");
  assert.equal(wire.counts.messages, 3);
  assert.equal(wire.counts.clusters, 2);
  assert.equal(wire.counts.llm_calls, 0);
  assert.equal(wire.items.length, 2);

  const fed = wire.items.find((i) => i.source_count === 2);
  assert.ok(fed, "Fed story merged across 2 channels");
  assert.equal(fed.direction, "bearish");
  assert.ok(["low", "med", "high"].includes(fed.heat_bucket));
  assert.ok(!("impact" in fed), "no raw numeric impact leaks to the item (D3)");
  assert.ok(fed.sources.length === 2, "distinct per-channel sources");
  assert.equal(fed.classifier_provider, "heuristic");
  assert.ok(stats.publish.published === false);
});

test("buildWire ranks the higher-impact story first", async () => {
  const { wire } = await buildWire({
    records: [
      rec("A", "Company holds routine board meeting next week", 60000),
      rec("B", "Market crash: Nifty plunges 5 percent, selloff accelerates on recession fears", 60000, { breaking: true }),
    ],
    skipLlm: true, writeMirror: false, now: NOW,
  });
  assert.match(wire.items[0].headline, /crash|plunges/i);
});

test("buildWire never throws on garbage records", async () => {
  const { wire } = await buildWire({ records: [null, {}, { text: "" }], skipLlm: true, writeMirror: false, now: NOW });
  assert.ok(Array.isArray(wire.items));
});

test("DEFAULT_WIRE_PATH points at data/news-wire/wire-latest.json", () => {
  assert.ok(DEFAULT_WIRE_PATH.endsWith("/data/news-wire/wire-latest.json"));
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok - ${name}`); pass++; }
  catch (err) { console.log(`  not ok - ${name}\n      ${err.message}`); fail++; }
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
