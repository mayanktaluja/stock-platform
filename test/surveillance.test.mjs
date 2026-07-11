/**
 * surveillance.js — NSE ASM/GSM snapshot freshness + outage guards.
 *
 * Production can have both a KV snapshot and a bundled disk snapshot. A stale
 * KV value must not mask a fresher `surveillance.json` shipped by the local
 * nightly, and a zero-row NSE outage must not overwrite a populated last-good
 * file.
 *
 * Run with: node test/surveillance.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const REAL_FILE = path.join(REPO_ROOT, "surveillance.json");

assert(
  !process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN,
  "test refuses to run with @vercel/kv configured — would write to remote KV"
);

const HAD_ORIGINAL = fs.existsSync(REAL_FILE);
const ORIGINAL_CONTENT = HAD_ORIGINAL ? fs.readFileSync(REAL_FILE, "utf-8") : null;

function restoreFile() {
  try {
    if (HAD_ORIGINAL) {
      fs.writeFileSync(REAL_FILE, ORIGINAL_CONTENT, "utf-8");
    } else if (fs.existsSync(REAL_FILE)) {
      fs.unlinkSync(REAL_FILE);
    }
  } catch (err) {
    console.error("[surveillance.test] FATAL: could not restore surveillance.json —", err.message);
  }
}
process.on("exit", restoreFile);
process.on("SIGINT", () => { restoreFile(); process.exit(130); });
process.on("uncaughtException", (err) => { restoreFile(); console.error(err); process.exit(1); });

const {
  buildSurveillance,
  getSurveillance,
  getSurveillanceStatus,
  saveSurveillance,
  _resetSurveillanceCacheForTests,
  _setSurveillanceCacheForTests,
  _surveillanceParserForTests,
} = await import("../surveillance.js");

let pass = 0;
let fail = 0;
async function it(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  ✓", name);
  } catch (err) {
    fail++;
    console.log("  ✗", name, "\n   ", err && err.message);
  }
}

function snap({ fetchedAt, symbols = ["AAA.NS"], source = "nse" } = {}) {
  const flagged = {};
  for (const symbol of symbols) {
    flagged[symbol] = { symbol, list: "ASM", stage: null, timeframe: "longterm", series: null };
  }
  return {
    fetchedAt,
    source,
    flagged,
    counts: { ASM: symbols.length, GSM: 0 },
  };
}

function emptySnap(fetchedAt = "2026-05-25T00:00:00.000Z") {
  return {
    fetchedAt,
    source: "nse",
    flagged: {},
    counts: { ASM: 0, GSM: 0 },
  };
}

function seedDisk(snapshot) {
  fs.writeFileSync(REAL_FILE, JSON.stringify(snapshot, null, 2), "utf-8");
  _resetSurveillanceCacheForTests();
}

console.log("\nsurveillance snapshot resolution\n");

await it("parses current NSE ASM shape with asmSurvIndicator and source time", () => {
  const rows = _surveillanceParserForTests.parseAsmRows({
    longterm: {
      data: [
        { symbol: "FOO", series: "EQ", asmSurvIndicator: "Stage I", asmTime: "17-Jun-2026" },
      ],
    },
    shortterm: {
      data: [
        { Symbol: "BAR", Series: "BE", asmSurvIndicator: "Stage II", asmTime: "17-Jun-2026" },
      ],
    },
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    symbol: "FOO.NS",
    list: "ASM",
    stage: "I",
    stage_num: 1,
    stage_label: "Stage I",
    timeframe: "longterm",
    series: "EQ",
    source_time: "17-Jun-2026",
  });
  assert.equal(rows[1].symbol, "BAR.NS");
  assert.equal(rows[1].stage, "II");
  assert.equal(rows[1].stage_num, 2);
  assert.equal(rows[1].timeframe, "shortterm");
  assert.equal(rows[1].series, "BE");
  assert.equal(rows[1].source_time, "17-Jun-2026");
});

await it("parses current NSE GSM top-level array shape", () => {
  const rows = _surveillanceParserForTests.parseGsmRows([
    { symbol: "ASIL", series: "EQ", gsmStage: "VI", gsmTime: "17-Jun-2026 08:08:02" },
  ]);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    symbol: "ASIL.NS",
    list: "GSM",
    stage: "VI",
    stage_num: 6,
    stage_label: "VI",
    timeframe: null,
    series: "EQ",
    source_time: "17-Jun-2026 08:08:02",
  });
});

await it("keeps backward compatibility with legacy GSM { data: [...] } shape", () => {
  const rows = _surveillanceParserForTests.parseGsmRows({
    data: [{ Symbol: "OLD", Series: "BZ", Stage: "III", Time: "legacy-time" }],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "OLD.NS");
  assert.equal(rows[0].stage, "III");
  assert.equal(rows[0].stage_num, 3);
  assert.equal(rows[0].series, "BZ");
  assert.equal(rows[0].source_time, "legacy-time");
});

await it("normalizes numeric and Roman surveillance stages for GSM-3+ logic", () => {
  assert.deepEqual(_surveillanceParserForTests.normalizeStage("Stage 3"), {
    stage: "3",
    stage_num: 3,
    stage_label: "Stage 3",
  });
  assert.deepEqual(_surveillanceParserForTests.normalizeStage("LXII"), {
    stage: "LXII",
    stage_num: 62,
    stage_label: "LXII",
  });
});

await it("fresher disk snapshot beats stale KV/cache", () => {
  const disk = snap({ fetchedAt: "2026-05-25T01:00:00.000Z", symbols: ["FRESH.NS"] });
  seedDisk(disk);
  _setSurveillanceCacheForTests(
    snap({ fetchedAt: "2026-05-21T01:00:00.000Z", symbols: ["STALE.NS"], source: "kv" }),
    "kv",
  );

  const out = getSurveillance();
  assert.equal(out.flagged["FRESH.NS"]?.list, "ASM");
  assert.equal(out.flagged["STALE.NS"], undefined);
  assert.equal(getSurveillanceStatus().source, "disk");
});

await it("fresher KV/cache snapshot beats older bundled disk", () => {
  seedDisk(snap({ fetchedAt: "2026-05-21T01:00:00.000Z", symbols: ["OLD_DISK.NS"] }));
  _setSurveillanceCacheForTests(
    snap({ fetchedAt: "2026-05-25T01:00:00.000Z", symbols: ["FRESH_KV.NS"], source: "kv" }),
    "kv",
  );

  const out = getSurveillance();
  assert.equal(out.flagged["FRESH_KV.NS"]?.list, "ASM");
  assert.equal(out.flagged["OLD_DISK.NS"], undefined);
  assert.equal(getSurveillanceStatus().source, "kv");
});

await it("populated disk snapshot beats newer empty KV/cache snapshot", () => {
  seedDisk(snap({ fetchedAt: "2026-05-21T01:00:00.000Z", symbols: ["LAST_GOOD.NS"] }));
  _setSurveillanceCacheForTests(emptySnap("2026-05-25T01:00:00.000Z"), "kv");

  const out = getSurveillance();
  assert.equal(out.flagged["LAST_GOOD.NS"]?.list, "ASM");
  assert.equal(getSurveillanceStatus().source, "disk");
});

await it("zero-row snapshot does not overwrite a populated last-good file", async () => {
  const existing = snap({ fetchedAt: "2026-05-24T01:00:00.000Z", symbols: ["KEEP.NS"] });
  seedDisk(existing);

  const result = await saveSurveillance(emptySnap("2026-05-25T01:00:00.000Z"));

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "zero_rows_preserved_existing");
  assert.equal(result.existingCount, 1);
  const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
  assert.equal(onDisk.flagged["KEEP.NS"]?.list, "ASM");
  assert.equal(onDisk.fetchedAt, "2026-05-24T01:00:00.000Z");
});

await it("normal non-empty snapshot writes to disk and updates status totals", async () => {
  seedDisk(emptySnap("2026-05-20T01:00:00.000Z"));

  const result = await saveSurveillance(
    snap({ fetchedAt: "2026-05-25T01:00:00.000Z", symbols: ["WRITE1.NS", "WRITE2.NS"] }),
  );

  assert.equal(result.target, "disk");
  const onDisk = JSON.parse(fs.readFileSync(REAL_FILE, "utf-8"));
  assert.equal(Object.keys(onDisk.flagged).length, 2);
  const status = getSurveillanceStatus();
  assert.equal(status.total, 2);
  assert.equal(status.counts.ASM, 2);
});

await it("buildSurveillance marks a throwing fetcher as failed (strict refresh can refuse)", async () => {
  const asmRow = { symbol: "OK.NS", list: "ASM", stage: null, stage_num: null, timeframe: "longterm", series: null, source_time: null };
  const built = await buildSurveillance({
    fetchAsm: async () => [asmRow],
    fetchGsm: async () => { throw new Error("NSE returned no data for /api/reportGSM after 3 attempts"); },
  });

  assert.equal(built.fetchStatus.ASM, "ok");
  assert.equal(built.fetchStatus.GSM, "failed");
  assert.match(built.fetchErrors.GSM, /no data for \/api\/reportGSM/);
});

await it("buildSurveillance marks a zero-row 'success' as failed — NSE never has zero ASM/GSM stocks", async () => {
  const built = await buildSurveillance({
    fetchAsm: async () => [],
    fetchGsm: async () => [],
  });

  assert.equal(built.fetchStatus.ASM, "failed");
  assert.equal(built.fetchStatus.GSM, "failed");
  assert.match(built.fetchErrors.ASM, /parsed 0 rows/);
  assert.match(built.fetchErrors.GSM, /parsed 0 rows/);
});

_resetSurveillanceCacheForTests();

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
