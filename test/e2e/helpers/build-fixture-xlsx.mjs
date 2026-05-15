import * as XLSX from "xlsx";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "fixtures");
if (!existsSync(fixturesDir)) mkdirSync(fixturesDir, { recursive: true });

const OUTPUT_PATH = resolve(fixturesDir, "groww-sample.xlsx");

const rows = [
  ["Stock Name", "ISIN", "Quantity", "Average buy price", "Buy value", "Closing price", "Closing value", "Unrealised P&L"],
  ["RELIANCE INDUSTRIES LTD", "INE002A01018", 10, 2400.5, 24005, 2840.0, 28400, 4395],
  ["HDFC BANK LTD", "INE040A01034", 15, 1500.0, 22500, 1712.3, 25685, 3185],
  ["TATA CONSULTANCY SERVICES LTD", "INE467B01029", 5, 3600.0, 18000, 3850.0, 19250, 1250],
  ["INFOSYS LTD", "INE009A01021", 12, 1450.0, 17400, 1525.0, 18300, 900],
  ["ITC LTD", "INE154A01025", 50, 410.0, 20500, 430.0, 21500, 1000],
];

const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Holdings");
XLSX.writeFile(wb, OUTPUT_PATH);

console.log(`Wrote ${OUTPUT_PATH}`);
