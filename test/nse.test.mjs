/**
 * Unit tests for nse.js — the NSE India API client.
 *
 * nse.js is 678 LOC of network code (cookie dance, multi-attempt fallback,
 * progressive-suffix autocomplete, GIFT Nifty futures parsing) with no prior
 * test coverage. Per CLAUDE.md nse.js:76-83, this module is THE local-only
 * scraper that backs catalysts / earnings refreshes because Vercel IPs are
 * blocked from NSE's cookie source.
 *
 * Strategy: this test file MUST NOT hit live NSE — that would flake on
 * rate limits in CI and defeat the point. Instead we stub globalThis.fetch
 * with a deterministic fake that records each URL, returns a canned
 * Response, and lets us assert both the request shape and the parsing
 * logic. No network calls are made.
 *
 * Coverage:
 *   • nseGet — happy path (no cookies needed), 404 short-circuit,
 *     401/403 triggers cookie fallback then succeeds
 *   • nseGetUnauthed — happy path, network throw returns null,
 *     non-OK status returns null
 *   • fetchNseIndex / fetchNifty50 — index row split + mapNseStock shape
 *   • fetchNseEventCalendar — array shape, numeric-keyed object shape,
 *     filtering invalid rows, uppercasing symbol
 *   • fetchGiftNifty — picks nearest non-expired NIFTY FUTIDX contract,
 *     rejects rows that aren't NIFTY FUTIDX, returns null on no rows
 *   • resolveNseStockLive — null inputs short-circuit, plausible-ticker
 *     direct quote, name → autocomplete fallback, ISIN-mismatch rejects
 *
 * Run with: node test/nse.test.mjs
 */

import {
  nseGet,
  nseGetUnauthed,
  resolveNseStockLive,
  fetchNseIndex,
  fetchNifty50,
  fetchNseEventCalendar,
  fetchGiftNifty,
} from "../nse.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

// ──────────────────── fetch stub harness ────────────────────

const realFetch = globalThis.fetch;

/**
 * Replace globalThis.fetch with a deterministic handler.
 * handler(url, options) → { status, body, throwError? }
 *   body is JSON-serialised (or returned raw for the homepage HTML hit)
 *   throwError causes the fetch to reject (simulates network failure)
 */
let calls = [];

function installFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    const result = handler(String(url), options) || {};
    if (result.throwError) throw result.throwError;
    const status = result.status ?? 200;
    const ok = status >= 200 && status < 300;
    const bodyText =
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body ?? {});
    return {
      ok,
      status,
      json: async () => (typeof result.body === "string" ? JSON.parse(bodyText) : result.body),
      text: async () => bodyText,
      headers: {
        getSetCookie: () => result.setCookies || [],
      },
    };
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

// Hard kill-switch: if any test accidentally lets a fetch through, blow up
// loudly rather than silently hitting NSE. (Belt-and-braces; installFetch
// is called before every test.)
globalThis.fetch = async () => {
  throw new Error("Test attempted to hit network — install a fetch stub first");
};

// ──────────────────── nseGetUnauthed ────────────────────

console.log("\nnseGetUnauthed()");

{
  installFetch(() => ({ body: { ok: true, payload: [1, 2, 3] } }));
  const out = await nseGetUnauthed("/api/fiidiiTradeReact");
  assert("returns parsed JSON on 200", out && out.ok === true, out);
  assert("issues exactly one fetch", calls.length === 1, calls.length);
  assert(
    "hits the NSE base URL with the supplied path",
    calls[0].url === "https://www.nseindia.com/api/fiidiiTradeReact",
    calls[0].url,
  );
  assert(
    "sends a browser User-Agent",
    String(calls[0].headers["User-Agent"] || "").includes("Mozilla/5.0"),
    calls[0].headers["User-Agent"],
  );
}

{
  installFetch(() => ({ status: 503, body: { error: "down" } }));
  const out = await nseGetUnauthed("/api/foo");
  assert("returns null on non-OK status (503)", out === null, out);
}

{
  installFetch(() => ({ throwError: new Error("ECONNRESET") }));
  const out = await nseGetUnauthed("/api/foo");
  assert("returns null when fetch throws", out === null, out);
}

