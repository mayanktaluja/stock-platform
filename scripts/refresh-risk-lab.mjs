#!/usr/bin/env node
/**
 * Risk Lab refresh — runs the orchestrator and writes data/risk-lab/*.
 *
 * Read-only on production files:
 *   - reads data/sws/picks-latest.json (untouched)
 *   - reads data/macroRegime.json (untouched)
 *   - writes data/risk-lab/picks-adjusted-latest.json
 *
 * Slot in sws-nightly.sh after refresh-earnings.mjs + resolve-earnings-
 * actuals.mjs. The lab needs picks fresh; everything else is incidental.
 *
 * Usage:
 *   node scripts/refresh-risk-lab.mjs            # write
 *   node scripts/refresh-risk-lab.mjs --dry-run  # print summary, don't write
 *   node scripts/refresh-risk-lab.mjs --json     # print full payload on success
 */

import { runRiskLab } from "../services/riskLab/labOrchestrator.js";

const DRY_RUN = process.argv.includes("--dry-run");
const JSON_OUT = process.argv.includes("--json");

const t0 = Date.now();
const { payload, outPath, dryRun } = runRiskLab({ dryRun: DRY_RUN });

const s = payload.summary;
const r = payload.regime
  ? `regime=${payload.regime.regime} sev=${payload.regime.severity} conf=${payload.regime.confidence}`
  : "regime=<missing>";
console.log(
  `[risk-lab] ${dryRun ? "DRY-RUN " : ""}${r} ` +
    `stocks=${s.total_stocks} flagged=${s.flagged_count} vetoed=${s.vetoed_count} ` +
    `stale_skipped=${s.stale_skipped_count} (${Date.now() - t0}ms)`,
);

if (!dryRun) {
  console.log(`[risk-lab] wrote ${outPath}`);
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

// Exit 1 only on a hard failure that prevents writing — orchestrator's
// per-row defensive guards mean a partial output is still useful, so we
// don't escalate on individual row failures.
if (!payload || !payload.schema_version) {
  console.error("[risk-lab] no payload generated");
  process.exit(1);
}
process.exit(0);
