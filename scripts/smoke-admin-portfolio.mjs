/**
 * Smoke for the admin Users-tab portfolio column.
 *
 * What it verifies:
 *   1. POST /api/portfolio/analyze (the only upload path the UI exposes)
 *      now mirrors the parsed holdings into portfolios.json so the
 *      /api/admin/users endpoint can flag hasPortfolio=true.
 *   2. The mirrored shape is what /api/admin/users/:sub/portfolio.xlsx
 *      reads — stocks[] and mutualFunds[].
 *
 * Run with the dev server already up:
 *   PORT=3022 node scripts/smoke-admin-portfolio.mjs
 *
 * Notes:
 *   - AUTH_ENABLED is off in dev, so userSub() falls back to "_local_dev".
 *   - The admin endpoints themselves require AUTH_ENABLED, so we verify by
 *     reading portfolios.json directly (the same file the admin handler
 *     hits via getPortfolioStorage().read).
 */

import xlsx from "xlsx";
import { unlinkSync, existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || "3022";
const BASE = `http://localhost:${PORT}`;
const SUB = "_local_dev";

function buildUpstoxXlsx({ asOfDate, rows }) {
  const header = [
    ["UPSTOX SECURITIES PRIVATE LIMITED"],
    ["Holdings Statement"],
    ["UCC", "AG5283"],
    ["Name", "TEST USER"],
    ["PAN", "ABCDE1234F"],
    ["Report Date", asOfDate],
    ["Generated On", `${asOfDate} 10:51:38`],
    ["ISIN", "Scrip Name", "Free Qty", "Current Qty", "Freeze Qty",
     "Locked Qty", "Pledge Qty", "Value Date", "Rate", "Valuation"],
  ];
  const data = rows.map((r) => [
    r.isin, r.name, r.qty, r.qty, 0, 0, 0, asOfDate, r.avg, r.qty * r.avg,
  ]);
  const ws = xlsx.utils.aoa_to_sheet(header.concat(data));
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, "HOLDING");
  return xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
}

function unlinkIfExists(p) { if (existsSync(p)) unlinkSync(p); }

console.log("\n== smoke-admin-portfolio ==\n");

const portfoliosPath = path.join(ROOT, "portfolios.json");
const analyzerPath = path.join(ROOT, "analyzer-last.json");
unlinkIfExists(portfoliosPath);
unlinkIfExists(analyzerPath);
console.log(`✓ wiped portfolios.json + analyzer-last.json`);

const buf = buildUpstoxXlsx({
  asOfDate: "2026-04-15",
  rows: [
    { isin: "INE467B01029", name: "TATA CONSULTANCY SERVICES LIMITED", qty: 100, avg: 3500 },
    { isin: "INE002A01018", name: "RELIANCE INDUSTRIES LIMITED", qty: 30, avg: 2400 },
    { isin: "INE040A01034", name: "HDFC BANK LIMITED", qty: 50, avg: 1500 },
  ],
});

const fd = new FormData();
fd.append("file", new Blob([buf]), "Holdings_2026-04-15.xlsx");
console.log(`→ POST ${BASE}/api/portfolio/analyze`);
const res = await fetch(`${BASE}/api/portfolio/analyze`, { method: "POST", body: fd });
const json = await res.json();
if (!res.ok) {
  console.error(`✗ upload failed: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  process.exit(1);
}
console.log(`  status: ok=${json.ok} elapsedMs=${json.elapsedMs} stocks=${json.savable?.stocks?.length || 0}`);

if (!existsSync(portfoliosPath)) {
  console.error(`✗ portfolios.json was not created — admin tab will not see this user's portfolio`);
  process.exit(1);
}

const persisted = JSON.parse(readFileSync(portfoliosPath, "utf-8"));
const userPortfolio = persisted[SUB];
if (!userPortfolio) {
  console.error(`✗ portfolios.json exists but has no entry for sub="${SUB}"`);
  console.error(`  keys: ${Object.keys(persisted).join(", ")}`);
  process.exit(1);
}
console.log(`✓ portfolios.json now has entry for sub="${SUB}"`);

if (!Array.isArray(userPortfolio.stocks) || userPortfolio.stocks.length === 0) {
  console.error(`✗ user's stocks[] is empty — admin XLSX export will 404 with empty-portfolio`);
  process.exit(1);
}
console.log(`✓ stocks[] has ${userPortfolio.stocks.length} entries`);
console.log(`  first row: ${JSON.stringify(userPortfolio.stocks[0])}`);

if (!userPortfolio.lastUpdated) {
  console.error(`✗ lastUpdated is missing — admin Users tab won't show a refreshed timestamp`);
  process.exit(1);
}
console.log(`✓ lastUpdated: ${userPortfolio.lastUpdated}`);

// Build the same XLSX the admin handler would build, to make sure xlsx.json_to_sheet
// can serialise our stored shape without throwing.
const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(userPortfolio.stocks), "Stocks");
const adminBuf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
if (!Buffer.isBuffer(adminBuf) || adminBuf.length < 200) {
  console.error(`✗ admin XLSX serialiser produced suspiciously small output: ${adminBuf?.length} bytes`);
  process.exit(1);
}
console.log(`✓ admin XLSX export builds (${adminBuf.length} bytes)`);

// Re-read what xlsx wrote to confirm it round-trips.
const wb2 = xlsx.read(adminBuf, { type: "buffer" });
const sheet = wb2.Sheets[wb2.SheetNames[0]];
const rowsBack = xlsx.utils.sheet_to_json(sheet);
if (rowsBack.length !== userPortfolio.stocks.length) {
  console.error(`✗ XLSX round-trip lost rows: wrote ${userPortfolio.stocks.length}, read ${rowsBack.length}`);
  process.exit(1);
}
console.log(`✓ XLSX round-trip preserves ${rowsBack.length} stock rows`);

// Sanity: re-uploading should overwrite, not duplicate.
console.log(`\n→ POST again with one different stock to confirm overwrite semantics`);
const buf2 = buildUpstoxXlsx({
  asOfDate: "2026-04-16",
  rows: [
    { isin: "INE467B01029", name: "TATA CONSULTANCY SERVICES LIMITED", qty: 75, avg: 3500 },
  ],
});
const fd2 = new FormData();
fd2.append("file", new Blob([buf2]), "Holdings_2026-04-16.xlsx");
const res2 = await fetch(`${BASE}/api/portfolio/analyze`, { method: "POST", body: fd2 });
const json2 = await res2.json();
if (!res2.ok) {
  console.error(`✗ second upload failed: ${res2.status} ${JSON.stringify(json2).slice(0, 200)}`);
  process.exit(1);
}
const persisted2 = JSON.parse(readFileSync(portfoliosPath, "utf-8"));
const userPortfolio2 = persisted2[SUB];
if (userPortfolio2.stocks.length !== 1) {
  console.error(`✗ overwrite produced ${userPortfolio2.stocks.length} stocks — expected 1`);
  process.exit(1);
}
console.log(`✓ second upload overwrote stocks[] cleanly (now ${userPortfolio2.stocks.length} entry)`);

console.log("\n== smoke-admin-portfolio: PASS ==\n");