// ──────────────────── nseGet — unauth-first then cookie fallback ────────────────────

console.log("\nnseGet()");

{
  installFetch(() => ({ body: { data: [{ symbol: "OK" }] } }));
  const out = await nseGet("/api/equity-stockIndices?index=NIFTY%2050");
  assert("happy path returns parsed JSON", out && out.data?.[0]?.symbol === "OK", out);
  assert("issues exactly one fetch (no cookie dance)", calls.length === 1, calls.length);
  assert(
    "does NOT send a Cookie header on the first attempt",
    !("Cookie" in calls[0].headers),
    calls[0].headers,
  );
}

{
  // 404 must NOT trigger the cookie dance — it's a real upstream error.
  installFetch(() => ({ status: 404, body: { error: "not found" } }));
  const out = await nseGet("/api/no-such-path");
  assert("returns null on 404", out === null, out);
  assert("does NOT retry with cookies on 404", calls.length === 1, calls.length);
}

{
  // 403 on first call → homepage hit for cookies → retry with cookies → 200.
  // NB: refreshCookies hits NSE_BASE = "https://www.nseindia.com" (no trailing
  // slash) — match without one.
  let n = 0;
  installFetch((url, options) => {
    n++;
    if (url === "https://www.nseindia.com") {
      return {
        body: "<html>ok</html>",
        setCookies: ["nsit=abc123; Path=/; HttpOnly", "nseappid=xyz; Path=/"],
      };
    }
    // First API call: 403. Cookie-gated API call (carries Cookie header): 200.
    if (!("Cookie" in (options.headers || {}))) return { status: 403, body: {} };
    return { body: { data: [{ symbol: "RECOVERED" }] } };
  });
  const out = await nseGet("/api/protected-thing");
  assert("403 then cookie-gated retry yields the JSON", out && out.data[0].symbol === "RECOVERED", out);
  assert("made >= 3 calls (api, homepage, api-with-cookie)", calls.length >= 3, calls.length);
  const cookieCall = calls.find((c) => "Cookie" in c.headers);
  assert(
    "second API call carries the Cookie header built from setCookies",
    cookieCall && /nsit=abc123/.test(cookieCall.headers.Cookie) && /nseappid=xyz/.test(cookieCall.headers.Cookie),
    cookieCall?.headers?.Cookie,
  );
}

// ──────────────────── fetchNseIndex + mapNseStock shape ────────────────────

console.log("\nfetchNseIndex() / mapNseStock()");

{
  installFetch(() => ({
    body: {
      data: [
        { symbol: "NIFTY 50", lastPrice: 22000, change: 100, pChange: 0.45 },
        {
          symbol: "RELIANCE",
          lastPrice: 2900,
          change: 12,
          pChange: 0.4,
          open: 2890,
          dayHigh: 2910,
          dayLow: 2880,
          previousClose: 2888,
          totalTradedVolume: 1234567,
          totalTradedValue: 9876543210,
          yearHigh: 3200,
          yearLow: 2300,
          perChange365d: 25.5,
          perChange30d: 1.2,
          meta: { companyName: "Reliance Industries Ltd", industry: "Refineries" },
        },
      ],
      timestamp: "12-MAY-2026 15:30:00",
    },
  }));

  const out = await fetchNseIndex("NIFTY 50");
  assert("returns an object with stocks[]", out && Array.isArray(out.stocks), out);
  assert("filters out the index row (NIFTY 50)", out.stocks.length === 1, out.stocks.length);

  const r = out.stocks[0];
  assert("symbol gets .NS suffix", r.symbol === "RELIANCE.NS", r.symbol);
  assert("name comes from meta.companyName", r.name === "Reliance Industries Ltd", r.name);
  assert("sector mirrors meta.industry", r.sector === "Refineries", r.sector);
  assert("industry mirrors meta.industry", r.industry === "Refineries", r.industry);
  assert("preserves lastPrice", r.lastPrice === 2900, r.lastPrice);
  assert("preserves totalTradedVolume", r.totalTradedVolume === 1234567, r.totalTradedVolume);
  assert("preserves perChange365d", r.perChange365d === 25.5, r.perChange365d);
  assert("source is 'nse'", r.source === "nse", r.source);
  assert("timestamp propagates from upstream", out.timestamp === "12-MAY-2026 15:30:00", out.timestamp);
}

