#!/usr/bin/env node
// Populate only the experimental Snowflake Gap Lab section from the current
// India SWS deep files. This intentionally avoids runFullScoring() so a
// data-gap backfill cannot rewrite canonical V4 sections or Track Record inputs.

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./sws-config.mjs";
import { buildFvCompositeIndustryAverages } from "../services/swsScoringV4.js";
import { reconcileFairValue } from "../services/fvReconciliation.js";
import { buildFvUpsideBenchmark } from "../services/scoring/fvUpsideRelative.js";
import { buildUniverseStats, pickCardFields, scoreStock } from "../services/swsScoring.js";
import { buildSnowflakeGapLabSection, buildSnowflakeGapPeerAverages } from "../services/swsSnowflakeGapLab.js";

const argValue = (name, fallback = null) => {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const limitRaw = argValue("--limit", "500");
const limit = Number.parseInt(limitRaw, 10);
if (!Number.isInteger(limit) || limit <= 0) {
  throw new Error(`Invalid --limit=${limitRaw}; expected a positive integer.`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function loadDeepUniverse(deepDir) {
  const files = fs.readdirSync(deepDir).filter((file) => file.endsWith(".json"));
  const loaded = [];
  let failed = 0;
  for (const file of files) {
    try {
      loaded.push(readJson(path.join(deepDir, file)));
    } catch (error) {
      failed += 1;
      console.error(`[sws-populate-gap-lab] failed to load ${file}: ${error.message}`);
    }
  }
  return { loaded, failed };
}

function buildShadowUniverse(loaded) {
  const universe = buildUniverseStats(loaded);
  universe.fvBenchmark = buildFvUpsideBenchmark(
    loaded.map((stock) => ({
      upside_pct: reconcileFairValue(stock?.overview).upside_pct,
      market_cap_inr: stock?.overview?.market_cap_inr,
    })),
    { microCapFloorInr: 5e9 },
  );
  universe.fvCompositeIndustryAverages = buildFvCompositeIndustryAverages(loaded, universe.fvBenchmark);
  universe.snowflakeGapPeerAverages = buildSnowflakeGapPeerAverages(loaded);
  return universe;
}

function orderSectionsWithGapLab(existingSections, gapLabItems) {
  const ordered = {};
  let inserted = false;
  for (const [key, value] of Object.entries(existingSections || {})) {
    if (key === "snowflake_gap_lab") continue;
    ordered[key] = value;
    if (key === "growing_sector_value") {
      ordered.snowflake_gap_lab = gapLabItems;
      inserted = true;
    }
  }
  if (!inserted) ordered.snowflake_gap_lab = gapLabItems;
  return ordered;
}

export function populateSnowflakeGapLab({ deepDir = PATHS.deepDir, picksPath = PATHS.picksLatest, limit: sectionLimit = limit } = {}) {
  const picks = readJson(picksPath);
  const { loaded, failed } = loadDeepUniverse(deepDir);
  const universe = buildShadowUniverse(loaded);
  const scored = [];
  let scoreFailed = 0;
  for (const stock of loaded) {
    try {
      scored.push(scoreStock(stock, { universe }));
    } catch (error) {
      scoreFailed += 1;
      console.error(`[sws-populate-gap-lab] failed to score ${stock?.ticker || "?"}: ${error.message}`);
    }
  }

  const section = buildSnowflakeGapLabSection(scored, {
    pickCardFields,
    universe,
    limit: sectionLimit,
  });

  picks.section_audit = {
    ...(picks.section_audit || {}),
    snowflake_gap_lab: {
      ...section.audit,
      deep_files_loaded: loaded.length,
      deep_files_failed: failed,
      score_failed: scoreFailed,
    },
  };
  picks.sections = orderSectionsWithGapLab(picks.sections || {}, section.items);
  writeJsonAtomic(picksPath, picks);

  return {
    deep_files_loaded: loaded.length,
    deep_files_failed: failed,
    score_failed: scoreFailed,
    selected: section.items.length,
    totalCandidates: section.audit.candidates_total,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = populateSnowflakeGapLab();
  console.log(JSON.stringify(result, null, 2));
}
