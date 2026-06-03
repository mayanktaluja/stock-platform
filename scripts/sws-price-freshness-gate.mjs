#!/usr/bin/env node
/**
 * SWS price freshness gate.
 *
 * Blocks publishing when raw SWS price captures are newer than parsed/deployable
 * artifacts but current_price_inr / returns_pct still reflect older data.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractSwsCurrentPrice,
  extractSwsPriceAsOf,
  extractSwsReturnsPct,
  swsPriceSeries,
} from "./sws-price-utils.mjs";

const RETURN_KEYS = ["1D", "7D", "1M", "3M", "6M", "1Y"];
const CARD_RETURN_KEYS = ["1D", "7D", "1M", "3M", "1Y"];
const PRICE_TOLERANCE_INR = 0.05;
const RETURN_TOLERANCE_PCT = 0.05;
const RAW_NEWER_SLACK_MS = 60_000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    root: "data/sws",
    source: "loose",
    human: false,
    maxFindings: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i];
    else if (a.startsWith("--root=")) args.root = a.slice("--root=".length);
    else if (a === "--source") args.source = argv[++i];
    else if (a.startsWith("--source=")) args.source = a.slice("--source=".length);
    else if (a === "--human") args.human = true;
    else if (a === "--max-findings") args.maxFindings = Number(argv[++i]);
    else if (a.startsWith("--max-findings=")) args.maxFindings = Number(a.slice("--max-findings=".length));
  }
  if (!["loose", "tarball"].includes(args.source)) {
    throw new Error("usage: sws-price-freshness-gate.mjs [--root data/sws] [--source loose|tarball] [--human]");
  }
  if (!Number.isFinite(args.maxFindings) || args.maxFindings < 1) args.maxFindings = 50;
  return args;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return null; }
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestamp(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function closeEnough(a, b, tolerance) {
  const na = finiteNumber(a);
  const nb = finiteNumber(b);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) <= tolerance;
}

function listJsonFiles(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith(".json")); }
  catch { return []; }
}

function loadDeepFromLoose(root) {
  return {
    source: "loose",
    dir: path.join(root, "deep"),
    cleanup: null,
  };
}

function loadDeepFromTarball(root) {
  const tarball = path.join(root, "deep.tar.gz");
  if (!existsSync(tarball)) {
    return {
      source: "tarball",
      dir: null,
      cleanup: null,
      sourceProblem: { name: "deep_tarball_present", message: "data/sws/deep.tar.gz is missing" },
    };
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "sws-price-gate-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", tmp], { stdio: "ignore" });
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    return {
      source: "tarball",
      dir: null,
      cleanup: null,
      sourceProblem: { name: "deep_tarball_extractable", message: `failed to extract data/sws/deep.tar.gz: ${error.message}` },
    };
  }
  return {
    source: "tarball",
    dir: path.join(tmp, "deep"),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

function loadPicksByTicker(root) {
  const picks = readJson(path.join(root, "picks-latest.json"));
  const cards = new Map();
  for (const items of Object.values(picks?.sections || {})) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const ticker = String(item?.ticker || "").trim().toUpperCase();
      if (ticker && !cards.has(ticker)) cards.set(ticker, item);
    }
  }
  return { picks, cards };
}

function finding(name, ticker, message, detail = {}) {
  return { name, ticker, message, detail };
}

function pushFinding(findings, maxFindings, item) {
  if (findings.length < maxFindings) findings.push(item);
}

function compareReturnBuckets({ ticker, expected, actual, actualLabel, findings, maxFindings }) {
  const keys = actualLabel === "picks" ? CARD_RETURN_KEYS : RETURN_KEYS;
  for (const key of keys) {
    if (expected?.[key] == null && actual?.[key] == null) continue;
    if (!closeEnough(expected?.[key], actual?.[key], RETURN_TOLERANCE_PCT)) {
      pushFinding(findings, maxFindings, finding(
        `${actualLabel}_return_mismatch`,
        ticker,
        `${actualLabel} ${key} return does not match expected SWS return`,
        {
          key,
          expected: expected?.[key] ?? null,
          actual: actual?.[key] ?? null,
          tolerance: RETURN_TOLERANCE_PCT,
        },
      ));
      return false;
    }
  }
  return true;
}

export function evaluateSwsPriceFreshness({ root = "data/sws", source = "loose", maxFindings = 50 } = {}) {
  const rawDir = path.join(root, "deep-api");
  const deepSource = source === "tarball" ? loadDeepFromTarball(root) : loadDeepFromLoose(root);
  const findings = [];
  const warnings = [];
  const stats = {
    source,
    raw_files: 0,
    raw_with_price: 0,
    deep_files: 0,
    raw_newer_than_deep: 0,
    raw_deep_checked: 0,
    picks_cards_checked: 0,
    raw_latest_fetched_at: null,
    raw_latest_price_as_of: null,
  };

  try {
    if (deepSource.sourceProblem) {
      pushFinding(findings, maxFindings, finding(deepSource.sourceProblem.name, null, deepSource.sourceProblem.message));
      return { ok: false, findings, warnings, stats };
    }

    const deepDir = deepSource.dir;
    const rawFiles = listJsonFiles(rawDir);
    const deepFiles = listJsonFiles(deepDir);
    stats.raw_files = rawFiles.length;
    stats.deep_files = deepFiles.length;

    const { cards } = loadPicksByTicker(root);

    for (const file of rawFiles) {
      const ticker = file.replace(/\.json$/, "").toUpperCase();
      const raw = readJson(path.join(rawDir, file));
      const series = swsPriceSeries(raw);
      if (!series.length) continue;
      stats.raw_with_price++;
      const rawFetchedAt = raw?.fetchedAt || raw?.fetched_at || null;
      const priceAsOf = extractSwsPriceAsOf(raw);
      if (rawFetchedAt && (!stats.raw_latest_fetched_at || rawFetchedAt > stats.raw_latest_fetched_at)) {
        stats.raw_latest_fetched_at = rawFetchedAt;
      }
      if (priceAsOf && (!stats.raw_latest_price_as_of || priceAsOf > stats.raw_latest_price_as_of)) {
        stats.raw_latest_price_as_of = priceAsOf;
      }

      const deep = readJson(path.join(deepDir, file));
      if (!deep) {
        pushFinding(findings, maxFindings, finding("deep_present", ticker, "raw SWS capture exists but parsed deep file is missing"));
        continue;
      }
      const rawTs = timestamp(rawFetchedAt);
      const deepTs = timestamp(deep.parsed_at);
      const rawNewer = rawTs != null && deepTs != null && rawTs > deepTs + RAW_NEWER_SLACK_MS;
      if (rawNewer) stats.raw_newer_than_deep++;

      const expectedPrice = extractSwsCurrentPrice(raw);
      const expectedReturns = extractSwsReturnsPct(raw);
      const actualPrice = deep?.overview?.current_price_inr;
      const actualReturns = deep?.overview?.returns_pct;
      stats.raw_deep_checked++;

      if (rawNewer && !closeEnough(expectedPrice, actualPrice, PRICE_TOLERANCE_INR)) {
        pushFinding(findings, maxFindings, finding("deep_price_stale", ticker, "parsed deep current_price_inr is stale versus newer raw SWS price tape", {
          raw_fetched_at: rawFetchedAt,
          raw_price_as_of: priceAsOf,
          deep_parsed_at: deep.parsed_at || null,
          expected: expectedPrice,
          actual: actualPrice ?? null,
          tolerance: PRICE_TOLERANCE_INR,
        }));
      }
      if (rawNewer) {
        compareReturnBuckets({
          ticker,
          expected: expectedReturns,
          actual: actualReturns,
          actualLabel: "deep",
          findings,
          maxFindings,
        });
      }

      const card = cards.get(ticker);
      if (card) {
        stats.picks_cards_checked++;
        const cardPrice = card.current_price_inr ?? card.price;
        if (!closeEnough(actualPrice, cardPrice, PRICE_TOLERANCE_INR)) {
          pushFinding(findings, maxFindings, finding("picks_price_mismatch", ticker, "picks card price does not match parsed deep price", {
            deep: actualPrice ?? null,
            card: cardPrice ?? null,
            tolerance: PRICE_TOLERANCE_INR,
          }));
        }
        compareReturnBuckets({
          ticker,
          expected: actualReturns,
          actual: card.returns_pct,
          actualLabel: "picks",
          findings,
          maxFindings,
        });
      }
    }

    if (!stats.raw_files) {
      warnings.push(finding("raw_captures_present", null, "no raw SWS deep-api captures found; freshness gate could only check picks/deep consistency"));
    }
    if (!stats.deep_files) {
      pushFinding(findings, maxFindings, finding("deep_files_present", null, "no parsed deep files found"));
    }

    return { ok: findings.length === 0, findings, warnings, stats };
  } finally {
    try { deepSource.cleanup?.(); } catch {}
  }
}

function printHuman(result) {
  const label = result.ok ? "PASS" : "FAIL";
  console.log(`[sws-price-freshness-gate] ${label} source=${result.stats.source} raw=${result.stats.raw_files} deep=${result.stats.deep_files} checked=${result.stats.raw_deep_checked}`);
  if (result.stats.raw_latest_price_as_of) {
    console.log(`  latest raw price_as_of: ${result.stats.raw_latest_price_as_of.slice(0, 10)}`);
  }
  if (result.stats.raw_newer_than_deep) {
    console.log(`  raw newer than deep: ${result.stats.raw_newer_than_deep}`);
  }
  for (const f of result.findings) {
    console.log(`  BLOCK ${f.ticker ? `${f.ticker}: ` : ""}${f.message}`);
  }
  for (const w of result.warnings) {
    console.log(`  WARN ${w.ticker ? `${w.ticker}: ` : ""}${w.message}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs();
    const result = evaluateSwsPriceFreshness(args);
    if (args.human) printHuman(result);
    else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`[sws-price-freshness-gate] ${error.message}`);
    process.exit(2);
  }
}
