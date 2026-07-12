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
 * GET an NSE API path. Tries the unauthenticated request FIRST, falls
 * back to a cookie-gated request only when NSE returns 401/403/412.
 *
 * Why unauth-first: NSE's homepage (the source of our cookies) rejects
 * Vercel datacenter IPs. That makes the cookie dance fail on production,
 * and the old "cookies-required" approach short-circuited with null even
 * for endpoints that don't actually require cookies — /api/equity-
 * stockIndices, /api/quote-equity, /api/fiidiiTradeReact, etc. all serve
 * JSON perfectly fine without any cookie. Reversing the order restores
 * full NSE coverage on Vercel while preserving the cookie fallback for
 * the paths that do need it.
 */
/**
 * Structured variant of nseGet. Returns a discriminated result instead of
 * collapsing every failure to `null`, so callers that need to SEE why a
 * fetch failed (e.g. surveillance's --strict gate) can log a real HTTP
 * status instead of silently treating a 404/blocked/HTML response as
 * "zero rows". `nseGet` is a thin wrapper preserving the legacy null contract.
 *
 * Shape: { ok, status, data, error, errorClass, attempt }
 *   ok:         boolean
 *   status:     number|null  — last HTTP status seen (null on pure network error)
 *   data:       parsed JSON on ok:true, else null
 *   error:      human string on ok:false ("HTTP 404", "non-JSON body", ...)
 *   errorClass: "http" | "timeout" | "network" | "non-json" | "cookie"
 *   attempt:    "unauth" | "cookie"  — which leg produced the result
 */
