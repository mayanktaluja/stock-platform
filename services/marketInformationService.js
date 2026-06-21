import fs from "node:fs";
import path from "node:path";

export const MARKET_INFORMATION_SCHEMA_VERSION = "market-information-v1";
export const MARKET_INFORMATION_PATH = path.join(process.cwd(), "data", "marketInformation", "latest.json");
export const MARKET_INFORMATION_STALE_HOURS = 12;

const MATERIAL_KEYWORDS = [
  ["results", "Results or earnings update"],
  ["financial result", "Results or earnings update"],
  ["earnings", "Results or earnings update"],
  ["merger", "Corporate action"],
  ["acquisition", "Corporate action"],
  ["scheme of arrangement", "Corporate action"],
  ["buyback", "Capital return"],
  ["dividend", "Capital return"],
  ["bonus", "Capital return"],
  ["split", "Capital structure"],
  ["fund raising", "Capital raise"],
  ["fundraising", "Capital raise"],
  ["preferential", "Capital raise"],
  ["qualified institutional placement", "Capital raise"],
  ["qip", "Capital raise"],
  ["default", "Credit or compliance risk"],
  ["credit rating", "Credit or compliance risk"],
  ["rating", "Credit or compliance risk"],
  ["resignation", "Management change"],
  ["appointment", "Management change"],
  ["order", "Business update"],
  ["contract", "Business update"],
  ["litigation", "Legal or regulatory update"],
  ["investigation", "Legal or regulatory update"],
];

const RESULT_KEYWORDS = ["result", "earnings", "dividend", "buyback", "bonus", "split"];

function isoNow() {
  return new Date().toISOString();
}

function minutesBetween(later, earlier) {
  const a = new Date(later).getTime();
  const b = new Date(earlier).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((a - b) / 60_000));
}

function normaliseTicker(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw
    .replace(/^(NSE|BSE|NASDAQ|NYSE|NYSEMKT|AMEX):/i, "")
    .replace(/\.(NS|BO|NSE|BSE)$/i, "")
    .toUpperCase();
}

function normaliseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normaliseTicker).filter(Boolean);
  return String(value)
    .split(",")
    .map(normaliseTicker)
    .filter(Boolean);
}

function lowerText(item) {
  return [item?.category, item?.title, item?.summary, item?.raw_type]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function classifyMarketInformationItem(item = {}) {
  const text = lowerText(item);
  const matched = MATERIAL_KEYWORDS.find(([keyword]) => text.includes(keyword));
  const sentiment = String(item.sentiment || "").toLowerCase();
  const materiality =
    sentiment === "negative" || matched
      ? "high"
      : text.includes("update") || text.includes("announcement")
        ? "medium"
        : "low";
  return {
    materiality,
    why_it_matters:
      matched?.[1] ||
      (sentiment === "negative" ? "Negative sentiment flag" : "Fresh exchange filing"),
  };
}

function decorateItem(item, { generatedAt, now = isoNow(), portfolioTickers = [], watchlistTickers = [] } = {}) {
  const ticker = normaliseTicker(item?.ticker);
  const classification = classifyMarketInformationItem(item);
  const portfolioSet = new Set(portfolioTickers.map(normaliseTicker).filter(Boolean));
  const watchlistSet = new Set(watchlistTickers.map(normaliseTicker).filter(Boolean));
  return {
    ...item,
    ticker,
    materiality: classification.materiality,
    why_it_matters: classification.why_it_matters,
    provider_lag_minutes: item?.published_at ? minutesBetween(generatedAt, item.published_at) : null,
    age_minutes: item?.published_at ? minutesBetween(now, item.published_at) : null,
    in_portfolio: ticker ? portfolioSet.has(ticker) : false,
    in_watchlist: ticker ? watchlistSet.has(ticker) : false,
  };
}

function sortNewest(items) {
  return [...items].sort((a, b) => {
    const bt = new Date(b.published_at || 0).getTime() || 0;
    const at = new Date(a.published_at || 0).getTime() || 0;
    return bt - at;
  });
}

function matchesQuery(item, query = {}) {
  const tickers = normaliseList(query.ticker || query.q || query.search);
  if (tickers.length) {
    const haystack = [item.ticker, item.company_name, item.title]
      .filter(Boolean)
      .join(" ")
      .toUpperCase();
    if (!tickers.some((ticker) => haystack.includes(ticker))) return false;
  }
  if (query.sentiment && String(query.sentiment) !== "all") {
    if (String(item.sentiment || "neutral") !== String(query.sentiment)) return false;
  }
  if (query.category && String(query.category) !== "all") {
    const needle = String(query.category).toLowerCase();
    if (!String(item.category || "").toLowerCase().includes(needle)) return false;
  }
  const source = String(query.source || "all").toLowerCase();
  if (source !== "all" && String(item.source_market || "").toLowerCase() !== source) return false;
  const scope = String(query.scope || "all").toLowerCase();
  if (scope === "portfolio" && !item.in_portfolio) return false;
  if (scope === "watchlist" && !item.in_watchlist) return false;
  return true;
}

function buildSections(items) {
  const newest = sortNewest(items);
  return {
    breaking_filings: newest.slice(0, 30),
    portfolio_watchlist: newest.filter((item) => item.in_portfolio || item.in_watchlist).slice(0, 30),
    negative_or_material: newest
      .filter((item) => item.sentiment === "negative" || item.materiality === "high")
      .slice(0, 30),
    results_earnings: newest
      .filter((item) => RESULT_KEYWORDS.some((keyword) => lowerText(item).includes(keyword)))
      .slice(0, 30),
    us_sec_filings: newest.filter((item) => item.source_market === "us").slice(0, 30),
  };
}

function extractTickers(value, out = new Set()) {
  if (!value) return out;
  if (typeof value === "string") {
    const ticker = normaliseTicker(value);
    if (ticker && /^[A-Z0-9&.-]{2,16}$/.test(ticker)) out.add(ticker);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractTickers(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const key of ["ticker", "symbol", "scrip", "nseSymbol", "bseSymbol"]) {
      extractTickers(value[key], out);
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") extractTickers(child, out);
    }
  }
  return out;
}

export function loadMarketInformationContext({
  cwd = process.cwd(),
  portfolioPath = path.join(cwd, "portfolio.json"),
  watchlistPath = path.join(cwd, ".watchlist.json"),
} = {}) {
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  };
  return {
    portfolioTickers: [...extractTickers(read(portfolioPath))],
    watchlistTickers: [...extractTickers(read(watchlistPath))],
  };
}

