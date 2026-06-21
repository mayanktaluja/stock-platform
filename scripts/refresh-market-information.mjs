#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchIndiaAnnouncements } from "../services/stockInsightsClient.js";
import {
  buildMarketInformationSnapshot,
  writeMarketInformationSnapshot,
} from "../services/marketInformationService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {}
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...parts] = arg.slice(2).split("=");
    out[key] = parts.length ? parts.join("=") : "true";
  }
  return out;
}

function dateInIndia(offsetDays = 0) {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  ist.setUTCDate(ist.getUTCDate() + offsetDays);
  return ist.toISOString().slice(0, 10);
}

export async function runRefreshMarketInformation({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  outPath,
  logger = console,
} = {}) {
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const args = parseArgs(argv);
  const apiKey = args.apiKey || env.STOCKINSIGHTS_API_KEY;
  const maxPages = Math.max(
    1,
    Number(args["max-pages"] || env.MARKET_INFORMATION_MAX_PAGES || 1),
  );
  const limit = Math.min(50, Math.max(1, Number(args.limit || 50)));
  const fromDate = args.from || dateInIndia(-1);
  const toDate = args.to || dateInIndia(0);
  const destination = outPath || args.out || path.join(REPO_ROOT, "data", "marketInformation", "latest.json");

  if (!apiKey) {
    logger.error("[market-information] STOCKINSIGHTS_API_KEY is required; leaving existing snapshot untouched");
    return { ok: false, exitCode: 75, reason: "missing_api_key" };
  }

  try {
    const result = await fetchIndiaAnnouncements({
      apiKey,
      baseUrl: args.baseUrl || env.STOCKINSIGHTS_BASE_URL,
      timeoutMs: Number(args.timeout || env.STOCKINSIGHTS_TIMEOUT_MS || 12_000),
      fetchImpl,
      fromDate,
      toDate,
      ticker: args.ticker,
      sentiment: args.sentiment,
      sector: args.sector,
      industry: args.industry,
      announcementTypeId: args["announcement-type-id"],
      limit,
      maxPages,
    });

    if (!result.rows.length) {
      logger.error("[market-information] provider returned zero rows; leaving existing snapshot untouched");
      return { ok: false, exitCode: 75, reason: "zero_rows", pages: result.pages };
    }

    const snapshot = buildMarketInformationSnapshot({
      items: result.rows,
      generatedAt: new Date().toISOString(),
      requested: {
        source: "india",
        from_date: fromDate,
        to_date: toDate,
        limit,
        max_pages: maxPages,
        ticker: args.ticker || null,
        sentiment: args.sentiment || null,
      },
      sourceHealth: {
        ok: true,
        provider: "stockinsights",
        pages: result.pages,
        free_trial_guardrail: maxPages === 1,
      },
    });

    if (args["dry-run"] === "true") {
      logger.log(JSON.stringify(snapshot, null, 2));
      return { ok: true, exitCode: 0, snapshot, dryRun: true };
    }

    writeMarketInformationSnapshot(snapshot, destination);
    logger.log(`[market-information] wrote ${snapshot.items.length} rows to ${destination}`);
    return { ok: true, exitCode: 0, snapshot, destination };
  } catch (err) {
    logger.error(`[market-information] refresh failed: ${err.message}`);
    return { ok: false, exitCode: 75, reason: "provider_failure", error: err };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = await runRefreshMarketInformation();
  process.exit(result.exitCode || 0);
}
