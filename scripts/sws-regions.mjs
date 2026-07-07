// Region registry for the SWS picks pipeline.
//
// Every region-varying fact lives here: the SWS sitemap region, exchange tokens,
// the canonical ticker-key rule, currency, market-cap gates, data namespace,
// route/tab ids, and browser-profile prefix. Pure data + pure helpers — NO I/O,
// no Playwright import — so it is safe to import from scripts, services, the
// server, and tests alike.
//
// The `in` (India) and `us` pipelines each have their own fork (data/sws,
// data/sws-us) and are NOT registry-driven. These two entries are consumed only
// by the shared market-fundamentals + config helpers (getRegion/makeRegionConfig);
// they are kept for completeness and a future migration — do not assume India's
// tokens are exhaustive.

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
