/**
 * Catalysts Today — assembles the upcoming-events tile for Market Intelligence.
 *
 * Two data sources, both committed JSON (SWS-style persistence — refreshed
 * locally via scripts/refresh-catalysts.mjs, committed, deployed):
 *
 *   data/catalysts/events-latest.json  — NSE corporate events (earnings,
 *                                        dividends, board meets, buybacks)
 *   data/macroCalendar.json            — Macro events (CPI, RBI, IIP, etc.)
 *
 * The service filters to a forward window, classifies each event by what
 * tier of attention it warrants, and cross-references the user's portfolio
 * + SWS picks universe so the most actionable items surface first.
 *
 * No buy/sell directives — this is a "what's coming up" surface, not an
 * action engine. Read-only signal.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const NSE_EVENTS_PATH = path.join(ROOT, "data", "catalysts", "events-latest.json");
const MACRO_CAL_PATH = path.join(ROOT, "data", "macroCalendar.json");
const PORTFOLIO_PATH = path.join(ROOT, "portfolio.json");
const PICKS_PATH = path.join(ROOT, "data", "sws", "picks-latest.json");

const NSE_WINDOW_DAYS = 10; // corp events: next 10 days
const MACRO_WINDOW_DAYS = 21; // macro events: next 3 weeks (longer for planning)
const BROADER_TOP_N = 12;

// Map NSE `purpose` strings into a coarse category + colour intent.
function categorisePurpose(purpose) {
  const p = String(purpose || "").toLowerCase();
  if (p.includes("financial results")) return { kind: "earnings", label: "Earnings" };
  if (p.includes("dividend") && !p.includes("financial results")) return { kind: "dividend", label: "Dividend" };
  if (p.includes("buyback")) return { kind: "buyback", label: "Buyback" };
  if (p.includes("bonus")) return { kind: "bonus", label: "Bonus" };
  if (p.includes("fund raising")) return { kind: "fundraising", label: "Fund Raising" };
  if (p.includes("financial results") && p.includes("dividend")) return { kind: "earnings_dividend", label: "Earnings + Dividend" };
  return { kind: "other", label: "Corporate Action" };
}

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * NSE returns dates as DD-Mmm-YYYY (e.g., "07-May-2026"). The macro
 * calendar uses ISO YYYY-MM-DD. We normalise both to YYYY-MM-DD for
 * consistent sorting and date math.
 */
