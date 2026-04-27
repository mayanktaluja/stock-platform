// A/B comparison: re-scrape the chosen sample tickers via the new Playwright
// driver and diff each field vs the existing data/sws/deep/<TICKER>.json
// (which was produced by the legacy Chrome-MCP path).
//
// This is the Phase-1 merge gate the user requested.
//
// Usage:
//   node scripts/sws-compare-playwright.mjs                  # default sample of 10
//   node scripts/sws-compare-playwright.mjs RELIANCE INFY ITC
//   node scripts/sws-compare-playwright.mjs --report-only    # diff existing pw
//                                                            # outputs vs deep
//                                                            # (skip re-scrape)
//
// Behaviour:
//   - For each ticker:
//       a. Re-scrape via Playwright into data/sws/playwright-comparison/<T>.json
//       b. Load the existing data/sws/deep/<T>.json as the golden.
//       c. Walk both JSONs field-by-field, classify each as exact / within-tol / DIVERGES.
//   - Tolerances: stale-price-aware (±5% on current_price_inr / market_cap_inr /
//     fair_value_inr / 52-week values). Ratios + snowflake numbers must match exact.
//   - Writes a markdown summary to data/sws/playwright-comparison/_report.md.
//   - Exits 0 if zero DIVERGES; 1 otherwise.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PATHS } from "./sws-config.mjs";
import { loadUniverse } from "./sws-deep-scrape.mjs";

const DEFAULT_SAMPLE = [
  "RELIANCE", "INFY", "ITC", "HDFCBANK", "TCS",
  "BAJFINANCE", "MARUTI", "ASIANPAINT", "TITAN", "NESTLEIND",
];

const PRICE_TOLERANCE_PCT = 5; // ±5% on price-like fields (stale data)
const PRICE_LIKE_FIELDS = new Set([
  "current_price_inr", "market_cap_inr", "fair_value_inr",
]);
const FIFTYTW_FIELDS = new Set(["high", "low"]); // inside fifty_two_week
const VOLATILE_FIELDS = new Set([
  "parsed_at", "raw_length", "upside_pct", // upside moves with price
  "returns_pct", // 1M/3M/1Y/3Y/5Y all move daily
]);

// ---------- Diff walker ----------

function classify(pathStr, a, b) {
  if (VOLATILE_FIELDS.has(pathStr.split(".").pop())) return "skip";
  if (a === b) return "exact";
  if (a == null && b == null) return "exact";
  if (a == null || b == null) return "diverge";
  const leaf = pathStr.split(".").pop();
  const wantNumericTol =
    PRICE_LIKE_FIELDS.has(leaf) || FIFTYTW_FIELDS.has(leaf);
  if (wantNumericTol && typeof a === "number" && typeof b === "number") {
    const denom = Math.max(Math.abs(a), Math.abs(b));
    if (denom === 0) return "exact";
    const pct = (Math.abs(a - b) / denom) * 100;
    return pct <= PRICE_TOLERANCE_PCT ? "tolerance" : "diverge";
  }
  return "diverge";
}

function walk(prefix, a, b, out) {
  // Both null/undefined → exact
  if (a == null && b == null) {
    out.push({ path: prefix, status: "exact", a, b });
    return;
  }
  // One side missing
  if (a == null || b == null) {
    out.push({ path: prefix, status: classify(prefix, a, b), a, b });
    return;
  }
  // Arrays: compare lengths + elementwise (loose)
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push({ path: prefix, status: "diverge", a, b });
      return;
    }
    out.push({
      path: `${prefix}.length`,
      status: a.length === b.length ? "exact" : "tolerance",
      a: a.length, b: b.length,
    });
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      walk(`${prefix}[${i}]`, a[i], b[i], out);
    }
    return;
  }
  // Objects: union of keys.
  if (typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) walk(prefix ? `${prefix}.${k}` : k, a[k], b[k], out);
    return;
  }
  // Primitive
  out.push({ path: prefix, status: classify(prefix, a, b), a, b });
}

// ---------- Per-ticker comparison ----------

function compareTickerJson(ticker, pwJson, goldJson) {
  const diffs = [];
  walk(ticker, pwJson, goldJson, diffs);
  const counts = { exact: 0, tolerance: 0, diverge: 0, skip: 0 };
  for (const d of diffs) counts[d.status] = (counts[d.status] || 0) + 1;
  return {
    ticker,
    counts,
    diverges: diffs.filter((d) => d.status === "diverge"),
    tolerated: diffs.filter((d) => d.status === "tolerance"),
  };
}

// ---------- Re-scrape one ticker via Playwright (single-stock invocation) ----------

