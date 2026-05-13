/**
 * Regression tests for scripts/sws-section-status.mjs — pure diff utility
 * stamping `section_status` on per-section stock objects.
 *
 * Also exercises the wrapper script scripts/sws-stamp-section-status.mjs
 * end-to-end against a tempdir, so any parse error or import failure in the
 * wrapper (the May-11 incident class) fails this test instead of silently
 * shipping a picks-latest.json with zero section_status fields.
 *
 * Run with: node test/swsSectionStatus.test.mjs
 */

import { computeSectionStatus, trendingThresholdForSize } from "../scripts/sws-section-status.mjs";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

function makeStock(ticker) {
  return { ticker, name: ticker, v3_score_100: 50 };
}

// Build [stocks T1..Tn] in given order. Order = rank.
function makeSection(prefix, n) {
  return Array.from({ length: n }, (_, i) => makeStock(`${prefix}${i + 1}`));
}

console.log("\ntrendingThresholdForSize\n");
assert("size  3 → null (suppress)", trendingThresholdForSize(3) === null, trendingThresholdForSize(3));
assert("size 13 → null (suppress)", trendingThresholdForSize(13) === null, trendingThresholdForSize(13));
assert("size 14 → null (suppress)", trendingThresholdForSize(14) === null, trendingThresholdForSize(14));
assert("size 15 → 5  (ceil(15*0.33))", trendingThresholdForSize(15) === 5, trendingThresholdForSize(15));
assert("size 20 → 7  (ceil(20*0.33))", trendingThresholdForSize(20) === 7, trendingThresholdForSize(20));
assert("size 29 → 10 (ceil(29*0.33))", trendingThresholdForSize(29) === 10, trendingThresholdForSize(29));
assert("size 30 → 10 (large bucket)",  trendingThresholdForSize(30) === 10, trendingThresholdForSize(30));
assert("size 221 → 10 (large bucket)", trendingThresholdForSize(221) === 10, trendingThresholdForSize(221));

console.log("\n(A) Trending — climbed 14 ranks in a 30-stock section\n");
{
  const prior = { top_ranked_30_v3: makeSection("T", 30) };
  // Move T15 from rank 15 → rank 1 (climb 14 ranks)
  const priorOrder = prior.top_ranked_30_v3.map((s) => s.ticker);
  const newOrder = ["T15", ...priorOrder.filter((t) => t !== "T15")];
  const current = { top_ranked_30_v3: newOrder.map(makeStock) };
  computeSectionStatus(current, prior, "2026-05-07T00:00:00Z");
  const t15 = current.top_ranked_30_v3.find((s) => s.ticker === "T15");
  assert("T15 trending=true", t15.section_status.trending === true, t15.section_status);
  assert("T15 rank_delta=14", t15.section_status.rank_delta === 14, t15.section_status);
  assert("T15 newly_added=false", t15.section_status.newly_added === false, t15.section_status);
  assert("T15 prior_rank=15", t15.section_status.prior_rank === 15, t15.section_status);
  assert("T15 current_rank=1", t15.section_status.current_rank === 1, t15.section_status);
  assert("T15 prior_scanned_at echoed", t15.section_status.prior_scanned_at === "2026-05-07T00:00:00Z", t15.section_status);

  // T1 was demoted from 1 → 2 (rank_delta = -1, no trending)
  const t1 = current.top_ranked_30_v3.find((s) => s.ticker === "T1");
  assert("T1 (demoted) trending=false", t1.section_status.trending === false, t1.section_status);
  assert("T1 rank_delta=-1", t1.section_status.rank_delta === -1, t1.section_status);
}

console.log("\n(B) Newly Added — ticker absent in prior\n");
{
  const prior = { best_to_buy_now: [makeStock("OLD1"), makeStock("OLD2")] };
  const current = { best_to_buy_now: [makeStock("OLD1"), makeStock("NEW1"), makeStock("OLD2")] };
  computeSectionStatus(current, prior, "2026-05-07T00:00:00Z");
  const newOne = current.best_to_buy_now.find((s) => s.ticker === "NEW1");
  assert("NEW1 newly_added=true", newOne.section_status.newly_added === true, newOne.section_status);
  assert("NEW1 trending=false (size<15 anyway)", newOne.section_status.trending === false, newOne.section_status);
  assert("NEW1 prior_rank=null", newOne.section_status.prior_rank === null, newOne.section_status);
  assert("NEW1 rank_delta=null", newOne.section_status.rank_delta === null, newOne.section_status);
  assert("NEW1 current_rank=2", newOne.section_status.current_rank === 2, newOne.section_status);
}

