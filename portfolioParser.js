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
 *   2. Symbol lookup (handles "TCS" / "TCS.NS" — tickers don't fuzzy-match
 *      against company names, so this must come before name matching)
 *   3. Fuzzy name lookup (fallback for CSVs without ISIN or symbol)
 *   4. Unmatched list (still reported, with partial fields)
 */

import xlsx from "xlsx";
import { findByIsin, findBySymbol, findByName, normalizeName } from "./stockList.js";
import { resolveNseStockLive } from "./nse.js";

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

  // ETFs: either the token "ETF" in the name, or a known ETF symbol family,
  // or an INF-prefix ISIN combined with an ETF-theme keyword.
  if (/\bETF\b/.test(name)) return "etf";
  if (/(NIFTYBEES|BANKBEES|GOLDBEES|LIQUIDBEES|JUNIORBEES|CPSEETF|PSUBNKBEES|SILVRBEES|MON100|MAFANG|HDFCNIFTY|ICICINIFTY|ITBEES|INFRABEES|SETFNIF|MIDCAPIETF|KOTAKGOLD|KOTAKBKETF)/.test(name)) return "etf";

  // INF-ISIN + ETF-theme keyword → ETF (not MF).
  // Silver/Gold/Nifty/Sensex commodity-tracker or index-tracker ETFs are
  // legally MF schemes (hence INF-ISIN) but behave like equities on NSE —
  // single-symbol, live-priced, same-day settlement. Broker exports use
  // AMC-prefix names like "TATAAML-TATSILV", "HDFCAMC-HDFCGOLDF",
  // "ICICIAM-ICICINIFTY" which the bare-keyword list above misses.
  if (/^INF/.test(iso) && /(SILV|SILVER|GOLD|NIFTY|SENSEX|BANK|LIQUID|BEES|MIDCAP|SMALLCAP|CPSE|PSU|ITBEE|INFRA|CONSUM|REALTY|HEALTH|AUTO|ENERG|FMCG|METAL)/.test(name)) {
    return "etf";
  }

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
// Detect & parse the Groww **Mutual Funds** XLSX export. Different schema
// from the Stocks export: header row is `Scheme Name | AMC | Category |
// Sub-category | Folio No. | Source | Units | Invested Value | Current Value
// | Returns | XIRR`. Returns null when the workbook isn't an MF export so
// the equity parser can proceed; throws only on truly unparseable rows.
function tryParseGrowwMfXlsx(buffer) {
  const wb = xlsx.read(buffer, { type: "buffer" });
  if (!wb.SheetNames.length) return null;
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false });
  if (!rows.length) return null;

  // MF header signature: "scheme name" + ("folio" or "xirr") + "invested"
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const joined = (rows[i] || []).map((x) => String(x || "").toLowerCase().trim()).join("|");
    if (!joined) continue;
    const hasScheme = joined.includes("scheme name") || joined.includes("schemename");
    const hasFolioOrXirr = joined.includes("folio") || joined.includes("xirr");
    const hasInvested = joined.includes("invested");
    if (hasScheme && hasFolioOrXirr && hasInvested) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return null;

  const headers = rows[headerIdx].map(normHeader);
  const find = (...cands) => {
    for (const c of cands) {
      const idx = headers.findIndex((h) => h === c);
      if (idx >= 0) return idx;
    }
    for (const c of cands) {
      const idx = headers.findIndex((h) => h.includes(c));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const iName = find("schemename", "scheme", "fundname");
  const iAmc = find("amc", "fundhouse");
  const iCat = find("category");
  const iSubCat = find("subcategory");
  const iFolio = find("folio", "folionumber");
  const iInvested = find("investedvalue", "invested", "investedamount");
  const iCurrent = find("currentvalue", "current", "marketvalue");
  const iReturns = find("returns", "pnlamount", "absolutereturn");
  const iXirr = find("xirr", "annualisedreturn", "irr");

  if (iName < 0 || iInvested < 0) return null;

  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = String(row[iName] ?? "").trim();
    if (!name) continue;
    const investedRaw = row[iInvested];
    const invested = parseFloat(String(investedRaw ?? "").replace(/[^\d.\-]/g, ""));
    if (!Number.isFinite(invested) || invested <= 0) continue;
    const currentRaw = iCurrent >= 0 ? row[iCurrent] : null;
    const current = parseFloat(String(currentRaw ?? "").replace(/[^\d.\-]/g, ""));
    const xirrRaw = iXirr >= 0 ? String(row[iXirr] ?? "").replace(/[^\d.\-]/g, "") : "";
    const publishedXirrPct = xirrRaw ? parseFloat(xirrRaw) : null;
    // Groww "Returns" column is absolute ₹, not %; compute pnlPercent ourselves.
    const pnlPercent = Number.isFinite(invested) && invested > 0 && Number.isFinite(current)
      ? ((current - invested) / invested) * 100 : null;
    out.push({
      name,
      rawName: name,
      isin: null,
      category: iCat >= 0 ? String(row[iCat] ?? "").trim() || null : null,
      subCategory: iSubCat >= 0 ? String(row[iSubCat] ?? "").trim() || null : null,
      folio: iFolio >= 0 ? String(row[iFolio] ?? "").trim() || null : null,
      amc: iAmc >= 0 ? String(row[iAmc] ?? "").trim() || null : null,
      instrumentType: "mf",
      invested,
      currentValue: Number.isFinite(current) ? current : invested,
      publishedXirrPct: Number.isFinite(publishedXirrPct) ? publishedXirrPct : null,
      pnlPercent: Number.isFinite(pnlPercent) ? pnlPercent : null,
      purchaseDate: null,
    });
  }

  if (out.length === 0) return null;

  return {
    source: "groww-mf-xlsx",
    holdings: [], // no equity rows — the optimizer's MF path handles these
    unmatched: [],
    mfHoldings: out,
    warnings: [],
    summary: { rowCount: out.length, mfCount: out.length },
  };
}

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
    // Try MF-only export first (different schema). Falls through to the
    // equity parser when not an MF file.
    parsed = tryParseGrowwMfXlsx(buffer);
    if (!parsed) parsed = parseGrowwXlsx(buffer);
  } else if (looksCsv) {
    const text = typeof buffer === "string" ? buffer : Buffer.from(buffer).toString("utf-8");
    parsed = parseCsv(text);
  } else {
    // Try MF, then equity xlsx, then CSV
    parsed = tryParseGrowwMfXlsx(buffer);
    if (!parsed) {
      try { parsed = parseGrowwXlsx(buffer); }
      catch {
        const text = typeof buffer === "string" ? buffer : Buffer.from(buffer).toString("utf-8");
        parsed = parseCsv(text);
      }
    }
  }

  const warnings = [];
  const unmatched = [];
  const holdings = [];
  const counts = { equity: 0, mf: 0, etf: 0, bond: 0, fno: 0, unknown: 0 };

  for (const h of parsed.holdings) {
    const instrumentType = classifyInstrument(h);
    counts[instrumentType] = (counts[instrumentType] || 0) + 1;

    // Non-equity instruments split into two groups:
    //
    //  • ETFs — live-priced on NSE, single-symbol, same-day settlement.
    //    We INCLUDE them as holdings (priced, with P&L, risk metrics,
    //    sector contribution) but without fundamental scoring. A silver
    //    ETF IS part of the user's portfolio by value — earlier versions
    //    dropped it into "unmatched" which understated the total book.
    //    Uses the live-NSE resolver in resolveUnmatchedLive to map from
    //    name → ticker.
    //
    //  • MFs, bonds, F&O — left in unmatched with a clear reason. MFs need
    //    NAV API integration we don't have; bonds/F&O aren't equity-like.
    if (instrumentType === "etf") {
      // Stash for live-resolve in the second pass. We don't try to match
      // against the curated list because ETFs aren't in it.
      unmatched.push({
        ...h,
        matchType: "pending-live",
        instrumentType: "etf",
        reason: "ETF — will be priced live; no fundamental scoring.",
      });
      continue;
    }
    if (instrumentType !== "equity" && instrumentType !== "unknown") {
      unmatched.push({
        ...h,
        matchType: "not-equity",
        instrumentType,
        reason: whyNotAnalysed(instrumentType),
      });
      continue;
    }

    // Resolution chain. Symbol goes BETWEEN ISIN and name because
    // tickers like "TCS" or "RELIANCE" will never fuzzy-match against
    // company names like "Tata Consultancy Services" / "Reliance
    // Industries" — the token overlap is zero. Without a dedicated
    // symbol lookup, even flagship Nifty 50 names end up in "unmatched"
    // when users upload a simple Symbol,Qty,Avg-Price CSV.
    let resolved = h.isin ? findByIsin(h.isin) : null;
    let matchType = resolved ? "isin" : null;
    if (!resolved) {
      resolved = findBySymbol(h.rawName);
      if (resolved) matchType = "symbol";
    }
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
    // MF-only Groww exports populate this directly. Stocks-only exports leave
    // it empty; the analyze endpoint then merges with saved-portfolio MFs.
    mfHoldings: Array.isArray(parsed.mfHoldings) ? parsed.mfHoldings : [],
  };
}

