import * as XLSX from "xlsx";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "fixtures");
if (!existsSync(fixturesDir)) mkdirSync(fixturesDir, { recursive: true });

const OUTPUT_PATH = resolve(fixturesDir, "groww-sample.xlsx");
const OUTPUT_WITH_SUMMARY_PATH = resolve(fixturesDir, "groww-sample-with-summary.xlsx");

const stockRows = [
  ["RELIANCE INDUSTRIES LTD", "INE002A01018", 10, 2400.5, 24005, 2840.0, 28400, 4395],
  ["HDFC BANK LTD", "INE040A01034", 15, 1500.0, 22500, 1712.3, 25685, 3185],
  ["TATA CONSULTANCY SERVICES LTD", "INE467B01029", 5, 3600.0, 18000, 3850.0, 19250, 1250],
  ["INFOSYS LTD", "INE009A01021", 12, 1450.0, 17400, 1525.0, 18300, 900],
  ["ITC LTD", "INE154A01025", 50, 410.0, 20500, 430.0, 21500, 1000],
];

// Variant 1 — minimal Groww shape (header + data rows only). Used by 4 prior
// specs that don't care about the summary block.
{
  const rows = [
    ["Stock Name", "ISIN", "Quantity", "Average buy price", "Buy value", "Closing price", "Closing value", "Unrealised P&L"],
    ...stockRows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Holdings");
  XLSX.writeFile(wb, OUTPUT_PATH);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

// Variant 2 — full Groww shape with the "Holdings statement … as on" date row
// and an Invested/Closing/Unrealised summary block. The portfolioParser only
// extracts these when present, and the broker-reconciliation chip only
// renders when banner.broker_summary has at least one numeric field.
{
  const totalInvested = stockRows.reduce((s, r) => s + r[4], 0);   // Buy value
  const totalCurrent = stockRows.reduce((s, r) => s + r[6], 0);    // Closing value
  const totalPnL = stockRows.reduce((s, r) => s + r[7], 0);        // Unrealised P&L
  const rows = [
    ["Name", "Test User"],
    ["Unique Client Code", "9999999999"],
    [],
    ["Holdings statement for stocks as on 15-05-2026"],
    [],
    ["Summary"],
    ["Invested Value", totalInvested],
    ["Closing Value", totalCurrent],
    ["Unrealised P&L", totalPnL],
    [],
    ["Stock Name", "ISIN", "Quantity", "Average buy price", "Buy value", "Closing price", "Closing value", "Unrealised P&L"],
    ...stockRows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, OUTPUT_WITH_SUMMARY_PATH);
  console.log(`Wrote ${OUTPUT_WITH_SUMMARY_PATH}`);
}
