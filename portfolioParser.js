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

/**
 * Best-effort date parser. Accepts DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD,
 * and Excel-serial dates. Returns ISO YYYY-MM-DD string or null.
 *
 * Dates in broker exports are almost always DD-MM (India). We prefer
 * that interpretation over US MM-DD when the format is ambiguous.
 */
function toIsoDate(v) {
  if (v == null) return null;
  if (typeof v === "number") {
    // Excel serial: days since 1899-12-30
    if (v > 0 && v < 100000) {
      const ms = Math.round((v - 25569) * 86400 * 1000);
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;

  // ISO-ish YYYY-MM-DD or YYYY/MM/DD
  const iso = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // DD-MM-YYYY or DD/MM/YYYY (India default)
  const dmy = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/.exec(s);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = (parseInt(y, 10) > 70 ? "19" : "20") + y;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  // Last resort — let Date.parse try (handles "21 Apr 2024" etc.)
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// ──────────────────── Instrument classification ────────────────────

/**
 * Classify a row by ISIN prefix + name heuristics. Returns one of:
 *   "equity"  — standard listed equity (goes to the scored universe)
 *   "mf"      — mutual fund units (not analysed)
 *   "etf"     — exchange-traded fund (not analysed, but may be priced)
 *   "bond"    — debt / G-sec
 *   "fno"     — futures / options contract
 *   "unknown" — can't tell
 *
 * India ISIN prefixes (RBI / NSDL convention):
 *   INE…  Equity shares
 *   INF…  Mutual fund units
 *   IN9…  Reissued capital (typically debt)
 *   INY…  Bonds (non-corporate)
 *   INR…  Sovereign gold bonds, state development loans
 */
export function classifyInstrument({ isin, rawName, symbol }) {
  const name = String(rawName || symbol || "").toUpperCase();
  const iso = String(isin || "").toUpperCase();

  // Name-based first — ETFs legally carry INF- ISINs in India (because they're
  // MF schemes structurally), but we want to classify them as ETFs so the user
  // sees the right "why we skipped" message. Name patterns beat ISIN here.

  // F&O: contracts contain FUT/CE/PE tokens or expiry-then-strike patterns
  if (/\b(FUT|CE|PE)\b/.test(name)) return "fno";
  if (/\d{2}[A-Z]{3}\d{2}.*\d+(CE|PE)$/.test(name.replace(/\s+/g, ""))) return "fno";

  // ETFs: either the token "ETF" in the name, or a known ETF symbol family
  if (/\bETF\b/.test(name)) return "etf";
  if (/(NIFTYBEES|BANKBEES|GOLDBEES|LIQUIDBEES|JUNIORBEES|CPSEETF|PSUBNKBEES|SILVRBEES|MON100|MAFANG|HDFCNIFTY|ICICINIFTY|ITBEES|INFRABEES|SETFNIF|MIDCAPIETF|KOTAKGOLD|KOTAKBKETF)/.test(name)) return "etf";

  // Explicit MF scheme naming ("Direct Growth", "Regular Plan" etc.)
  if (/MUTUAL\s*FUND|DIRECT\s*GROWTH|DIRECT\s*PLAN|REGULAR\s*PLAN/.test(name)) return "mf";

  // ISIN-based fallback (authoritative for things without telltale names)
  if (/^INF/.test(iso)) return "mf";
  if (/^IN9/.test(iso) || /^INY/.test(iso) || /^INR/.test(iso)) return "bond";

  if (/^INE/.test(iso) || iso === "") return "equity";
  return "unknown";
}

/**
 * Build a short explanation for a row we decided not to analyse, so the
 * UI can render "not scored because …".
 */
function whyNotAnalysed(instrumentType) {
  switch (instrumentType) {
    case "mf":   return "Mutual fund units — StarBhai's scoring engine is calibrated for listed equities. MF analysis requires NAV history and expense-ratio data we don't ingest.";
    case "etf":  return "ETF — tracks a basket, not a single company. Our fundamentals model (ROE, D/E, valuation vs. sector) doesn't apply.";
    case "bond": return "Debt instrument — yield-to-maturity + credit rating are the right lens, not equity scoring.";
    case "fno":  return "Futures or options contract — out of scope for a long-only holdings analyser.";
    default:     return "Could not classify this instrument as a listed equity.";
  }
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
  // Purchase date — Groww "Transactions" exports sometimes include a
  // "First Purchase Date" column; Zerodha tradebook has "Trade Date".
  const iDate = findHeader(
    "firstpurchasedate", "firstpurchaseon", "purchasedate", "purchasedon",
    "buydate", "tradedate", "datepurchased", "investedon", "firstbuydate",
  );

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
      purchaseDate: iDate >= 0 ? toIsoDate(row[iDate]) : null,
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
  const iDate = findCol(
    "firstpurchasedate", "firstpurchaseon", "purchasedate", "purchasedon",
    "buydate", "tradedate", "datepurchased", "investedon", "firstbuydate",
  );

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
      purchaseDate: iDate >= 0 ? toIsoDate(row[iDate]) : null,
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
  const counts = { equity: 0, mf: 0, etf: 0, bond: 0, fno: 0, unknown: 0 };

  for (const h of parsed.holdings) {
    const instrumentType = classifyInstrument(h);
    counts[instrumentType] = (counts[instrumentType] || 0) + 1;

    // Non-equity instruments are surfaced as unmatched with an explicit
    // reason — they still show up in the report so the user understands
    // their full book, but they don't get scored.
    if (instrumentType !== "equity" && instrumentType !== "unknown") {
      unmatched.push({
        ...h,
        matchType: "not-equity",
        instrumentType,
        reason: whyNotAnalysed(instrumentType),
      });
      continue;
    }

    let resolved = h.isin ? findByIsin(h.isin) : null;
    let matchType = "isin";
    if (!resolved) {
      resolved = findByName(h.rawName);
      matchType = resolved ? "name" : "none";
    }

    if (!resolved) {
      unmatched.push({
        ...h,
        matchType: "none",
        instrumentType,
        reason: "Not in our scored universe (typically BSE-only, SME, or non-Nifty-500).",
      });
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
      purchaseDate: h.purchaseDate || null,
      rawName: h.rawName,
      matchType,
      instrumentType: "equity",
      sourceRow: h.sourceRow,
    });
  }

  // Compose a precise warning sentence per instrument-type bucket
  const skippedNonEquity = counts.mf + counts.etf + counts.bond + counts.fno;
  if (skippedNonEquity > 0) {
    const parts = [];
    if (counts.mf)   parts.push(`${counts.mf} mutual fund unit${counts.mf > 1 ? "s" : ""}`);
    if (counts.etf)  parts.push(`${counts.etf} ETF${counts.etf > 1 ? "s" : ""}`);
    if (counts.bond) parts.push(`${counts.bond} debt/bond instrument${counts.bond > 1 ? "s" : ""}`);
    if (counts.fno)  parts.push(`${counts.fno} F&O contract${counts.fno > 1 ? "s" : ""}`);
    warnings.push(
      `Skipped ${parts.join(", ")} — the analyser only scores listed equities. ` +
      "They're listed under 'Not analysed' with a per-row reason.",
    );
  }

  const unresolvedEquities = unmatched.filter((u) => u.matchType === "none").length;
  if (unresolvedEquities > 0) {
    warnings.push(
      `${unresolvedEquities} equity row(s) couldn't be matched to the platform's stock universe ` +
      "(typically BSE-only, SME, or non-Nifty-500). They're in the report with raw info only.",
    );
  }

  return {
    holdings,
    unmatched,
    warnings,
    source: parsed.source,
    summary: parsed.summary || {},
    instrumentCounts: counts,
  };
}
