#!/usr/bin/env node
// Populate only the experimental US Snowflake Gap Lab section from the current
// US SWS deep files. This avoids runFullScoringUS() so a data-gap rollout does
// not rewrite canonical US sections, universe stats, or regional artifacts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PATHS } from "./sws-config-us.mjs";
import { buildFvCompositeIndustryAverages } from "./swsScoringV4.mjs";
import { reconcileFairValue } from "../services/fvReconciliation.js";
import { buildFvUpsideBenchmark } from "../services/scoring/fvUpsideRelative.js";
import {
  MIN_MCAP_USD,
  buildLeaderboardUS,
  scoreStockUS,
  snowflakeGapLabUSOptions,
  usCardFields,
} from "./sws-scoring-us.mjs";
import { buildUniverseStats } from "./sws-scoring.mjs";
import {
  buildSnowflakeGapLabSection,
  buildSnowflakeGapPeerAverages,
} from "../services/swsSnowflakeGapLab.js";

const argValue = (name, fallback = null) => {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};

const limitRaw = argValue("--limit", "200");
const limit = Number.parseInt(limitRaw, 10);
if (!Number.isInteger(limit) || limit <= 0) {
  throw new Error(`Invalid --limit=${limitRaw}; expected a positive integer.`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, filePath);
}

function loadDeepUniverse(deepDir) {
  if (!fs.existsSync(deepDir)) return { loaded: [], failed: 0 };
  const files = fs.readdirSync(deepDir).filter((file) => file.endsWith(".json"));
  const loaded = [];
  let failed = 0;
  for (const file of files) {
    try {
      loaded.push(readJson(path.join(deepDir, file)));
    } catch (error) {
      failed += 1;
      console.error(`[sws-populate-gap-lab-us] failed to load ${file}: ${error.message}`);
    }
  }
  return { loaded, failed };
}

function countCheckMatrices(stocks) {
  return (stocks || []).filter((stock) => stock?.overview?.snowflake_check_matrix?.checks?.length > 0).length;
}

function loadDeepUniverseWithTarFallback(deepDir) {
  const loose = loadDeepUniverse(deepDir);
  if (loose.loaded.length && countCheckMatrices(loose.loaded) > 0) {
    return { ...loose, source: "loose_deep" };
  }

  const tarPath = path.join(path.dirname(deepDir), "deep-us.tar.gz");
  if (!fs.existsSync(tarPath)) return { ...loose, source: "loose_deep" };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sws-gap-lab-us-deep-"));
  try {
    execFileSync("tar", ["-xzf", tarPath, "-C", tempRoot], { stdio: "ignore" });
    const extractedDeepDir = path.join(tempRoot, "deep");
    const packed = loadDeepUniverse(extractedDeepDir);
    return { ...packed, source: "deep_us_tarball" };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function buildShadowUniverseUS(loaded) {
  const universe = buildUniverseStats(loaded);
  universe.fvBenchmark = buildFvUpsideBenchmark(
    loaded.map((stock) => ({
      upside_pct: reconcileFairValue(stock?.overview).upside_pct,
      market_cap_inr: stock?.overview?.market_cap_inr,
    })),
    { microCapFloorInr: MIN_MCAP_USD },
  );
  universe.fvCompositeIndustryAverages = buildFvCompositeIndustryAverages(loaded, universe.fvBenchmark);
  universe.snowflakeGapPeerAverages = buildSnowflakeGapPeerAverages(
    loaded,
    snowflakeGapLabUSOptions(),
  );
  return universe;
}

function orderSectionsWithGapLab(existingSections, gapLabItems) {
  const ordered = {};
  let inserted = false;
  for (const [key, value] of Object.entries(existingSections || {})) {
    if (key === "snowflake_gap_lab") continue;
    ordered[key] = value;
    if (key === "deep_value") {
      ordered.snowflake_gap_lab = gapLabItems;
      inserted = true;
    }
  }
  if (!inserted) ordered.snowflake_gap_lab = gapLabItems;
  return ordered;
}

export function populateSnowflakeGapLabUS({
  deepDir = PATHS.deepDir,
  picksPath = PATHS.picksLatest,
  limit: sectionLimit = limit,
} = {}) {
  const picks = readJson(picksPath);
  const { loaded, failed, source } = loadDeepUniverseWithTarFallback(deepDir);
  const universe = buildShadowUniverseUS(loaded);
  const scored = [];
  let scoreFailed = 0;
  for (const stock of loaded) {
    try {
      scored.push(scoreStockUS(stock, { universe }));
    } catch (error) {
      scoreFailed += 1;
      console.error(`[sws-populate-gap-lab-us] failed to score ${stock?.ticker || "?"}: ${error.message}`);
    }
  }

  const section = buildSnowflakeGapLabSection(scored, {
    ...snowflakeGapLabUSOptions({ limit: sectionLimit }),
    pickCardFields: usCardFields,
    universe,
  });

  picks.section_audit = {
    ...(picks.section_audit || {}),
    snowflake_gap_lab: {
      ...section.audit,
      deep_files_loaded: loaded.length,
      deep_files_failed: failed,
      score_failed: scoreFailed,
      source,
    },
  };
  picks.sections = orderSectionsWithGapLab(picks.sections || buildLeaderboardUS(scored, { universe }), section.items);
  writeJsonAtomic(picksPath, picks);

  return {
    deep_files_loaded: loaded.length,
    deep_files_failed: failed,
    score_failed: scoreFailed,
    source,
    selected: section.items.length,
    totalCandidates: section.audit.candidates_total,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = populateSnowflakeGapLabUS();
  console.log(JSON.stringify(result, null, 2));
}
