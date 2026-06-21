export const DEFAULT_STOCKINSIGHTS_BASE_URL = "https://stockinsights-ai-main-95a26a0.zuplo.app";
export const INDIA_ANNOUNCEMENTS_PATH = "/api/in/v0/documents/announcement";
export const DEFAULT_STOCKINSIGHTS_TIMEOUT_MS = 12_000;

export class StockInsightsApiError extends Error {
  constructor(message, { status = null, url = null, body = null } = {}) {
    super(message);
    this.name = "StockInsightsApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export function buildStockInsightsUrl({
  baseUrl = DEFAULT_STOCKINSIGHTS_BASE_URL,
  path = INDIA_ANNOUNCEMENTS_PATH,
  params = {},
} = {}) {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") {
          url.searchParams.append(key, String(item));
        }
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normaliseTicker(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw
    .replace(/^(NSE|BSE|NASDAQ|NYSE|NYSEMKT|AMEX):/i, "")
    .replace(/\.(NS|BO|NSE|BSE)$/i, "")
    .toUpperCase();
}

function normaliseSentiment(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (["bullish", "positive", "pos"].includes(raw)) return "positive";
  if (["bearish", "negative", "neg"].includes(raw)) return "negative";
  if (["mixed", "neutral", "none"].includes(raw)) return "neutral";
  return raw.replace(/[^a-z0-9_-]/g, "_");
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function stableHash(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim())
    .map((part) => String(part).trim().toLowerCase())
    .join("|");
}

export function normalizeStockInsightsRow(
  raw,
  { sourceMarket = "india", sourceKind = "corporate_announcement" } = {},
) {
  const insights = raw?.ai_insights || raw?.aiInsights || {};
  const ticker =
    normaliseTicker(raw?.ticker) ||
    normaliseTicker(raw?.symbol) ||
    normaliseTicker(raw?.exchange_ticker) ||
    normaliseTicker(Array.isArray(raw?.exchange_tickers) ? raw.exchange_tickers[0] : null);
  const providerId = firstString(raw?.id, raw?.document_id, raw?.filing_id, raw?.accession_no);
  const publishedAt = firstString(raw?.published_date, raw?.published_at, raw?.filing_date, raw?.date);
  const category = firstString(
    insights?.announcement_type,
    insights?.filing_type,
    raw?.announcement_type,
    raw?.form_type,
    raw?.filing_type,
    raw?.category,
    raw?.type,
  );
  const title = firstString(insights?.summary_header, raw?.title, raw?.headline, category);
  const summary = firstString(insights?.summary_text, raw?.summary, raw?.description, raw?.text);
  const sourceUrl = firstString(raw?.source_link, raw?.source_url, raw?.url, raw?.link);
  const stableId =
    providerId
      ? `stockinsights:${sourceMarket}:${providerId}`
      : `stockinsights:${sourceMarket}:${stableHash([ticker, publishedAt, title, sourceUrl])}`;

  return {
    stable_id: stableId,
    provider: "stockinsights",
    provider_id: providerId,
    source_market: sourceMarket,
    source_kind: sourceKind,
    ticker,
    company_name: firstString(raw?.company_name, raw?.company, raw?.issuer_name, raw?.issuer),
    exchange_tickers: Array.isArray(raw?.exchange_tickers)
      ? raw.exchange_tickers.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    category,
    category_id: firstString(insights?.announcement_type_id, raw?.announcement_type_id, raw?.category_id),
    sentiment: normaliseSentiment(raw?.sentiment ?? insights?.sentiment),
    title,
    summary,
    source_url: sourceUrl,
    published_at: publishedAt,
    sector: firstString(raw?.sector, insights?.sector),
    industry: firstString(raw?.industry, insights?.industry),
    raw_type: firstString(raw?.type, raw?.form_type, raw?.filing_type),
  };
}

export function dedupeStockInsightsItems(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item?.stable_id || stableHash([item?.ticker, item?.published_at, item?.title, item?.source_url]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function normalizeStockInsightsRows(rows = [], options = {}) {
  return dedupeStockInsightsItems(
    rows
      .map((row) => normalizeStockInsightsRow(row, options))
      .filter((item) => item.ticker || item.company_name || item.title || item.summary),
  );
}

export async function fetchStockInsightsPage({
  apiKey = process.env.STOCKINSIGHTS_API_KEY,
  baseUrl = process.env.STOCKINSIGHTS_BASE_URL || DEFAULT_STOCKINSIGHTS_BASE_URL,
  path = INDIA_ANNOUNCEMENTS_PATH,
  params = {},
  timeoutMs = Number(process.env.STOCKINSIGHTS_TIMEOUT_MS || DEFAULT_STOCKINSIGHTS_TIMEOUT_MS),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) {
    throw new StockInsightsApiError("STOCKINSIGHTS_API_KEY is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new StockInsightsApiError("fetch implementation is not available");
  }

  const url = buildStockInsightsUrl({ baseUrl, path, params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      throw new StockInsightsApiError(`StockInsights request failed with ${response.status}`, {
        status: response.status,
        url: url.toString(),
        body,
      });
    }
    return {
      url: url.toString(),
      body,
      rows: extractRows(body),
      meta: body?.meta || body?.pagination || {},
    };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new StockInsightsApiError("StockInsights request timed out", { url: url.toString() });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchIndiaAnnouncements({
  apiKey = process.env.STOCKINSIGHTS_API_KEY,
  baseUrl = process.env.STOCKINSIGHTS_BASE_URL || DEFAULT_STOCKINSIGHTS_BASE_URL,
  fromDate,
  toDate,
  ticker,
  sentiment,
  sector,
  industry,
  announcementTypeId,
  limit = 50,
  page = 1,
  maxPages = 1,
  timeoutMs,
  fetchImpl,
} = {}) {
  const cappedLimit = Math.min(50, Math.max(1, Number(limit) || 50));
  const pageCap = Math.max(1, Number(maxPages) || 1);
  const allRows = [];
  const pages = [];
  for (let currentPage = Number(page) || 1; currentPage < (Number(page) || 1) + pageCap; currentPage++) {
    const result = await fetchStockInsightsPage({
      apiKey,
      baseUrl,
      path: INDIA_ANNOUNCEMENTS_PATH,
      timeoutMs,
      fetchImpl,
      params: {
        from_date: fromDate,
        to_date: toDate,
        ticker,
        sentiment,
        sector,
        industry,
        announcement_type_id: announcementTypeId,
        limit: cappedLimit,
        page: currentPage,
      },
    });
    pages.push({ page: currentPage, url: result.url, rows: result.rows.length, meta: result.meta });
    allRows.push(...result.rows);
    if (result.rows.length < cappedLimit) break;
  }
  return {
    pages,
    rows: normalizeStockInsightsRows(allRows, {
      sourceMarket: "india",
      sourceKind: "corporate_announcement",
    }),
  };
}
