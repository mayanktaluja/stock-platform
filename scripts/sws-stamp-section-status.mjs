#!/usr/bin/env node
/**
 * SWS pipeline stage — runs after narrate, before PDF.
 *
 * Reads picks-latest.json (current run, post-narrate) and picks-previous.json
 * (prior nightly's final file). Stamps `section_status` on every per-section
 * stock object via computeSectionStatus(). Atomic-writes picks-latest.json,
 * then snapshots it to picks-previous.json as the baseline for the next run.
 *
 * First-run safe: if picks-previous.json is missing or unparseable, baseline
 * mode kicks in — every stock gets neutral section_status, no badges render
 * in the UI on this run, and the next run will diff against today's snapshot.
 */

import fs from "fs";
import path from "path";
import { computeSectionStatus } from "./sws-section-status.mjs";
import * as dal from "../services/swsDal/index.js";
import { closeDb } from "../db/client.js";

const RUN_ID = process.env.SWS_RUN_ID || null;

const DATA_DIR = path.resolve(process.cwd(), "data/sws");
const PICKS_LATEST = path.join(DATA_DIR, "picks-latest.json");
const PICKS_PREVIOUS = path.join(DATA_DIR, "picks-previous.json");

function writeJsonAtomic(filePath, value) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function tryReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error(`[stamp] failed to parse ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

async function main() {
  const current = tryReadJson(PICKS_LATEST);
  if (!current || !current.sections) {
    console.error("[stamp] picks-latest.json missing or has no sections — bailing");
    process.exit(1);
  }

  const prior = tryReadJson(PICKS_PREVIOUS);
  const priorScannedAt = prior?.scanned_at || null;
  const priorSections = prior?.sections || null;

  if (!priorSections) {
    console.log("[stamp] baseline established (no prior file found — first run)");
  }

  computeSectionStatus(current.sections, priorSections, priorScannedAt);

  let stamped = 0;
  let newlyAdded = 0;
  let trending = 0;
  for (const items of Object.values(current.sections)) {
    if (!Array.isArray(items)) continue;
    for (const s of items) {
      if (s?.section_status) {
        stamped++;
        if (s.section_status.newly_added) newlyAdded++;
        if (s.section_status.trending) trending++;
      }
    }
  }

  writeJsonAtomic(PICKS_LATEST, current);

  try {
    fs.copyFileSync(PICKS_LATEST, PICKS_PREVIOUS);
  } catch (e) {
    console.error(`[stamp] WARNING — failed to snapshot picks-previous.json: ${e.message}`);
  }

  console.log(`[stamp] stamped=${stamped} newly_added=${newlyAdded} trending=${trending}`);

  // Phase 3 dual-write: mirror every section_status into Postgres. Gated
  // by SWS_DB_DUAL_WRITE=1 in the DAL — no-op when disabled.
  if (RUN_ID && dal.isDualWriteEnabled()) {
    let dbStamped = 0;
    for (const [section, items] of Object.entries(current.sections)) {
      if (!Array.isArray(items)) continue;
      for (const s of items) {
        if (s?.ticker && s?.section_status) {
          await dal.stampSectionStatus(RUN_ID, s.ticker, section, s.section_status);
          dbStamped++;
        }
      }
    }
    console.log(`[stamp] DAL stamped ${dbStamped} rows`);
    await closeDb();
  }
}

await main();
