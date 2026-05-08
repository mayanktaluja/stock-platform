/**
 * One-shot end-to-end smoke for the recommendation-memory pipeline.
 *
 *   1. Wipe per-user memory files (sub = "_local_dev" since AUTH is off)
 *   2. POST a synthetic Upstox XLSX (TCS qty 100 @ 1500, 18% weight)
 *   3. POST a follow-up XLSX with TCS qty 75 (25% reduction) one day later
 *   4. Assert the second response carries executionAcks with TCS EXECUTED
 *
 * Run with:
 *   PORT=63019 node scripts/smoke-rec-memory.mjs
 */

import xlsx from "xlsx";
import { unlinkSync, existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || "63019";
const BASE = `http://localhost:${PORT}`;

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

async function postFile(buf, filename) {
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename);
  const res = await fetch(`${BASE}/api/portfolio/analyze`, {
    method: "POST", body: fd,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

function unlinkIfExists(p) { if (existsSync(p)) unlinkSync(p); }

console.log("\n== smoke-rec-memory ==\n");

unlinkIfExists(path.join(ROOT, "analyzer-last.json"));
unlinkIfExists(path.join(ROOT, "portfolio-history.json"));
unlinkIfExists(path.join(ROOT, "recommendation-ledger.json"));
console.log("✓ cleared local memory files");

// Build two XLSX uploads. Concentrated TCS at 18% weight to ensure the
// SWS engine flags a Reduction-25-33% rec; ITC is a small position to
// keep the weight math honest.
const xlsxA = buildUpstoxXlsx({
  asOfDate: "2026-04-15",
  rows: [
    { isin: "INE467B01029", name: "TATA CONSULTANCY SERVICES LIMITED", qty: 100, avg: 3500 },
    { isin: "INE154A01025", name: "ITC LIMITED", qty: 100, avg: 350 },
    { isin: "INE002A01018", name: "RELIANCE INDUSTRIES LIMITED", qty: 30, avg: 2400 },
  ],
});
console.log("→ POST initial portfolio (TCS qty 100)");
const r1 = await postFile(xlsxA, "Holdings_2026-04-15.xlsx");
console.log(`  status: ok=${r1.ok} elapsedMs=${r1.elapsedMs}`);
console.log(`  memoryStatus: ${JSON.stringify(r1.report?.memoryStatus)}`);
console.log(`  executionAcks (expect 0): ${JSON.stringify(r1.report?.executionAcks || []).slice(0, 80)}`);
console.log(`  recRegistry keys (expect 0): ${Object.keys(r1.report?.recRegistry || {}).length}`);

const xlsxB = buildUpstoxXlsx({
  asOfDate: "2026-05-08",
  rows: [
    { isin: "INE467B01029", name: "TATA CONSULTANCY SERVICES LIMITED", qty: 75, avg: 3500 },
    { isin: "INE154A01025", name: "ITC LIMITED", qty: 100, avg: 350 },
    { isin: "INE002A01018", name: "RELIANCE INDUSTRIES LIMITED", qty: 30, avg: 2400 },
  ],
});
console.log("\n→ POST follow-up portfolio (TCS qty 75, -25%)");
const r2 = await postFile(xlsxB, "Holdings_2026-05-08.xlsx");
console.log(`  status: ok=${r2.ok} elapsedMs=${r2.elapsedMs}`);
console.log(`  memoryStatus: ${JSON.stringify(r2.report?.memoryStatus)}`);
console.log(`  backdated: ${r2.report?.backdated}`);
console.log(`  executionAcks: ${JSON.stringify(r2.report?.executionAcks || [], null, 2)}`);
console.log(`  freedCapital: ${JSON.stringify(r2.report?.freedCapital)}`);
console.log(`  freedCapitalPicks available: ${r2.report?.freedCapitalPicks?.available}`);

const acks = r2.report?.executionAcks || [];
const tcsExec = acks.find((a) => (a.symbol || "").includes("TCS"));
console.log("\n--- assertions ---");
console.log(`  executionAcks length > 0: ${acks.length > 0 ? "PASS" : "FAIL — got " + acks.length}`);
console.log(`  TCS EXECUTED ack present:  ${tcsExec ? "PASS — " + JSON.stringify({ type: tcsExec.type, symbol: tcsExec.symbol, action: tcsExec.action, ratio: tcsExec.ratio }) : "FAIL"}`);

// Inspect ledger directly
const ledger = JSON.parse(readFileSync(path.join(ROOT, "recommendation-ledger.json"), "utf-8"));
const sub = "_local_dev";
const events = ledger[sub]?.events || [];
console.log(`\n  ledger event count: ${events.length}`);
console.log(`  ledger event types: ${events.map((e) => e.type).join(", ")}`);

const history = JSON.parse(readFileSync(path.join(ROOT, "portfolio-history.json"), "utf-8"));
const snaps = history[sub]?.snapshots || [];
console.log(`  history snapshot count: ${snaps.length}`);
console.log(`  history asOfDates: ${snaps.map((s) => s.asOfDateIso).join(", ")}`);

console.log(`\n${tcsExec ? "✓ smoke PASS" : "✗ smoke FAIL"}\n`);
process.exit(tcsExec ? 0 : 1);
