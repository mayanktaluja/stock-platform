/**
 * Portfolio file parser — Phase 5.
 *
 * Input: raw file buffer from a user upload (xlsx or csv).
 * Output: { holdings, warnings, unmatched, source } where:
 *   • holdings: normalised, platform-resolved list of { symbol, isin,
 *     name, quantity, avgPrice, rawName, sourceRow }
 *   • warnings: non-fatal issues the UI should surface
 *   • unmatched: rows the parser could parse but not resolve to a
 *     platform stock (shown in report with "limited coverage" badge)
 *   • source: "groww-xlsx" | "groww-csv" | "zerodha-csv" | "generic-csv"
 *
 * Design: each broker format has its own detect() + parse() pair. A
 * pluggable registry makes adding new formats mechanical.
 *
 * Resolution order for every parsed row:
 *   1. ISIN lookup (authoritative — never false-positive)
 *   2. Fuzzy name lookup (fallback for CSVs without ISIN)
 *   3. Unmatched list (still reported, with partial fields)
 */

import xlsx from "xlsx";
import { findByIsin, findByName, normalizeName } from "./stockList.js";

// ──────────────────── Helpers ────────────────────

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[,₹\s]/g, "").trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function normHeader(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ──────────────────── Groww XLSX ────────────────────

/**
 * Groww holdings statement (xlsx).
 *
 * Structure (observed from real export):
 *   Row 0: ["Name", "<user>"]
 *   Row 1: ["Unique Client Code", "<code>"]
 *   Row 2: ["Holdings statement for stocks as on DD-MM-YYYY"]
 *   Row 3: ["Summary"]
 *   Row 4-6: Invested Value / Closing Value / Unrealised P&L
 *   Row 7: column headers: Stock Name | ISIN | Quantity | Average buy price |
 *          Buy value | Closing price | Closing value | Unrealised P&L
 *   Row 8+: data
 */
function parseGrowwXlsx(buffer) {
  const wb = xlsx.read(buffer, { type: "buffer" });
  if (!wb.SheetNames.length) throw new Error("Empty workbook");

  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false });

  // Find the header row — more permissive than before. Scan every row and
  // try to detect the header by multiple criteria so small Groww format
  // changes don't break the parser.
  //
  //   Strategy 1: look for "stock name" + "isin" + ("qty" or "quantity")
  //   Strategy 2: look for "stock" + "isin" (most Groww exports have both)
  //   Strategy 3: look for just "isin" + "qty" or "quantity"
  //
  // Whichever matches first wins.
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const joined = (rows[i] || []).map((x) => String(x || "").toLowerCase().trim()).join("|");
    if (!joined) continue;
    const hasStock = joined.includes("stock") || joined.includes("instrument") || joined.includes("tradingsymbol") || joined.includes("security");
    const hasIsin = joined.includes("isin");
    const hasQty = joined.includes("qty") || joined.includes("quantity") || joined.includes("holdings");
    const hasAvg = joined.includes("average") || joined.includes("avg") || joined.includes("buy price") || joined.includes("cost");
    // Strongest match: all four signals
    if (hasStock && hasIsin && hasQty && hasAvg) { headerIdx = i; break; }
  }
  // Fallback: relax one criterion
  if (headerIdx === -1) {
    for (let i = 0; i < rows.length; i++) {
      const joined = (rows[i] || []).map((x) => String(x || "").toLowerCase().trim()).join("|");
      if (!joined) continue;
      const hasIsin = joined.includes("isin");
      const hasQty = joined.includes("qty") || joined.includes("quantity");
      if (hasIsin && hasQty) { headerIdx = i; break; }
    }
  }
  if (headerIdx === -1) {
    // Give the user a useful debug message — show what rows we did see
    const sampleRows = rows.slice(0, 12).map((r, i) => `row ${i}: [${(r || []).slice(0, 8).join(" | ")}]`).join("\n");
    throw new Error(
      "Could not locate a recognizable holdings header row in the Groww xlsx. " +
      "Expected a row containing Stock Name / ISIN / Quantity / Average buy price. " +
      `First 12 rows seen:\n${sampleRows}`,
    );
  }

  const headers = rows[headerIdx].map(normHeader);
  // Column locators — use substring matching over normalized headers, so
  // "Stock Name" / "STOCK NAME" / "Stock Name " all match.
  const findHeader = (...candidates) => {
    for (const c of candidates) {
      const idx = headers.findIndex((h) => h === c);
      if (idx >= 0) return idx;
    }
    // Substring fallback
    for (const c of candidates) {
      const idx = headers.findIndex((h) => h.includes(c));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const iName = findHeader("stockname", "instrument", "tradingsymbol", "security", "name");
  const iIsin = findHeader("isin", "isincode");
  const iQty = findHeader("quantity", "qty", "holdings");
  const iAvg = findHeader("averagebuyprice", "avgcost", "averageprice", "avgprice", "buyprice", "cost");
  const iClose = findHeader("closingprice", "ltp", "lastprice", "currentprice");

  if (iName < 0 || iQty < 0 || iAvg < 0) {
    throw new Error(
      `Could not locate required columns. Found headers: [${headers.join(", ")}]. ` +
      "Need at least Stock Name / Quantity / Average buy price.",
    );
  }

  // Pull out the summary block above the header for useful metadata
  const summary = {};
  for (let i = 0; i < headerIdx; i++) {
    const row = rows[i] || [];
    const k = String(row[0] || "").toLowerCase();
    const v = row[1];
    if (!k || v == null) continue;
    if (k.includes("invested value")) summary.invested = toNumber(v);
    else if (k.includes("closing value")) summary.current = toNumber(v);
    else if (k.includes("unrealised")) summary.unrealisedPL = toNumber(v);
    else if (k.includes("holdings statement")) {
      const m = /(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/.exec(String(row[0] || ""));
      if (m) summary.asOfDate = m[1];
    }
  }

  const holdings = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rawName = row[iName];
    if (!rawName) continue;
    const qty = toNumber(row[iQty]);
    const avg = toNumber(row[iAvg]);
    if (!qty || qty <= 0 || !avg || avg <= 0) continue;
    holdings.push({
      rawName: String(rawName).trim(),
      isin: iIsin >= 0 ? (String(row[iIsin] || "").trim() || null) : null,
      quantity: qty,
      avgPrice: avg,
      closePrice: iClose >= 0 ? toNumber(row[iClose]) : null,
      sourceRow: r + 1,
    });
  }

  return { holdings, summary, source: "groww-xlsx" };
}

// ──────────────────── Generic CSV (including Groww CSV / Zerodha) ────────────────────

/**
 * A flexible CSV parser that auto-detects columns by normalized header
 * name. Covers:
 *   • Groww CSV export (same columns as xlsx, without the metadata block)
 *   • Zerodha Console holdings export (Instrument, Qty., Avg. cost, LTP)
 *   • Generic CSV with any reasonable column naming
 *
 * If it can't find at least symbol-or-name + quantity + avg-price it
 * throws a descriptive error that the upload UI can surface.
 */
function parseCsv(text) {
  // Very small CSV parser — handles quoted fields but not escaped quotes-
  // inside-quotes (unlikely in broker exports).
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV too short (need header + at least one row)");

  function parseLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  const rawHeaders = parseLine(lines[0]);
  const headers = rawHeaders.map(normHeader);

  const findCol = (...keys) => {
    for (const k of keys) {
      const idx = headers.indexOf(k);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const iName = findCol("stockname", "instrument", "tradingsymbol", "symbol", "name");
  const iIsin = findCol("isin", "isincode");
  const iQty = findCol("quantity", "qty", "holdingquantity");
  const iAvg = findCol("averagebuyprice", "avgcost", "averageprice", "avgprice", "buyprice");
  const iClose = findCol("closingprice", "ltp", "lastprice", "currentprice");

  if (iName < 0 || iQty < 0 || iAvg < 0) {
    throw new Error(
      `CSV column auto-detect failed. Found headers: ${rawHeaders.join(", ")}. ` +
      "Need at least Name/Symbol + Quantity + Average price.",
    );
  }

  const holdings = [];
  for (let r = 1; r < lines.length; r++) {
    const row = parseLine(lines[r]);
    if (!row[iName]) continue;
    const qty = toNumber(row[iQty]);
    const avg = toNumber(row[iAvg]);
    if (!qty || qty <= 0 || !avg || avg <= 0) continue;
    holdings.push({
      rawName: String(row[iName]).trim(),
      isin: iIsin >= 0 ? String(row[iIsin] || "").trim() || null : null,
      quantity: qty,
      avgPrice: avg,
      closePrice: iClose >= 0 ? toNumber(row[iClose]) : null,
      sourceRow: r + 1,
    });
  }

  let source = "generic-csv";
  if (headers.includes("isin") && headers.includes("stockname")) source = "groww-csv";
  else if (headers.includes("instrument")) source = "zerodha-csv";

  return { holdings, summary: {}, source };
}

// ──────────────────── Entry point ────────────────────

/**
 * Parse an uploaded portfolio file.
 * @param {Buffer|Uint8Array|string} buffer - file contents
 * @param {string} filename - used to detect format
 * @returns {{ holdings, unmatched, warnings, source, summary }}
 */
export function parsePortfolioFile(buffer, filename = "") {
  const lower = filename.toLowerCase();
  const looksXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls");
  const looksCsv = lower.endsWith(".csv") || (!looksXlsx && typeof buffer === "string");

  let parsed;
  if (looksXlsx) {
    parsed = parseGrowwXlsx(buffer);
  } else if (looksCsv) {
    const text = typeof buffer === "string" ? buffer : Buffer.from(buffer).toString("utf-8");
    parsed = parseCsv(text);
  } else {
    // Try xlsx first, fall back to CSV
    try { parsed = parseGrowwXlsx(buffer); }
    catch {
      const text = typeof buffer === "string" ? buffer : Buffer.from(buffer).toString("utf-8");
      parsed = parseCsv(text);
    }
  }

  const warnings = [];
  const unmatched = [];
  const holdings = [];

  for (const h of parsed.holdings) {
    let resolved = h.isin ? findByIsin(h.isin) : null;
    let matchType = "isin";
    if (!resolved) {
      resolved = findByName(h.rawName);
      matchType = resolved ? "name" : "none";
    }

    if (!resolved) {
      unmatched.push({ ...h, matchType: "none" });
      continue;
    }

    holdings.push({
      symbol: resolved.symbol,
      isin: resolved.isin || h.isin || null,
      name: resolved.name,
      sector: resolved.sector,
      quantity: h.quantity,
      avgPrice: h.avgPrice,
      closePrice: h.closePrice,
      rawName: h.rawName,
      matchType,
      sourceRow: h.sourceRow,
    });
  }

  if (unmatched.length > 0) {
    warnings.push(
      `${unmatched.length} holding(s) couldn't be matched to the platform's stock universe ` +
      `(typically BSE-only, SME, or non-Nifty-500 stocks). They'll still appear in the report ` +
      "with basic info but without platform scoring.",
    );
  }

  return {
    holdings,
    unmatched,
    warnings,
    source: parsed.source,
    summary: parsed.summary || {},
  };
}
