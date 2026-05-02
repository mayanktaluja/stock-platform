#!/usr/bin/env node
/**
 * One-shot portfolio importer.
 *
 * Usage: node scripts/import-portfolio.mjs <path-to-xlsx-or-csv>
 *
 * Reads a Groww / Upstox / Zerodha holdings statement, runs the same parser
 * + live-NSE resolver that the Portfolio Analyzer uses, and persists the
 * resolved equity holdings to portfolio.json (file in dev / Vercel KV in
 * prod via portfolioStorage). Existing mutualFunds, riskProfile, and any
 * other top-level fields are preserved.
 *
 * Why a script and not the UI: the user supplied a known-good file and
 * just wants it persisted as the canonical portfolio. The Analyzer
 * endpoint is intentionally stateless (it only analyses, it doesn't save),
 * so a small one-shot is the cleanest path.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parsePortfolioFile, resolveUnmatchedLive } from "../portfolioParser.js";
import { getPortfolioStorage } from "../portfolioStorage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/import-portfolio.mjs <path-to-xlsx-or-csv>");
  process.exit(2);
}

const buffer = readFileSync(filePath);
const filename = path.basename(filePath);

console.log(`[IMPORT] Parsing ${filename} (${buffer.length} bytes) ...`);
const parsed = parsePortfolioFile(buffer, filename);
console.log(`[IMPORT] Initial: ${parsed.holdings.length} matched · ${parsed.unmatched.length} unmatched · source=${parsed.source}`);

console.log("[IMPORT] Live-resolving unmatched equities via NSE...");
try {
  await resolveUnmatchedLive(parsed);
} catch (err) {
  console.warn("[IMPORT] live resolution warning:", err.message);
}
console.log(`[IMPORT] After live resolve: ${parsed.holdings.length} matched · ${parsed.unmatched.length} unmatched`);

// Map analyzer-shape holdings → portfolio.json schema.
const stocks = parsed.holdings.map((h) => ({
  name: h.name,
  symbol: h.symbol,
  quantity: h.quantity,
  avgPrice: h.avgPrice,
  sector: h.sector || null,
  // Preserve ISIN + purchaseDate for downstream consumers (paperTrades,
  // tax-aware sells, etc.) — adding extra fields is fine; the API GET
  // doesn't care.
  isin: h.isin || null,
  purchaseDate: h.purchaseDate || null,
}));

const storage = getPortfolioStorage();
const existing = await storage.read();

const next = {
  ...existing,
  stocks,
  // Don't touch MFs unless the parsed file is itself an MF export.
  mutualFunds: Array.isArray(parsed.mfHoldings) && parsed.mfHoldings.length > 0
    ? parsed.mfHoldings
    : (existing.mutualFunds || []),
  lastUpdated: new Date().toISOString(),
};

await storage.write(next);

console.log(`[IMPORT] ✓ Saved ${stocks.length} stocks to portfolio storage (${storage.constructor?.name || "default"}).`);
if (parsed.unmatched.length > 0) {
  const reasons = parsed.unmatched.reduce((acc, u) => {
    const k = u.reason || u.matchType || "unknown";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log("[IMPORT] Unmatched (not persisted):");
  for (const u of parsed.unmatched.slice(0, 10)) {
    console.log(`  · ${u.rawName || "(no name)"} — ${u.reason || u.matchType}`);
  }
  if (parsed.unmatched.length > 10) console.log(`  ... and ${parsed.unmatched.length - 10} more`);
  console.log("[IMPORT] Reason buckets:", reasons);
}
if (parsed.warnings?.length) {
  console.log("[IMPORT] Warnings:");
  for (const w of parsed.warnings) console.log(`  · ${w}`);
}
process.exit(0);
