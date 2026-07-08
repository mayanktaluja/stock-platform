import { strict as assert } from "node:assert";
import { normalizeTokens, jaccard, clusterMessages } from "../services/newsWire/wireClusterer.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    pass++;
  } catch (err) {
    console.log(`  not ok - ${name}\n      ${err.message}`);
    fail++;
  }
}

const msg = (channel, text, publishedAt, over = {}) => ({
  channel,
  category: "markets",
  text,
  url: `https://t.me/${channel}/1`,
  publishedAt,
  breaking: false,
  symbols: [],
  tags: [],
  routerKey: `${channel}:${text.slice(0, 8)}`,
  ...over,
});

test("normalizeTokens lowercases, strips URLs/punctuation/emoji + stopwords", () => {
  const t = normalizeTokens("The Fed HOLDS rates 🚨 steady https://x.co/a — signals cut!");
  assert.ok(t.has("fed"));
  assert.ok(t.has("holds"));
  assert.ok(t.has("steady"));
  assert.ok(!t.has("the"), "stopword dropped");
  assert.ok(![...t].some((x) => x.includes("http")), "url dropped");
  assert.ok(![...t].some((x) => /[^a-z0-9]/.test(x)), "no punctuation/emoji tokens");
});

test("jaccard math", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["c", "d"])), 0);
  assert.equal(jaccard(new Set(["a", "b", "c", "d"]), new Set(["a", "b"])), 0.5);
});

test("same story on 2 channels → one cluster, source_count 2", () => {
  const { clusters } = clusterMessages([
    msg("FinancialJuice", "Fed holds interest rates steady signals one cut in 2026", "2026-07-08T18:00:00Z"),
    msg("Walter Bloomberg", "Fed keeps interest rates steady signals one cut in 2026", "2026-07-08T18:00:03Z"),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].source_count, 2);
  assert.equal(clusters[0].members.length, 2);
});

test("different stories sharing a prefix do NOT merge", () => {
  const { clusters } = clusterMessages([
    msg("A", "Fed holds rates steady this month again", "2026-07-08T18:00:00Z"),
    msg("B", "Fed chair to speak at Jackson Hole symposium tomorrow", "2026-07-08T18:01:00Z"),
  ]);
  assert.equal(clusters.length, 2);
});

test("[terse guard] short one-liners need a stricter cutoff", () => {
  const { clusters } = clusterMessages([
    msg("A", "oil up", "2026-07-08T18:00:00Z"),
    msg("B", "oil down", "2026-07-08T18:00:10Z"),
  ]);
  assert.equal(clusters.length, 2, "oil up vs oil down must not merge");
});

test("determinism under shuffled input (same keys + source counts)", () => {
  const base = [
    msg("A", "RBI keeps repo rate unchanged at 6.5 percent as expected", "2026-07-08T10:00:00Z"),
    msg("B", "RBI holds repo rate unchanged at 6.5 percent as expected", "2026-07-08T10:00:05Z"),
    msg("C", "Nifty closes at a fresh record high led by banks and IT", "2026-07-08T11:00:00Z"),
  ];
  const run = (arr) => clusterMessages(arr).clusters.map((c) => `${c.key}:${c.source_count}`).sort();
  const forward = run(base);
  const shuffled = run([base[2], base[0], base[1]]);
  assert.deepEqual(forward, shuffled);
});

test("[H3] cluster key is stable when a later member arrives", () => {
  const first = clusterMessages([
    msg("A", "ECB cuts deposit rate by 25 bps to 3.5 percent", "2026-07-08T12:00:00Z"),
    msg("B", "ECB lowers deposit rate by 25 bps to 3.5 percent", "2026-07-08T12:00:04Z"),
  ]).clusters[0].key;

  const withLater = clusterMessages([
    msg("A", "ECB cuts deposit rate by 25 bps to 3.5 percent", "2026-07-08T12:00:00Z"),
    msg("B", "ECB lowers deposit rate by 25 bps to 3.5 percent", "2026-07-08T12:00:04Z"),
    msg("C", "ECB reduces deposit rate by 25 bps to 3.5 percent now", "2026-07-08T12:05:00Z"),
  ]).clusters[0].key;

  assert.equal(withLater, first, "new later member must not re-key the cluster");
});

test("cluster aggregates breaking, symbols, categories, first/last seen", () => {
  const { clusters } = clusterMessages([
    msg("A", "Reliance jumps 4 percent on strong Q1 results beat", "2026-07-08T09:00:00Z", { symbols: ["RELIANCE"], breaking: true, category: "india" }),
    msg("B", "Reliance surges 4 percent on strong Q1 results beat", "2026-07-08T09:00:30Z", { symbols: ["RELIANCE"], category: "markets" }),
  ]);
  assert.equal(clusters.length, 1);
  const c = clusters[0];
  assert.equal(c.breaking, true);
  assert.deepEqual(c.symbols, ["RELIANCE"]);
  assert.equal(c.source_count, 2);
  assert.equal(c.first_seen, "2026-07-08T09:00:00.000Z");
  assert.equal(c.last_seen, "2026-07-08T09:00:30.000Z");
  assert.ok(c.categories.includes("india") && c.categories.includes("markets"));
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