console.log("\n(C) AVOID carve-out — large rank jump does NOT mark Trending\n");
{
  const prior = { avoid: makeSection("A", 30) };
  // Move A25 from rank 25 → rank 5 (climb 20 ranks)
  const priorOrder = prior.avoid.map((s) => s.ticker);
  const filtered = priorOrder.filter((t) => t !== "A25");
  const newOrder = [...filtered.slice(0, 4), "A25", ...filtered.slice(4)];
  const current = { avoid: newOrder.map(makeStock) };
  computeSectionStatus(current, prior, "2026-05-07T00:00:00Z");
  const a25 = current.avoid.find((s) => s.ticker === "A25");
  assert("A25 trending=false (avoid carve-out)", a25.section_status.trending === false, a25.section_status);
  assert("A25 rank_delta=20 still recorded", a25.section_status.rank_delta === 20, a25.section_status);

  // Newly added on AVOID: still flagged (UI will relabel to "Newly Flagged")
  const currentWithNew = { avoid: [...current.avoid, makeStock("FRESH_AVOID")] };
  computeSectionStatus(currentWithNew, prior, "2026-05-07T00:00:00Z");
  const fresh = currentWithNew.avoid.find((s) => s.ticker === "FRESH_AVOID");
  assert("FRESH_AVOID newly_added=true even on AVOID", fresh.section_status.newly_added === true, fresh.section_status);
}

console.log("\n(D) Small section (size 13) — Trending suppressed regardless of jump\n");
{
  const prior = { dividend_aristocrats: makeSection("D", 13) };
  // Move D13 from rank 13 → rank 1 (climb 12 ranks)
  const priorOrder = prior.dividend_aristocrats.map((s) => s.ticker);
  const newOrder = ["D13", ...priorOrder.filter((t) => t !== "D13")];
  const current = { dividend_aristocrats: newOrder.map(makeStock) };
  computeSectionStatus(current, prior, "2026-05-07T00:00:00Z");
  const d13 = current.dividend_aristocrats.find((s) => s.ticker === "D13");
  assert("D13 trending=false (size<15)", d13.section_status.trending === false, d13.section_status);
  assert("D13 rank_delta=12 still recorded", d13.section_status.rank_delta === 12, d13.section_status);
}

console.log("\n(E) First-run baseline — priorSections=null → silent\n");
{
  const current = { top_ranked_30_v3: makeSection("B", 30) };
  computeSectionStatus(current, null, null);
  const allBaseline = current.top_ranked_30_v3.every(
    (s) =>
      s.section_status.newly_added === false &&
      s.section_status.trending === false &&
      s.section_status.prior_rank === null &&
      s.section_status.rank_delta === null &&
      s.section_status.prior_scanned_at === null,
  );
  assert("Every stock baseline-stamped (no badges)", allBaseline, current.top_ranked_30_v3[0].section_status);
  assert("current_rank still set on baseline", current.top_ranked_30_v3[14].section_status.current_rank === 15, current.top_ranked_30_v3[14].section_status);
}

console.log("\n(F) Mid-size section (size 20) — threshold = 7 (ceil(20*0.33))\n");
{
  const prior = { deep_value: makeSection("V", 20) };
  // V8 climbs 7 ranks (8 → 1) — should hit threshold exactly
  const priorOrder = prior.deep_value.map((s) => s.ticker);
  const newOrder = ["V8", ...priorOrder.filter((t) => t !== "V8")];
  const current = { deep_value: newOrder.map(makeStock) };
  computeSectionStatus(current, prior, "2026-05-07T00:00:00Z");
  const v8 = current.deep_value.find((s) => s.ticker === "V8");
  assert("V8 rank_delta=7", v8.section_status.rank_delta === 7, v8.section_status);
  assert("V8 trending=true (delta=7 ≥ threshold=7)", v8.section_status.trending === true, v8.section_status);
}

console.log("\n(G) Just below threshold — climbed 9 in 30-stock section\n");
{
  const prior = { top_ranked_30_v3: makeSection("G", 30) };
  // G10 climbs 9 ranks (10 → 1) — below threshold of 10
  const priorOrder = prior.top_ranked_30_v3.map((s) => s.ticker);
  const newOrder = ["G10", ...priorOrder.filter((t) => t !== "G10")];
  const current = { top_ranked_30_v3: newOrder.map(makeStock) };
  computeSectionStatus(current, prior, "2026-05-07T00:00:00Z");
  const g10 = current.top_ranked_30_v3.find((s) => s.ticker === "G10");
  assert("G10 rank_delta=9", g10.section_status.rank_delta === 9, g10.section_status);
  assert("G10 trending=false (below threshold)", g10.section_status.trending === false, g10.section_status);
}