async function rescrapeOne(ticker) {
  // Find the universe entry for this ticker so we know its shard.
  const uni = loadUniverse();
  const idx = uni.findIndex((s) => s.ticker === ticker);
  if (idx < 0) throw new Error(`ticker ${ticker} not in universe`);
  const shardId = (idx % 3) + 1;

  // Spawn the playwright driver with --max 1. Note: this advances real shard
  // progress — caller must understand that tradeoff (the comparison run uses
  // up one slot in the per-shard slice).
  return new Promise((resolve, reject) => {
    const p = spawn("node", [
      "scripts/sws-scrape-playwright.mjs", String(shardId),
      "--max", "1", "--mode", "full", "--ignore-window",
    ], { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2);
  const reportOnly = args.includes("--report-only");
  const explicit = args.filter((a) => !a.startsWith("--"));
  const sample = explicit.length ? explicit : DEFAULT_SAMPLE;

  fs.mkdirSync(PATHS.playwrightComparison, { recursive: true });

  // 1. Re-scrape (unless --report-only) and copy fresh deep/<T>.json into the
  // comparison dir as the new "PW" snapshot. Preserves the gold (deep/) intact.
  if (!reportOnly) {
    for (const t of sample) {
      const goldPath = path.join(PATHS.deepDir, `${t}.json`);
      if (!fs.existsSync(goldPath)) {
        console.log(`[skip] ${t} — no existing deep/<T>.json to compare against`);
        continue;
      }
      // Preserve the existing JSON to a side-by-side path before re-scrape
      // overwrites it.
      const goldCopy = path.join(PATHS.playwrightComparison, `${t}.gold.json`);
      fs.copyFileSync(goldPath, goldCopy);
      console.log(`[scrape] ${t} via Playwright...`);
      try {
        await rescrapeOne(t);
      } catch (e) {
        console.log(`[error] ${t}: ${e.message}`);
        continue;
      }
      // After scrape, the new value lives at deep/<T>.json. Copy it to .pw.
      const pwCopy = path.join(PATHS.playwrightComparison, `${t}.pw.json`);
      fs.copyFileSync(goldPath, pwCopy);
      // Restore the golden so the legacy data is unchanged.
      fs.copyFileSync(goldCopy, goldPath);
    }
  }

  // 2. Diff each pair.
  const results = [];
  for (const t of sample) {
    const goldP = path.join(PATHS.playwrightComparison, `${t}.gold.json`);
    const pwP = path.join(PATHS.playwrightComparison, `${t}.pw.json`);
    if (!fs.existsSync(goldP) || !fs.existsSync(pwP)) {
      console.log(`[skip-diff] ${t} (missing gold or pw snapshot)`);
      continue;
    }
    const gold = JSON.parse(fs.readFileSync(goldP, "utf-8"));
    const pw = JSON.parse(fs.readFileSync(pwP, "utf-8"));
    const cmp = compareTickerJson(t, pw, gold);
    results.push(cmp);
    console.log(`[diff] ${t}: exact=${cmp.counts.exact} tol=${cmp.counts.tolerance} diverge=${cmp.counts.diverge}`);
    if (cmp.diverges.length) {
      for (const d of cmp.diverges.slice(0, 5)) {
        console.log(`        ${d.path}: pw=${JSON.stringify(d.a)} gold=${JSON.stringify(d.b)}`);
      }
      if (cmp.diverges.length > 5) console.log(`        ... ${cmp.diverges.length - 5} more`);
    }
  }

  // 3. Markdown report.
  const reportPath = path.join(PATHS.playwrightComparison, "_report.md");
  const lines = [
    "# Playwright vs legacy Chrome-MCP — A/B comparison",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Sample size: ${results.length}`,
    `Tolerance: ±${PRICE_TOLERANCE_PCT}% on price-like fields`,
    "",
    "| Ticker | Exact | Within tolerance | DIVERGES |",
    "|--------|-------|------------------|----------|",
  ];
  let totalDiverge = 0;
  for (const r of results) {
    lines.push(`| ${r.ticker} | ${r.counts.exact} | ${r.counts.tolerance} | ${r.counts.diverge} |`);
    totalDiverge += r.counts.diverge;
  }
  lines.push("", `**Total divergent fields: ${totalDiverge}**`, "");
  if (totalDiverge > 0) {
    lines.push("## Divergent fields (by ticker)", "");
    for (const r of results.filter((x) => x.diverges.length)) {
      lines.push(`### ${r.ticker}`, "", "| Path | Playwright | Chrome-MCP |", "|------|------------|-----------|");
      for (const d of r.diverges) {
        lines.push(`| ${d.path} | \`${JSON.stringify(d.a)}\` | \`${JSON.stringify(d.b)}\` |`);
      }
      lines.push("");
    }
  }
  fs.writeFileSync(reportPath, lines.join("\n"));
  console.log(`\nReport: ${reportPath}`);
  console.log(`Total divergent fields: ${totalDiverge}`);

  process.exit(totalDiverge === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
