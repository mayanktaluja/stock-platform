#!/usr/bin/env node
/**
 * Macro Regime Refresh — local-cron entry point.
 *
 * Fired from scripts/sws-nightly.sh (launchd, 16:30 IST). Mirrors
 * the fundamentals pattern established in PR #195: refresh locally, commit
 * data/macroRegime.json to git, let Vercel deploy on green CI. Production
 * reads the on-disk file via services/macroRegimeStorage.js — no Vercel
 * KV, no Vercel cron, no in-process setInterval (all three were
 * structurally broken on serverless; see the plan note in the file).
 *
 * Why local: RSS feeds (Reuters, Bloomberg Quint, Moneycontrol, RBI) block
 * Vercel datacenter IPs — same root cause as the NSE rejection documented
 * in CLAUDE.md / nse.js:76. A laptop IP gets the wires the classifier
 * needs; a serverless function does not.
 *
 * Exit codes:
 *   0  — wrote fresh file; classifier OK (Groq / Gemini / heuristic all count)
 *   1  — RSS returned zero headlines AND no prior file exists (non-fatal in
 *        nightly: prefer slightly stale to nothing)
 *   2  — wrote fresh file, BUT at least one LLM provider returned auth_error.
 *        Operator must rotate the key. sws-nightly treats this as non-fatal
 *        but the PR body surfaces it.
 *   9  — both GROQ_API_KEY and GEMINI_API_KEY are missing from the env, AND
 *        MACRO_ALLOW_HEURISTIC_ONLY is NOT set. Refuses to run rather than
 *        overwrite the prior file with a strictly-worse keyword-only
 *        snapshot. Most likely cause: .env not loaded (launchd, fresh
 *        shell). Prior file is preserved.
 *
 * Env flags:
 *   MACRO_ALLOW_HEURISTIC_ONLY=1
 *        Opt-in: when both LLM keys are missing, run the keyword-only
 *        heuristic and exit 0 (instead of exit 9). Used by the GH Actions
 *        backup workflow, where shipping no secrets is the whole point.
 *        Local cron leaves it unset so the strict "refuse to downgrade"
 *        posture stays the default.
 *
 * Usage:
 *   node scripts/refresh-macro-regime.mjs            # full run
 *   node scripts/refresh-macro-regime.mjs --dry-run  # fetch + classify, no write
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the repo root BEFORE importing modules that read
// process.env at import-time. Launchd invokes this script via
// scripts/sws-nightly.sh with a minimal environment (PATH/HOME only),
// so without this load both GROQ_API_KEY and GEMINI_API_KEY would be
// undefined and macroRegime.js would skip straight to the keyword
// heuristic — silently committing a degraded data/macroRegime.json.
// Derived from __dirname (not process.cwd()) so the load is robust
// against the script being invoked from anywhere. `override: false`
// lets a real shell-set env var (future Vercel-side run) win over the
// committed .env file.
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: false });

const { fetchMacroHeadlines } = await import("../macroHeadlineFetcher.js");
const { classifyRegime, defaultCalmRegime } = await import("../macroRegime.js");
// PR B1.2 — archive every fetched headline batch to data/macro-headlines/
// so the analog backtester (B1.4) can later classify past regimes from
// real headlines instead of narrative anchors only.
const { archiveHeadlines: _archiveHeadlines } = await import("../services/macroHeadlineArchive.js");
const { appendRegimeIfChanged } = await import("../services/macroRegimeHistory.js");

const OUT_PATH = path.join(__dirname, "..", "data", "macroRegime.json");

const DRY_RUN = process.argv.includes("--dry-run");

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, "utf-8");
  renameSync(tmp, filePath);
}

function readExisting() {
  if (!existsSync(OUT_PATH)) return null;
  try { return JSON.parse(readFileSync(OUT_PATH, "utf-8")); }
  catch { return null; }
}

async function main() {
  const t0 = Date.now();
  console.log(`[macro-refresh] starting (dry-run=${DRY_RUN})`);

  // Pre-flight: refuse to silently downgrade prod to keyword-only when both
  // LLM keys are missing from the process env. Same posture as the
  // zero-headlines path below (line 67-75): if a prior file exists, leave
  // it in place rather than overwriting a known-good snapshot with a
  // strictly worse one. Returns exit 9 so sws-nightly can surface this
  // distinctly from the auth_error (exit 2) and no-data (exit 1) cases.
  //
  // MACRO_ALLOW_HEURISTIC_ONLY=1 opt-in inverts this for callers that
  // explicitly want heuristic-only mode — GH Actions backup workflow ships
  // without LLM secrets on purpose. Local cron leaves it unset.
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    const heuristicOnlyOK = process.env.MACRO_ALLOW_HEURISTIC_ONLY === "1";
    const existing = readExisting();
    if (!heuristicOnlyOK) {
      console.error(
        "[macro-refresh] no GROQ_API_KEY and no GEMINI_API_KEY in env — refusing to run " +
        "(would silently overwrite the cache with a keyword-only file). " +
        "Check that .env is loaded and that the keys are present, or set " +
        "MACRO_ALLOW_HEURISTIC_ONLY=1 to opt into heuristic-only mode."
      );
      if (existing) {
        console.warn(`[macro-refresh] kept existing file generatedAt=${existing.generatedAt}`);
      }
      return 9;
    }
    console.warn(
      "[macro-refresh] no LLM keys present, but MACRO_ALLOW_HEURISTIC_ONLY=1 — " +
      "running keyword-only heuristic classifier (lower fidelity than LLM)"
    );
  }

  const headlines = await fetchMacroHeadlines();
  const meta = headlines.meta || { sourceHealth: {}, tierCoverage: { "A+": 0, "A": 0, "B": 0 }, fallbacksUsed: [] };
  console.log(
    `[macro-refresh] headlines=${headlines.length} sources-ok=${meta.okSources}/${meta.totalSources} ` +
    `tier-coverage=${JSON.stringify(meta.tierCoverage)}`
  );

  // PR B1.2 — append-only archive. Never fatal: failure here is logged
  // but doesn't break the regime refresh.
  try {
    const arc = _archiveHeadlines(headlines, { meta });
    if (arc.written > 0 || arc.skipped > 0) {
      console.log(`[macro-refresh] archived headlines: +${arc.written} new, ${arc.skipped} dup → ${arc.path}`);
    }
  } catch (err) {
    console.warn(`[macro-refresh] archive failed (non-fatal): ${err.message}`);
  }

  if (headlines.length === 0) {
    const existing = readExisting();
    if (existing) {
      console.warn("[macro-refresh] zero headlines — leaving existing file in place (slightly stale > nothing)");
      console.log(`[macro-refresh] kept generatedAt=${existing.generatedAt}`);
      // Non-fatal: do not bump generatedAt, do not exit 1 — file is still
      // present and the staleness banner will surface the gap if it widens.
      return 0;
    }
    console.error("[macro-refresh] zero headlines AND no prior file — exit 1");
    return 1;
  }

  const regime = await classifyRegime(headlines);

  // If tier-A wire coverage is zero, cap confidence at 0.4 — same defensive
  // cap server.js applies. Keeps the script's output identical to what the
  // in-process refresh would have produced.
  if (meta.tierCoverage["A"] === 0 && regime.confidence > 0.4) {
    regime.confidence = 0.4;
    regime.reasoning = `${regime.reasoning} [Confidence capped: no tier-A wire sources available]`;
  }

  // Attach the same source/tier metadata server.js does, so the on-disk
  // file is interchangeable between in-process and out-of-process refresh.
  regime.sourceHealth = meta.sourceHealth;
  regime.tierCoverage = meta.tierCoverage;
  regime.fallbacksUsed = meta.fallbacksUsed;

  console.log(
    `[macro-refresh] classifier=${regime.classifierProvider} regime=${regime.regime} ` +
    `sev=${regime.severity} conf=${(regime.confidence || 0).toFixed(2)}`
  );
  if (regime.llmProviderHealth) {
    console.log(`[macro-refresh] llm-health groq=${regime.llmProviderHealth.groq} gemini=${regime.llmProviderHealth.gemini}`);
  }

  if (DRY_RUN) {
    console.log("[macro-refresh] DRY RUN — not writing data/macroRegime.json");
    console.log(JSON.stringify(regime, null, 2));
    return 0;
  }

  writeAtomic(OUT_PATH, JSON.stringify(regime));
  console.log(`[macro-refresh] wrote ${OUT_PATH} in ${Date.now() - t0}ms`);

  // Append to the yearly NDJSON history if this is a transition. Foundation
  // for the Risk Lab backtest — see services/macroRegimeHistory.js. Only
  // this canonical script appends; the in-process macroRegimeStorage adapter
  // does not, because that path re-runs the same regime many times per
  // process and would bloat the history with no-op duplicates.
  try {
    const histResult = appendRegimeIfChanged(regime);
    if (histResult.appended) {
      console.log(`[macro-refresh] history transition appended → ${histResult.path}`);
    } else {
      console.log(`[macro-refresh] history no-op (${histResult.reason})`);
    }
  } catch (err) {
    // History is supplementary — never let a history-write failure escalate
    // and unwind the main refresh.
    console.warn(`[macro-refresh] history append failed (non-fatal): ${err.message}`);
  }

  // Exit 2 if any provider returned auth_error so the operator notices —
  // throttled and unreachable are transient and don't warrant escalation.
  const ph = regime.llmProviderHealth || {};
  const authBroken = ph.groq === "auth_error" || ph.gemini === "auth_error";
  if (authBroken) {
    console.warn("[macro-refresh] ⚠ LLM provider auth_error detected — rotate API key(s)");
    return 2;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[macro-refresh] fatal:", err.message, err.stack);
    // Fallback: if a previous file exists, leave it; exit 1 so nightly logs
    // the failure but doesn't abort the rest of the chain.
    process.exit(1);
  });