{
  // Falsy/empty NSE response → null
  installFetch(() => ({ body: { somethingElse: true } }));
  const out = await fetchNseIndex("NIFTY 50");
  assert("returns null when response has no .data", out === null, out);
}

{
  // fetchNifty50 — verify it splits indexData + stocks correctly
  installFetch(() => ({
    body: {
      data: [
        {
          symbol: "NIFTY 50",
          lastPrice: 22500,
          change: 150,
          pChange: 0.67,
          open: 22400,
          dayHigh: 22550,
          dayLow: 22380,
          previousClose: 22350,
          yearHigh: 23000,
          yearLow: 19000,
        },
        { symbol: "HDFCBANK", lastPrice: 1500, change: 5, pChange: 0.33 },
      ],
      timestamp: "ts",
    },
  }));
  const out = await fetchNifty50();
  assert("Nifty 50 indexData.value pulled from index row", out.indexData.value === 22500, out.indexData);
  assert("Nifty 50 stocks excludes the index row", out.stocks.length === 1 && out.stocks[0].symbol === "HDFCBANK.NS", out.stocks);
  assert("yearHigh propagates onto indexData", out.indexData.yearHigh === 23000, out.indexData.yearHigh);
}

// ──────────────────── fetchNseEventCalendar ────────────────────

console.log("\nfetchNseEventCalendar()");

{
  installFetch(() => ({
    body: [
      { symbol: "tcs", company: "Tata Consultancy Services", purpose: "Financial Results", date: "16-May-2026", bm_desc: "Q4 results" },
      { symbol: "INFY", company: "Infosys", purpose: "Dividend", date: "20-May-2026" },
      // Invalid rows — should be filtered out:
      { company: "no-symbol" },
      null,
      { symbol: "X" /* missing date */ },
      "string-row",
    ],
  }));
  const out = await fetchNseEventCalendar();
  assert("returns an array", Array.isArray(out), out);
  assert("keeps only rows with both symbol and date", out.length === 2, out.length);
  assert("uppercases symbol", out[0].symbol === "TCS", out[0].symbol);
  assert("maps bm_desc → description", out[0].description === "Q4 results", out[0].description);
  assert("preserves purpose verbatim", out[1].purpose === "Dividend", out[1].purpose);
}

{
  // NSE sometimes returns an object with numeric keys instead of a JSON array
  installFetch(() => ({
    body: {
      0: { symbol: "tcs", company: "TCS", purpose: "Board Meeting", date: "16-May-2026" },
      1: { symbol: "infy", company: "Infosys", purpose: "Dividend", date: "20-May-2026" },
    },
  }));
  const out = await fetchNseEventCalendar();
  assert("normalises numeric-keyed object to array", out.length === 2, out.length);
  assert("first symbol uppercased", out[0].symbol === "TCS", out[0].symbol);
}

{
  installFetch(() => ({ status: 500, body: { error: "down" } }));
  const out = await fetchNseEventCalendar();
  assert("returns [] when upstream fails (no .data)", Array.isArray(out) && out.length === 0, out);
}

{
  installFetch(() => ({
    body: [
      { symbol: "TCS", company: "Tata Consultancy Services", purpose: "Financial Results", date: "16-May-2026" },
    ],
  }));
  const out = await fetchNseEventCalendar({
    index: "equities",
    fromDate: "2026-05-25",
    toDate: "2026-07-24",
  });
  assert("date-range call still parses rows", out.length === 1 && out[0].symbol === "TCS", out);
  const url = new URL(calls[0].url);
  assert("date-range call hits event-calendar", url.pathname === "/api/event-calendar", calls[0].url);
  assert("date-range call sends index=equities", url.searchParams.get("index") === "equities", calls[0].url);
  assert("date-range call sends NSE from_date", url.searchParams.get("from_date") === "25-05-2026", calls[0].url);
  assert("date-range call sends NSE to_date", url.searchParams.get("to_date") === "24-07-2026", calls[0].url);
}

