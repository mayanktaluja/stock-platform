#!/usr/bin/env node
/**
 * Walk the latest api-research capture and extract one canonical GraphQL
 * query string per operationName. Saves to data/sws/api-queries.json.
 *
 * The api-client uses these to replay GraphQL ops with our own variables.
 *
 * Usage:
 *   node scripts/sws-api-extract-queries.mjs
 *   node scripts/sws-api-extract-queries.mjs --run 2026-04-28T08-34-04-187Z
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RESEARCH_DIR = path.join(REPO_ROOT, "data/sws/api-research");
const OUT_PATH = path.join(REPO_ROOT, "data/sws/api-queries.json");

function pickLatestRun() {
  const runs = fs
    .readdirSync(RESEARCH_DIR)
    .filter((d) => fs.statSync(path.join(RESEARCH_DIR, d)).isDirectory())
    .sort();
  return runs[runs.length - 1];
}

function main() {
  const args = process.argv.slice(2);
  const runArgIdx = args.indexOf("--run");
  const runId = runArgIdx >= 0 ? args[runArgIdx + 1] : pickLatestRun();
  const runDir = path.join(RESEARCH_DIR, runId);
  console.log(`[queries] using run: ${runDir}`);

  // For each ticker dir under the run, scan _index.json + signal entries
  const tickers = fs
    .readdirSync(runDir)
    .filter((d) => fs.statSync(path.join(runDir, d)).isDirectory());
  console.log(`[queries] tickers: ${tickers.join(", ")}`);

  const opMap = new Map(); // operationName -> { query, sampleVariables }
  const restEndpoints = new Set();

  for (const ticker of tickers) {
    const idxPath = path.join(runDir, ticker, "_index.json");
    if (!fs.existsSync(idxPath)) continue;
    const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));

    for (const e of idx.signal) {
      if (!e.url || !e.method) continue;

      // GraphQL POSTs
      if (e.url.endsWith("/graphql") && e.method === "POST" && e.reqBody) {
        try {
          const parsed = JSON.parse(e.reqBody);
          const op = parsed.operationName;
          const query = parsed.query;
          if (op && query && !opMap.has(op)) {
            opMap.set(op, {
              query,
              sampleVariables: parsed.variables || {},
              capturedFrom: ticker,
            });
          }
        } catch {}
      }

      // REST endpoints — track unique paths (with placeholder for IDs)
      if (e.url.includes("simplywall.st/api/") && !e.url.endsWith("/graphql")) {
        const u = new URL(e.url);
        // Replace UUIDs and canonical-URL paths with placeholders
        let pathTemplate = u.pathname
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{companyId}")
          .replace(/\/stocks\/[^/]+\/[^/]+\/[^/]+\/[^/]+/g, "/stocks/{canonicalUrl}");
        restEndpoints.add(`${e.method} ${pathTemplate}`);
      }
    }
  }

  // Build output
  const output = {
    extractedAt: new Date().toISOString(),
    fromRun: runId,
    operations: {},
    restEndpoints: Array.from(restEndpoints).sort(),
  };
  for (const [op, info] of opMap) {
    output.operations[op] = info;
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`[queries] extracted ${opMap.size} GraphQL ops + ${restEndpoints.size} REST endpoints`);
  console.log(`[queries] saved to ${OUT_PATH}`);
  console.log(`[queries] operations: ${Array.from(opMap.keys()).sort().join(", ")}`);
}

main();
