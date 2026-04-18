#!/usr/bin/env node
/**
 * CLI entrypoint for fundamentals enrichment.
 *
 * Run:
 *   node scripts/enrich-fundamentals.mjs
 *
 * The heavy lifting lives in ../enrichFundamentals.js — this file is just the
 * file-I/O wrapper for local development. In production (Vercel), the same
 * module is called from /api/cron/enrich-fundamentals which writes the result
 * to Vercel KV instead of back to fundamentals.json on disk.
 *
 * Safe to re-run — existing metrics are overwritten with fresh data.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { enrichSnapshot } from "../enrichFundamentals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUND_PATH = path.join(__dirname, "..", "fundamentals.json");

async function main() {
  if (!existsSync(FUND_PATH)) {
    console.error("fundamentals.json not found. Run refresh-fundamentals.mjs first.");
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(FUND_PATH, "utf-8"));
  const total = Object.keys(data.snapshots || {}).length;
  console.log(`Enriching ${total} stocks from Yahoo Finance...\n`);

  const result = await enrichSnapshot(data, {
    concurrency: 4,
    onProgress: ({ index, total, symbol, metrics, error }) => {
      const tag = `[${String(index).padStart(3)}/${total}]`;
      if (error) {
        console.error(`  ${tag} ${symbol.padEnd(22)} FAILED: ${error.message}`);
        return;
      }
      if (!metrics) return;
      const parts = [];
      if (metrics.roe != null)              parts.push(`ROE=${(metrics.roe * 100).toFixed(1)}%`);
      if (metrics.debtToEquity != null)     parts.push(`D/E=${metrics.debtToEquity.toFixed(2)}`);
      if (metrics.profitMargin != null)     parts.push(`PM=${(metrics.profitMargin * 100).toFixed(1)}%`);
      if (metrics.revenueGrowthYoY != null) parts.push(`RevGr=${(metrics.revenueGrowthYoY * 100).toFixed(0)}%`);
      console.log(`  ${tag} ${symbol.padEnd(22)} ${parts.join(", ") || "no data"}`);
    },
  });

  writeFileSync(FUND_PATH, JSON.stringify(data, null, 2), "utf-8");

  console.log(
    `\nDone in ${(result.durationMs / 1000).toFixed(1)}s. ` +
    `Enriched: ${result.enriched}, Skipped: ${result.skipped}, Failed: ${result.failed}`
  );
  console.log(`Saved to ${FUND_PATH}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
