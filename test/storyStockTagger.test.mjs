// Tests for services/multibagger/storyStockTagger.js.
// Run: node test/storyStockTagger.test.mjs

import assert from "node:assert/strict";
import { tagStoryStock, STORY_TAGGER_CONFIG } from "../services/multibagger/storyStockTagger.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\nstoryStockTagger");

it("config exposes tag list", () => {
  assert.ok(STORY_TAGGER_CONFIG.TAGS.includes("PLI"));
  assert.ok(STORY_TAGGER_CONFIG.TAGS.includes("DEFENSE"));
  assert.equal(STORY_TAGGER_CONFIG.BONUS_TWO_PLUS, 3);
});

it("flags single PLI mention", () => {
  const r = tagStoryStock(["Beneficiary of PLI scheme for electronics manufacturing"]);
  assert.deepEqual(r.tags, ["PLI"]);
  assert.equal(r.score_bonus, 1);
});

it("flags two distinct tags as +3", () => {
  const r = tagStoryStock(["Renewable energy investment", "EV battery supplier"]);
  assert.equal(r.tags.length, 2);
  assert.ok(r.tags.includes("RENEWABLE"));
  assert.ok(r.tags.includes("EV"));
  assert.equal(r.score_bonus, 3);
});

it("capex-related text fires CAPEX tag", () => {
  const r = tagStoryStock(["Capacity expansion underway at new greenfield plant"]);
  assert.ok(r.tags.includes("CAPEX"));
});

it("returns 0 when no tags hit", () => {
  const r = tagStoryStock(["Boring textile manufacturer"]);
  assert.deepEqual(r.tags, []);
  assert.equal(r.score_bonus, 0);
});

it("accepts SWS overview shape (rewards + risks)", () => {
  const r = tagStoryStock({
    rewards: ["Strong order book in defence", "AI-driven product portfolio"],
    risks: ["High debt"],
  });
  assert.ok(r.tags.includes("DEFENSE"));
  assert.ok(r.tags.includes("AI"));
  assert.equal(r.score_bonus, 3);
});

it("accepts news array", () => {
  const r = tagStoryStock({
    rewards: [],
    risks: [],
    news: [{ title: "Company wins ₹500cr semiconductor order" }],
  });
  assert.ok(r.tags.includes("SEMICONDUCTOR"));
});

it("case insensitive", () => {
  const r = tagStoryStock(["RENEWABLE energy"]);
  assert.ok(r.tags.includes("RENEWABLE"));
});

it("handles malformed input", () => {
  assert.deepEqual(tagStoryStock(null).tags, []);
  assert.deepEqual(tagStoryStock(undefined).tags, []);
  assert.deepEqual(tagStoryStock({}).tags, []);
  assert.deepEqual(tagStoryStock([null, undefined, ""]).tags, []);
});

it("deduplicates: matching pattern once still gives one tag entry", () => {
  const r = tagStoryStock(["PLI scheme expanded under PLI 2.0; PLI extension to FY30"]);
  assert.equal(r.tags.length, 1);
  assert.equal(r.tags[0], "PLI");
});

it("railway tag fires on RVNL/Vande Bharat language", () => {
  const r = tagStoryStock(["KAVACH train protection rollout accelerating"]);
  assert.ok(r.tags.includes("RAILWAY_PSU"));
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
