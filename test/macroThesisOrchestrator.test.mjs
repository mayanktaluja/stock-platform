import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildMacroThesis, POSITION_CAP_PCT } from "../services/macroThesis/thesisOrchestrator.js";
import { rankSectorsFromAnalog } from "../services/macroThesis/sectorBeneficiaryRanker.js";
import { mapStocksToSector, KNOWN_CONGLOMERATES } from "../services/macroThesis/stockExposureMapper.js";

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

function withFixtures(regimeDoc, regimeHistory, sectorBars, picksDoc, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "macroThesis-"));
  const regimePath = path.join(dir, "macroRegime.json");
  fs.writeFileSync(regimePath, JSON.stringify(regimeDoc));
  const regimeHistoryDir = path.join(dir, "macroRegime-history");
  fs.mkdirSync(regimeHistoryDir);
  fs.writeFileSync(
    path.join(regimeHistoryDir, "test.jsonl"),
    regimeHistory.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const sectorDir = path.join(dir, "sector-indices");
  fs.mkdirSync(sectorDir);
  for (const [key, bars] of Object.entries(sectorBars || {})) {
    fs.writeFileSync(
      path.join(sectorDir, `${key}.jsonl`),
      bars.map((b) => JSON.stringify(b)).join("\n") + "\n",
    );
  }
  const picksPath = path.join(dir, "picks-latest.json");
  fs.writeFileSync(picksPath, JSON.stringify(picksDoc));
  try {
    fn({ regimePath, regimeHistoryDir, sectorDataDir: sectorDir, picksPath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NOW_REGIME = {
  regime: "WAR_ESCALATION",
  severity: 3,
  confidence: 0.75,
  regimeLabel: "India-Pak tensions",
  generatedAt: "2026-05-18T00:00:00Z",
};

const HISTORY = [
  { regime: "WAR_ESCALATION", severity: 3, regimeLabel: "Israel-Hamas", generatedAt: "2023-10-07T00:00:00Z" },
  { regime: "WAR_ESCALATION", severity: 4, regimeLabel: "Russia-Ukraine", generatedAt: "2022-02-24T00:00:00Z" },
  { regime: "WAR_ESCALATION", severity: 3, regimeLabel: "India-Pak 2025", generatedAt: "2025-05-07T00:00:00Z" },
  { regime: "CALM", severity: 1, regimeLabel: "Calm", generatedAt: "2024-08-01T00:00:00Z" },
];

const SAMPLE_PICKS = {
  sections: {
    upcoming: [
      { ticker: "DLF", name: "DLF Ltd", sector: "Real Estate", v3_score_100: 65, valuation_band: "DISCOUNT", combined_score: 70 },
      { ticker: "ANANTRAJ", name: "Anant Raj", sector: "Real Estate", v3_score_100: 64.8, valuation_band: "DEEP_DISCOUNT", combined_score: 65 },
      { ticker: "RELIANCE", name: "Reliance", sector: "Energy", v3_score_100: 75, valuation_band: "FAIR", combined_score: 80 },
      { ticker: "HAL", name: "Hindustan Aeronautics", sector: "Capital Goods", v3_score_100: 70, valuation_band: "DISCOUNT", combined_score: 78 },
      { ticker: "BEL", name: "Bharat Electronics", sector: "Capital Goods", v3_score_100: 68, valuation_band: "FAIR", combined_score: 72 },
      { ticker: "WEAK", name: "Weak Stock", sector: "Real Estate", v3_score_100: 30, valuation_band: "DEEP_OVERPRICE", combined_score: 25 },
    ],
  },
};

test("buildMacroThesis returns indeterminate when regime missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "macroThesis-empty-"));
  try {
    const r = buildMacroThesis({
      regimePath: path.join(dir, "nope.json"),
    });
    assert.equal(r.indeterminate, true);
    assert.ok(r.reason.includes("missing"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildMacroThesis assembles 4 branches when regime present", () => {
  withFixtures(NOW_REGIME, HISTORY, {}, SAMPLE_PICKS, ({ regimePath, regimeHistoryDir, sectorDataDir, picksPath }) => {
    const r = buildMacroThesis({
      regimePath,
      regimeHistoryDir,
      sectorDataDir,
      picksPath,
      asOf: new Date("2026-05-19T00:00:00Z"),
    });
    assert.equal(r.regime.regime, "WAR_ESCALATION");
    assert.equal(r.branches.length, 4);
    assert.deepEqual(
      r.branches.map((b) => b.key).sort(),
      ["continue", "de_escalate", "escalate", "new_shock"],
    );
  });
});

test("rankSectorsFromAnalog: empirical analog data beats template", () => {
  const ranking = rankSectorsFromAnalog({
    regime: "WAR_ESCALATION",
    scenarioBranchKey: "continue",
    scenarioProjection: {
      NIFTY_REALTY: {
        label: "Nifty Realty",
        sector: "Real Estate",
        horizons: { 30: { median: -8.5, p25: -12, p75: -3, n: 4 } },
      },
    },
  });
  // Real Estate should appear from analog (n=4, |median|=8.5) AND not be
  // duplicated by the template (skipped because already covered).
  const realty = ranking.ranked.find((r) => r.sector_bucket === "Real Estate");
  assert.ok(realty);
  assert.equal(realty.source, "analog");
  assert.equal(realty.direction, "HIT");
  assert.equal(realty.expected_return_pct, -8.5);
});

test("rankSectorsFromAnalog: falls back to template when analog n<3", () => {
  const ranking = rankSectorsFromAnalog({
    regime: "WAR_ESCALATION",
    scenarioBranchKey: "continue",
    scenarioProjection: {
      NIFTY_REALTY: { label: "Nifty Realty", sector: "Real Estate", horizons: { 30: { median: -8.5, n: 1 } } },
    },
  });
  // Realty analog rejected (n<3) → fills from template
  const realty = ranking.ranked.find((r) => r.sector_bucket === "Real Estate");
  assert.ok(realty);
  assert.equal(realty.source, "template");
});

test("mapStocksToSector: filters out conglomerates without override", () => {
  withFixtures(NOW_REGIME, HISTORY, {}, SAMPLE_PICKS, ({ picksPath }) => {
    const r = mapStocksToSector({ sectorBucket: "Energy", picksPath });
    // Energy has only RELIANCE; conglomerate filter should exclude it
    assert.equal(r.stocks.length, 0);
    assert.ok(r.excluded_conglomerates.includes("RELIANCE"));
  });
});

test("mapStocksToSector: returns pure-play stocks for Real Estate", () => {
  withFixtures(NOW_REGIME, HISTORY, {}, SAMPLE_PICKS, ({ picksPath }) => {
    const r = mapStocksToSector({ sectorBucket: "Real Estate", picksPath });
    assert.ok(r.stocks.length >= 2);
    const tickers = r.stocks.map((s) => s.ticker);
    assert.ok(tickers.includes("DLF"));
    assert.ok(tickers.includes("ANANTRAJ"));
    assert.ok(!tickers.includes("WEAK"), "WEAK should be excluded (v3 < 50)");
  });
});

test("buildMacroThesis includes the position-cap caveat", () => {
  withFixtures(NOW_REGIME, HISTORY, {}, SAMPLE_PICKS, ({ regimePath, regimeHistoryDir, sectorDataDir, picksPath }) => {
    const r = buildMacroThesis({ regimePath, regimeHistoryDir, sectorDataDir, picksPath });
    assert.ok(r.caveats.some((c) => c.includes(`${POSITION_CAP_PCT}%`)));
  });
});

test("KNOWN_CONGLOMERATES is comprehensive", () => {
  for (const c of ["RELIANCE", "ITC", "LT", "ADANIENT"]) {
    assert.ok(KNOWN_CONGLOMERATES.has(c), `${c} should be a known conglomerate`);
  }
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
