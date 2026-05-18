import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findAnalogs,
  matchRegimes,
  buildSectorDistribution,
  loadAllRegimeHistory,
} from "../services/macroThesis/historicalAnalogFinder.js";

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

function withFixtures(regimeRows, sectorSeries, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogFinder-"));
  const regimeDir = path.join(root, "macroRegime-history");
  const sectorDir = path.join(root, "sector-indices");
  fs.mkdirSync(regimeDir);
  fs.mkdirSync(sectorDir);
  fs.writeFileSync(
    path.join(regimeDir, "test.jsonl"),
    regimeRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  for (const [key, bars] of Object.entries(sectorSeries || {})) {
    fs.writeFileSync(
      path.join(sectorDir, `${key}.jsonl`),
      bars.map((b) => JSON.stringify(b)).join("\n") + "\n",
    );
  }
  try {
    fn({ regimeDir, sectorDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const WAR_ANALOGS = [
  { regime: "WAR_ESCALATION", severity: 4, generatedAt: "2022-02-24T00:00:00Z", regimeLabel: "Russia-Ukraine" },
  { regime: "WAR_ESCALATION", severity: 3, generatedAt: "2023-10-07T00:00:00Z", regimeLabel: "Israel-Hamas" },
  { regime: "WAR_ESCALATION", severity: 3, generatedAt: "2025-05-07T00:00:00Z", regimeLabel: "India-Pak" },
  { regime: "CALM", severity: 1, generatedAt: "2026-05-01T00:00:00Z", regimeLabel: "Calm" },
];

// Build a realty series that goes DOWN -10% over 30d after each war event,
// and an IT series that recovers +5% over the same window.
function makeReturnSeries(events, returns) {
  const bars = [];
  for (const event of events) {
    let day = new Date(event + "T00:00:00Z");
    let close = 100;
    for (let i = 0; i < 90; i++) {
      bars.push({ date: day.toISOString().slice(0, 10), close: Math.round(close * 100) / 100 });
      day.setUTCDate(day.getUTCDate() + 1);
      // apply daily change derived from horizon returns
      close *= 1 + returns(i);
    }
  }
  // Dedup by date (events may overlap if too close)
  const seen = new Set();
  return bars.filter((b) => (seen.has(b.date) ? false : (seen.add(b.date), true)));
}

test("matchRegimes finds analogs by regime+severity", () => {
  withFixtures(WAR_ANALOGS, {}, ({ regimeDir }) => {
    const m = matchRegimes({
      regime: "WAR_ESCALATION",
      severity: 3,
      currentDate: "2025-05-07",
      excludeWindowDays: 30,
      regimeHistoryDir: regimeDir,
    });
    // Should match Russia-Ukraine (sev 4, within tolerance 1) and Israel-Hamas (sev 3) — exclude India-Pak as the current event
    assert.equal(m.length, 2, `expected 2, got ${m.length}: ${JSON.stringify(m.map((x) => x.label))}`);
    assert.ok(m.find((x) => x.label === "Russia-Ukraine"));
    assert.ok(m.find((x) => x.label === "Israel-Hamas"));
  });
});

test("matchRegimes severity tolerance respects bounds", () => {
  withFixtures(WAR_ANALOGS, {}, ({ regimeDir }) => {
    const tight = matchRegimes({
      regime: "WAR_ESCALATION",
      severity: 3,
      toleranceSeverity: 0,
      regimeHistoryDir: regimeDir,
    });
    // Only exact-sev-3 events — Israel-Hamas + India-Pak
    assert.equal(tight.length, 2);
  });
});

test("buildSectorDistribution computes median/IQR per horizon", () => {
  // 3 dates with realty all DOWN ~-3% at +7d, IT FLAT
  const dates = ["2022-02-24", "2023-10-07", "2025-05-07"];
  const realtyBars = makeReturnSeries(dates, () => -0.005); // -0.5% per day → ~-3.5% at +7d
  const itBars = makeReturnSeries(dates, () => 0);
  withFixtures(
    WAR_ANALOGS,
    { NIFTY_REALTY: realtyBars, NIFTY_IT: itBars },
    ({ regimeDir, sectorDir }) => {
      const matched = matchRegimes({
        regime: "WAR_ESCALATION",
        severity: 3,
        currentDate: "2030-01-01",
        excludeWindowDays: 0,
        regimeHistoryDir: regimeDir,
      });
      assert.ok(matched.length >= 2);
      const sectors = buildSectorDistribution({ matched, sectorDataDir: sectorDir });
      assert.ok(sectors.NIFTY_REALTY, "realty data present");
      const realty7d = sectors.NIFTY_REALTY.horizons[7];
      assert.ok(realty7d.n >= 2);
      assert.ok(realty7d.median < 0, `realty should be negative at +7d; got ${realty7d.median}`);
      const it7d = sectors.NIFTY_IT.horizons[7];
      assert.ok(Math.abs(it7d.median) < 1, `IT should be ~flat; got ${it7d.median}`);
    },
  );
});

test("findAnalogs returns INDETERMINATE when n < 3", () => {
  withFixtures([WAR_ANALOGS[0]], {}, ({ regimeDir, sectorDir }) => {
    const r = findAnalogs({
      regime: "WAR_ESCALATION",
      severity: 4,
      currentDate: "2030-01-01",
      excludeWindowDays: 0,
      regimeHistoryDir: regimeDir,
      sectorDataDir: sectorDir,
    });
    assert.equal(r.n_analogs, 1);
    assert.equal(r.indeterminate, true);
    assert.ok(r.warnings.length > 0);
  });
});

test("findAnalogs flags missing sector data as a warning", () => {
  withFixtures(WAR_ANALOGS, {}, ({ regimeDir, sectorDir }) => {
    const r = findAnalogs({
      regime: "WAR_ESCALATION",
      severity: 3,
      currentDate: "2030-01-01",
      excludeWindowDays: 0,
      regimeHistoryDir: regimeDir,
      sectorDataDir: sectorDir,
    });
    assert.ok(r.n_analogs >= 2);
    assert.ok(r.warnings.some((w) => w.includes("no sector-index data") || w.includes("only ")));
  });
});

test("loadAllRegimeHistory: empty dir → empty array (no crash)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "analogFinder-empty-"));
  try {
    const r = loadAllRegimeHistory({ regimeHistoryDir: dir });
    assert.deepEqual(r, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
