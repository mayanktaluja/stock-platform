// Region registry for the SWS picks pipeline.
//
// Every region-varying fact lives here: the SWS sitemap region, exchange tokens,
// the canonical ticker-key rule, currency, market-cap gates, data namespace,
// route/tab ids, and browser-profile prefix. Pure data + pure helpers — NO I/O,
// no Playwright import — so it is safe to import from scripts, services, the
// server, and tests alike.
//
// The generic region pipeline (sws-*-region.mjs, services/regionPicksDal.js,
// the server route factory, the gated/app.js render path) is driven entirely by
// the "kr" and "tw" entries below. The "in" (India) and "us" pipelines are NOT
// registry-driven yet — their entries are documented here for completeness and a
// future migration; do not assume India's tokens are exhaustive.

export const REGIONS = {
  // ── India (reference only — the India pipeline is its own fork, NOT consumed here) ──
  in: {
    code: "in",
    label: "India",
    sitemapRegion: "as-asia",
    sitemapShardCount: 12,
    sitemapShardUrl: (i) => `https://simplywall.st/sitemap/companies/as-asia/${i}.xml`,
    urlHasSharesSuffix: true,
    exchangeTokens: ["nse", "bse"], // approximate; India build is not registry-driven
    excludedExchangeTokens: [],
    exchangePriority: { nse: 1, bse: 2 },
    tickerKey: (exch, id) => id.toUpperCase(),
    currencyIso: "INR",
    currencySymbol: "₹",
    currencyDecimals: 2,
    locale: "en-IN",
    timezone: "Asia/Kolkata",
    mcapFloorNative: 2_000_000_000,
    smallcapCeilingNative: 50_000_000_000,
    dataDir: "data/sws",
    profilePrefix: ".sws-profile",
    routePrefix: "sws",
    tabId: "picksTab",
    domPrefix: "picks",
    applyBseFilter: true,
    surveillanceEnabled: true,
    nseCalendar: true,
    avoidSection: false,
  },

  // ── US (reference only — the US pipeline is the -us fork, NOT consumed here) ──
  us: {
    code: "us",
    label: "US",
    sitemapRegion: "na-north-america",
    sitemapShardCount: 7,
    sitemapShardUrl: (i) => `https://simplywall.st/sitemap/companies/na-north-america/${i}.xml`,
    urlHasSharesSuffix: false, // US URLs have NO -shares suffix
    exchangeTokens: ["nasdaq", "nyse", "nysemkt"],
    excludedExchangeTokens: ["otc"], // OTC pink shells excluded by default
    exchangePriority: { nasdaq: 1, nyse: 2, nysemkt: 3, otc: 4 },
    tickerKey: (exch, id) => id.toUpperCase(), // BRK.B keeps its dot
    currencyIso: "USD",
    currencySymbol: "$",
    currencyDecimals: 2,
    locale: "en-US",
    timezone: "America/New_York",
    mcapFloorNative: 50_000_000,
    smallcapCeilingNative: 2_000_000_000,
    dataDir: "data/sws-us",
    profilePrefix: ".sws-profile-us",
    routePrefix: "us",
    tabId: "usPicksTab",
    domPrefix: "usPicks",
    applyBseFilter: false,
    surveillanceEnabled: false,
    nseCalendar: false,
    avoidSection: false,
  },

  // ── Korea (KRX: KOSPI + KOSDAQ) ──
  kr: {
    code: "kr",
    label: "Korea",
    sitemapRegion: "as-asia", // KR lives in the same sitemap region as India
    sitemapShardCount: 12,
    sitemapShardUrl: (i) => `https://simplywall.st/sitemap/companies/as-asia/${i}.xml`,
    urlHasSharesSuffix: true, // KR carries the -shares suffix (like India)
    exchangeTokens: ["kose", "kosdaq"], // KOSPI + KOSDAQ
    // KONEX (xkon) is the illiquid startup board — excluded by default (analogous
    // to US OTC). The builder still MATCHES it so the count is logged; pass
    // --include-konex to promote it.
    excludedExchangeTokens: ["xkon"],
    exchangePriority: { kose: 1, kosdaq: 2, xkon: 3 },
    // SWS short ids are 'a'-prefixed (kose-a005930 → real ticker 005930). Strip the
    // single leading 'a' and append a market suffix so the key is never pure-numeric
    // (KOSPI .KS, KOSDAQ .KQ, KONEX .KN — Yahoo-style).
    tickerKey: (exch, id) => {
      const bare = String(id).replace(/^a/i, "");
      const suffix = exch === "kosdaq" ? ".KQ" : exch === "xkon" ? ".KN" : ".KS";
      return `${bare}${suffix}`;
    },
    currencyIso: "KRW",
    currencySymbol: "₩",
    currencyDecimals: 0, // KRW is conventionally shown with no decimals
    locale: "ko-KR",
    timezone: "Asia/Seoul",
    mcapFloorNative: 50_000_000_000, // ₩50B ≈ $36M — TUNE-AT-SEED
    smallcapCeilingNative: 2_000_000_000_000, // ₩2T ≈ $1.4B — TUNE-AT-SEED
    dataDir: "data/sws-kr",
    profilePrefix: ".sws-profile-kr",
    routePrefix: "kr",
    tabId: "krPicksTab",
    domPrefix: "krPicks",
    applyBseFilter: false,
    surveillanceEnabled: false,
    nseCalendar: false,
    avoidSection: false,
    expectedTotalApprox: 2760,
  },

  // ── Taiwan (TWSE + TPEx) ──
  tw: {
    code: "tw",
    label: "Taiwan",
    sitemapRegion: "as-asia",
    sitemapShardCount: 12,
    sitemapShardUrl: (i) => `https://simplywall.st/sitemap/companies/as-asia/${i}.xml`,
    urlHasSharesSuffix: true,
    exchangeTokens: ["twse", "tpex"], // main board + Taipei Exchange
    excludedExchangeTokens: [],
    exchangePriority: { twse: 1, tpex: 2 },
    // TW short ids are bare numeric (twse-2330 → 2330). Append a market suffix so
    // the key is never pure-numeric (TWSE .TW, TPEx .TWO — Yahoo-style).
    tickerKey: (exch, id) => `${id}${exch === "tpex" ? ".TWO" : ".TW"}`,
    currencyIso: "TWD",
    currencySymbol: "NT$",
    currencyDecimals: 2,
    locale: "zh-TW",
    timezone: "Asia/Taipei",
    mcapFloorNative: 1_000_000_000, // NT$1B ≈ $31M — TUNE-AT-SEED
    smallcapCeilingNative: 60_000_000_000, // NT$60B ≈ $1.9B — TUNE-AT-SEED
    dataDir: "data/sws-tw",
    profilePrefix: ".sws-profile-tw",
    routePrefix: "tw",
    tabId: "twPicksTab",
    domPrefix: "twPicks",
    applyBseFilter: false,
    surveillanceEnabled: false,
    nseCalendar: false,
    avoidSection: false,
    expectedTotalApprox: 2339,
  },
};

export function getRegion(code) {
  const r = REGIONS[String(code || "").toLowerCase()];
  if (!r) {
    throw new Error(`Unknown region code: ${code}. Known: ${Object.keys(REGIONS).join(", ")}`);
  }
  return r;
}

// Build the sitemap-matching regex for a region. Captures:
//   [1] sector slug   [2] exchange token   [3] SWS short id   [4] company slug
// The exchange alternation includes the EXCLUDED tokens too (KONEX, OTC) so the
// universe builder can see + count them before filtering — the regex never
// silently drops an exchange. KR/TW carry a -shares suffix; the `</loc>`
// lookahead drops sub-tab (…/valuation) and hreflang (…-shares"/>) variants that
// would otherwise double-match.
export function sitemapRegex(region) {
  const toks = region.exchangeTokens.concat(region.excludedExchangeTokens || []).join("|");
  const tail = region.urlHasSharesSuffix ? "-shares(?=<\\/loc>)" : "(?=<\\/loc>)";
  return new RegExp(
    `https:\\/\\/simplywall\\.st\\/stocks\\/${region.code}\\/([a-z0-9-]+)\\/(${toks})-([a-z0-9][a-z0-9.\\-]*)\\/([a-z0-9-]+)${tail}`,
    "g",
  );
}
