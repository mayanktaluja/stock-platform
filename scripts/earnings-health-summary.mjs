#!/usr/bin/env node
/**
 * Earnings Watch — daily pipeline health summary.
 *
 * Rolls the observable state of the whole earnings pipeline (actuals
 * resolver, fundamentals refresh, V3 adapter, LLM signal, weight-tune
 * gate, archive schema integrity) into one snapshot:
 * data/catalysts/earnings-health.json. Run it after the backtest in
 * the local nightly chain so a silent failure in any stage surfaces.
 *
 * Slack: if SLACK_WEBHOOK_URL is set in the environment, a one-line
 * summary is POSTed there. There is no notification infra in this repo
 * yet, so absent the env var the script just writes the JSON — that's
 * the primary, always-on output.
 *
 * Read-only except for the one JSON file it writes. Safe to run any
 * time.
 *
 * Usage:
 *   node scripts/earnings-health-summary.mjs
 *   node scripts/earnings-health-summary.mjs --json
 *
 * Exit codes:
 *   0  ran (whether or not there are alerts)
 *   1  fatal error
 */

import fs from "node:fs";
import path from "node:path";

import { loadAllHistory } from "../services/earnings/earningsHistoryArchive.js";
import { buildHealthSummary, formatHealthOneLiner } from "../services/earnings/earningsHealth.js";

const ROOT = process.cwd();
const CATALYSTS_DIR = path.join(ROOT, "data", "catalysts");
const BACKTEST_PATH = path.join(CATALYSTS_DIR, "earnings-backtest-latest.json");
const WATCH_PATH = path.join(CATALYSTS_DIR, "earnings-watch-latest.json");
const WATCH_STATS_PATH = path.join(CATALYSTS_DIR, "earnings-watch-stats.json");
const HEALTH_PATH = path.join(CATALYSTS_DIR, "earnings-health.json");
const MACRO_REGIME_PATH = path.join(ROOT, "data", "macroRegime.json");
const SWS_HEALTH_DIR = path.join(ROOT, "data", "sws", "health");
const PICKS_FV_DRIFT_REPORT_PATH = path.join(SWS_HEALTH_DIR, "picks-snapshot-fv-drift.json");
const PICKS_FV_DRIFT_JSONL_PATH = path.join(SWS_HEALTH_DIR, "picks-fv-drift-24h.jsonl");

const argJson = process.argv.includes("--json");

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Reads a newline-delimited JSON file, returning an array. Malformed
// lines are dropped silently — the probe is fire-and-forget telemetry,
// not a structured datastore.
function readJsonlSafe(p) {
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // ignore malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

async function postToSlack(oneLiner, health) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { posted: false, reason: "no SLACK_WEBHOOK_URL" };
  try {
    const lines = [oneLiner];
    for (const a of health.alerts || []) lines.push(`  • ${a}`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
    return { posted: res.ok, reason: res.ok ? "ok" : `http ${res.status}` };
  } catch (err) {
    // Slack is best-effort — never let it fail the health run.
    return { posted: false, reason: String(err && err.message) };
  }
}

async function main() {
  const history = loadAllHistory();
  const backtestSnapshot = readJsonSafe(BACKTEST_PATH);
  const watch = readJsonSafe(WATCH_PATH);
  const watchStats = readJsonSafe(WATCH_STATS_PATH);
  const priorHealth = readJsonSafe(HEALTH_PATH);

  const macroRegime = readJsonSafe(MACRO_REGIME_PATH);
  // picks-vs-snapshots Fair-Value drift surface — pipeline check writes
  // the report file, the 15-min probe appends to the JSONL. See plan
  // ~/.claude/plans/so-i-have-attached-virtual-sphinx.md (Layer 3).
  const picksFvDriftReport = readJsonSafe(PICKS_FV_DRIFT_REPORT_PATH);
  const picksFvDriftJsonl = readJsonlSafe(PICKS_FV_DRIFT_JSONL_PATH);

  const health = buildHealthSummary({
    history,
    backtestSnapshot,
    watchEvents: watch && Array.isArray(watch.events) ? watch.events : [],
    // PR after #247: pass the LLM batcher stats so a heuristic_cache_invalidations
    // spike is surfaced as a Slack-able alert. Null on pre-stats files / first runs.
    llmStats: watchStats?.llm_stats || null,
    priorHealth,
    macroRegime,
    picksFvDriftReport,
    picksFvDriftJsonl,
  });

  writeJsonAtomic(HEALTH_PATH, health);

  const oneLiner = formatHealthOneLiner(health);
  const slack = await postToSlack(oneLiner, health);

  if (argJson) {
    console.log(JSON.stringify({ ...health, _slack: slack }, null, 2));
    return;
  }

  console.log("Earnings Watch — Pipeline Health");
  console.log("=================================");
  console.log(oneLiner);
  console.log("");
  console.log(`History files:       ${health.history_files}`);
  console.log(`Resolved actuals:    ${health.resolved.count}` +
    (health.resolved.delta_vs_prior != null ? `  (${health.resolved.delta_vs_prior >= 0 ? "+" : ""}${health.resolved.delta_vs_prior} vs prior run)` : ""));
  console.log(`LLM providers:       groq ${health.llm_providers.groq} · gemini ${health.llm_providers.gemini} · heuristic ${health.llm_providers.heuristic} · none ${health.llm_providers.none}`);
  console.log(`Cap-lift gate:       ${health.cap_lift_gate.state ? "MET" : "not met"} (${health.cap_lift_gate.days_in_current_state}d in state) · ${health.cap_lift_gate.current_resolved_note || `${health.cap_lift_gate.current_resolved} resolved`}`);
  console.log(`Archive schema:      ${Object.entries(health.archive_schema).map(([k, v]) => `${k}×${v}`).join(", ") || "—"}`);
  console.log(`Predictor versions:  ${Object.entries(health.predictor_versions).map(([k, v]) => `${k}×${v}`).join(", ") || "—"}`);
  console.log(`Restatements:        ${health.restatements.count}`);
  if (health.picks_snapshot_fv_drift) {
    const pd = health.picks_snapshot_fv_drift;
    const pipeStr = pd.pipeline ? `pipeline ${pd.pipeline.drifted_count}` : "pipeline n/a";
    const rtStr = pd.runtime_24h ? `runtime peak ${pd.runtime_24h.max_drift_count} (${pd.runtime_24h.samples} probes/24h)` : "runtime n/a";
    console.log(`Picks↔Snapshot FV:   ${pipeStr} · ${rtStr}`);
  }
  if (health.macro_regime && health.macro_regime.present) {
    const m = health.macro_regime;
    console.log(`Macro regime:        ${m.regime || "?"} via ${m.classifier_provider || "?"} · ${m.age_hours}h old${m.stale ? " ⚠ STALE" : ""}`);
  } else {
    console.log(`Macro regime:        (missing — data/macroRegime.json not present)`);
  }
  console.log("");
  if (health.alerts.length === 0) {
    console.log("✅ No alerts — pipeline healthy.");
  } else {
    console.log(`⚠ ${health.alerts.length} alert(s):`);
    for (const a of health.alerts) console.log(`  • ${a}`);
  }
  if (slack.posted) console.log(`\nSlack: posted.`);
  else if (slack.reason !== "no SLACK_WEBHOOK_URL") console.log(`\nSlack: not posted (${slack.reason}).`);
}

main().catch((err) => {
  console.error("[earnings-health] FAILED:", err.stack || err.message);
  process.exit(1);
});