async function nseGetDetailed(path, referer) {
  const url = `${NSE_BASE}${path}`;
  const baseHeaders = {
    "User-Agent": NSE_UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer || `${NSE_BASE}/market-data/live-equity-market`,
  };

  // NSE occasionally serves an HTML block/interstitial page with a 200 —
  // parse defensively so those masquerade as failures, not empty JSON.
  async function readJson(res, attempt) {
    try {
      const data = await res.json();
      return { ok: true, status: res.status, data, error: null, errorClass: null, attempt };
    } catch {
      return {
        ok: false, status: res.status, data: null,
        error: "non-JSON body (HTML block page?)", errorClass: "non-json", attempt,
      };
    }
  }

  let lastStatus = null;
  let lastError = null;
  let lastClass = null;

  // Attempt 1: no cookies. Fast path for Vercel.
  try {
    const res = await fetchNseWithTimeout(url, { headers: baseHeaders }, 10000);
    if (res.ok) return await readJson(res, "unauth");
    lastStatus = res.status;
    lastError = `HTTP ${res.status}`;
    lastClass = "http";
    // Only fall back to the cookie dance for auth-style rejections. A 404
    // or 500 is a real upstream error, retrying with cookies won't help.
    if (![401, 403, 412].includes(res.status)) {
      return { ok: false, status: res.status, data: null, error: lastError, errorClass: "http", attempt: "unauth" };
    }
  } catch (err) {
    // Network failure — let the cookie path try, maybe the TLS/DNS
    // negotiation just glitched once.
    console.warn(`NSE unauth attempt failed for ${path}:`, err.message);
    lastError = err.message;
    lastClass = err.code === "TIMEOUT" ? "timeout" : "network";
  }

  // Attempt 2: cookie-gated. Restores access for the few endpoints that
  // do enforce a session check (e.g. some report downloads).
  const cookies = await getCookies();
  if (!cookies) {
    return {
      ok: false, status: lastStatus, data: null,
      error: lastError ? `${lastError}; cookie priming failed` : "cookie priming failed",
      errorClass: "cookie", attempt: "cookie",
    };
  }
  try {
    let res = await fetchNseWithTimeout(
      url,
      { headers: { ...baseHeaders, Cookie: cookies } },
      12000,
    );
    if (res.status === 401 || res.status === 403) {
      await refreshCookies();
      const refreshed = await getCookies();
      if (!refreshed) {
        return {
          ok: false, status: res.status, data: null,
          error: `HTTP ${res.status}; cookie refresh failed`, errorClass: "cookie", attempt: "cookie",
        };
      }
      res = await fetchNseWithTimeout(
        url,
        { headers: { ...baseHeaders, Cookie: refreshed } },
        12000,
      );
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}`, errorClass: "http", attempt: "cookie" };
    }
    return await readJson(res, "cookie");
  } catch (err) {
    console.error(`NSE cookie fetch failed for ${path}:`, err.message);
    return {
      ok: false, status: lastStatus, data: null, error: err.message,
      errorClass: err.code === "TIMEOUT" ? "timeout" : "network", attempt: "cookie",
    };
  }
}

/**
 * Legacy null-or-data contract. Thin wrapper over nseGetDetailed so the
 * dozens of existing callers (fetchNseIndex, refresh-*.mjs, ...) are
 * unchanged: parsed JSON on success, null on any failure.
 */
async function nseGet(path, referer) {
  const r = await nseGetDetailed(path, referer);
  return r.ok ? r.data : null;
}

// Export nseGet + nseGetDetailed so other modules (refresh-fundamentals.mjs,
// surveillance.js) can reuse them.
export { nseGet, nseGetDetailed };

/**
 * Build a progressively-shorter list of name variants for NSE autocomplete.
 *
 * NSE autocomplete is fuzzy on "EASY TRIP PLANNERS" but returns nothing
 * for "EASY TRIP PLANNERS LTD". Broker xlsx exports commonly include
 * corporate suffixes (LTD, LIMITED, & CO, INDIA, INDUSTRIES). We generate
 * variants stripping these and return them longest-first so the caller
 * can try each until one hits.
 *
 * Example:
 *   "EASY TRIP PLANNERS LTD"        → ["EASY TRIP PLANNERS LTD", "EASY TRIP PLANNERS"]
 *   "GARDEN REACH SHIP&ENG LTD"     → [original, "GARDEN REACH SHIP&ENG", "GARDEN REACH SHIP", "GARDEN REACH"]
 *   "TATA MOTORS LIMITED"           → [original, "TATA MOTORS"]
 */
function buildAutocompleteCandidates(rawName) {
  const out = [];
  const original = String(rawName || "").trim();
  if (!original) return out;
  out.push(original);

  // ETF/MF broker-export format: "TATAAML-TATSILV", "HDFCAMC-HDFCGOLD",
  // "ICICIAM-NIFTYBEES". The part after the dash IS the NSE symbol.
  // Split on dash and push the right-hand side as its own candidate.
  if (/^[A-Z]+-[A-Z0-9]+$/i.test(original)) {
    const parts = original.split("-");
    if (parts.length === 2 && parts[1].length >= 3) out.push(parts[1]);
  }

  // Strip common corporate suffixes (iteratively, so "LTD" AND "INDIA LTD" both work).
  const SUFFIX_RE =
    /\s+(LIMITED|LTD|CORPORATION|CORP|LTDA|INC|PVT|PRIVATE|PLC|COMPANY|CO|& CO|AND CO|INDUSTRIES|INDUSTRY|ENTERPRISES|HOLDINGS|HOLDING|INDIA|GROUP|CONSULTANCY)\.?$/i;
  let current = original;
  for (let i = 0; i < 5; i++) {
    const stripped = current.replace(SUFFIX_RE, "").trim();
    if (stripped && stripped !== current) {
      out.push(stripped);
      current = stripped;
    } else {
      break;
    }
  }

  // Also try the first 2-3 significant tokens — NSE autocomplete ranks
  // prefix matches highly. Skip tokens ≤2 chars.
  const tokens = original.split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length > 2) {
    const twoToken = tokens.slice(0, 2).join(" ");
    if (!out.includes(twoToken)) out.push(twoToken);
  }
  if (tokens.length > 1) {
    const oneToken = tokens[0];
    if (oneToken.length >= 4 && !out.includes(oneToken)) out.push(oneToken);
  }

  // De-dup while preserving order
  return [...new Set(out)];
}

/**
 * Last-resort live resolver for a portfolio row that didn't match the
 * curated list OR the supplement. Tries:
 *   1. /api/quote-equity?symbol=X  (if we have a symbol)
 *   2. /api/search/autocomplete?q=X (if we have a name but no symbol)
 *
 * Returns { symbol, isin, name, sector, industry } or null. Always
 * returns null on network errors rather than throwing — the analyzer
 * just keeps the row in `unmatched` in that case.
 *
 * Why this exists: even the 1000-stock supplement won't cover every
 * NSE-listed name — newer listings, SME Emerge, and illiquid names
 * sit outside the major indices. This live lookup handles them on
 * demand during portfolio analysis. At most one call per unmatched
 * row per upload — not a hot path.
 */
export async function resolveNseStockLive({ symbol, isin, name } = {}) {
  if (!symbol && !name && !isin) return null;

  // Best input: a bare ticker we can quote directly. We only accept
  // `symbol` when it actually looks like a ticker — short, no spaces,
  // letters + digits + a few symbols. Broker xlsx files often stuff the
  // company name ("FIBERWEB INDIA LIMITED") into the "symbol" field,
  // which would otherwise become a bogus ticker "FIBERWEBINDIALIMITED"
  // and block the autocomplete fallback from even running.
  let tryQuote = null;
  if (symbol) {
    const cleaned = String(symbol)
      .toUpperCase()
      .replace(/\.(NS|BO)$/, "")
      .replace(/\s+/g, "")
      .trim();
    const looksLikeTicker = /^[A-Z0-9&-]{1,15}$/.test(cleaned);
    if (looksLikeTicker) tryQuote = cleaned;
  }

  // If we don't have a plausible ticker, bounce through autocomplete.
  // NSE's autocomplete is fuzzy: given "FIBERWEB INDIA LIMITED" we get
  // the FIBERWEB symbol. It doesn't match ISINs directly.
  if (!tryQuote && name) {
    // NSE autocomplete is fuzzy on company root-name but brittle about
    // corporate suffixes. "EASY TRIP PLANNERS LTD" returns ZERO results;
    // "EASY TRIP PLANNERS" returns EASEMYTRIP. We try the raw name first
    // then progressively shorter variants.
    const candidates = buildAutocompleteCandidates(name);
    for (const candidate of candidates) {
      try {
        const url = `${NSE_BASE}/api/search/autocomplete?q=${encodeURIComponent(candidate)}`;
        const res = await fetchNseWithTimeout(
          url,
          { headers: { "User-Agent": NSE_UA, Accept: "application/json", Referer: `${NSE_BASE}/` } },
          8000,
        );
        if (!res.ok) continue;
        const data = await res.json();
        const first = (data?.symbols || []).find((s) => s?.symbol && !s.symbol.endsWith("*"));
        if (first?.symbol) {
          tryQuote = first.symbol;
          break;
        }
      } catch {
        /* silent — try next candidate */
      }
    }
  }

  if (!tryQuote) return null;

  // Quote the resolved symbol for the authoritative metadata + ISIN
  try {
    const url = `${NSE_BASE}/api/quote-equity?symbol=${encodeURIComponent(tryQuote)}`;
    const res = await fetchNseWithTimeout(
      url,
      {
        headers: {
          "User-Agent": NSE_UA,
          Accept: "application/json",
          Referer: `${NSE_BASE}/get-quotes/equity?symbol=${encodeURIComponent(tryQuote)}`,
        },
      },
      8000,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const info = data?.info || {};
    const meta = data?.metadata || {};
    const ind = data?.industryInfo || {};
    if (!info.isin && !meta.symbol) return null;
    // If the caller passed an ISIN, sanity-check it matches — otherwise we
    // resolved the wrong ticker (autocomplete picked a different company).
    if (isin && info.isin && info.isin.toUpperCase() !== String(isin).toUpperCase()) {
      return null;
    }
    return {
      symbol: `${meta.symbol || tryQuote}.NS`,
      isin: info.isin || null,
      name: info.companyName || meta.symbol || tryQuote,
      sector: ind.sector || meta.industry || null,
      industry: ind.industry || meta.industry || null,
      source: "nse-live",
    };
  } catch {
    return null;
  }
}

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

  const value = indexRow.lastPrice ?? data.metadata?.last;
  const prevClose = indexRow.previousClose;
  // The index summary row's `change` field is intraday-from-open, not
  // from-prev-close. Recompute from previousClose so the ticker matches
  // what every other platform shows (prev-close basis).
  const change =
    prevClose != null && value != null
      ? value - prevClose
      : (data.metadata?.change ?? indexRow.change);
  const pChange =
    prevClose != null && value != null && prevClose !== 0
      ? ((value - prevClose) / prevClose) * 100
      : (data.metadata?.percentChange ?? indexRow.pChange);

  return {
    indexData: {
      name: "NIFTY 50",
      value,
      change,
      pChange,
      open: indexRow.open,
      dayHigh: indexRow.dayHigh,
      dayLow: indexRow.dayLow,
      previousClose: prevClose,
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
  const bnValue = indexRow.lastPrice ?? data.metadata?.last;
  const bnPrevClose = indexRow.previousClose;
  const bnChange =
    bnPrevClose != null && bnValue != null
      ? bnValue - bnPrevClose
      : (data.metadata?.change ?? indexRow.change);
  const bnPChange =
    bnPrevClose != null && bnValue != null && bnPrevClose !== 0
      ? ((bnValue - bnPrevClose) / bnPrevClose) * 100
      : (data.metadata?.percentChange ?? indexRow.pChange);
  return {
    indexData: {
      name: "BANK NIFTY",
      value: bnValue,
      change: bnChange,
      pChange: bnPChange,
      previousClose: bnPrevClose,
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
function formatNseDateParam(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const dd = String(value.getDate()).padStart(2, "0");
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const yyyy = String(value.getFullYear());
    return `${dd}-${mm}-${yyyy}`;
  }
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  const nse = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (nse) return raw;
  return null;
}

export async function fetchNseEventCalendar(opts = {}) {
  const params = new URLSearchParams();
  if (opts.index) params.set("index", String(opts.index));
  const fromDate = formatNseDateParam(opts.fromDate);
  const toDate = formatNseDateParam(opts.toDate);
  if (fromDate) params.set("from_date", fromDate);
  if (toDate) params.set("to_date", toDate);
  const query = params.toString();
  const data = await nseGet(`/api/event-calendar${query ? `?${query}` : ""}`);
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
