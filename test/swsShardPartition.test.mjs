/**
 * Regression tests for the SWS shard-partitioning contract.
 *
 * Background — the bug these tests exist to prevent:
 *
 *   Two files derived "which stocks belong to shard N" independently, and they
 *   disagreed. The LIVE api scraper (scripts/sws-api-scrape.mjs) sorts the
 *   universe alphabetically by ticker and takes CONTIGUOUS BLOCKS — confirmed
 *   from real run logs, where shard 1 ended on a numeric BSE code and shard 3
 *   on ZYDUSWELL. The progress rebuilder (`--reset-progress` in
 *   scripts/sws-universe-from-sitemap.mjs) derived each slice MODULARLY, with
 *   `merged.filter(e => e.index % 3 === shardId - 1)`.
 *
 *   Those are unrelated partitions, not offset versions of each other:
 *   mergeAndSort() stores the universe sorted by priorityScore FIRST (curated
 *   entries lead) and only then by ticker, so the modular scheme strides a
 *   curated-first list while the contiguous scheme blocks an alphabetical one.
 *
 *   `next_local_index` is just an integer offset into a slice. Point it at a
 *   different slice and it silently designates a different set of stocks —
 *   some get re-scraped, others are skipped entirely and age out. No crash, no
 *   log line; the same shape of failure as the 2026-07-23 universe truncation
 *   (#1166), which is when this was found. #1166 deliberately did NOT use
 *   --reset-progress because of this mismatch, resetting cursors to 0 instead.
 *
 *   Compounding it, the rebuilder wrote PATHS.progress (`progress-<n>.json`,
 *   the LEGACY DOM scraper's files) while sws-api-scrape.mjs reads its own
 *   `progress-api-<n>.json`. So --reset-progress rebuilt cursors for a pipeline
 *   that no longer runs, and the live one kept its stale ones.
 *
 * The fix: one shared partition module (scripts/sws-shard-partition.mjs) that
 * both pipelines bind to, and a rebuilder that writes BOTH progress files —
 * each derived under its OWN pipeline's scheme, since the modular derivation is
 * still correct for the legacy scraper that reads progress-<n>.json.
 *
 * The load-bearing assertions here are:
 *   - the scraper's shard function IS the shared one (identity, not a copy)
 *   - cursors in progress-api-<n>.json agree with a walk of the scraper's slice
 *   - the fixture actually discriminates the two schemes, so that is not vacuous
 *   - the pre-fix derivation is replayed and shown to disagree
 *
 * Run with: node test/swsShardPartition.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tickers = (slice) => slice.map((e) => e.ticker);
// A missing progress file is itself a failure this suite reports; don't let the
// read throw and abandon the remaining shards' assertions.
const readJsonOr = (p, fallback = {}) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};

// ---------------------------------------------------------------------------
// Fixture — mirrors the real universe's shape, which is what makes the two
// schemes diverge. mergeAndSort() emits curated entries first, then everything
// else alphabetically, and stamps `index = <array position>`. Numeric BSE-only
// codes sort ahead of alphabetic tickers under localeCompare, so they cluster
// into shard 1 under the contiguous scheme (exactly as the run logs showed)
// while being scattered across all three under the modular one.
// ---------------------------------------------------------------------------
function buildUniverse() {
  const curated = ["RELIANCE", "TCS", "ICICIBANK", "HINDUNILVR", "BHARTIARTL"];
  const rest = [
    "544108", "544112", "543320", "20MICRONS", "AARTIIND", "ABB", "ACC",
    "BAJAJ-AUTO", "BEL", "CIPLA", "DIVISLAB", "EICHERMOT", "GODIGIT",
    "GODREJAGRO", "HDFCBANK", "INFY", "ITC", "JSWSTEEL", "KOTAKBANK",
    "LT", "MARUTI", "NESTLEIND", "ONGC", "POWERGRID", "SBIN", "SUNPHARMA",
    "TATAMOTORS", "ULTRACEMCO", "WIPRO", "ZYDUSWELL",
  ];
  const out = [
    ...curated.map((t) => ({ ticker: t, curated: true })),
    ...rest.slice().sort((a, b) => a.localeCompare(b)).map((t) => ({ ticker: t, curated: false })),
  ];
  // mergeAndSort() re-indexes 0..n-1 over the STORED order.
  out.forEach((e, i) => { e.index = i; });
  return out;
}

// The pre-fix derivation, replayed verbatim so the test can prove it disagrees.
function legacyIndexModuloSlice(merged, shardId, shardCount = 3) {
  return merged.filter((e) => (e.index % shardCount) === (shardId - 1));
}

// What the api scraper's cursor SHOULD be, given a set of already-scraped
// tickers: walk the slice in order, count scraped, stop at the first gap.
function expectedCursor(slice, scraped) {
  let next = slice.length, done = 0;
  for (let i = 0; i < slice.length; i++) {
    if (scraped.has(slice[i].ticker)) done++;
    else if (next === slice.length) next = i;
  }
  return { slice_size: slice.length, done, next };
}

// ---------------------------------------------------------------------------
// Isolate every filesystem write. sws-config.mjs resolves its repo root from
// SWS_REPO_ROOT_OVERRIDE, so this must be set BEFORE the first import of
// anything that pulls config in — hence the dynamic imports below. Without it
// the test would clobber the real data/sws/progress*.json and read the live
// ~6000-file deep/ directory.
// ---------------------------------------------------------------------------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sws-shard-partition-"));
process.env.SWS_REPO_ROOT_OVERRIDE = TMP_ROOT;

const { PATHS, SHARD_COUNT } = await import("../scripts/sws-config.mjs");
const { shardSliceContiguous, shardSliceLegacyModular } =
  await import("../scripts/sws-shard-partition.mjs");
const { rewriteProgressFromDeep } = await import("../scripts/sws-universe-from-sitemap.mjs");
const scraper = await import("../scripts/sws-api-scrape.mjs");

const UNIVERSE = buildUniverse();
const SHARDS = Array.from({ length: SHARD_COUNT }, (_, i) => i + 1);

try {

console.log("\n1. The live scraper binds to the shared partition — no private copy");
{
  assert(
    "sws-api-scrape.mjs exports the shared function itself (identity, not a duplicate)",
    scraper.shardSlice === shardSliceContiguous,
    scraper.shardSlice === shardSliceContiguous,
  );
  // Importing the scraper must not run a scrape or hijack the importer's
  // process handlers — that entrypoint guard is what makes this test possible.
  assert(
    "importing the scraper installs no fatal handlers (guard held)",
    process.listenerCount("uncaughtException") === 0,
    process.listenerCount("uncaughtException"),
  );
}

console.log("\n2. Contiguous partition contract (the scheme that actually runs)");
{
  const slices = SHARDS.map((s) => shardSliceContiguous(UNIVERSE, s, SHARD_COUNT));
  const union = slices.flatMap(tickers);
  const alphabetical = UNIVERSE.map((e) => e.ticker).sort((a, b) => a.localeCompare(b));

  assert("every entry lands in exactly one shard", eq(union, alphabetical), union.length);
  assert("no entry is duplicated across shards", new Set(union).size === union.length, union.length);
  assert(
    "concatenating the shards in order reproduces the alphabetical universe",
    eq(union, alphabetical),
    union.slice(0, 3),
  );
  assert(
    "numeric BSE codes cluster in shard 1, as the run logs showed",
    slices[0][0].ticker === "20MICRONS" && tickers(slices[0]).includes("543320"),
    tickers(slices[0]).slice(0, 4),
  );
  assert(
    "the last shard ends on the alphabetically-last ticker",
    slices[SHARD_COUNT - 1].at(-1).ticker === "ZYDUSWELL",
    slices[SHARD_COUNT - 1].at(-1).ticker,
  );
  assert(
    "the remainder goes to the LAST shard (floor division, load-bearing for cursors)",
    slices[0].length === Math.floor(UNIVERSE.length / SHARD_COUNT)
      && slices[SHARD_COUNT - 1].length >= slices[0].length,
    slices.map((s) => s.length),
  );
  assert(
    "repeated calls are deterministic",
    eq(tickers(shardSliceContiguous(UNIVERSE, 2, SHARD_COUNT)), tickers(slices[1])),
    null,
  );
  assert(
    "the input array is not mutated",
    UNIVERSE[0].ticker === "RELIANCE" && UNIVERSE[0].index === 0,
    UNIVERSE[0],
  );
}

console.log("\n3. Contiguous partition edge cases");
{
  const tiny = [{ ticker: "A" }, { ticker: "B" }];
  assert(
    "fewer entries than shards: all but the last shard are empty",
    eq(SHARDS.map((s) => shardSliceContiguous(tiny, s, 3).length), [0, 0, 2]),
    SHARDS.map((s) => shardSliceContiguous(tiny, s, 3).length),
  );
  assert("empty universe yields empty slices", shardSliceContiguous([], 1, 3).length === 0, null);
  assert(
    "entries missing a ticker sort first and do not throw",
    shardSliceContiguous([{ index: 0 }, { ticker: "B" }, { ticker: "C" }], 3, 3).length === 1,
    null,
  );

  let threw = null;
  try { shardSliceContiguous(UNIVERSE, 4, 3); } catch (e) { threw = e.message; }
  assert("out-of-range shardId throws rather than returning a wrong block", threw !== null, threw);
  threw = null;
  try { shardSliceContiguous(UNIVERSE, 0, 3); } catch (e) { threw = e.message; }
  assert("shardId 0 throws (1-based contract)", threw !== null, threw);
}

console.log("\n4. The two schemes genuinely differ — the mismatch was real");
{
  // If this ever passes trivially (schemes coincide), every agreement assertion
  // below becomes vacuous. Pin it explicitly.
  const contiguous = tickers(shardSliceContiguous(UNIVERSE, 1, SHARD_COUNT));
  const modular = tickers(shardSliceLegacyModular(UNIVERSE, 1));
  const preFix = tickers(legacyIndexModuloSlice(UNIVERSE, 1, SHARD_COUNT));

  assert(
    "contiguous shard 1 ≠ modular shard 1 (the drift this file guards)",
    !eq(contiguous.slice().sort(), modular.slice().sort()),
    { contiguous: contiguous.slice(0, 3), modular: modular.slice(0, 3) },
  );
  assert(
    "the pre-fix `index % 3` derivation reproduces the LEGACY slice exactly",
    eq(preFix, modular),
    { preFix: preFix.slice(0, 3), modular: modular.slice(0, 3) },
  );
  assert(
    "…and therefore disagrees with what the api scraper walks",
    !eq(preFix.slice().sort(), contiguous.slice().sort()),
    null,
  );
  assert(
    "modular slices also cover the universe exactly once (legacy stays whole)",
    eq(
      SHARDS.flatMap((s) => tickers(shardSliceLegacyModular(UNIVERSE, s))).sort(),
      UNIVERSE.map((e) => e.ticker).sort(),
    ),
    null,
  );
}

console.log("\n5. rewriteProgressFromDeep agrees with the scraper (the actual guard)");
{
  // Seed deep/ with a realistic partial scrape: the first 60% of the
  // CONTIGUOUS shard-1 slice, plus a scattered handful. The gap position is
  // what makes the cursor a fingerprint of the slice ORDER, so a wrong
  // partition produces a wrong cursor rather than a coincidentally equal one.
  fs.mkdirSync(PATHS.deepDir, { recursive: true });
  const s1 = shardSliceContiguous(UNIVERSE, 1, SHARD_COUNT);
  const seeded = [
    ...tickers(s1).slice(0, Math.floor(s1.length * 0.6)),
    "RELIANCE", "TCS", "ZYDUSWELL",
  ];
  for (const t of seeded) fs.writeFileSync(path.join(PATHS.deepDir, `${t}.json`), "{}");
  const scraped = new Set(seeded);

  const report = rewriteProgressFromDeep(UNIVERSE);

  for (const shardId of SHARDS) {
    const apiPath = PATHS.progressApi(shardId);
    assert(
      `shard ${shardId}: progress-api-${shardId}.json was written at all (pre-fix: never)`,
      fs.existsSync(apiPath),
      apiPath,
    );
    const api = readJsonOr(apiPath);
    const want = expectedCursor(shardSliceContiguous(UNIVERSE, shardId, SHARD_COUNT), scraped);
    assert(
      `shard ${shardId}: api cursor matches a walk of the scraper's own slice`,
      api.next_local_index === want.next && api.done_count === want.done
        && api._slice_size === want.slice_size,
      { got: { next: api.next_local_index, done: api.done_count, size: api._slice_size }, want },
    );
    assert(
      `shard ${shardId}: api file records the contiguous scheme`,
      api._shard_scheme === "contiguous_alphabetical",
      api._shard_scheme,
    );

    const legacyPath = PATHS.progress(shardId);
    assert(
      `shard ${shardId}: progress-${shardId}.json still written for the legacy pipeline`,
      fs.existsSync(legacyPath),
      legacyPath,
    );
    const legacy = readJsonOr(legacyPath);
    const wantLegacy = expectedCursor(shardSliceLegacyModular(UNIVERSE, shardId), scraped);
    assert(
      `shard ${shardId}: legacy cursor derived under the MODULAR scheme, not the api one`,
      legacy.next_local_index === wantLegacy.next && legacy.done_count === wantLegacy.done
        && legacy._slice_size === wantLegacy.slice_size,
      { got: { next: legacy.next_local_index, done: legacy.done_count }, want: wantLegacy },
    );
  }

  // Discrimination: if the fixture produced identical cursors under both
  // schemes the assertions above could not distinguish them. Require at least
  // one shard where they differ.
  const differs = SHARDS.some((s) => {
    const a = expectedCursor(shardSliceContiguous(UNIVERSE, s, SHARD_COUNT), scraped);
    const b = expectedCursor(shardSliceLegacyModular(UNIVERSE, s), scraped);
    return a.next !== b.next || a.done !== b.done;
  });
  assert("fixture discriminates the two schemes (test is not vacuous)", differs, differs);

  assert(
    "report is keyed by filename so a wrong-file write is visible in the log",
    Object.keys(report).sort().join(",")
      === "progress-1.json,progress-2.json,progress-3.json,progress-api-1.json,progress-api-2.json,progress-api-3.json",
    Object.keys(report).sort(),
  );

  // The original bug, stated as an assertion: writing the modular-derived
  // cursor into the api file would have mis-seeded the live pipeline.
  const preFixCursor = expectedCursor(legacyIndexModuloSlice(UNIVERSE, 1, SHARD_COUNT), scraped);
  const apiCursor = readJsonOr(PATHS.progressApi(1)).next_local_index;
  assert(
    "pre-fix cursor for shard 1 ≠ the api pipeline's correct cursor",
    preFixCursor.next !== apiCursor,
    { preFix: preFixCursor.next, correct: apiCursor },
  );
}

console.log("\n6. Progress filenames agree with what sws-api-scrape.mjs reads");
{
  assert(
    "PATHS.progressApi basename is progress-api-<n>.json",
    path.basename(PATHS.progressApi(2)) === "progress-api-2.json",
    path.basename(PATHS.progressApi(2)),
  );
  // sws-api-scrape.mjs resolves its own repo root and ignores
  // SWS_REPO_ROOT_OVERRIDE, so compare in a child process with no override —
  // config caches repoRoot at import, and the two cannot coexist in-process.
  const probe = execFileSync(process.execPath, ["-e", `
    const path = require("node:path");
    import("${pathToPosix(path.join(REPO_ROOT, "scripts/sws-config.mjs"))}").then(({ PATHS }) => {
      const scraperPath = path.join(${JSON.stringify(REPO_ROOT)}, "data/sws", "progress-api-2.json");
      console.log(JSON.stringify({ config: PATHS.progressApi(2), scraper: scraperPath }));
    });
  `], { encoding: "utf8", env: { ...process.env, SWS_REPO_ROOT_OVERRIDE: "" } });
  const { config, scraper: scraperPath } = JSON.parse(probe);
  assert(
    "PATHS.progressApi resolves to the exact path sws-api-scrape.mjs builds",
    config === scraperPath,
    { config, scraper: scraperPath },
  );
}

} finally {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
}

function pathToPosix(p) { return p.split(path.sep).join("/"); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