export function buildMarketInformationSnapshot({
  items = [],
  generatedAt = isoNow(),
  sourceHealth = {},
  requested = {},
} = {}) {
  const normalisedItems = sortNewest(items);
  return {
    schema_version: MARKET_INFORMATION_SCHEMA_VERSION,
    generated_at: generatedAt,
    provider: "stockinsights",
    mode: "manual_cached",
    requested,
    source_health: sourceHealth,
    items: normalisedItems,
    stats: {
      total: normalisedItems.length,
      india: normalisedItems.filter((item) => item.source_market === "india").length,
      us: normalisedItems.filter((item) => item.source_market === "us").length,
      negative: normalisedItems.filter((item) => item.sentiment === "negative").length,
    },
  };
}

export function computeMarketInformationRuntimeAudit(snapshot, { now = isoNow() } = {}) {
  const generatedAt = snapshot?.generated_at || null;
  const ageHours = generatedAt
    ? (new Date(now).getTime() - new Date(generatedAt).getTime()) / 3_600_000
    : null;
  return {
    generated_at: generatedAt,
    age_hours: Number.isFinite(ageHours) ? ageHours : null,
    stale: !Number.isFinite(ageHours) || ageHours > MARKET_INFORMATION_STALE_HOURS,
    stale_threshold_hours: MARKET_INFORMATION_STALE_HOURS,
    provider: snapshot?.provider || "stockinsights",
    mode: snapshot?.mode || "manual_cached",
  };
}

export function buildMarketInformationPayload(
  snapshot,
  {
    query = {},
    portfolioTickers = [],
    watchlistTickers = [],
    now = isoNow(),
  } = {},
) {
  const generatedAt = snapshot?.generated_at || now;
  const decorated = (Array.isArray(snapshot?.items) ? snapshot.items : [])
    .map((item) => decorateItem(item, { generatedAt, now, portfolioTickers, watchlistTickers }))
    .filter((item) => matchesQuery(item, query));
  const sections = buildSections(decorated);
  return {
    schema_version: MARKET_INFORMATION_SCHEMA_VERSION,
    title: "Market Radar",
    description: "Fast market-moving filings and announcements. Informational evidence only, not a recommendation.",
    generated_at: generatedAt,
    runtime_audit: computeMarketInformationRuntimeAudit(snapshot, { now }),
    filters: {
      ticker: query.ticker || query.q || query.search || null,
      sentiment: query.sentiment || "all",
      category: query.category || "all",
      source: query.source || "all",
      scope: query.scope || "all",
    },
    stats: {
      total: decorated.length,
      negative: decorated.filter((item) => item.sentiment === "negative").length,
      material: decorated.filter((item) => item.materiality === "high").length,
      portfolio_watchlist: sections.portfolio_watchlist.length,
      us_sec_filings: sections.us_sec_filings.length,
    },
    sections,
    caveats: [
      "StockInsights is used as an informational filing feed only.",
      "This feed does not update SWS scores, action ladders, or portfolio recommendations.",
      "Refreshes are manual and cached while the integration is experimental.",
    ],
  };
}

export function loadMarketInformationSnapshot(file = MARKET_INFORMATION_PATH) {
  try {
    return { ok: true, snapshot: JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: false, status: 503, error: "market-information-latest not yet generated" };
    }
    return { ok: false, status: 500, error: "failed to load market-information-latest" };
  }
}

export function writeMarketInformationSnapshot(snapshot, file = MARKET_INFORMATION_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}
