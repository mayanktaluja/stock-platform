#!/usr/bin/env node
/**
 * Phase 5: write a compact, human-readable summary of a canonical run
 * to data/sws/snapshots/<date>.summary.json. Committed alongside the
 * pg_dump blob so the auto-PR diff stays readable.
 *
 * Reads picks-latest.json directly (Phase 3) — once Phase 5 lands and
 * picks-latest.json stops being written, switch to dal.getPicksLatest()
 * via the SQL backend.
 *
 *   $ node scripts/sws-emit-summary.mjs
 *   $ node scripts/sws-emit-summary.mjs --date 2026-05-11
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data", "sws");

const argv = process.argv.slice(2);
let dateLabel = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--date") dateLabel = argv[++i];
}
const today = (dateLabel || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, "");

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}

function summarise(picks) {
  if (!picks?.sections) return { sections: {}, totals: { picks: 0 } };

  const out = { sections: {}, totals: { picks: 0 } };
  for (const [section, items] of Object.entries(picks.sections)) {
    if (!Array.isArray(items)) continue;
    out.totals.picks += items.length;
    const newlyAdded = items.filter((i) => i?.section_status?.newly_added).length;
    const trending = items.filter((i) => i?.section_status?.trending).length;
    const top3 = items.slice(0, 3).map((c) => ({
      ticker: c.ticker,
      v3: c.v4_score_100 ?? c.v4_score ?? null,
      upside_pct: c.upside_pct ?? null,
      verdict: c.v4_verdict ?? c.verdict ?? null,
    }));
    out.sections[section] = {
      count: items.length,
      newly_added: newlyAdded,
      trending: trending,
      top_picks: top3,
    };
  }
  return out;
}

const picks = readJson(path.join(DATA, "picks-latest.json"));
const lastRefresh = readJson(path.join(DATA, "last-refresh.json"));

if (!picks) {
  console.error("picks-latest.json missing — cannot emit summary");
  process.exit(1);
}

const summary = {
  generated_at: new Date().toISOString(),
  scanned_at: picks.scanned_at ?? null,
  last_refresh: {
    finished_at: lastRefresh?.finished_at ?? null,
    duration_seconds: lastRefresh?.duration_seconds ?? null,
    scored_count: lastRefresh?.scored_count ?? null,
    shards_failed: lastRefresh?.shards_failed ?? null,
    pipeline_status: lastRefresh?.pipeline_status ?? null,
  },
  universe_size: picks.universe_size ?? null,
  scored_count: picks.scored_count ?? null,
  failed_count: picks.failed_count ?? null,
  ...summarise(picks),
};

const dir = path.join(DATA, "snapshots");
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `${today}.summary.json`);
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`[summary] wrote ${out} — ${summary.totals.picks} picks across ${Object.keys(summary.sections).length} sections`);
