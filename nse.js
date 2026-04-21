/**
 * NSE India Official Data Module
 *
 * Fetches live market data directly from nseindia.com.
 * Handles cookie/session management required by NSE's API.
 * Falls back gracefully if NSE is unreachable.
 */

const NSE_BASE = "https://www.nseindia.com";
const NSE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ────────── Timeout wrapper (local copy; no circular import) ──────────

async function fetchNseWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error(`NSE timeout after ${timeoutMs}ms`);
      e.code = "TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ────────── Cookie / Session Manager ──────────

let _cookies = "";
let _cookieExpiry = 0;

/**
 * Obtain fresh cookies from the NSE homepage.
 * Cookies are cached for 4 minutes before refresh.
 */
async function refreshCookies() {
  try {
    const res = await fetchNseWithTimeout(NSE_BASE, {
      headers: {
        "User-Agent": NSE_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }, 12000);

    if (!res.ok) throw new Error(`Homepage ${res.status}`);

    const setCookies = res.headers.getSetCookie?.() || [];
    _cookies = setCookies.map((c) => c.split(";")[0]).join("; ");
    _cookieExpiry = Date.now() + 4 * 60 * 1000; // 4 min
    return true;
  } catch (err) {
    console.error("NSE cookie refresh failed:", err.message);
    return false;
  }
}

async function getCookies() {
  if (!_cookies || Date.now() > _cookieExpiry) {
    await refreshCookies();
  }
  return _cookies;
}

/**
 * Make an authenticated GET to the NSE API.
 * Retries once with fresh cookies on auth failure.
 */
async function nseGet(path, referer) {
  const cookies = await getCookies();
  if (!cookies) return null;

  const url = `${NSE_BASE}${path}`;
  const headers = {
    "User-Agent": NSE_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookies,
    Referer: referer || `${NSE_BASE}/market-data/live-equity-market`,
  };

  try {
    let res = await fetchNseWithTimeout(url, { headers }, 12000);

    // Retry once with fresh cookies on 401/403
    if (res.status === 401 || res.status === 403) {
      await refreshCookies();
      const newCookies = await getCookies();
      headers.Cookie = newCookies;
      res = await fetchNseWithTimeout(url, { headers }, 12000);
    }

    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    console.error(`NSE fetch failed for ${path}:`, err.message);
    return null;
  }
}

// Export nseGet so other modules (like refresh-fundamentals.mjs) can reuse it
export { nseGet };

/**
 * Unauthenticated NSE GET — bypasses the cookie dance entirely.
 *
 * WHY THIS EXISTS: `nseGet` above short-circuits with `return null` when
 * cookie refresh fails. NSE blocks datacenter IPs from the HOMEPAGE (which
 * is what `refreshCookies` hits), but several of NSE's public API paths —
 * most importantly `/api/fiidiiTradeReact` — happily serve JSON without
 * any cookie at all. On Vercel the homepage call always fails, so ANY
 * caller going through nseGet is blocked even if their endpoint doesn't
 * actually need cookies.
 *
 * This helper skips the cookie step and does a direct fetch with just a
 * browser User-Agent + Referer. Use it for endpoints you've verified
 * work cookie-less. Returns null on any failure so callers can fall
 * back gracefully.
 */
export async function nseGetUnauthed(path, referer) {
  const url = `${NSE_BASE}${path}`;
  const headers = {
    "User-Agent": NSE_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer || `${NSE_BASE}/`,
  };
  try {
    const res = await fetchNseWithTimeout(url, { headers }, 10000);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(`NSE unauth fetch failed for ${path}:`, err.message);
    return null;
  }
}

// ────────── Public API ──────────

/**
 * Fetch stocks for ANY NSE index by name.
 * Returns raw array of stock rows from NSE.
 */
export async function fetchNseIndex(indexName) {
  const encoded = encodeURIComponent(indexName);
  const data = await nseGet(`/api/equity-stockIndices?index=${encoded}`);
  if (!data || !data.data) return null;
  return {
    stocks: data.data.filter((d) => d.symbol !== indexName).map(mapNseStock),
    timestamp: data.timestamp || new Date().toISOString(),
  };
}

/**
 * Fetch all Nifty 50 stocks in one call.
 * Returns { indexData, stocks[] } where each stock has lastPrice, change, pChange,
 * open, dayHigh, dayLow, previousClose, totalTradedVolume, yearHigh, yearLow, etc.
 */
export async function fetchNifty50() {
  const data = await nseGet("/api/equity-stockIndices?index=NIFTY%2050");
  if (!data || !data.data) return null;

  const indexRow = data.data.find((d) => d.symbol === "NIFTY 50") || {};
  const stocks = data.data.filter((d) => d.symbol !== "NIFTY 50");

  return {
    indexData: {
      name: "NIFTY 50",
      value: indexRow.lastPrice || data.metadata?.last,
      change: indexRow.change || data.metadata?.change,
      pChange: indexRow.pChange || data.metadata?.percentChange,
      open: indexRow.open,
      dayHigh: indexRow.dayHigh,
      dayLow: indexRow.dayLow,
      previousClose: indexRow.previousClose,
      yearHigh: indexRow.yearHigh,
      yearLow: indexRow.yearLow,
    },
    stocks: stocks.map(mapNseStock),
    timestamp: data.timestamp || new Date().toISOString(),
  };
}

/**
 * Fetch Bank Nifty stocks.
 */
export async function fetchBankNifty() {
  const data = await nseGet("/api/equity-stockIndices?index=NIFTY%20BANK");
  if (!data || !data.data) return null;

  const indexRow = data.data.find((d) => d.symbol === "NIFTY BANK") || {};
  return {
    indexData: {
      name: "BANK NIFTY",
      value: indexRow.lastPrice || data.metadata?.last,
      change: indexRow.change || data.metadata?.change,
      pChange: indexRow.pChange || data.metadata?.percentChange,
    },
  };
}

/**
 * Fetch RAW NSE quote-equity response (full object with metadata, securityInfo, priceInfo, industryInfo).
 * Used by the fundamentals scraper + detail endpoint to extract P/E, sector P/E, issued size, etc.
 */
export async function fetchNseQuoteRaw(symbol) {
  const clean = symbol.replace(".NS", "").replace(".BO", "");
  return nseGet(
    `/api/quote-equity?symbol=${encodeURIComponent(clean)}`,
    `${NSE_BASE}/get-quotes/equity?symbol=${encodeURIComponent(clean)}`
  );
}

/**
 * Convenience wrapper for Nifty Next 50.
 */
export async function fetchNiftyNext50() {
  return fetchNseIndex("NIFTY NEXT 50");
}

/**
 * Fetch NSE's upcoming corporate events calendar (board meetings, earnings,
 * dividends, etc.). Returns ~150 events for the next few weeks.
 *
 * Response shape per event:
 *   { symbol, company, purpose, date, bm_desc }
 *
 * We only care about "Financial Results" events (which are the board meetings
 * that approve earnings), plus dividend and bonus announcements.
 */
export async function fetchNseEventCalendar() {
  const data = await nseGet("/api/event-calendar");
  if (!data) return [];
  // NSE returns the data as an array OR as an object with numeric keys — normalise
  const arr = Array.isArray(data) ? data : Object.values(data);
  return arr
    .filter((e) => e && typeof e === "object" && e.symbol && e.date)
    .map((e) => ({
      symbol: (e.symbol || "").toUpperCase(),
      company: e.company,
      purpose: e.purpose,
      date: e.date,
      description: e.bm_desc,
    }));
}

/**
 * Fetch detailed quote for a single stock.
 */
export async function fetchNseQuote(symbol) {
  const clean = symbol.replace(".NS", "").replace(".BO", "");
  const data = await nseGet(
    `/api/quote-equity?symbol=${encodeURIComponent(clean)}`,
    `${NSE_BASE}/get-quotes/equity?symbol=${encodeURIComponent(clean)}`
  );
  if (!data || !data.priceInfo) return null;

  const p = data.priceInfo;
  const info = data.info || {};
  const sec = data.securityInfo || {};
  const meta = data.metadata || {};

  return {
    symbol: clean + ".NS",
    shortName: info.companyName || clean,
    longName: info.companyName || clean,
    industry: info.industry || null,
    isin: info.isin || null,

    regularMarketPrice: p.lastPrice,
    regularMarketChange: p.change,
    regularMarketChangePercent: p.pChange,
    regularMarketOpen: p.open,
    regularMarketDayHigh: p.intraDayHighLow?.max,
    regularMarketDayLow: p.intraDayHighLow?.min,
    regularMarketPreviousClose: p.previousClose,
    regularMarketVolume: sec.tradedVolume || null,
    vwap: p.vwap,
    deliveryPercent: sec.deliveryToTradedQuantity || null,

    fiftyTwoWeekHigh: p.weekHighLow?.max || p.weekHighLow?.maxDate ? null : null,
    fiftyTwoWeekLow: p.weekHighLow?.min || null,
    upperCircuit: p.upperCP,
    lowerCircuit: p.lowerCP,

    currency: "INR",
    exchange: "NSE",
    marketState: p.close ? "Closed" : "Open",
    source: "nse",
  };
}

/**
 * Fetch GIFT Nifty (front-month Nifty futures on NSE International Exchange).
 *
 * GIFT Nifty replaced SGX Nifty on 3 July 2023 after NSE and SGX unwound
 * their licensing arrangement. It trades in GIFT City (Gujarat) on NSE IX
 * across two sessions (06:30–15:40 IST morning, 16:35–02:45 IST overnight)
 * and is the single most-watched Indian pre-open indicator for traders.
 *
 * Yahoo Finance has no reliable symbol for GIFT Nifty, so we pull it
 * directly from NSE IX's public streamer. The endpoint is unauthenticated;
 * a browser User-Agent and Referer are enough. We pick the NEAREST
 * non-expired futures contract — that's what financial dashboards quote
 * when they say "GIFT Nifty".
 *
 * Returns null on any failure so the caller can gracefully degrade —
 * GIFT Nifty is a nice-to-have, never a hard dependency.
 *
 * LTT (last trade time) in the response is IST and comes back like
 * "21-Apr-2026 02:18:17" — we surface it raw so the UI can show a
 * "Last traded 02:18 IST" reference, important because GIFT Nifty can be
 * stale for hours between sessions.
 */
export async function fetchGiftNifty() {
  try {
    const res = await fetchNseWithTimeout(
      "https://www.nseix.com/api/streamer-market-watch/",
      {
        headers: {
          "User-Agent": NSE_UA,
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.nseix.com/market-watch",
        },
      },
      10000,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const blocks = data?.MBP_data_Market_Watch;
    if (!Array.isArray(blocks)) return null;

    // Flatten all contract rows across blocks, keep only NIFTY futures
    const rows = [];
    for (const b of blocks) {
      const arr = Array.isArray(b?.token_data) ? b.token_data : [];
      for (const r of arr) {
        if (r && r.SYMBOL === "NIFTY" && r.INSTRUMENTTYPE === "FUTIDX") {
          rows.push(r);
        }
      }
    }
    if (rows.length === 0) return null;

    // Pick the nearest non-expired contract. Expiry format is DD-Mon-YYYY.
    const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const parseExpiry = (s) => {
      const m = String(s || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
      if (!m) return null;
      const mo = MONTHS[m[2]];
      if (mo === undefined) return null;
      return new Date(+m[3], mo, +m[1]).getTime();
    };
    const now = Date.now();
    let nearest = null;
    for (const r of rows) {
      const t = parseExpiry(r.EXPIRYDATE);
      if (t == null || t < now) continue;
      if (!nearest || t < nearest._ts) {
        nearest = { ...r, _ts: t };
      }
    }
    // If all contracts appear expired (e.g. on a rollover day), fall back
    // to the earliest by date so we still surface a number rather than nothing
    if (!nearest) {
      for (const r of rows) {
        const t = parseExpiry(r.EXPIRYDATE);
        if (t == null) continue;
        if (!nearest || t < nearest._ts) nearest = { ...r, _ts: t };
      }
    }
    if (!nearest) return null;

    const toNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const price = toNumber(nearest.LASTPRICE);
    if (price == null) return null;

    return {
      symbol: "GIFTNIFTY",
      name: "GIFT NIFTY",
      price,
      change: toNumber(nearest.CHANGE),
      changePercent: toNumber(nearest.PERCHANGE),
      open: toNumber(nearest.OPEN),
      dayHigh: toNumber(nearest.HIGH),
      dayLow: toNumber(nearest.LOW),
      // CLOSE on NSE IX is the previous-session close — the reference
      // for today's % change calculation.
      previousClose: toNumber(nearest.CLOSE),
      volume: toNumber(nearest.VOLUME),
      expiry: nearest.EXPIRYDATE,
      // "Last traded at" — raw IST string from NSE IX, surfaced for the UI
      lastTradedAt: nearest.LTT || null,
      source: "nseix",
    };
  } catch (err) {
    console.error("GIFT Nifty fetch failed:", err.message);
    return null;
  }
}

/**
 * Fetch live data for market indices (NIFTY 50, SENSEX proxy, BANK NIFTY).
 */
export async function fetchNseIndices() {
  const [nifty, bankNifty] = await Promise.all([
    fetchNifty50(),
    fetchBankNifty(),
  ]);

  const indices = [];
  if (nifty?.indexData) {
    indices.push({
      symbol: "^NSEI",
      name: "NIFTY 50",
      price: nifty.indexData.value,
      change: nifty.indexData.change,
      changePercent: nifty.indexData.pChange,
      dayHigh: nifty.indexData.dayHigh,
      dayLow: nifty.indexData.dayLow,
      previousClose: nifty.indexData.previousClose,
      source: "nse",
    });
  }
  if (bankNifty?.indexData) {
    indices.push({
      symbol: "^NSEBANK",
      name: "BANK NIFTY",
      price: bankNifty.indexData.value,
      change: bankNifty.indexData.change,
      changePercent: bankNifty.indexData.pChange,
      source: "nse",
    });
  }
  return indices;
}

// ────────── helpers ──────────

function mapNseStock(row) {
  return {
    symbol: row.symbol + ".NS",
    name: row.meta?.companyName || row.symbol,
    // NSE index API includes a `meta.industry` field for each stock — this is
    // the best sector hint we get for small/microcaps that aren't in our
    // curated ALL_STOCKS list or fundamentals.json. Surface it so the macro
    // layer can apply sector-based tilts to smallcap scanner results.
    sector: row.meta?.industry || null,
    industry: row.meta?.industry || null,
    lastPrice: row.lastPrice,
    change: row.change,
    pChange: row.pChange,
    open: row.open,
    dayHigh: row.dayHigh,
    dayLow: row.dayLow,
    previousClose: row.previousClose,
    totalTradedVolume: row.totalTradedVolume,
    totalTradedValue: row.totalTradedValue,
    yearHigh: row.yearHigh,
    yearLow: row.yearLow,
    perChange365d: row.perChange365d,
    perChange30d: row.perChange30d,
    source: "nse",
  };
}

/**
 * Warm up NSE cookies proactively (call on server start).
 */
export async function warmup() {
  const ok = await refreshCookies();
  if (ok) console.log("  NSE session established (cookies acquired)");
  else console.log("  NSE session failed — will use Yahoo Finance fallback");
  return ok;
}
