import { strict as assert } from "node:assert";
import {
  normalizeTokens, jaccard, clusterMessages,
  clusterTokens, stripBoilerplate, containment, contradicts, pairScore,
  CONTAINMENT_CUT, CONTAINMENT_MIN_OVERLAP,
} from "../services/newsWire/wireClusterer.js";

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

// ══════════════════════════════════════════════════════════════════════════════
// Cross-channel corroboration recovery. Before this, source_count was 1 on ALL 40
// live items — the "N sources" chip and the rank's (1+log2(source_count)) multiplier
// were both dead.
// ══════════════════════════════════════════════════════════════════════════════

test("stripBoilerplate removes channel branding, not payload", () => {
  assert.equal(stripBoilerplate("JUST IN: Trump orders trade halt").trim(), "Trump orders trade halt");
  assert.equal(stripBoilerplate("BREAKING: Trump: Cut off trade").trim(), "Trump: Cut off trade", "nested markers");
  assert.equal(stripBoilerplate("Trump: Cut off trade.|FJ").trim(), "Trump: Cut off trade.");
  assert.ok(!stripBoilerplate("Fed cuts @WalterBloomberg").includes("@Walter"));
  assert.ok(!/for more news/i.test(stripBoilerplate("Fed cuts rates. Follow @x for more news and updates")));
  assert.ok(!/https/.test(stripBoilerplate("Fed cuts https://t.me/x/1")));
});

test("[anti-regression] stripBoilerplate does NOT truncate a 'Sources:' clause", () => {
  // A tempting /\bsources?:.*$/ regex would reduce this to "Sources" and destroy the story.
  const t = clusterTokens("Sources: Fed to cut rates in March, says Reuters");
  for (const w of ["fed", "cut", "rates", "march", "reuters"]) assert.ok(t.has(w), `lost "${w}"`);
  assert.ok(!t.has("sources"), "the word itself is stopworded, the payload survives");
});

test("containment is immune to length asymmetry where jaccard is not", () => {
  const short = new Set(["trump", "cut", "trade", "spain", "visits"]);
  const long = new Set([
    "president", "trump", "orders", "us", "cut", "trade", "spain", "visits",
    "immediately", "official", "statement", "madrid",
  ]);
  // 5 shared / 12 union = 0.417 → below the 0.5 Jaccard cut, even though the short
  // headline is entirely contained in the long one. That gap is the whole bug.
  assert.ok(jaccard(short, long) < 0.5, `jaccard rejects the same story (got ${jaccard(short, long)})`);
  assert.equal(containment(short, long), 1, "containment sees the subset");
});

test("[veto] opposite events never merge, on either similarity path", () => {
  const t = (s) => clusterTokens(s);
  assert.equal(contradicts(t("Fed cuts rates by 25 bps"), t("Fed hikes rates by 25 bps")), "antonym");
  assert.equal(contradicts(t("Fed cuts rates by 25 bps"), t("Fed cuts rates by 50 bps")), "numeric");
  assert.equal(contradicts(t("Reliance beats Q1 estimates"), t("Reliance misses Q1 estimates")), "antonym");
  assert.equal(pairScore(t("Fed cuts rates by 25 bps"), t("Fed hikes rates by 25 bps")).mode, "veto");
});

test("[veto] fails OPEN — same-pole synonyms and shared numbers never veto", () => {
  const t = (s) => clusterTokens(s);
  assert.equal(contradicts(t("Fed slashes rates"), t("Fed cuts rates")), null, "slash and cut are the same pole");
  assert.equal(contradicts(t("Nifty up 1 percent"), t("Nifty rises 1 percent")), null);
  assert.equal(contradicts(t("Fed holds rates steady, signals one cut"), t("Fed keeps rates steady, signals one cut")), null);
});

test("[asymmetry gate] equal-length pairs stay on jaccard, never containment", () => {
  const a = clusterTokens("alpha bravo charlie delta echo foxtrot");
  const b = clusterTokens("alpha bravo charlie delta echo golf");
  assert.equal(pairScore(a, b).mode, "jaccard", "containment is only licensed by length asymmetry");
});

test("[overlap floor] a small set 80% contained in an unrelated long one does NOT merge", () => {
  // The real false positive: "Trump says MoU with Iran is over" vs a Bitcoin headline
  // that happened to mention Trump. Intersection was 4 — below the floor of 5.
  const small = new Set(["alpha", "bravo", "charlie", "delta", "echo"]);
  const long = new Set(["alpha", "bravo", "charlie", "delta", "zulu", "yankee", "xray", "whiskey", "victor"]);
  assert.ok(containment(small, long) >= CONTAINMENT_CUT - 0.01, "containment alone would pass");
  assert.ok(4 < CONTAINMENT_MIN_OVERLAP);
  assert.notEqual(pairScore(small, long).mode, "containment", "the absolute overlap floor blocks it");
});

test("[the whole point] one story across four channels → source_count 4", () => {
  const t0 = "2026-07-08T11:00:00Z";
  const { clusters } = clusterMessages([
    msg("FinancialJuice", "Trump: Cut off all trade with Spain, all visits.|FJ", t0),
    msg("Clash Report", "BREAKING: Trump: Cut off all trade with Spain, please, including visits", "2026-07-08T11:00:20Z"),
    msg("Watcher.Guru", "JUST IN: President Trump orders US to cut off all trade with Spain and all visits", "2026-07-08T11:01:00Z"),
    msg("Insider Paper", "Spain is taking US President Donald Trump's threat to cut off all trade and visits seriously", "2026-07-08T11:02:00Z"),
  ]);
  assert.equal(clusters.length, 1, "four channels, one story");
  assert.equal(clusters[0].source_count, 4);
});

test("[veto in the pipeline] a rate cut and a rate hike stay separate clusters", () => {
  const { clusters } = clusterMessages([
    msg("A", "Fed cuts benchmark rate by 25 bps at todays meeting", "2026-07-08T11:00:00Z"),
    msg("B", "Fed hikes benchmark rate by 25 bps at todays meeting", "2026-07-08T11:00:30Z"),
  ]);
  assert.equal(clusters.length, 2, "opposite events must never fuse into one card");
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
