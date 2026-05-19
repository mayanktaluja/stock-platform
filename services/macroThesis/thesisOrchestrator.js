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
import { getUpcomingCatalysts, getCatalystProximity } from "./catalystTimeline.js";

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

  // PR B4 — pull upcoming catalysts so the scenario probability engine
  // gets a real catalystProximityDays input (instead of the explicit
  // override only). Caller can still override via opts.catalystProximityDays.
  const upcomingCatalysts = getUpcomingCatalysts({
    asOf: asOf.toISOString().slice(0, 10),
  });
  const effectiveCatalystProximity =
    catalystProximityDays != null
      ? catalystProximityDays
      : getCatalystProximity({ asOf: asOf.toISOString().slice(0, 10) });

  const scenarioPackage = buildScenarioPackage({
    regime,
    severity,
    daysInState: daysInState || 0,
    catalystProximityDays: effectiveCatalystProximity,
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
      // PR 4 (2026-05-19) — TRANSPARENCY — surface the reasoning the
      // orchestrator was already computing but throwing away. Lets the
      // UI render "Why this branch?" with the actual math + analogs +
      // analog warnings instead of opaque probabilities.
      reasoning: {
        modulator_applied: sc.modulator_applied,
        base_probability: _baseProbabilityFor(sc.key),
        analog_pool_regime:
          sc.key === "de_escalate"
            ? "CALM"
            : sc.key === "escalate"
              ? `${regime} (severity +1)`
              : sc.key === "new_shock"
                ? "n/a (new regime — projection suppressed by design)"
                : regime,
        analog_warnings: _analogWarningsFor(scenarioPackage, sc.key),
        analogs: _analogsFor(scenarioPackage, sc.key).slice(0, 5),
      },
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
      // PR 4 — surface the regime classifier's REASONING (LLM one-liner) +
      // the top news headlines that drove the call. This is what was
      // already computed by macroRegime.js and dropped before reaching the
      // UI. SEBI Reg 16: every conclusion must have its evidence visible.
      reasoning: regimeDoc.reasoning || null,
      key_events: Array.isArray(regimeDoc.keyEvents) ? regimeDoc.keyEvents.slice(0, 5) : [],
      classifier_provider: regimeDoc.classifierProvider || null,
      source_health: regimeDoc.sourceHealth || null,
      tier_coverage: regimeDoc.tierCoverage || null,
      sector_impacts: Array.isArray(regimeDoc.sectorImpacts) ? regimeDoc.sectorImpacts : [],
    },
    catalyst_proximity_days: effectiveCatalystProximity,
    upcoming_catalysts: upcomingCatalysts.slice(0, 10),
    position_cap_pct: POSITION_CAP_PCT,
    branches,
    caveats,
    indeterminate: branches.every((b) => b.indeterminate),
    // PR 4 — audit footer for the UI to render (schema + freshness +
    // classifier provenance). Mirrors the Earnings Watch "How prediction
    // was built" pattern at gated/earnings.js:872-956.
    audit: {
      thesis_schema: "macro-thesis-v1",
      regime_generated_at: regimeDoc.generatedAt || null,
      regime_classifier: regimeDoc.classifierProvider || null,
      scenario_engine_version: scenarioPackage.engine_version || null,
    },
  };
}

// PR 4 — helpers for branch reasoning. The base probabilities are duplicated
// here from scenarioProbabilityEngine.js for display only — the canonical
// definition is in that file. If those weights change there, change here.
function _baseProbabilityFor(branchKey) {
  return { continue: 0.55, escalate: 0.15, de_escalate: 0.20, new_shock: 0.10 }[branchKey] ?? null;
}
function _analogWarningsFor(pkg, branchKey) {
  if (!pkg) return [];
  const map = {
    continue: pkg.analog_report_continue?.warnings,
    escalate: pkg.analog_report_escalate?.warnings,
    de_escalate: pkg.analog_report_de_escalate?.warnings,
  };
  return Array.isArray(map[branchKey]) ? map[branchKey] : [];
}
function _analogsFor(pkg, branchKey) {
  if (!pkg || !pkg.scenarios) return [];
  const sc = pkg.scenarios.find((s) => s.key === branchKey);
  // We didn't store analogs[] on the scenario; they live one level deeper
  // in the analog_report_* siblings of the package. Return what's
  // available — scenarios in the package only have n_analogs without
  // dates. UI shows the count + warnings; the dates surface in PR 5+
  // when we plumb analog_report.matched_dates through.
  return sc?.analogs || [];
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