// ──────────────────── fetchGiftNifty ────────────────────

console.log("\nfetchGiftNifty()");

{
  // Pick the nearest non-expired NIFTY FUTIDX contract from a multi-block payload.
  // Use real future dates so the test isn't time-bombed.
  const now = new Date();
  const inOneMonth = new Date(now.getFullYear(), now.getMonth() + 1, 28);
  const inTwoMonths = new Date(now.getFullYear(), now.getMonth() + 2, 28);
  const monthName = (d) => ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
  const fmt = (d) => `${String(d.getDate()).padStart(2,"0")}-${monthName(d)}-${d.getFullYear()}`;

  installFetch(() => ({
    body: {
      MBP_data_Market_Watch: [
        {
          token_data: [
            // Wrong instrument type — should be filtered out
            { SYMBOL: "NIFTY", INSTRUMENTTYPE: "OPTIDX", EXPIRYDATE: fmt(inOneMonth), LASTPRICE: 99999 },
            // Different symbol — should be filtered out
            { SYMBOL: "BANKNIFTY", INSTRUMENTTYPE: "FUTIDX", EXPIRYDATE: fmt(inOneMonth), LASTPRICE: 88888 },
          ],
        },
        {
          token_data: [
            // Two valid contracts — should pick the nearer one
            {
              SYMBOL: "NIFTY",
              INSTRUMENTTYPE: "FUTIDX",
              EXPIRYDATE: fmt(inTwoMonths),
              LASTPRICE: 22500,
              CHANGE: 50,
              PERCHANGE: 0.22,
              OPEN: 22480,
              HIGH: 22550,
              LOW: 22460,
              CLOSE: 22450,
              VOLUME: 12345,
              LTT: "21-Apr-2026 02:18:17",
            },
            {
              SYMBOL: "NIFTY",
              INSTRUMENTTYPE: "FUTIDX",
              EXPIRYDATE: fmt(inOneMonth),
              LASTPRICE: 22600,
              CHANGE: 100,
              PERCHANGE: 0.44,
              OPEN: 22500,
              HIGH: 22650,
              LOW: 22480,
              CLOSE: 22500,
              VOLUME: 99999,
              LTT: "22-Apr-2026 03:00:00",
            },
          ],
        },
      ],
    },
  }));

  const out = await fetchGiftNifty();
  assert("returns an object on success", out && typeof out === "object", out);
  assert("picks the nearest expiry (inOneMonth)", out && out.price === 22600, out?.price);
  assert("symbol is GIFTNIFTY", out?.symbol === "GIFTNIFTY", out?.symbol);
  assert("propagates LTT raw", out?.lastTradedAt === "22-Apr-2026 03:00:00", out?.lastTradedAt);
  assert("source is 'nseix'", out?.source === "nseix", out?.source);
  assert("previousClose comes from CLOSE field", out?.previousClose === 22500, out?.previousClose);
  assert(
    "hits the nseix streamer URL",
    calls[0].url === "https://www.nseix.com/api/streamer-market-watch/",
    calls[0].url,
  );
}

{
  // No NIFTY FUTIDX rows at all → null
  installFetch(() => ({
    body: {
      MBP_data_Market_Watch: [
        { token_data: [{ SYMBOL: "BANKNIFTY", INSTRUMENTTYPE: "FUTIDX", EXPIRYDATE: "30-Dec-2099", LASTPRICE: 1 }] },
      ],
    },
  }));
  const out = await fetchGiftNifty();
  assert("returns null when no NIFTY FUTIDX contracts present", out === null, out);
}

{
  // Malformed payload → null (no MBP_data_Market_Watch array)
  installFetch(() => ({ body: { wrong: "shape" } }));
  const out = await fetchGiftNifty();
  assert("returns null on malformed payload", out === null, out);
}

// ──────────────────── resolveNseStockLive ────────────────────

console.log("\nresolveNseStockLive()");

{
  installFetch(() => {
    throw new Error("should not be called");
  });
  const out = await resolveNseStockLive({});
  assert("null inputs short-circuit to null (no fetch)", out === null, out);
}