console.log("\n(H) Same ticker in two sections gets independent badges\n");
{
  // Stock TWO appears in both top_ranked_30_v3 (rank 5 prior, rank 5 current — flat)
  // and best_to_buy_now (absent prior, rank 1 current — newly_added).
  const prior = {
    top_ranked_30_v3: [...makeSection("X", 4), makeStock("TWO"), ...makeSection("Y", 25)],
    best_to_buy_now: [makeStock("OLD1"), makeStock("OLD2")],
  };
  const current = {
    top_ranked_30_v3: [...makeSection("X", 4), makeStock("TWO"), ...makeSection("Y", 25)],
    best_to_buy_now: [makeStock("TWO"), makeStock("OLD1"), makeStock("OLD2")],
  };
  computeSectionStatus(current, prior, "2026-05-07T00:00:00Z");
  const twoInTop = current.top_ranked_30_v3.find((s) => s.ticker === "TWO");
  const twoInBuyNow = current.best_to_buy_now.find((s) => s.ticker === "TWO");
  assert("TWO in top_ranked: newly_added=false (was there)", twoInTop.section_status.newly_added === false, twoInTop.section_status);
  assert("TWO in top_ranked: rank_delta=0", twoInTop.section_status.rank_delta === 0, twoInTop.section_status);
  assert("TWO in buy_now: newly_added=true (fresh entry)", twoInBuyNow.section_status.newly_added === true, twoInBuyNow.section_status);
  assert("Independent objects — different status", twoInTop.section_status !== twoInBuyNow.section_status, null);
}

// ──────────────────────────────────────────────────────────────────────────
// End-to-end: scripts/sws-stamp-section-status.mjs
//
// The May-11 incident shipped a parse error in this wrapper — `await` inside
// a non-async `main()` — that the pipeline's `|| true` swallowed. Two days of
// auto-refreshes wrote picks-latest.json with zero section_status fields and
// no badge appeared on any card. The unit tests above didn't catch it because
// they exercise the pure diff utility, not the wrapper.
//
// This block invokes the wrapper as Node would in prod (real spawn, real cwd,
// real fs writes) against a temp directory. A parse error / import failure /
// missing-file regression in the wrapper now fails this test loudly.
// ──────────────────────────────────────────────────────────────────────────

console.log("\n(E) Stamper wrapper end-to-end\n");
{
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(__dirname, "..");
  const STAMPER = resolve(REPO_ROOT, "scripts/sws-stamp-section-status.mjs");

  const tempRoot = mkdtempSync(join(tmpdir(), "sws-stamp-test-"));
  try {
    const dataDir = join(tempRoot, "data", "sws");
    mkdirSync(dataDir, { recursive: true });

    // Prior: only OLD1, OLD2 in best_to_buy_now.
    // Current: NEW1 at top + OLD1, OLD2 → NEW1 should get newly_added=true.
    const prior = {
      scanned_at: "2026-05-07T00:00:00Z",
      sections: {
        best_to_buy_now: [
          { ticker: "OLD1", name: "Old One" },
          { ticker: "OLD2", name: "Old Two" },
        ],
      },
    };
    const current = {
      scanned_at: "2026-05-08T00:00:00Z",
      sections: {
        best_to_buy_now: [
          { ticker: "NEW1", name: "New One" },
          { ticker: "OLD1", name: "Old One" },
          { ticker: "OLD2", name: "Old Two" },
        ],
      },
    };
    writeFileSync(join(dataDir, "picks-previous.json"), JSON.stringify(prior));
    writeFileSync(join(dataDir, "picks-latest.json"), JSON.stringify(current));

    // Spawn the real stamper. Any parse error or import-time crash throws
    // here. Empty SWS_RUN_ID keeps the DB dual-write branch dormant — we
    // only want to exercise the JSON write path.
    execFileSync(process.execPath, [STAMPER], {
      cwd: tempRoot,
      env: { ...process.env, SWS_RUN_ID: "", SWS_DB_DUAL_WRITE: "0" },
      stdio: "pipe",
    });

    const result = JSON.parse(readFileSync(join(dataDir, "picks-latest.json"), "utf-8"));
    const items = result.sections.best_to_buy_now;
    const new1 = items.find((s) => s.ticker === "NEW1");
    const old1 = items.find((s) => s.ticker === "OLD1");

    assert("wrapper wrote section_status on NEW1", new1?.section_status != null, new1);
    assert("wrapper wrote section_status on OLD1", old1?.section_status != null, old1);
    assert("NEW1 marked newly_added=true",         new1?.section_status?.newly_added === true,  new1?.section_status);
    assert("OLD1 marked newly_added=false",        old1?.section_status?.newly_added === false, old1?.section_status);
    assert("wrapper snapshotted picks-previous.json", existsSync(join(dataDir, "picks-previous.json")), null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