/**
 * Second-pass resolution via live NSE lookup.
 *
 * parsePortfolioFile is synchronous and only consults the in-memory
 * curated list + supplement. For rows that still fall into `unmatched`
 * as `instrumentType === "equity"` with `matchType === "none"`, we call
 * NSE's quote-equity endpoint here to authoritatively resolve them.
 * Handles newly-listed stocks, SME/illiquid names, and anything outside
 * the pre-built universe.
 *
 * This is the function that makes the analyzer truly complete: after it,
 * any real NSE-listed equity the user holds will land in `holdings`
 * rather than the "not in our scored universe" bucket.
 *
 * Called from /api/portfolio/analyze. Safe to run in parallel per row
 * because NSE throttles gracefully and we cap concurrency. On network
 * failure we leave the row in `unmatched` — the only cost of the live
 * lookup is latency, never correctness.
 *
 * Mutates `parsed` in place: moves resolved rows from unmatched →
 * holdings and updates warnings.
 */
export async function resolveUnmatchedLive(parsed) {
  if (!parsed || !parsed.unmatched || parsed.unmatched.length === 0) return parsed;

  // Two kinds of rows are eligible for live resolution:
  //
  //   • equity rows with matchType "none" — the curated list + supplement
  //     couldn't find them. Live NSE lookup usually finds newly-listed
  //     names, SME Emerge, illiquid small-caps outside the indices.
  //
  //   • ETF rows (instrumentType=etf, matchType=pending-live) — the parser
  //     deliberately leaves these for live resolution so we can fetch the
  //     real NSE symbol + current price. Resolved ETFs get promoted into
  //     holdings (NOT unmatched) so they contribute to portfolio totals.
  const toResolve = parsed.unmatched.filter(
    (u) =>
      (u.instrumentType === "equity" && u.matchType === "none") ||
      (u.instrumentType === "etf" && u.matchType === "pending-live"),
  );
  if (toResolve.length === 0) return parsed;

  // Concurrency 4 — NSE handles this fine without rate-limiting.
  const CONCURRENCY = 4;
  const resolvedMap = new Map(); // sourceRow → resolved record
  for (let i = 0; i < toResolve.length; i += CONCURRENCY) {
    const batch = toResolve.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          // Only pass `symbol` when we genuinely have a ticker; brokers
          // often use `rawName` for the company name ("KROSS LIMITED"),
          // which would then look like a ticker after whitespace-strip
          // and block the autocomplete-by-name fallback in resolveNseStockLive.
          const hit = await resolveNseStockLive({
            symbol: row.symbol || null,
            isin: row.isin,
            name: row.rawName,
          });
          return { row, hit };
        } catch {
          return { row, hit: null };
        }
      }),
    );
    for (const { row, hit } of results) {
      if (hit) resolvedMap.set(row.sourceRow, hit);
    }
  }

  if (resolvedMap.size === 0) return parsed; // Nothing promoted

  // Rebuild unmatched excluding the now-resolved rows. Push resolved rows
  // into holdings, preserving the original instrumentType so the analyzer
  // can distinguish ETFs (price-only, no scoring) from equities (scored).
  const stillUnmatched = [];
  for (const u of parsed.unmatched) {
    const hit = resolvedMap.get(u.sourceRow);
    if (!hit) {
      stillUnmatched.push(u);
      continue;
    }
    const isEtf = u.instrumentType === "etf";
    parsed.holdings.push({
      symbol: hit.symbol,
      isin: hit.isin || u.isin || null,
      name: hit.name,
      sector: isEtf ? (hit.sector || "ETF") : hit.sector,
      quantity: u.quantity,
      avgPrice: u.avgPrice,
      closePrice: u.closePrice,
      purchaseDate: u.purchaseDate || null,
      rawName: u.rawName,
      matchType: isEtf ? "live-etf" : "live",
      // Critical: preserve the original instrumentType so downstream
      // analyzer skips scoring on ETFs but still prices them.
      instrumentType: isEtf ? "etf" : "equity",
      // Flag so analyzeHolding + buildReport know this row should be
      // price-only (no TA score, no action, no recommendation).
      scored: !isEtf,
      sourceRow: u.sourceRow,
    });
  }
  parsed.unmatched = stillUnmatched;

  // Refresh the warning text — the sync pass said "X equity rows couldn't
  // be matched"; after this pass the count may be lower or zero.
  const remainingEquityMisses = stillUnmatched.filter(
    (u) => u.instrumentType === "equity" && u.matchType === "none",
  ).length;
  parsed.warnings = (parsed.warnings || []).filter(
    (w) => !/couldn't be matched to the platform's stock universe/i.test(w),
  );
  if (remainingEquityMisses > 0) {
    parsed.warnings.push(
      `${remainingEquityMisses} equity row(s) couldn't be matched — NSE also couldn't find them. ` +
      "Typically delisted, SME Emerge, or BSE-only names. They're in the report with raw info only.",
    );
  }

  return parsed;
}
