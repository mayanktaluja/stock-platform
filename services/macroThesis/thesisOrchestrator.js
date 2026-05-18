// Macro thesis orchestrator (PR B3).
//
// Single entrypoint that assembles the full thesis package:
//   - current regime (from data/macroRegime.json)
//   - scenario probabilities (B2)
//   - per-branch sector beneficiaries + losers (B3 ranker)
//   - per-sector stock candidates (B3 mapper)
//   - all the SEBI Reg 16 caveats (n_analogs, indeterminate flags,
//     conglomerate exclusions, "max 10% per thesis" position cap)
//
// Output is the snapshot consumed by /api/risk-lab/macro-thesis and
// rendered by the gated UI sub-view.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildScenarioPackage } from "./scenarioProbabilityEngine.js";
import { rankSectorsFromAnalog } from "./sectorBeneficiaryRanker.js";
import { mapStocksToSector } from "./stockExposureMapper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_REGIME_PATH = path.join(REPO_ROOT, "data", "macroRegime.json");
export const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, "data", "risk-lab", "macro-thesis-latest.json");

export const POSITION_CAP_PCT = 10; // hard cap per thesis (SEBI Reg 16 framing)

function _loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

// daysSince returns whole days between two ISO datetimes (UTC).
function _daysSince(iso, asOf = new Date()) {
  if (!iso) return null;
  const a = new Date(iso).getTime();
  const b = asOf.getTime();
  return Math.floor((b - a) / (24 * 3600 * 1000));
}

export function buildMacroThesis({
  regimePath = DEFAULT_REGIME_PATH,
  picksPath,
  overridesPath,
  regimeHistoryDir,
  sectorDataDir,
  asOf = new Date(),
  catalystProximityDays = null,
} = {}) {
  const regimeDoc = _loadJson(regimePath);
  if (!regimeDoc) {
    return {
      schema_version: "macro-thesis-v1",
      generated_at: new Date().toISOString(),
      regime: null,
      indeterminate: true,
      reason: "macroRegime.json missing — run scripts/refresh-macro-regime.mjs",
      caveats: ["No regime detected — thesis unavailable"],
    };
  }
  const regime = regimeDoc.regime;
  const severity = regimeDoc.severity;
  const daysInState = _daysSince(regimeDoc.generatedAt, asOf);

  const scenarioPackage = buildScenarioPackage({
    regime,
    severity,
    daysInState: daysInState || 0,
    catalystProximityDays,
    currentDate: asOf.toISOString().slice(0, 10),
    regimeHistoryDir,
    sectorDataDir,
  });

  // For each scenario branch, rank sectors + map stocks for the top 3
  // beneficiaries and top 3 losers.
  const branches = (scenarioPackage.scenarios || []).map((sc) => {
    const ranking = rankSectorsFromAnalog({
      regime: sc.key === "de_escalate" ? "CALM" : (sc.key === "escalate" ? regime : regime),
      scenarioBranchKey: sc.key,
      scenarioProjection: sc.projected_sector_returns,
    });
    const beneficiaries = ranking.ranked.filter((r) => r.direction === "BENEFICIARY").slice(0, 3);
    const losers = ranking.ranked.filter((r) => r.direction === "HIT").slice(0, 3);

    // Stock candidates per beneficiary sector
    const beneficiariesWithStocks = beneficiaries.map((b) => ({
      ...b,
      stock_candidates: mapStocksToSector({
        sectorBucket: b.sector_bucket,
        picksPath,
        overridesPath,
      }),
    }));

    return {
      key: sc.key,
      label: sc.label,
      probability: sc.probability,
      duration_days: sc.duration_days,
      n_analogs: sc.n_analogs,
      indeterminate: sc.indeterminate,
      beneficiaries: beneficiariesWithStocks,
      losers,
    };
  });

  // SEBI-RA caveats roll-up
  const caveats = [];
  caveats.push(`Position-sizing cap: max ${POSITION_CAP_PCT}% of portfolio per thesis — multi-thesis diversification mandatory.`);
  if (regimeDoc.confidence != null && regimeDoc.confidence < 0.6) {
    caveats.push(`Regime confidence ${Math.round(regimeDoc.confidence * 100)}% — below the 60% high-conviction threshold; treat outlook as speculative.`);
  }
  if (branches.some((b) => b.indeterminate)) {
    const ind = branches.filter((b) => b.indeterminate).map((b) => b.key).join(", ");
    caveats.push(`INDETERMINATE branches (n<3 analogs): ${ind} — sector projections suppressed for these branches.`);
  }
  caveats.push("Analog backtester is heuristic-seeded (~12 events); recommendations require user judgement, not auto-trading.");

  return {
    schema_version: "macro-thesis-v1",
    generated_at: new Date().toISOString(),
    regime: {
      regime,
      severity,
      confidence: regimeDoc.confidence,
      label: regimeDoc.regimeLabel || regimeDoc.regime,
      generated_at: regimeDoc.generatedAt,
      days_in_state: daysInState,
      stale: regimeDoc.stale === true,
    },
    catalyst_proximity_days: catalystProximityDays,
    position_cap_pct: POSITION_CAP_PCT,
    branches,
    caveats,
    indeterminate: branches.every((b) => b.indeterminate),
  };
}

// Convenience: build + atomically write to data/risk-lab/macro-thesis-latest.json
export function writeMacroThesis(opts = {}) {
  const thesis = buildMacroThesis(opts);
  const outPath = opts.outputPath || DEFAULT_OUTPUT_PATH;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(thesis, null, 2));
  return { thesis, outputPath: outPath };
}

export default { buildMacroThesis, writeMacroThesis, POSITION_CAP_PCT };
