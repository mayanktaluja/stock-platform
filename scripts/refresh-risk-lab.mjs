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
 *   node scripts/refresh-risk-lab.mjs            # write (with LLM disagreement check)
 *   node scripts/refresh-risk-lab.mjs --dry-run  # print summary, don't write
 *   node scripts/refresh-risk-lab.mjs --skip-llm # heuristic-only (CI / no LLM keys)
 *   node scripts/refresh-risk-lab.mjs --json     # print full payload on success
 *   node scripts/refresh-risk-lab.mjs --max-llm-calls=300  # cap per run (default 500)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load .env so GROQ_API_KEY / GEMINI_API_KEY are available — mirrors the
// refresh-macro-regime.mjs pattern. Without this the LLM step would
// silently fall back to heuristic for everything.
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: false });

const { runRiskLabWithLlm } = await import("../services/riskLab/labOrchestrator.js");

const DRY_RUN = process.argv.includes("--dry-run");
const JSON_OUT = process.argv.includes("--json");
const SKIP_LLM = process.argv.includes("--skip-llm");
const maxLlmCallsArg = process.argv.find((a) => a.startsWith("--max-llm-calls="));
const MAX_LLM_CALLS = maxLlmCallsArg ? Math.max(0, parseInt(maxLlmCallsArg.split("=")[1], 10) || 0) : undefined;

const t0 = Date.now();
const { payload, qualityPayload, outPath, qualityFlagsOutPath, llm, dryRun } = await runRiskLabWithLlm({
  dryRun: DRY_RUN,
  skipLlm: SKIP_LLM,
  maxLlmCalls: MAX_LLM_CALLS,
});

const s = payload.summary;
const r = payload.regime
  ? `regime=${payload.regime.regime} sev=${payload.regime.severity} conf=${payload.regime.confidence}`
  : "regime=<missing>";
console.log(
  `[risk-lab] ${dryRun ? "DRY-RUN " : ""}${r} ` +
    `stocks=${s.total_stocks} (${Date.now() - t0}ms)`,
);
console.log(
  `[risk-lab]   macro: flagged=${s.macro_flagged_count} vetoed=${s.macro_vetoed_count} stale_skipped=${s.macro_stale_skipped_count}`,
);
console.log(
  `[risk-lab]   quality: flagged=${s.quality_flagged_count} vetoed=${s.quality_vetoed_count} ` +
    `low=${s.low_quality_count} insufficient_data=${s.insufficient_quality_data_count}`,
);
if (llm) {
  const p = llm.classifier_provider;
  console.log(
    `[risk-lab]   llm-disagree: eligible_beat=${llm.eligible_beat} ` +
      `cache_hit=${llm.cache_hit} cache_miss_attempted=${llm.cache_miss_attempted} ` +
      `gemini=${p.gemini} groq=${p.groq} heuristic=${p.heuristic} ` +
      `disagreed=${llm.disagreed} (${llm.disagreement_rate_pct}% of all)`,
  );
}

if (!dryRun) {
  console.log(`[risk-lab] wrote ${outPath}`);
  console.log(`[risk-lab] wrote ${qualityFlagsOutPath} (${qualityPayload.total_with_flags} stocks with flags)`);
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
