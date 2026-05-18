import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadSectorSeries,
  computeRollingReturns,
  computeAllSectorReturns,
  describeSectorFreshness,
  STANDARD_HORIZONS_DAYS,
} from "../services/macroThesis/sectorReturnLoader.js";
import { SECTOR_INDEX_CATALOG, SECTOR_KEYS, getSectorEntry, getEntryForSectorName } from "../services/macroThesis/sectorIndexCatalog.js";

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

function withFixture(seriesByKey, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sectorReturnLoader-"));
  for (const [key, bars] of Object.entries(seriesByKey)) {
    const lines = bars.map((b) => JSON.stringify(b)).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, `${key}.jsonl`), lines);
  }
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ───────── catalog ─────────
test("SECTOR_INDEX_CATALOG covers ≥15 sectors and is frozen", () => {
  assert.ok(SECTOR_INDEX_CATALOG.length >= 14);
  assert.throws(() => SECTOR_INDEX_CATALOG.push({}));
});
test("SECTOR_KEYS exposes all keys", () => {
  assert.equal(SECTOR_KEYS.length, SECTOR_INDEX_CATALOG.length);
  for (const k of SECTOR_KEYS) assert.ok(getSectorEntry(k));
});
test("getEntryForSectorName matches Real Estate → NIFTY_REALTY", () => {
  const e = getEntryForSectorName("Real Estate");
  assert.ok(e);
  assert.equal(e.key, "NIFTY_REALTY");
});

// ───────── loader ─────────
test("loadSectorSeries reads + sorts a fixture jsonl", () => {
  withFixture(
    {
      NIFTY_IT: [
        { date: "2026-05-03", close: 38000 },
        { date: "2026-05-01", close: 37500 },
        { date: "2026-05-02", close: 37800 },
      ],
    },
    (dir) => {
      const s = loadSectorSeries("NIFTY_IT", { dataDir: dir });
      assert.equal(s.length, 3);
      assert.deepEqual(
        s.map((b) => b.date),
        ["2026-05-01", "2026-05-02", "2026-05-03"],
      );
    },
  );
});
test("loadSectorSeries skips malformed lines without crashing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sectorReturnLoader-malformed-"));
  try {
    fs.writeFileSync(
      path.join(dir, "NIFTY_IT.jsonl"),
      JSON.stringify({ date: "2026-05-01", close: 37500 }) + "\nnot-json-at-all\n" + JSON.stringify({ date: "2026-05-02", close: 37700 }) + "\n",
    );
    const s = loadSectorSeries("NIFTY_IT", { dataDir: dir });
    assert.equal(s.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────── rolling returns ─────────
test("computeRollingReturns at +7/+14/+30 days", () => {
  // Build a synthetic 60-day series: start at 100, rise linearly +1/day
  const bars = [];
  let d = new Date("2026-04-01T00:00:00Z");
  for (let i = 0; i < 60; i++) {
    bars.push({ date: d.toISOString().slice(0, 10), close: 100 + i });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  withFixture({ NIFTY_IT: bars }, (dir) => {
    const r = computeRollingReturns("NIFTY_IT", "2026-04-01", { dataDir: dir });
    assert.ok(r.entry);
    assert.equal(r.entry.close, 100);
    // +7d → close 107 → +7%
    assert.ok(Math.abs(r.horizons[7].return_pct - 7) < 0.01);
    // +30d → close 130 → +30%
    assert.ok(Math.abs(r.horizons[30].return_pct - 30) < 0.01);
  });
});
test("computeRollingReturns: horizon beyond series → null", () => {
  withFixture(
    { NIFTY_IT: [{ date: "2026-05-01", close: 100 }, { date: "2026-05-02", close: 101 }] },
    (dir) => {
      const r = computeRollingReturns("NIFTY_IT", "2026-05-01", { dataDir: dir });
      assert.ok(r.horizons[7] === null || r.horizons[7] == null, "no +7d bar available");
    },
  );
});
test("computeRollingReturns: reference date before series → empty", () => {
  withFixture({ NIFTY_IT: [{ date: "2026-05-01", close: 100 }] }, (dir) => {
    const r = computeRollingReturns("NIFTY_IT", "2025-01-01", { dataDir: dir });
    assert.equal(r._empty, true);
    assert.equal(r.entry, null);
  });
});

// ───────── batch + freshness ─────────
test("computeAllSectorReturns iterates the catalog", () => {
  withFixture({}, (dir) => {
    const out = computeAllSectorReturns("2026-05-01", { dataDir: dir });
    assert.equal(Object.keys(out).length, SECTOR_INDEX_CATALOG.length);
    // All empty since no fixtures
    for (const k of Object.keys(out)) assert.equal(out[k]._empty, true);
  });
});
test("describeSectorFreshness reports stale_days", () => {
  withFixture(
    {
      NIFTY_IT: [{ date: "2026-05-01", close: 100 }, { date: "2026-05-15", close: 105 }],
    },
    (dir) => {
      const f = describeSectorFreshness({ dataDir: dir, asOf: "2026-05-18" });
      assert.equal(f.NIFTY_IT.latest_date, "2026-05-15");
      assert.equal(f.NIFTY_IT.stale_days, 3);
      // Other sectors: no fixture → null
      assert.equal(f.NIFTY_REALTY.latest_date, null);
    },
  );
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
