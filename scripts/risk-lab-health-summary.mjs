#!/usr/bin/env node
/**
 * Risk Lab health summary — reads the lab JSONs + (optionally) the backtest
 * report, emits a health verdict + alerts, and optionally posts a one-liner
 * to Slack via SLACK_WEBHOOK_URL.
 *
 * Usage:
 *   node scripts/risk-lab-health-summary.mjs              # human-readable
 *   node scripts/risk-lab-health-summary.mjs --json       # machine-readable
 *   node scripts/risk-lab-health-summary.mjs --no-slack   # skip Slack post
 *   node scripts/risk-lab-health-summary.mjs --skip-backtest
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PICKS_PATH = path.join(REPO_ROOT, "data", "risk-lab", "picks-adjusted-latest.json");

const JSON_OUT = process.argv.includes("--json");
const NO_SLACK = process.argv.includes("--no-slack");
const SKIP_BACKTEST = process.argv.includes("--skip-backtest");

const { buildLabHealth, formatSlackMessage } = await import("../services/riskLab/labHealth.js");

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.warn(`[risk-lab-health] failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

const payload = readJsonSafe(PICKS_PATH);
if (!payload) {
  console.error("[risk-lab-health] no payload — run scripts/refresh-risk-lab.mjs first");
  process.exit(1);
}

let backtest = null;
if (!SKIP_BACKTEST) {
  // Run the backtest in-line so we don't depend on a separate scheduling step
  const result = spawnSync("node", ["scripts/backtest-risk-lab.mjs", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 30000,
  });
  if (result.status === 0 && result.stdout) {
    try { backtest = JSON.parse(result.stdout); }
    catch { backtest = null; }
  }
}

const health = buildLabHealth(payload, backtest);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(health, null, 2) + "\n");
} else {
  console.log(`Risk Lab Health — ${health.generated_at}`);
  console.log("=".repeat(70));
  console.log(`Status: ${health.status}`);
  console.log();
  console.log("Summary:");
  for (const [k, v] of Object.entries(health.summary)) {
    console.log(`  ${k}: ${v}`);
  }
  if (health.alerts.length > 0) {
    console.log();
    console.log("Alerts:");
    for (const a of health.alerts) {
      console.log(`  [${a.severity.toUpperCase()}] ${a.category}: ${a.message}`);
    }
  } else {
    console.log();
    console.log("No alerts.");
  }
}

if (!NO_SLACK && process.env.SLACK_WEBHOOK_URL && health.alerts.length > 0) {
  try {
    const message = formatSlackMessage(health);
    const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) {
      console.warn(`[risk-lab-health] Slack POST failed: ${res.status} ${res.statusText}`);
    } else if (!JSON_OUT) {
      console.log("[risk-lab-health] Slack notification posted");
    }
  } catch (err) {
    console.warn(`[risk-lab-health] Slack post error: ${err.message}`);
  }
}

process.exit(health.status === "UNHEALTHY" ? 2 : 0);