{
  // Plausible ticker → goes straight to quote-equity, skips autocomplete.
  installFetch((url) => {
    if (url.includes("/api/quote-equity?symbol=RELIANCE")) {
      return {
        body: {
          info: { isin: "INE002A01018", companyName: "Reliance Industries Ltd", industry: "Refineries" },
          metadata: { symbol: "RELIANCE", industry: "Refineries" },
          industryInfo: { sector: "Energy", industry: "Refineries" },
        },
      };
    }
    return { body: {} };
  });
  const out = await resolveNseStockLive({ symbol: "RELIANCE.NS" });
  assert("ticker → resolves with .NS suffix", out && out.symbol === "RELIANCE.NS", out);
  assert("propagates ISIN", out && out.isin === "INE002A01018", out?.isin);
  assert("source tag is 'nse-live'", out && out.source === "nse-live", out?.source);
  assert(
    "does NOT call autocomplete (ticker path)",
    !calls.some((c) => c.url.includes("/api/search/autocomplete")),
    calls.map((c) => c.url),
  );
}

{
  // Name with a corporate suffix → autocomplete first (fails on full),
  // then fuzzy variant works → quote happy.
  installFetch((url) => {
    if (url.includes("/api/search/autocomplete")) {
      const q = decodeURIComponent(url.split("q=")[1] || "");
      if (q === "EASY TRIP PLANNERS LTD") {
        // NSE returns no symbols for the suffix-laden form (known fuzzy
        // gap documented in buildAutocompleteCandidates' jsdoc).
        return { body: { symbols: [] } };
      }
      if (q === "EASY TRIP PLANNERS") {
        return { body: { symbols: [{ symbol: "EASEMYTRIP" }] } };
      }
      return { body: { symbols: [] } };
    }
    if (url.includes("/api/quote-equity?symbol=EASEMYTRIP")) {
      return {
        body: {
          info: { isin: "INE07ZK01017", companyName: "Easy Trip Planners Ltd" },
          metadata: { symbol: "EASEMYTRIP", industry: "Travel" },
          industryInfo: { sector: "Services", industry: "Travel" },
        },
      };
    }
    return { body: {} };
  });

  const out = await resolveNseStockLive({ name: "EASY TRIP PLANNERS LTD" });
  assert("falls back through autocomplete variants", out && out.symbol === "EASEMYTRIP.NS", out);
  assert(
    "tried both the suffix-laden form AND the stripped form",
    calls.filter((c) => c.url.includes("autocomplete")).length >= 2,
    calls.filter((c) => c.url.includes("autocomplete")).length,
  );
}

{
  // ISIN mismatch — quote returns a DIFFERENT ISIN than the one supplied →
  // function refuses to map (caller's ISIN is the integrity check).
  installFetch((url) => {
    if (url.includes("/api/quote-equity?symbol=RELIANCE")) {
      return {
        body: {
          info: { isin: "INE002A01018", companyName: "Reliance" },
          metadata: { symbol: "RELIANCE" },
          industryInfo: {},
        },
      };
    }
    return { body: {} };
  });
  const out = await resolveNseStockLive({ symbol: "RELIANCE", isin: "INE999X99999" });
  assert("returns null when caller's ISIN doesn't match the quote's ISIN", out === null, out);
}

{
  // Long all-caps "symbol" that's actually a company name should NOT be
  // accepted as a ticker — the autocomplete fallback must kick in.
  installFetch((url) => {
    if (url.includes("/api/search/autocomplete")) {
      return { body: { symbols: [{ symbol: "FIBERWEB" }] } };
    }
    if (url.includes("/api/quote-equity?symbol=FIBERWEB")) {
      return {
        body: {
          info: { isin: "INE111", companyName: "Fiberweb (India) Ltd" },
          metadata: { symbol: "FIBERWEB" },
          industryInfo: {},
        },
      };
    }
    return { body: {} };
  });
  // 21 chars, way too long for the /^[A-Z0-9&-]{1,15}$/ ticker pattern
  const out = await resolveNseStockLive({ symbol: "FIBERWEBINDIALIMITED!" });
  assert("oversized 'symbol' is rejected as a ticker", out === null, out);
}

// ──────────────────── teardown ────────────────────

restoreFetch();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