function normaliseDate(s) {
  if (!s) return null;
  const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dmy) {
    const mo = MONTHS[dmy[2]];
    if (mo == null) return null;
    return `${dmy[3]}-${String(mo + 1).padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function loadPortfolioTickers() {
  const data = readJsonSafe(PORTFOLIO_PATH);
  const stocks = data?.stocks || [];
  const out = new Map();
  for (const s of stocks) {
    const sym = String(s.symbol || "").replace(/\.(NS|BO)$/i, "").toUpperCase();
    if (!sym) continue;
    out.set(sym, { name: s.name, sector: s.sector });
  }
  return out;
}

function loadPicksTickers() {
  const picks = readJsonSafe(PICKS_PATH);
  if (!picks) return new Map();
  const out = new Map();
  const seen = new WeakSet();

  function walk(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const tkr = node.ticker || node.symbol || node.tckrSymb || null;
    if (typeof tkr === "string" && /^[A-Z0-9&-]{1,15}$/.test(tkr)) {
      const norm = tkr.replace(/\.(NS|BO)$/i, "").toUpperCase();
      if (!out.has(norm)) {
        out.set(norm, { name: node.name || node.companyName || null });
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  }
  walk(picks);
  return out;
}

function isWithinNextDays(dateYmd, days) {
  if (!dateYmd) return false;
  const ts = Date.parse(`${dateYmd}T00:00:00`);
  if (!Number.isFinite(ts)) return false;
  const istNow = Date.now() + 5.5 * 3600 * 1000;
  const istDay = Math.floor(istNow / 86400000) * 86400000;
  const evDay = Math.floor(ts / 86400000) * 86400000;
  const deltaDays = Math.round((evDay - istDay) / 86400000);
  return deltaDays >= 0 && deltaDays <= days;
}

function daysFromToday(dateYmd) {
  if (!dateYmd) return null;
  const ts = Date.parse(`${dateYmd}T00:00:00`);
  if (!Number.isFinite(ts)) return null;
  const istNow = Date.now() + 5.5 * 3600 * 1000;
  const istDay = Math.floor(istNow / 86400000) * 86400000;
  const evDay = Math.floor(ts / 86400000) * 86400000;
  return Math.round((evDay - istDay) / 86400000);
}

/**
 * Build the served payload. No I/O outside the function — caller may pass
 * in custom paths via `options` for testing.
 */
export function buildCatalystsPayload(options = {}) {
  const portfolioTickers = options.portfolioTickers || loadPortfolioTickers();
  const picksTickers = options.picksTickers || loadPicksTickers();
  const nseEventsFile = readJsonSafe(NSE_EVENTS_PATH);
  const macroEventsFile = readJsonSafe(MACRO_CAL_PATH);

  if (!nseEventsFile && !macroEventsFile) {
    return {
      status: "warming",
      message: "Catalysts data not yet seeded. Run scripts/refresh-catalysts.mjs.",
    };
  }

  const nseEventsRaw = nseEventsFile?.events || [];
  const macroEventsRaw = macroEventsFile?.events || [];

  const nseInWindow = nseEventsRaw
    .map((e) => ({
      ...e,
      dateNorm: normaliseDate(e.date),
    }))
    .filter((e) => e.dateNorm && isWithinNextDays(e.dateNorm, NSE_WINDOW_DAYS))
    .map((e) => {
      const cat = categorisePurpose(e.purpose);
      const tickerNorm = String(e.symbol || "").replace(/\.(NS|BO)$/i, "").toUpperCase();
      return {
        ticker: tickerNorm,
        company: e.company,
        purpose: e.purpose,
        category: cat.kind,
        categoryLabel: cat.label,
        date: e.dateNorm,
        daysFromToday: daysFromToday(e.dateNorm),
        description: e.description || e.bm_desc || null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const inBook = [];
  const inPicks = [];
  const broader = [];
  for (const ev of nseInWindow) {
    if (portfolioTickers.has(ev.ticker)) {
      const meta = portfolioTickers.get(ev.ticker);
      inBook.push({ ...ev, name: meta.name, sector: meta.sector });
    } else if (picksTickers.has(ev.ticker)) {
      const meta = picksTickers.get(ev.ticker);
      inPicks.push({ ...ev, name: meta.name });
    } else {
      broader.push(ev);
    }
  }

  const macroInWindow = macroEventsRaw
    .map((e) => ({ ...e, dateNorm: normaliseDate(e.date) }))
    .filter((e) => e.dateNorm && isWithinNextDays(e.dateNorm, MACRO_WINDOW_DAYS))
    .map((e) => ({
      title: e.title,
      country: e.country || "IN",
      category: e.category || "Macro",
      tier: e.tier || "B",
      date: e.dateNorm,
      daysFromToday: daysFromToday(e.dateNorm),
      notes: e.notes || null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    schemaVersion: "catalysts-v1",
    fetchedAt: nseEventsFile?.fetched_at || null,
    macroUpdated: macroEventsFile?._updated || null,
    windows: { corporateDays: NSE_WINDOW_DAYS, macroDays: MACRO_WINDOW_DAYS },
    stats: {
      corpInWindow: nseInWindow.length,
      inBookCount: inBook.length,
      inPicksCount: inPicks.length,
      broaderCount: Math.min(broader.length, BROADER_TOP_N),
      macroInWindow: macroInWindow.length,
      truncatedBroader: Math.max(0, broader.length - BROADER_TOP_N),
    },
    sections: {
      inBook,
      inPicks: inPicks.slice(0, BROADER_TOP_N),
      broader: broader.slice(0, BROADER_TOP_N),
      macro: macroInWindow,
    },
    methodology:
      "Corporate events from NSE Event Calendar (next " + NSE_WINDOW_DAYS + " days); macro from curated India calendar (next " + MACRO_WINDOW_DAYS + " days). Cross-referenced with portfolio + SWS picks. Educational analytics; not investment advice.",
  };
}
