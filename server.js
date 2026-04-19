// Resolve the .env file relative to this file's location so the server works
// no matter what cwd it was launched from (e.g. some launchers invoke it as
// `node stock-platform/server.js` from the parent directory, which would
// otherwise make dotenv look in the wrong place).
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
const __filenameForEnv = fileURLToPath(import.meta.url);
const __dirnameForEnv = path.dirname(__filenameForEnv);
dotenv.config({ path: path.join(__dirnameForEnv, ".env") });

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import NodeCache from "node-cache";

import { analyzeStock, intradayScan, midTermAnalysis, longTermOutlook } from "./analysis.js";
import { ALL_STOCKS, NIFTY_50, NIFTY_NEXT_50, getNifty100, getNifty500, getStocksByIndex, validateStockList } from "./stockList.js";
import { analyzeNewsSentiment, quickSentiment } from "./sentiment.js";
import { fetchNifty50, fetchNseQuote, fetchNseIndices, fetchNseIndex, fetchNseEventCalendar, nseGet, warmup as nseWarmup } from "./nse.js";
import {
  getFundamentals,
  getAllFundamentals,
  scoreFundamentals,
  categoriseBatch,
  getSnapshotGeneratedAt,
  getSnapshotEnrichedAt,
  getSnapshotSource,
  loadFundamentalsFromDisk,
  primeFundamentalsFromKV,
  saveFundamentalsToKV,
} from "./fundamentals.js";
// Path to fundamentals.json for the dev-mode disk fallback in the enrichment
// cron endpoint. In production (Vercel) the filesystem is read-only so we
// write to Vercel KV instead; see saveFundamentalsToKV in fundamentals.js.
// fs imports (readFileSync/writeFileSync/existsSync) are below in this file
// and hoisted by ES module semantics.
const FUNDAMENTALS_PATH_SERVER = path.join(__dirnameForEnv, "fundamentals.json");
import { buildPortfolioIntelligence, computePortfolioCombinedScore } from "./portfolioIntelligence.js";
import { classifyRegime, computeMacroDelta, defaultCalmRegime, normalizeSector, REGIMES, SECTORS, withOpenAIRetry } from "./macroRegime.js";
import OpenAI from "openai";

// Lazy OpenAI client for server.js (same pattern as macroRegime.js)
let _serverOpenAI = null;
function getOpenAI() {
  if (_serverOpenAI) return _serverOpenAI;
  if (!process.env.OPENAI_API_KEY) return null;
  _serverOpenAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _serverOpenAI;
}
import {
  snapshotPicks,
  hasSnapshotToday,
  readAllTrades,
  appendTrades,
  computeReturns,
  aggregatePerformance,
  groupAndAggregate,
  getStorageStats,
  getISTDateKey,
} from "./paperTrades.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Cache: short TTL for real-time feel
const quoteCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });
const historicalCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const newsCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
const scanCache = new NodeCache({ stdTTL: 90, checkperiod: 30 });
// Catalyst calendar (NSE corporate events) changes slowly — cache for 2 hours.
const catalystCache = new NodeCache({ stdTTL: 7200, checkperiod: 600 });
// Portfolio intelligence orchestration is expensive (~1 second per call even
// when underlying quotes are warm). Cache for 30 seconds so rapid refreshes,
// tab switches, and the 60s auto-refresh don't rebuild the whole pipeline.
// The Refresh button passes ?bust=1 to force a recompute.
const portfolioCache = new NodeCache({ stdTTL: 30, checkperiod: 15 });
// Macro regime — one global object refreshed every 15 minutes. Contains the
// LLM-classified market regime (war/rate/oil/policy/calm) plus sector-level
// impact scores used by the Buy Now scanner to tilt recommendations.
const macroRegimeCache = new NodeCache({ stdTTL: 900, checkperiod: 60 });
const MACRO_CACHE_KEY = "macro_regime";
// In-memory ring buffer of the last 5 regime classifications + the headlines
// that produced them. Exposed via /api/macro/debug for audit/debugging.
const macroHistory = [];
// Per-source failure counter for observability. Incremented when a source
// fetch fails, reset on success. A WARN is logged when a source crosses 3
// consecutive failures.
const macroSourceFailures = new Map();

// CORS — permissive by default so the frontend works from anywhere (mobile,
// embeds, dev tunnels). The platform doesn't expose any user-specific data
// that would justify a stricter origin allow-list right now.
app.use(cors());

// Rate limiting — protects the LLM API budget and underlying data sources
// from abuse. The audit found that 50 burst requests succeeded with no
// throttling, which means anyone with the public Vercel URL could drain
// the Anthropic API key by hitting /api/stock with random symbols.
//
// Limits:
//   • All API routes:           60 requests per IP per minute
//   • /api/stock/ (LLM-heavy):  additional 30 per IP per minute
// Static files (HTML, CSS, JS) are NOT rate-limited.
//
// `trust proxy` is set BEFORE the limiters so they see real client IPs
// from X-Forwarded-For (Vercel and most reverse proxies set this). Without
// it the limiter would lump all users into one global counter.
app.set("trust proxy", 1);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: "draft-7", // emits the RateLimit-* response headers
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down (60 req/min limit)." },
});

const stockDetailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many stock detail requests. Please slow down (30 req/min limit)." },
});

app.use("/api/", apiLimiter);

// ── API key authentication for sensitive endpoints ──
//
// Industry deployment requires protecting portfolio, watchlist, and track
// record write endpoints. When STARBHAI_API_KEY is set in the environment,
// these endpoints require an X-API-Key header. When NOT set (local dev),
// all endpoints are open — no friction for development.
//
// Public endpoints (scan, stock, market, news, heatmap, macro) stay open.
function requireApiKey(req, res, next) {
  const envKey = process.env.STARBHAI_API_KEY;
  if (!envKey) return next(); // No key configured = open (local dev)
  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (provided === envKey) return next();
  return res.status(401).json({ error: "Unauthorized. Provide X-API-Key header." });
}

// Apply to sensitive routes (portfolio, watchlist, track writes)
app.use("/api/portfolio", requireApiKey);
app.use("/api/watchlist", requireApiKey);
app.use("/api/stock/", stockDetailLimiter);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ==================== Yahoo Finance Direct API ====================

const YF_BASE = "https://query1.finance.yahoo.com";
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

// ==================== RELIABILITY PRIMITIVES ====================

/**
 * fetch wrapped in AbortController timeout.
 * Throws a timeout-tagged error on expiry.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error(`Timeout after ${timeoutMs}ms`);
      e.code = "TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Retrying fetch.
 * Retries on network errors / 5xx / 429 / timeout with exponential backoff.
 * Never retries on 404. Returns null on final failure (does not throw — matches call sites).
 */
export async function fetchWithRetry(url, options = {}, cfg = {}) {
  const { retries = 2, timeoutMs = 8000, backoffMs = 400 } = cfg;
  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      // Don't retry client errors except rate-limit
      if (res.status === 404 || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        return res;
      }
      if (res.ok) return res;
      // Retriable server error
      lastErr = new Error(`HTTP ${res.status}`);
      lastErr.code = "HTTP_" + res.status;
    } catch (err) {
      lastErr = err;
    }
    attempt++;
    if (attempt <= retries) {
      const delay = backoffMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // All retries exhausted — return null so callers don't crash
  if (lastErr) console.error(`fetchWithRetry gave up on ${url.slice(0, 80)}:`, lastErr.message);
  return null;
}

/**
 * Failure tracker for scan batches.
 * Pass into per-stock fetch logic so we can surface which stocks dropped and why.
 */
export function createFailureTracker() {
  const failures = [];
  return {
    record(symbol, reason) { failures.push({ symbol, reason }); },
    summary() {
      return {
        failedCount: failures.length,
        failedSymbols: failures.slice(0, 20), // cap to 20 for JSON size
      };
    },
  };
}

// ==================== DATA FETCHERS ====================

/**
 * Fetch quote data using Yahoo Finance v8 chart endpoint
 */
async function fetchQuote(symbol) {
  const cached = quoteCache.get(symbol);
  if (cached) return cached;

  try {
    const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&includePrePost=false`;
    const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 2, timeoutMs: 8000 });

    if (!res || !res.ok) return null;

    const data = await res.json();
    if (!data.chart?.result?.[0]) return null;

    const r = data.chart.result[0];
    const meta = r.meta;
    const q = r.indicators.quote[0];
    const timestamps = r.timestamp || [];
    const lastIdx = timestamps.length - 1;

    // IMPORTANT: meta.chartPreviousClose is the close of the FIRST bar in the
    // requested range (e.g. 5 days ago with range=5d), NOT yesterday's close.
    // The true previous close is the second-to-last daily bar's close.
    const prevClose =
      lastIdx >= 1 && q.close?.[lastIdx - 1] != null
        ? q.close[lastIdx - 1]
        : meta.chartPreviousClose;

    const currentPrice = meta.regularMarketPrice;

    const quote = {
      symbol: meta.symbol,
      shortName: meta.shortName || meta.longName || meta.symbol,
      longName: meta.longName || meta.shortName || meta.symbol,
      regularMarketPrice: currentPrice,
      regularMarketDayHigh: meta.regularMarketDayHigh,
      regularMarketDayLow: meta.regularMarketDayLow,
      regularMarketVolume: meta.regularMarketVolume,
      regularMarketOpen: lastIdx >= 0 ? q.open?.[lastIdx] : null,
      regularMarketPreviousClose: prevClose,
      regularMarketChange: currentPrice - prevClose,
      regularMarketChangePercent:
        prevClose !== 0 ? ((currentPrice - prevClose) / prevClose) * 100 : 0,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      currency: meta.currency || "INR",
      exchange: meta.exchangeName,
      marketState: meta.hasPrePostMarketData ? "Regular" : "Closed",
    };

    quoteCache.set(symbol, quote);
    return quote;
  } catch (err) {
    console.error(`Quote error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Fetch detailed quote - uses chart endpoint + derives additional metrics from historical data
 */
async function fetchDetailedQuote(symbol) {
  try {
    const basicQuote = await fetchQuote(symbol);
    if (!basicQuote) return null;

    // Derive additional metrics from historical data
    const historical = await fetchHistorical(symbol);
    if (historical && historical.length > 0) {
      // Calculate 50-day and 200-day averages
      const closes = historical.map((d) => d.close);
      if (closes.length >= 50) {
        basicQuote.fiftyDayAverage = closes.slice(-50).reduce((s, v) => s + v, 0) / 50;
      }
      if (closes.length >= 200) {
        basicQuote.twoHundredDayAverage = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
      }
      // Average volume (last 60 trading days)
      const volumes = historical.map((d) => d.volume);
      const avgVolPeriod = Math.min(60, volumes.length);
      basicQuote.averageDailyVolume3Month =
        volumes.slice(-avgVolPeriod).reduce((s, v) => s + v, 0) / avgVolPeriod;
    }

    return basicQuote;
  } catch (err) {
    console.error(`Detailed quote error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Fetch historical data for technical analysis
 */
async function fetchHistorical(symbol, range = "6mo") {
  const cacheKey = `${symbol}_${range}`;
  const cached = historicalCache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
    const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 2, timeoutMs: 8000 });

    if (!res || !res.ok) return null;

    const data = await res.json();
    if (!data.chart?.result?.[0]) return null;

    const r = data.chart.result[0];
    const timestamps = r.timestamp || [];
    const q = r.indicators.quote[0];

    const historical = timestamps
      .map((ts, i) => ({
        date: new Date(ts * 1000),
        open: q.open?.[i],
        high: q.high?.[i],
        low: q.low?.[i],
        close: q.close?.[i],
        volume: q.volume?.[i] || 0,
      }))
      .filter((d) => d.close !== null && d.high !== null && d.low !== null && d.open !== null);

    if (historical.length > 0) {
      historicalCache.set(cacheKey, historical);
    }

    return historical;
  } catch (err) {
    console.error(`Historical error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Search for stocks using Yahoo Finance search API
 */
async function searchYahoo(query) {
  try {
    const url = `${YF_BASE}/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=0&quotesCount=10`;
    const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 1, timeoutMs: 6000 });

    if (!res || !res.ok) return [];

    const data = await res.json();

    // Yahoo's search returns a lot of noise for Indian queries:
    //   - futures/options contracts (symbols with "FUT" or "-J<digits>" or patterns
    //     like JIOFIN26APRFUT or JFSL-J2630.BO)
    //   - mutual funds (symbols starting with "0P0" — Morningstar codes)
    //   - non-equity quoteTypes
    // Strip those out so the dropdown only shows real equity tickers.
    const isNoise = (q) => {
      if (!q.symbol) return true;
      // Mutual fund codes
      if (q.symbol.startsWith("0P0")) return true;
      // Futures (e.g. "JIOFIN26APRFUT", "NIFTY26JANFUT", "-J2630")
      if (/FUT(\.|$)/.test(q.symbol)) return true;
      if (/-J\d+/.test(q.symbol)) return true;
      // Only EQUITY quote types (excludes ETF-mutualfund hybrids, futures, options)
      if (q.quoteType && q.quoteType !== "EQUITY") return true;
      return false;
    };

    const filtered = (data.quotes || []).filter(
      (q) =>
        !isNoise(q) &&
        (q.exchange === "NSI" ||
          q.exchange === "NSE" ||
          q.exchange === "BSE" ||
          q.exchange === "BOM" ||
          (q.symbol && (q.symbol.endsWith(".NS") || q.symbol.endsWith(".BO"))))
    );

    // Rank NSE listings above BSE listings — NSE is the primary exchange on
    // Groww and has tighter spreads. If a stock has both .NS and .BO, the .NS
    // should come first in the dropdown.
    filtered.sort((a, b) => {
      const aNse = a.symbol?.endsWith(".NS") ? 0 : 1;
      const bNse = b.symbol?.endsWith(".NS") ? 0 : 1;
      return aNse - bNse;
    });

    return filtered.map((q) => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchange,
      type: q.quoteType,
    }));
  } catch (err) {
    console.error("Yahoo search error:", err.message);
    return [];
  }
}

/**
 * Fetch latest news for a stock - searches with full name for better India-specific results
 */
async function fetchNews(symbol) {
  const cached = newsCache.get(symbol);
  if (cached) return cached;

  try {
    // Find the stock's full name for better news search
    const stockInfo = ALL_STOCKS.find((s) => s.symbol === symbol);
    const searchTerm = stockInfo
      ? `${stockInfo.name} India stock`
      : symbol.replace(".NS", "").replace(".BO", "") + " India";

    const url = `${YF_BASE}/v1/finance/search?q=${encodeURIComponent(searchTerm)}&newsCount=10&quotesCount=0`;
    const res = await fetchWithRetry(url, { headers: YF_HEADERS }, { retries: 1, timeoutMs: 6000 });

    if (!res || !res.ok) return [];

    const data = await res.json();
    const news = (data.news || []).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      publishedAt: n.providerPublishTime
        ? new Date(n.providerPublishTime * 1000).toISOString()
        : null,
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
    }));

    newsCache.set(symbol, news);
    return news;
  } catch (err) {
    console.error(`News error for ${symbol}:`, err.message);
    return [];
  }
}

// ==================== API ROUTES ====================

/**
 * Search for Indian stocks
 */
app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 1) {
      return res.json({ results: [] });
    }

    // Search in our local list
    const localResults = ALL_STOCKS.filter(
      (s) =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        s.symbol.toLowerCase().includes(query.toLowerCase().replace(".ns", "") + ".ns") ||
        s.symbol.toLowerCase().replace(".ns", "").includes(query.toLowerCase())
    ).slice(0, 10);

    // Also search Yahoo Finance
    const yahooResults = await searchYahoo(query);

    // Merge results, local first
    const allResults = [...localResults];
    for (const yr of yahooResults) {
      if (!allResults.find((r) => r.symbol === yr.symbol)) {
        allResults.push(yr);
      }
    }

    res.json({ results: allResults.slice(0, 15) });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

/**
 * Full stock analysis endpoint
 */
/**
 * Compute a per-stock "should I buy THIS stock TODAY?" verdict.
 * Combines the stock's own signals with the current market environment.
 *
 * Returns { verdict, verdictColor, signals[], score, actionText }
 */
function computeStockVerdict({ techScore, newsScore, fundamentalScore, fundamentalVerdict, combinedScore, scannerScore, macroBoost, macroContext, dataConfidence, midTerm }) {
  const signals = [];
  let score = 0;

  // Signal 1: Fundamentals
  if (fundamentalScore != null) {
    if (fundamentalVerdict === "DEEP_VALUE") {
      signals.push({ name: "Fundamentals", signal: "green", value: `DEEP VALUE (${fundamentalScore}/100)`, action: "Trading at a steep discount to sector peers.", icon: "💎" });
      score += 4;
    } else if (fundamentalVerdict === "QUALITY_GROWTH") {
      signals.push({ name: "Fundamentals", signal: "green", value: `QUALITY GROWTH (${fundamentalScore}/100)`, action: "Reasonably priced with good momentum.", icon: "✅" });
      score += 2;
    } else if (fundamentalVerdict === "FAIR_VALUE") {
      signals.push({ name: "Fundamentals", signal: "yellow", value: `FAIR VALUE (${fundamentalScore}/100)`, action: "Priced about right — no discount, no premium.", icon: "➖" });
      score += 0;
    } else if (fundamentalVerdict === "FULLY_VALUED") {
      signals.push({ name: "Fundamentals", signal: "yellow", value: `FULLY VALUED (${fundamentalScore}/100)`, action: "Trading at a premium. Limited upside.", icon: "⚠️" });
      score -= 2;
    } else if (fundamentalVerdict === "OVERVALUED") {
      signals.push({ name: "Fundamentals", signal: "red", value: `OVERVALUED (${fundamentalScore}/100)`, action: "Expensive. High re-rating risk.", icon: "🔴" });
      score -= 4;
    }
  } else {
    signals.push({ name: "Fundamentals", signal: "neutral", value: "No data", action: "Fundamental data unavailable for this stock.", icon: "❓" });
  }

  // Signal 2: Technicals
  if (techScore != null) {
    if (techScore >= 65) {
      signals.push({ name: "Technicals", signal: "green", value: `Score ${techScore}/100`, action: "Strong bullish momentum — RSI, MACD, trend aligned.", icon: "📈" });
      score += 3;
    } else if (techScore >= 55) {
      signals.push({ name: "Technicals", signal: "green", value: `Score ${techScore}/100`, action: "Mildly bullish — positive signals outweigh negatives.", icon: "📈" });
      score += 1;
    } else if (techScore >= 45) {
      signals.push({ name: "Technicals", signal: "yellow", value: `Score ${techScore}/100`, action: "Neutral — no clear directional signal.", icon: "📊" });
      score += 0;
    } else if (techScore >= 35) {
      signals.push({ name: "Technicals", signal: "yellow", value: `Score ${techScore}/100`, action: "Mildly bearish — some weakness showing.", icon: "📉" });
      score -= 2;
    } else {
      signals.push({ name: "Technicals", signal: "red", value: `Score ${techScore}/100`, action: "Strong bearish momentum — multiple sell signals.", icon: "📉" });
      score -= 3;
    }
  }

  // Signal 3: News Sentiment
  if (newsScore != null) {
    if (newsScore >= 65) {
      signals.push({ name: "News Sentiment", signal: "green", value: `${newsScore}/100`, action: "Positive headlines dominating for this stock.", icon: "📰" });
      score += 2;
    } else if (newsScore >= 45) {
      signals.push({ name: "News Sentiment", signal: "yellow", value: `${newsScore}/100`, action: "Mixed or neutral news flow.", icon: "📰" });
    } else {
      signals.push({ name: "News Sentiment", signal: "red", value: `${newsScore}/100`, action: "Negative headlines — bearish sentiment around this stock.", icon: "📰" });
      score -= 2;
    }
  }

  // Signal 4: Market Context (breadth from heatmap cache)
  try {
    const heatmap = sectorHeatmapCache.get("heatmap");
    if (heatmap?.marketBreadth) {
      const adv = heatmap.marketBreadth.advancing || 0;
      const dec = heatmap.marketBreadth.declining || 0;
      const total = adv + dec || 1;
      const ratio = (adv / total) * 100;
      if (ratio >= 60) {
        signals.push({ name: "Market Context", signal: "green", value: `${adv}↑ ${dec}↓`, action: "Broad market strength supports individual stocks.", icon: "🌍" });
        score += 2;
      } else if (ratio >= 45) {
        signals.push({ name: "Market Context", signal: "yellow", value: `${adv}↑ ${dec}↓`, action: "Mixed market — stock-specific factors matter more today.", icon: "🌍" });
      } else {
        signals.push({ name: "Market Context", signal: "red", value: `${adv}↑ ${dec}↓`, action: "Broad weakness — even good stocks get dragged down on days like this.", icon: "🌍" });
        score -= 3;
      }
    }
  } catch { /* silent */ }

  // Signal 5: Macro impact on THIS stock's sector
  if (macroContext && macroContext.delta !== 0) {
    const isTailwind = macroContext.delta > 0;
    signals.push({
      name: "Macro Impact",
      signal: isTailwind ? "green" : "red",
      value: `${isTailwind ? "+" : ""}${macroContext.delta.toFixed(1)} (${macroContext.sector})`,
      action: macroContext.reason || (isTailwind ? "Current regime favors this sector." : "Current regime is a headwind for this sector."),
      icon: isTailwind ? "🌱" : "🌧️",
    });
    score += isTailwind ? 2 : -2;
  } else {
    signals.push({ name: "Macro Impact", signal: "neutral", value: "Neutral", action: "Current macro regime has no specific impact on this sector.", icon: "—" });
  }

  // ── Market environment cap ──
  // If the market-level verdict is negative (CAUTIOUS / STAY OUT), cap the
  // stock verdict so no individual stock says "BUY" when the market page
  // says "don't buy anything." This prevents the contradiction where
  // REC shows "BUY" but the Market Intelligence tab says "STAY OUT."
  //
  // Read the cached market verdict to get the market-level score.
  let marketCap = null;
  try {
    const mv = verdictCache.get("verdict");
    if (mv && mv.score != null) {
      if (mv.score <= -5) {
        // Market says STAY OUT — cap stock at WAIT maximum
        marketCap = { maxVerdict: "WAIT", reason: `Market verdict is "${mv.verdict}" — not a buying day even for strong stocks.` };
        score = Math.min(score, -1); // force at most WAIT
      } else if (mv.score <= -3) {
        // Market says CAUTIOUS — cap stock at SELECTIVE BUY maximum
        marketCap = { maxVerdict: "SELECTIVE BUY", reason: `Market is cautious — enter only with strict stop-loss.` };
        score = Math.min(score, 1); // force at most SELECTIVE BUY
      }
    }
  } catch { /* silent */ }

  // Compute overall verdict
  let verdict, verdictColor, actionText;
  if (score >= 8) {
    verdict = "STRONG BUY"; verdictColor = "green";
    actionText = "All signals align — high-conviction entry opportunity.";
  } else if (score >= 4) {
    verdict = "BUY"; verdictColor = "green";
    actionText = "Most signals are favorable. Good entry with stop-loss.";
  } else if (score >= 1) {
    verdict = "SELECTIVE BUY"; verdictColor = "yellow";
    actionText = "Stock is okay but environment is mixed. Enter with tight SL.";
  } else if (score >= -2) {
    verdict = "WAIT"; verdictColor = "yellow";
    actionText = "Too many headwinds right now. Watch for improvement.";
  } else if (score >= -5) {
    verdict = "AVOID TODAY"; verdictColor = "red";
    actionText = "Weak stock + weak market. Not the right time.";
  } else {
    verdict = "SELL / EXIT"; verdictColor = "red";
    actionText = "Multiple bearish signals. Consider exiting if you hold.";
  }

  // Append market cap explanation if it kicked in
  if (marketCap) {
    actionText += ` ${marketCap.reason}`;
  }

  // Adjust for confidence
  if (dataConfidence === "low") {
    actionText += " (Low data confidence — only 1 signal dimension available.)";
  }

  return { verdict, verdictColor, actionText, score, signals, marketCap: marketCap ? marketCap.maxVerdict : null };
}

app.get("/api/stock/:symbol", async (req, res) => {
  try {
    let symbol = req.params.symbol.toUpperCase();
    if (!symbol.endsWith(".NS") && !symbol.endsWith(".BO")) {
      symbol += ".NS";
    }

    // Bug fix: we used to pre-compute `stockName` here by reading `quote.shortName`,
    // but `quote` isn't fetched yet — that threw `Cannot access 'quote' before
    // initialization` for any symbol NOT in our static stockList (e.g. Geojit).
    // It only appeared to work for Nifty 50 stocks because stockInfo was non-null
    // and the `||` short-circuited before hitting the TDZ variable.
    //
    // The fix: fetch the quote FIRST, then use its shortName for the news search.
    // This also gives us real company names for stocks beyond our curated list.
    const stockInfo = ALL_STOCKS.find((s) => s.symbol === symbol);

    const [quote, historical] = await Promise.all([
      fetchDetailedQuote(symbol),
      fetchHistorical(symbol),
    ]);

    if (!quote) {
      return res.status(404).json({ error: "Stock not found on NSE/Yahoo Finance. Check the symbol." });
    }

    // Now we have a real quote → use its shortName for a more accurate news search.
    const stockName = stockInfo?.name || quote.shortName || quote.longName || symbol.replace(".NS", "");
    const sentiment = await analyzeNewsSentiment(symbol, stockName);

    // Fix #3: New-IPO / insufficient-history guard.
    //
    // When a stock has <30 daily bars of history (recently listed, freshly
    // re-listed, or mid-suspension), we can still show fundamentals and news
    // but we CANNOT compute a technical score or combined recommendation.
    //
    // Previously this returned a barebones shape without `fundamentals` or
    // `lastUpdated`, which caused the frontend to render inconsistently.
    // Now we return the same shape as the happy path, with `analysis.error`
    // surfaced clearly and `combinedScore: null` so downstream doesn't
    // compute bogus weighted averages.
    if (!historical || historical.length < 30) {
      // Still compute fundamentals if the snapshot exists — they don't
      // depend on historical data.
      const fundSnap = getFundamentals(symbol);
      let fundamentalResult = null;
      if (fundSnap) fundamentalResult = scoreFundamentals(fundSnap, null);
      // Long-term outlook can still work for new IPOs — it's fundamentals-
      // driven and doesn't need 200 days of history. Pass null for analysis
      // and dma200; the function handles missing data gracefully.
      const earlyLongTerm = longTermOutlook({indicators:{}}, quote, fundamentalResult, null);
      return res.json({
        quote: formatQuote(quote),
        analysis: {
          error: "Insufficient historical data for technical analysis (need at least 30 days of price history — this is usually a recent IPO or a freshly re-listed stock).",
          combinedScore: null,
          technicalScore: null,
          sentimentScore: sentiment.available ? sentiment.score : null,
          fundamentalScore: fundamentalResult?.score ?? null,
          portfolioBasisScore: null,
        },
        fundamentals: fundamentalResult,
        longTerm: earlyLongTerm,
        sentiment,
        news: sentiment.headlines,
        lastUpdated: new Date().toISOString(),
      });
    }

    const analysis = analyzeStock(historical, quote);
    const intraday = intradayScan(analysis, quote);
    const midTerm = midTermAnalysis(analysis, quote, historical ? historical.map(d => d.close) : null);

    // ── Look up fundamental snapshot + score ──
    const fundSnap = getFundamentals(symbol);
    let fundamentalScore = null;
    let fundamentalResult = null;
    if (fundSnap) {
      // Compute 200DMA from historical for the fundamental score
      let dma200 = null;
      if (historical.length >= 200) {
        const closes = historical.map((d) => d.close);
        dma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
      }
      fundamentalResult = scoreFundamentals(fundSnap, dma200);
      fundamentalScore = fundamentalResult.score;
    }

    // ── Long-term outlook (3–12 months, fundamentals-driven) ──
    // Must be computed AFTER fundamentalResult because 70% of the long-term
    // score comes from the fundamental pillar engine. The 200DMA for the
    // trend-context slice is computed above (or null for <200 day histories).
    let dma200ForLT = null;
    if (historical.length >= 200) {
      const closes200 = historical.map((d) => d.close);
      dma200ForLT = closes200.slice(-200).reduce((s, v) => s + v, 0) / 200;
    }
    const longTerm = longTermOutlook(analysis, quote, fundamentalResult, dma200ForLT);

    // ── Combined score ──
    //
    // Rather than hard-coded weights that break when a dimension is missing,
    // we now compute a weighted average over ONLY the dimensions that
    // contributed data. Missing dimensions (news unavailable, no fundamentals)
    // are skipped entirely instead of being faked as 50/100 — this was
    // inflating scores and causing spurious BUY recommendations.
    //
    // Phase 1 (Apr 2026): news weight 0.25 → 0.12 + confidence gate.
    //
    // Rationale: Yahoo/Google News return a lot of off-topic noise for
    // Indian tickers (the sentiment.js system prompt explicitly compensates
    // for this), and even with a good classifier a 25% weight amplifies
    // that noise into the recommendation. The honest-backtest exit
    // breakdown showed trades clustering around earnings cycles where
    // news sentiment was rich but unreliable. Cut to 12% and require
    // headline_count ≥ 5 before the dimension is even counted — below
    // that threshold, sentiment is ignored and weight is redistributed
    // to tech + fundamentals.
    //
    // Base weights (when news qualifies): technical 0.50 / news 0.12 /
    // fundamentals 0.38. Missing dimensions redistribute via sumWeights.
    const MIN_HEADLINES_FOR_SENTIMENT = 5;
    const techScore = analysis.score;
    const newsScore = (sentiment.available && (sentiment.headline_count ?? 0) >= MIN_HEADLINES_FOR_SENTIMENT)
      ? sentiment.score
      : null;

    // Guard: if technical analysis somehow returned no score, we still want a
    // usable response — previously this could propagate NaN through the
    // combined formula and appear as "NaN/100" in the frontend.
    if (techScore == null || Number.isNaN(techScore)) {
      return res.json({
        quote: formatQuote(quote),
        analysis: { error: "Technical analysis unavailable for this stock (likely insufficient history — new listing or delisted)." },
        fundamentals: fundamentalResult,
        sentiment,
        news: sentiment.headlines,
        lastUpdated: new Date().toISOString(),
      });
    }

    const contributions = [];
    contributions.push({ key: "tech", score: techScore, weight: 0.50 });
    if (newsScore != null)           contributions.push({ key: "news",  score: newsScore,        weight: 0.12 });
    if (fundamentalScore != null)    contributions.push({ key: "fund",  score: fundamentalScore, weight: 0.38 });

    const sumWeights = contributions.reduce((s, c) => s + c.weight, 0);
    const combinedScore = Math.round(
      contributions.reduce((s, c) => s + c.score * c.weight, 0) / sumWeights
    );

    // Which dimensions actually contributed? Used for the action copy, the
    // divergence warning, and — new — confidence gating on the recommendation
    // strength itself.
    const dims = contributions.map((c) => c.key);
    const dimLabel =
      dims.length === 3 ? "technical + news + fundamentals" :
      dims.length === 2 ? dims.map(d => ({tech:"technical",news:"news",fund:"fundamentals"}[d])).join(" + ") :
      "technical only";

    // Confidence level based on how many dimensions contributed:
    //   • 3 dims → HIGH confidence, full recommendation strength
    //   • 2 dims → MEDIUM confidence, cap recommendations at BUY/SELL (no STRONG)
    //   • 1 dim  → LOW confidence, cap at WEAK BUY/WEAK SELL, add a prominent warning
    //
    // This prevents the platform from emitting "STRONG BUY" on a new IPO that
    // only has technical signals, or "SELL" on a stock where news sentiment
    // is the only dimension that came back. A single dimension is a hint,
    // not a trade signal.
    const dataConfidence = dims.length === 3 ? "high" : dims.length === 2 ? "medium" : "low";

    // Divergence check: compare every pair of contributing dimensions.
    // If the spread exceeds 25 points we warn the user NOT to blindly trust the
    // averaged score — it's hiding conflicting signals.
    const scoreValues = contributions.map((c) => c.score);
    const maxScore = Math.max(...scoreValues);
    const minScore = Math.min(...scoreValues);
    // Divergence threshold lowered from 25 to 18. At 25, stocks with Tech 70
    // + News 45 + Fund 72 barely triggered. 18 catches "one dimension disagrees
    // by almost 20 points" — meaningful enough to warrant a warning. Still won't
    // fire on normal noise (a 10-point spread is common and benign).
    const hasDivergence = scoreValues.length >= 2 && (maxScore - minScore) > 18;

    // Base recommendation from the combined score
    let combinedRec, combinedAction, combinedUrgency;
    if (combinedScore >= 75) {
      combinedRec = "STRONG BUY";
      combinedAction = `Strong buy signal from ${dimLabel}. High-conviction entry.`;
      combinedUrgency = "Act on this soon — confluence of positive signals is rare.";
    } else if (combinedScore >= 62) {
      combinedRec = "BUY";
      combinedAction = `Bullish picture from ${dimLabel}. Consider initiating a position.`;
      combinedUrgency = "Good entry window if the broader market is cooperative.";
    } else if (combinedScore >= 53) {
      combinedRec = "WEAK BUY";
      combinedAction = `Mildly positive based on ${dimLabel}. Small starter position only.`;
      combinedUrgency = "Wait for confirmation before sizing up.";
    } else if (combinedScore >= 47) {
      combinedRec = "HOLD";
      combinedAction = `No clear edge from ${dimLabel}. Hold current position.`;
      combinedUrgency = "Wait for one dimension to break the tie.";
    } else if (combinedScore >= 38) {
      combinedRec = "WEAK SELL";
      combinedAction = `Mildly negative from ${dimLabel}. Consider trimming.`;
      combinedUrgency = "Set a stop-loss if holding.";
    } else if (combinedScore >= 25) {
      combinedRec = "SELL";
      combinedAction = `Bearish picture from ${dimLabel}. Reduce exposure.`;
      combinedUrgency = "Exit soon to limit drawdown.";
    } else {
      combinedRec = "STRONG SELL";
      combinedAction = `Heavy bearish signals from ${dimLabel}. Exit immediately.`;
      combinedUrgency = "Significant downside risk — do not hold.";
    }

    // Apply confidence caps — cannot issue high-conviction signals on thin data.
    // The score itself stays unchanged so the UI can still show it; only the
    // human-readable label and action text get downgraded.
    const originalRec = combinedRec;
    if (dataConfidence === "medium") {
      // 2 dims → no STRONG ratings
      if (combinedRec === "STRONG BUY") { combinedRec = "BUY"; combinedAction = `Bullish on ${dimLabel}, but 1 dimension is missing — downgraded from STRONG BUY because of incomplete data.`; }
      if (combinedRec === "STRONG SELL") { combinedRec = "SELL"; combinedAction = `Bearish on ${dimLabel}, but 1 dimension is missing — downgraded from STRONG SELL because of incomplete data.`; }
    } else if (dataConfidence === "low") {
      // 1 dim → cap at WEAK BUY/WEAK SELL, very cautious copy
      if (combinedRec === "STRONG BUY" || combinedRec === "BUY") {
        combinedRec = "WEAK BUY";
        combinedAction = `Only technical signals available — 2 of 3 dimensions are missing. Treat this as a hint, not a trade signal. Wait for news + fundamentals to confirm.`;
        combinedUrgency = "Insufficient data for a high-conviction call. Do not size up based on technicals alone.";
      }
      if (combinedRec === "STRONG SELL" || combinedRec === "SELL") {
        combinedRec = "WEAK SELL";
        combinedAction = `Only technical signals available — 2 of 3 dimensions are missing. Could be a temporary swing rather than a thesis break.`;
        combinedUrgency = "Insufficient data for a forced exit. Watch for confirming signals before acting.";
      }
    }

    // Build combined reasoning
    let combinedReasoning = `TECHNICAL (${techScore}/100): ${analysis.reasoning}`;
    if (newsScore != null) {
      combinedReasoning += `\n\nNEWS SENTIMENT (${newsScore}/100): ${sentiment.summary}`;
    } else {
      combinedReasoning += `\n\nNEWS SENTIMENT: unavailable (no recent headlines found — sentiment skipped, not faked).`;
    }
    if (fundamentalResult) {
      combinedReasoning += `\n\nFUNDAMENTALS (${fundamentalScore}/100 · ${fundamentalResult.verdict}): ${fundamentalResult.reasoning}`;
    }

    // Divergence warning across ALL contributing dimensions, not just tech vs news.
    if (hasDivergence) {
      const breakdown = contributions.map((c) => {
        const name = { tech: "Technical", news: "News", fund: "Fundamentals" }[c.key];
        return `${name} ${c.score}`;
      }).join(", ");
      combinedReasoning += `\n\n⚠ DIVERGENCE WARNING: ${breakdown} disagree by ${maxScore - minScore} points. Do not blindly trust the combined number — one of these signals is wrong, and you need to figure out which before committing capital.`;
    }

    // ── Phase 1 Fix #1: Score consistency between stock detail + portfolio ──
    //
    // The stock detail page uses a 3-factor combined score (tech 45% + news 25%
    // + fund 30%) to answer "what's the current market view of this stock?".
    // The Portfolio tab uses a 2-factor score (tech 60% + fund 40%) because
    // news is too noisy for structural position decisions.
    //
    // Both formulas are defensible, but when the user clicks from the Portfolio
    // card into the Stock Detail page, the score jumps and the recommendation
    // may flip (HOLD → WEAK SELL). The audit found this broke user trust.
    //
    // Fix: compute BOTH scores and expose them side-by-side with clear labels
    // on the frontend. The 3-factor score stays the headline number (market
    // view), the 2-factor score is shown alongside for portfolio reconciliation.
    const portfolioBasisScore = computePortfolioCombinedScore(techScore, fundamentalScore);

    // Scanner score — uses the EXACT same formula the Buy Now scanner uses
    // (tech 40% + fund 60%) so the number on the scanner card matches the
    // number on the stock detail page. Eliminates the BUY→WEAK BUY flip.
    const scannerScore = fundamentalScore != null
      ? Math.round(techScore * 0.50 + fundamentalScore * 0.50)
      : Math.round(techScore);

    // ─── Macro regime context ───
    //
    // Stock Detail now BLENDS macro into the market-view combinedScore so
    // "what does the market think of this stock today?" reflects the
    // current regime. The portfolioBasisScore deliberately stays macro-free
    // because holdings should be less twitchy than fresh picks — the same
    // decision logic used in My Portfolio is what reads portfolioBasisScore.
    //
    // macroContext is still exposed separately so the UI can render a
    // dedicated macro pill with the delta + reason + regime label.
    let macroContext = null;
    let macroBoost = 0;
    const stockSector = stockInfo?.sector || null;
    if (stockSector) {
      const cachedRegime = macroRegimeCache.get(MACRO_CACHE_KEY);
      if (cachedRegime && cachedRegime.regime) {
        const { delta, reason, sector } = computeMacroDelta(cachedRegime, stockSector);
        if (delta !== 0) {
          macroBoost = delta;
          macroContext = {
            delta,
            reason,
            sector,
            regime: cachedRegime.regime,
            regimeLabel: cachedRegime.regimeLabel,
            severity: cachedRegime.severity,
            confidence: cachedRegime.confidence,
          };
        }
      }
    }
    // Scale macro boost by data confidence. A stock with only technical data
    // (LOW confidence) shouldn't get a full ±15 tilt from macro — that would
    // push the score from WEAK BUY to BUY territory, contradicting the gating
    // that specifically downgraded it because of thin data. Full boost is only
    // applied when all 3 dimensions contributed.
    const macroConfidenceScale = dataConfidence === "high" ? 1.0 : dataConfidence === "medium" ? 0.5 : 0.2;
    const effectiveMacroBoost = parseFloat((macroBoost * macroConfidenceScale).toFixed(2));

    // Blend macro tilt into the market-view combined score. Clamped to 0-100.
    // We DON'T change portfolioBasisScore — see comment above.
    const marketCombinedScore = Math.max(
      0,
      Math.min(100, Math.round(combinedScore + effectiveMacroBoost))
    );

    res.json({
      quote: formatQuote(quote),
      analysis: {
        ...analysis,
        // Base 3-factor combined score (tech + news + fund), WITHOUT macro.
        // Kept on the response so the frontend can show "before macro: X".
        baseCombinedScore: combinedScore,
        // Headline "market view" score — base blended with the current macro tilt.
        combinedScore: marketCombinedScore,
        combinedRecommendation: combinedRec,
        // If confidence gating kicked in, the raw recommendation the score
        // WOULD have produced on 3 dimensions — exposed for transparency.
        rawRecommendation: originalRec,
        combinedAction,
        combinedUrgency,
        combinedReasoning,
        technicalScore: techScore,
        sentimentScore: newsScore,
        fundamentalScore,
        // Data confidence: "high" (3 dims), "medium" (2), "low" (1). The
        // frontend shows a chip when it's not "high" so users know why the
        // recommendation was downgraded from what the score alone would give.
        dataConfidence,
        contributingDimensions: dims,
        // Macro delta applied to combinedScore, scaled by data confidence
        // (full delta at HIGH confidence, 50% at MEDIUM, 20% at LOW)
        macroBoost: effectiveMacroBoost,
        rawMacroBoost: macroBoost,
        // Same data viewed through the portfolio-basis lens — deliberately
        // WITHOUT macro, since holding decisions should be less twitchy.
        portfolioBasisScore,
        // Scanner score — matches the Buy Now scanner's 40/60 formula exactly.
        scannerScore,
      },
      fundamentals: fundamentalResult,
      midTerm,
      longTerm,
      sentiment,
      news: sentiment.headlines,
      macro: macroContext,
      // ── Per-stock verdict: "should I buy THIS stock TODAY?" ──
      stockVerdict: computeStockVerdict({
        techScore,
        newsScore,
        fundamentalScore,
        fundamentalVerdict: fundamentalResult?.verdict,
        combinedScore: marketCombinedScore,
        scannerScore,
        macroBoost: effectiveMacroBoost,
        macroContext,
        dataConfidence,
        midTerm,
      }),
      // Last 90 days of OHLCV for the price chart on the frontend.
      historicalChart: historical
        ? historical.slice(-90).map((d) => ({ close: d.close, volume: d.volume, date: d.date }))
        : null,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Stock analysis error:", err.message);
    res.status(500).json({ error: "Failed to analyze stock: " + err.message });
  }
});

/**
 * Scan stocks for recommendations
 */
// Canonical enums for input validation. Anything outside these returns 400
// instead of silently defaulting (which used to mask user typos like
// `?universe=nifty50000` returning the full Nifty 100 with no warning).
const VALID_SCAN_TYPES = ["all", "midterm", "buynow", "sell"];
const VALID_SCAN_UNIVERSES = ["nifty50", "niftyNext50", "nifty100", "nifty500", "all"];

app.get("/api/scan/:type", async (req, res, next) => {
  // Delegate specific named scans to their own handlers
  if (req.params.type === "volume-breakout") return next();
  if (req.params.type === "fundamentals") return next();

  try {
    const type = req.params.type;
    const universe = req.query.universe || "nifty100"; // nifty50, niftyNext50, nifty100, all

    // Validate type + universe up front. Bad inputs were previously silently
    // coerced to defaults — that masks typos and hides bugs.
    if (!VALID_SCAN_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Unknown scan type "${type}". Valid types: ${VALID_SCAN_TYPES.join(", ")}`,
      });
    }
    if (!VALID_SCAN_UNIVERSES.includes(universe)) {
      return res.status(400).json({
        error: `Unknown universe "${universe}". Valid universes: ${VALID_SCAN_UNIVERSES.join(", ")}`,
      });
    }

    // ── Pre-computed cache check (for Vercel cron) ──
    // Two-tier:
    //   L1: in-process scanCache (NodeCache, 8h TTL, per-instance)
    //   L2: Vercel KV (shared across lambdas, written by the daily cron)
    // L1 catches re-hits on the same warm lambda; L2 means a newly-booted
    // lambda doesn't need to wait until the next cron run for the pre-
    // computed data. Cuts typical scan latency from 8-15s (live scan) to
    // ~20ms (L2 hit) / ~1ms (L1 hit).
    const PRECOMPUTE_CACHE_KEY = "precomputed_buynow_nifty100";
    if (type === "buynow" && (universe === "nifty100" || universe === "all")) {
      const l1 = scanCache.get(PRECOMPUTE_CACHE_KEY);
      if (l1) {
        res.set("X-Precomputed", "L1");
        return res.json(l1);
      }
      // L2: Vercel KV — best-effort, never blocks on failure
      try {
        const kv = await getKVClientForPortfolio();
        if (kv) {
          const l2 = await kv.get(`scan:${PRECOMPUTE_CACHE_KEY}`);
          if (l2) {
            scanCache.set(PRECOMPUTE_CACHE_KEY, l2, 28800); // promote to L1
            res.set("X-Precomputed", "L2");
            return res.json(l2);
          }
        }
      } catch (e) { /* fall through to live scan */ }
    }

    const cacheKey = `scan_${type}_${universe}`;
    const cached = scanCache.get(cacheKey);
    if (cached) return res.json(cached);

    // Choose scan universe (validation above guarantees one of these matches)
    let stocksToScan;
    if (universe === "nifty50") stocksToScan = getStocksByIndex("NIFTY50");
    else if (universe === "niftyNext50") stocksToScan = getStocksByIndex("NIFTY_NEXT_50");
    else if (universe === "nifty500") stocksToScan = getNifty500();
    else if (universe === "all") stocksToScan = ALL_STOCKS;
    else stocksToScan = getNifty100(); // nifty100

    // Full universe scan — no truncation. maxDuration=60s in vercel.json
    // handles the timeout. The full 100-stock scan completes in ~15-25s.
    const fullUniverseSize = stocksToScan.length;
    const truncatedForVercel = false;

    const failureTracker = createFailureTracker();
    const results = [];
    const BATCH_SIZE = 8;

    for (let i = 0; i < stocksToScan.length; i += BATCH_SIZE) {
      const batch = stocksToScan.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (stock) => {
          try {
            const [quote, historical] = await Promise.all([
              fetchQuote(stock.symbol),
              fetchHistorical(stock.symbol),
            ]);

            if (!quote) { failureTracker.record(stock.symbol, "quote_null"); return null; }
            if (!historical) { failureTracker.record(stock.symbol, "historical_null"); return null; }
            if (historical.length < 30) { failureTracker.record(stock.symbol, "insufficient_bars"); return null; }

            const analysis = analyzeStock(historical, quote);
            const intraday = intradayScan(analysis, quote);
            const midTerm = midTermAnalysis(analysis, quote, historical ? historical.map(d => d.close) : null);

            return {
              symbol: stock.symbol,
              name: stock.name,
              sector: stock.sector,
              price: quote.regularMarketPrice,
              change: quote.regularMarketChange,
              changePercent: quote.regularMarketChangePercent,
              score: analysis.score,
              recommendation: analysis.recommendation,
              reasoning: analysis.reasoning,
              midTerm,
              volume: analysis.indicators?.volume?.description || "N/A",
              rsi: analysis.indicators?.rsi || "N/A",
              trend: analysis.indicators?.trend?.trend || "N/A",
              // ATR for stop-loss/target computation in Buy Now
              atr: analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null,
            };
          } catch (e) {
            failureTracker.record(stock.symbol, "exception: " + e.message);
            return null;
          }
        })
      );

      results.push(...batchResults.filter(Boolean));

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < stocksToScan.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    let filtered;
    // Fetch current macro regime ONCE per scan (for buynow only — other scan
    // types are unaffected). On Vercel this uses the lazy stale-while-revalidate
    // cache; locally it uses the 15-min background refresh.
    let macroRegime = null;
    if (type === "buynow") {
      try {
        macroRegime = await getMacroRegime();
      } catch (e) {
        console.warn("[MACRO] buynow scan: failed to load regime:", e.message);
        macroRegime = defaultCalmRegime();
      }

      // ── FULL 3-FACTOR SCORING for Buy Now ──
      //
      // The previous version ranked by technical score + macro tilt only. This
      // produced momentum-chase picks that underperformed the Nifty (44.8%
      // beats-Nifty rate) because stocks with great technicals but terrible
      // fundamentals (OVERVALUED) or bearish news got recommended.
      //
      // The fix: compute a proper combined score for each stock:
      //   • Technical score — already computed above (analysis.score)
      //   • Fundamental score — looked up from fundamentals.json (FREE, instant)
      //   • News sentiment — NOT included (requires per-stock LLM call; too
      //     expensive for a 100-stock scan). When available from cache it's used.
      //   • Macro tilt — additive as before
      //
      // This brings the scanner in line with the Stock Detail page's scoring,
      // so "Buy Now" picks no longer contradict their own detail view.
      //
      // Additionally: FULLY_VALUED and OVERVALUED stocks are filtered OUT.
      // An expensive stock with bullish technicals is a momentum play, not a
      // "best stock to buy now."

      // ── Fix 5: Earnings Calendar Filter ──
      // Build a set of symbols with "Financial Results" (= earnings) within 7
      // days of today. These stocks get flagged with earningsNearby so the UI
      // can show a warning badge. Phase 2 adds a hard-blackout map for the
      // 3-trading-day window immediately before earnings — these picks get
      // EXCLUDED, not just warned. The previous "warn only" policy left
      // users exposed to earnings-gap losses the ATR-based SL can't contain.
      //
      // The 7-day map continues to drive the UI badge; the 3-day blackout
      // map drives scanner filtering.
      const earningsNearbyMap = new Map();
      const earningsBlackoutSet = new Set();
      try {
        let events = catalystCache.get("nse_events");
        if (!events) {
          events = await fetchNseEventCalendar();
          if (events && events.length > 0) catalystCache.set("nse_events", events);
        }
        if (events) {
          const now = new Date();
          const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
          const blackoutMs = 3 * 24 * 60 * 60 * 1000; // 3 calendar days ≈ 3 trading days
          for (const e of events) {
            if (!/financial result/i.test(e.purpose)) continue;
            const eventDate = new Date(e.date);
            if (isNaN(eventDate.getTime())) continue;
            const diffMs = eventDate.getTime() - now.getTime();
            if (diffMs >= 0 && diffMs <= sevenDaysMs) {
              const sym = e.symbol + ".NS";
              earningsNearbyMap.set(sym, { date: e.date, purpose: e.purpose, company: e.company });
              if (diffMs <= blackoutMs) earningsBlackoutSet.add(sym);
            }
          }
        }
      } catch (e) {
        // Silent — earnings data is a nice-to-have, don't break the scan
      }

      for (const r of results) {
        // Attach earnings info if available
        if (earningsNearbyMap.has(r.symbol)) {
          r.earningsNearby = earningsNearbyMap.get(r.symbol);
        }

        // 1. Look up fundamental score from the pre-computed snapshot (zero cost)
        const fundSnap = getFundamentals(r.symbol);
        let fundamentalScore = null;
        let fundamentalVerdict = null;
        if (fundSnap) {
          const fundResult = scoreFundamentals(fundSnap);
          if (fundResult) {
            fundamentalScore = fundResult.score;
            fundamentalVerdict = fundResult.verdict;
          }
        }

        // 2. Compute combined score: fundamental-dominant with technical confirmation.
        //    Tech 40% + Fund 60% when both available; 100% tech when fund missing.
        //
        //    WHY 40/60 (rebalanced Apr 2026): The fundamental side now covers 9
        //    dimensions including ROE, debt, margins, and revenue growth — not
        //    just valuation. With a genuine quality-adjusted value signal
        //    driving the 60%, we no longer need the extreme 65% weight to
        //    defend against momentum noise. The 40/60 split sits in the sweet
        //    spot CFA/CANSLIM-style hybrid strategies use: fundamentals pick
        //    what to buy, technicals pick when, with a slightly larger
        //    technical weight than pure deep-value because the quality
        //    filtering upstream already removes value traps.
        const SCANNER_TECH_WEIGHT = 0.40;
        const SCANNER_FUND_WEIGHT = 0.60;
        const techScore = r.score;
        let combinedBase;
        let dataConfidence;
        if (fundamentalScore != null) {
          combinedBase = techScore * SCANNER_TECH_WEIGHT + fundamentalScore * SCANNER_FUND_WEIGHT;
          dataConfidence = "high"; // tech + fund = 2 strong dimensions
        } else {
          combinedBase = techScore;
          dataConfidence = "medium"; // tech only
        }

        // 3. Apply macro tilt (clamped to ±10)
        const { delta, reason, sector } = computeMacroDelta(macroRegime, r.sector);
        r.macroBoost = delta;
        r.macroReason = reason;
        r.macroSector = sector;

        // 4. Final combined score
        // P0 (Apr 2026): DO NOT apply macro delta to Buy Now / Fundamental
        // picks. Multi-horizon backtesting showed the macro mood filter
        // HURTS value-oriented picks by -3.1pp average. A value scanner
        // should BUY when the market dips, not skip those months. Macro
        // delta is still applied for midterm/sell/intraday where momentum
        // timing matters.
        r.technicalScore = techScore;
        r.fundamentalScore = fundamentalScore;
        r.fundamentalVerdict = fundamentalVerdict;
        r.dataConfidence = dataConfidence;
        r.baseScore = Math.round(combinedBase);
        // For buynow: use base score only (no macro). For other types: add delta.
        const applyMacro = (type !== "buynow");
        let sectorMomentumBonus = 0;

        // ── Fix 3: Sector Momentum Overlay ──
        // Reads the existing sector heatmap cache (refreshed every 2 min) to
        // get each sector's daily performance. Sectors outperforming Nifty by
        // >3% get a +3 score bonus; underperforming by >3% get a -3 penalty.
        // This naturally rotates picks toward currently strong sectors.
        if (type === "buynow") {
          const heatmapData = sectorHeatmapCache.get("heatmap");
          if (heatmapData && heatmapData.sectors) {
            const stockSector = normalizeSector(r.sector) || r.sector || "";
            const sectorEntry = heatmapData.sectors.find(
              (s) => normalizeSector(s.sector) === stockSector || s.sector === stockSector
            );
            const niftyChange = heatmapData.niftyChange || 0;
            if (sectorEntry && sectorEntry.avgChange != null) {
              const relativePerf = sectorEntry.avgChange - niftyChange;
              if (relativePerf > 3) sectorMomentumBonus = 3;
              else if (relativePerf < -3) sectorMomentumBonus = -3;
            }
          }
          r.sectorMomentum = sectorMomentumBonus;
        }

        r.adjustedScore = Math.max(0, Math.min(100, combinedBase + (applyMacro ? delta : 0) + sectorMomentumBonus));

        // 5. Stop-loss and target from ATR — MID-TERM multipliers
        // Phase 1 (Apr 2026): SL 3× / target 7× ATR. The honest 24-month
        // backtest with the old 4×/5× setting produced 40% SL hits and 13%
        // target hits — the SL was too tight and the target wasn't
        // aspirational enough to justify carrying losers. Asymmetric 3×/7×
        // gives theoretical R:R = 2.33 and pairs with the activation-gated
        // trailing stop that engages only after +2×ATR of gain.
        const atr = r.atr ?? null;
        if (atr && r.price) {
          r.stopLoss = parseFloat((r.price - atr * 3).toFixed(2));
          r.target = parseFloat((r.price + atr * 7).toFixed(2));
          r.riskReward = parseFloat(((r.target - r.price) / (r.price - r.stopLoss)).toFixed(2));
        }
      }
    }
    if (type === "midterm") {
      filtered = results
        .filter((r) => r.midTerm.score >= 58)
        .sort((a, b) => b.midTerm.score - a.midTerm.score)
        .slice(0, 10);
    } else if (type === "buynow") {
      // Best stocks to buy RIGHT NOW:
      //   1. Combined score ≥ 65 (tech + fund, no macro for value picks)
      //   2. NOT HOLD recommendation on technicals
      //   3. Only DEEP_VALUE + QUALITY_GROWTH pass
      //   4. P4: Exclude sectors with <31% win rate across 5-year backtest
      //   5. P5: QUALITY_GROWTH gets +5 sort bonus (63.6% win rate vs 42.5% for DV)
      //   6. MAX 3 per sector — prevents all-banking or all-IT top 10
      //
      // P4 (Apr 2026): Sector exclusion based on 8-horizon backtesting.
      // Banking (31% WR, -1.74%), Tourism/IRCTC (31%, -1.79%), Cement (28%,
      // -1.47%), Chemicals (28%, -2.91%) consistently destroy alpha across
      // ALL tested horizons. Excluding them removes ~30% of losing trades.
      const EXCLUDED_SECTORS = new Set([
        "Banking", "Tourism", "Cement", "Chemicals",
      ]);

      // ── Fix 2: QG/DV Dual-Lane Scanner ──
      // Week 2 (Apr 2026): slot allocation narrowed.
      //
      // The previous 6 QG / 4 DV split was based on 8-horizon backtests that
      // used biased (current-snapshot) fundamentals. After the Week 1 bias fix
      // the point-in-time backtest shows:
      //   • QG: negative alpha in 1yr/2yr/4yr (concentrated picks lose badly)
      //   • DV: consistently strong 3yr/4yr alpha; best at Top 3
      //   • Top 1 > Top 10 in every category — signal strength is in the top ranks
      // So we narrow from 10 total picks to 5 total, weighted toward DV:
      //   • QG lane: 2 slots (tightened guardrail should filter out the losers)
      //   • DV lane: 3 slots (the consistent alpha generator)
      // Overflow still cross-fills so we always return 5 when candidates exist.
      // Phase 4 (Apr 2026): slot allocation flipped based on attribution.
      // 24-month per-signal attribution showed fundDeepValue had NEGATIVE
      // −1.97% edge across 193 trades, while fundQualityGrowth had +1.97%
      // edge across 47 trades. Previous allocation (DV=3, QG=2) was
      // spending 60% of scanner slots on the worse signal.
      //
      // New: QG=4, DV=1. DV survives in the lane because occasionally a
      // deep-value pick with very high quality (ROE ≥ 15%, not just the
      // ≥ 10% guardrail floor) genuinely delivers — but it now has to
      // clear a tighter bar (adjustedScore ≥ 70 vs the 65 floor for QG).
      const MAX_PER_SECTOR = 2;
      const QG_SLOTS = 4;
      const DV_SLOTS = 1;
      const DV_MIN_SCORE = 70; // stricter than QG's 65 floor

      const baseFilter = (r) => {
        if (r.adjustedScore < 65) return false;
        if (r.recommendation === "HOLD") return false;
        // Phase 2: earnings blackout — excludes picks within 3 trading days
        // of their earnings announcement. ATR-based SL can't defend against
        // earnings-gap losses. UI still shows the 7-day warning badge.
        if (earningsBlackoutSet.has(r.symbol)) return false;
        if (r.fundamentalVerdict === "OVERVALUED" || r.fundamentalVerdict === "FULLY_VALUED" || r.fundamentalVerdict === "FAIR_VALUE") return false;
        const sector = normalizeSector(r.sector) || r.sector || "";
        if (EXCLUDED_SECTORS.has(sector)) return false;
        return true;
      };

      const qgCandidates = results
        .filter((r) => baseFilter(r) && r.fundamentalVerdict === "QUALITY_GROWTH")
        .sort((a, b) => b.adjustedScore - a.adjustedScore);

      // Phase 4: DV candidates must clear DV_MIN_SCORE (tighter than QG's
      // 65 floor), AND have ROE ≥ 15% (tighter than the 10% guardrail).
      // Both gates required because attribution showed DV = value trap.
      const dvCandidates = results
        .filter((r) => baseFilter(r) && r.fundamentalVerdict === "DEEP_VALUE")
        .filter((r) => r.adjustedScore >= DV_MIN_SCORE)
        .filter((r) => {
          const roe = getFundamentals(r.symbol)?.roe;
          return roe != null && roe >= 0.15;
        })
        .sort((a, b) => b.adjustedScore - a.adjustedScore);

      // Fill lanes — overflow goes to the other lane, but overflow FROM DV
      // is allowed (DV limit is tight because attribution-negative), while
      // overflow INTO DV is NOT allowed (Phase 4 intentionally biases toward
      // the positive-edge QG lane).
      const qgPicked = qgCandidates.slice(0, QG_SLOTS);
      const dvPicked = dvCandidates.slice(0, DV_SLOTS);
      const qgShortfall = QG_SLOTS - qgPicked.length;
      // If QG is short, pull from DV only if DV has cleared the high bar
      const dvExtra = dvCandidates.slice(DV_SLOTS, DV_SLOTS + qgShortfall);
      const merged = [...qgPicked, ...dvPicked, ...dvExtra];

      // Diversification pass: MAX_PER_SECTOR across both lanes combined
      const sectorCounts = {};
      const diversified = [];
      // Sort merged by score descending for final pick order
      merged.sort((a, b) => b.adjustedScore - a.adjustedScore);
      for (const r of merged) {
        if (diversified.length >= 10) break;
        const sector = normalizeSector(r.sector) || r.sector || "Unknown";
        sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
        if (sectorCounts[sector] > MAX_PER_SECTOR) continue;
        diversified.push(r);
      }

      filtered = diversified.map((r) => ({
          ...r,
          score: Math.round(r.adjustedScore),
        }));
    } else if (type === "sell") {
      filtered = results
        .filter((r) => r.score <= 40)
        .sort((a, b) => a.score - b.score)
        .slice(0, 10);
    } else {
      filtered = results.sort((a, b) => b.score - a.score).slice(0, 15);
    }

    const response = {
      type,
      universe,
      stocks: filtered,
      scannedCount: results.length,
      universeSize: stocksToScan.length,
      fullUniverseSize,
      truncatedForVercel,
      ...failureTracker.summary(),
      lastUpdated: new Date().toISOString(),
    };

    // High-conviction messaging: when strict filters (Phase 1) produce fewer
    // than 10 picks, communicate this as selectivity, not a gap.
    if (type === "buynow" && filtered.length < 10 && filtered.length > 0) {
      response.highConvictionMessage = `${filtered.length} high-conviction pick${filtered.length === 1 ? "" : "s"} found from ${results.length} scanned — only stocks with strong fundamentals (Deep Value or Quality Growth) and technical confirmation pass our filters.`;
    }

    // Attach the macro regime so the frontend can render the banner without
    // a second round-trip. Only for buynow — other scan types don't use it.
    if (type === "buynow" && macroRegime) {
      response.regime = macroRegime;
    }

    // ─── Paper-trade snapshot trigger ───
    // On the first buynow scan of the day, persist the top picks with the
    // current price + regime context so we can later compute forward returns.
    // Idempotent: hasSnapshotToday() prevents duplicates if the user opens
    // the platform multiple times in a day.
    if (type === "buynow" && filtered.length > 0 && !(await hasSnapshotToday("buynow_nifty100"))) {
      try {
        // Capture the current Nifty 50 level so we can compute "alpha vs Nifty"
        // for every pick later.
        const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
        const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
        const result = await snapshotPicks(filtered, "buynow_nifty100", {
          regime: macroRegime,
          niftyPrice,
          rationale: "Auto-snapshot from /api/scan/buynow",
        });
        console.log(`[PAPERTRADES] Snapshotted ${result.written} buynow picks (Nifty=${niftyPrice})`);
      } catch (e) {
        console.warn("[PAPERTRADES] Snapshot failed:", e.message);
      }
    }

    scanCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: "Scan failed: " + err.message });
  }
});

// ==================== CRON: PRE-COMPUTE BUY NOW ====================

/**
 * GET /api/cron/scan-precompute
 *
 * Called by Vercel Cron every 5 minutes. Runs the FULL 100-stock Buy Now
 * scan without the 50-stock truncation cap, and caches the result. The
 * regular /api/scan/buynow endpoint checks for this cache first — if
 * present, it serves the pre-computed result instantly (no truncation,
 * no live scan needed).
 *
 * This eliminates the #1 performance gap between Vercel and local:
 *   Before: Vercel scans 49 stocks → 3 picks
 *   After:  Cron scans 100 stocks → 8 picks, served from cache
 *
 * Vercel cron jobs have up to 60 seconds (vs 10s for user requests).
 * The scan typically completes in 15-25 seconds for 100 stocks.
 *
 * Security: Vercel cron requests include an Authorization header with
 * CRON_SECRET. We verify it if the env var is set.
 */
app.get("/api/cron/scan-precompute", async (req, res) => {
  // Optional security: verify Vercel cron secret
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const startTime = Date.now();
    console.log("[CRON] Starting full 100-stock Buy Now pre-compute...");

    const stocksToScan = getNifty100();
    const failureTracker = createFailureTracker();
    const results = [];
    const BATCH_SIZE = 10; // slightly larger batches since we have 60s

    for (let i = 0; i < stocksToScan.length; i += BATCH_SIZE) {
      const batch = stocksToScan.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (stock) => {
          try {
            const [quote, historical] = await Promise.all([
              fetchQuote(stock.symbol),
              fetchHistorical(stock.symbol),
            ]);
            if (!quote || !historical || historical.length < 30) return null;

            const analysis = analyzeStock(historical, quote);
            const intraday = intradayScan(analysis, quote);
            const midTerm = midTermAnalysis(analysis, quote, historical ? historical.map(d => d.close) : null);

            return {
              symbol: stock.symbol,
              name: stock.name,
              sector: stock.sector,
              price: quote.regularMarketPrice,
              change: quote.regularMarketChange,
              changePercent: quote.regularMarketChangePercent,
              score: analysis.score,
              recommendation: analysis.recommendation,
              reasoning: analysis.reasoning,
              midTerm,
              volume: analysis.indicators?.volume?.description || "N/A",
              rsi: analysis.indicators?.rsi || "N/A",
              trend: analysis.indicators?.trend?.trend || "N/A",
              atr: analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null,
            };
          } catch { return null; }
        })
      );
      results.push(...batchResults.filter(Boolean));
      if (i + BATCH_SIZE < stocksToScan.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    // Apply the full Buy Now scoring pipeline (same as the regular handler)
    let macroRegime = null;
    try { macroRegime = await getMacroRegime(); }
    catch { macroRegime = defaultCalmRegime(); }

    // Mirror of the live scanner's 40/60 weighting — see the primary scanner
    // handler above for the rationale. Kept here (instead of imported) because
    // this is the precompute path that runs on a schedule.
    const SCANNER_TECH_WEIGHT = 0.40;
    const SCANNER_FUND_WEIGHT = 0.60;

    for (const r of results) {
      const fundSnap = getFundamentals(r.symbol);
      let fundamentalScore = null;
      let fundamentalVerdict = null;
      if (fundSnap) {
        const fundResult = scoreFundamentals(fundSnap);
        if (fundResult) {
          fundamentalScore = fundResult.score;
          fundamentalVerdict = fundResult.verdict;
        }
      }

      const techScore = r.score;
      let combinedBase;
      let dataConfidence;
      if (fundamentalScore != null) {
        combinedBase = techScore * SCANNER_TECH_WEIGHT + fundamentalScore * SCANNER_FUND_WEIGHT;
        dataConfidence = "high";
      } else {
        combinedBase = techScore;
        dataConfidence = "medium";
      }

      const { delta, reason, sector } = computeMacroDelta(macroRegime, r.sector);
      r.macroBoost = delta;
      r.macroReason = reason;
      r.macroSector = sector;
      r.technicalScore = techScore;
      r.fundamentalScore = fundamentalScore;
      r.fundamentalVerdict = fundamentalVerdict;
      r.dataConfidence = dataConfidence;
      r.baseScore = Math.round(combinedBase);
      r.adjustedScore = Math.max(0, Math.min(100, combinedBase + delta));

      // Phase 1: SL 3× ATR, Target 7× ATR — matches live scanner handler
      const atr = r.atr ?? null;
      if (atr && r.price) {
        r.stopLoss = parseFloat((r.price - atr * 3).toFixed(2));
        r.target = parseFloat((r.price + atr * 7).toFixed(2));
        r.riskReward = parseFloat(((r.target - r.price) / (r.price - r.stopLoss)).toFixed(2));
      }
    }

    // Apply filters + sector diversification — Phase 1: MAX_PER_SECTOR 3 → 2
    // to match the live handler. Prevents a single sector dominating the
    // scan output (which currently punishes us when the leading sector
    // happens to be Cement or Tourism — 0%/6% WR in the honest backtest).
    const MAX_PER_SECTOR = 2;
    const sectorCounts = {};
    const candidates = results
      .filter((r) => {
        if (r.adjustedScore < 65) return false;
        if (r.recommendation === "HOLD") return false;
        if (r.fundamentalVerdict === "OVERVALUED" || r.fundamentalVerdict === "FULLY_VALUED" || r.fundamentalVerdict === "FAIR_VALUE") return false;
        return true;
      })
      .sort((a, b) => b.adjustedScore - a.adjustedScore);

    const diversified = [];
    for (const r of candidates) {
      if (diversified.length >= 10) break;
      const sector = normalizeSector(r.sector) || r.sector || "Unknown";
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
      if (sectorCounts[sector] > MAX_PER_SECTOR) continue;
      diversified.push(r);
    }

    const filtered = diversified.map((r) => ({
      ...r,
      score: Math.round(r.adjustedScore),
    }));

    const response = {
      type: "buynow",
      universe: "nifty100",
      stocks: filtered,
      scannedCount: results.length,
      universeSize: stocksToScan.length,
      fullUniverseSize: stocksToScan.length,
      truncatedForVercel: false, // full scan — no truncation!
      precomputed: true,
      precomputedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };

    if (filtered.length < 10 && filtered.length > 0) {
      response.highConvictionMessage = `${filtered.length} high-conviction pick${filtered.length === 1 ? "" : "s"} found from ${results.length} scanned — only stocks with strong fundamentals (Deep Value or Quality Growth) and technical confirmation pass our filters.`;
    }

    if (macroRegime) response.regime = macroRegime;

    // Cache for 8 hours (covers full IST trading session 9:15–15:30).
    // Cron runs at 3:50 UTC = 9:20 IST (5 min after market open, weekdays only).
    //
    // Two-tier write:
    //   L1 (NodeCache, per-instance): 8h TTL — serves same-lambda re-hits
    //   L2 (Vercel KV, shared): 8h TTL — serves all OTHER lambdas instantly
    // Without L2, every freshly-booted lambda would miss the cron output and
    // fall back to a 10-15s live scan.
    const PRECOMPUTE_CACHE_KEY = "precomputed_buynow_nifty100";
    scanCache.set(PRECOMPUTE_CACHE_KEY, response, 28800);
    try {
      const kv = await getKVClientForPortfolio();
      if (kv) await kv.set(`scan:${PRECOMPUTE_CACHE_KEY}`, response, { ex: 28800 });
    } catch (e) {
      console.warn("[CRON] KV scan cache write failed:", e.message);
    }

    // Also trigger paper-trade snapshot (once per day)
    if (filtered.length > 0 && !(await hasSnapshotToday("buynow_nifty100"))) {
      try {
        const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
        const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
        const snapResult = await snapshotPicks(filtered, "buynow_nifty100", {
          regime: macroRegime,
          niftyPrice,
          rationale: "Auto-snapshot from cron pre-compute (full 100-stock scan)",
        });
        console.log(`[CRON] Paper-trade snapshot: ${snapResult.written} picks captured`);
      } catch (e) {
        console.warn("[CRON] Snapshot failed:", e.message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[CRON] Pre-compute done: ${results.length} scanned, ${filtered.length} picks, ${elapsed}s`);

    res.json({
      ok: true,
      scanned: results.length,
      picks: filtered.length,
      elapsed: `${elapsed}s`,
      cachedUntil: new Date(Date.now() + 360000).toISOString(),
    });
  } catch (err) {
    console.error("[CRON] Pre-compute failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cron/warm-caches
 *
 * Hourly cron (see vercel.json) that keeps the two expensive-to-build
 * NodeCaches primed — macro regime and NSE event calendar. Both block the
 * portfolio endpoint on cold start if the cache is empty, and both take
 * 10-40s to build from scratch (RSS fetches + OpenAI call for regime, NSE
 * cookie handshake that usually times out on Vercel US IPs for events).
 *
 * By refreshing them hourly on the cron's own time, every user request
 * finds both caches populated and returns in <5s even on cold start.
 *
 * Security: CRON_SECRET bearer auth (matches the other two crons).
 * Runtime: ~20-30s typical; well under the 60s function ceiling.
 */
app.get("/api/cron/warm-caches", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const started = Date.now();
  const results = {};

  // Refresh macro regime in parallel with NSE events — both are independent.
  await Promise.allSettled([
    refreshMacroRegime().then(
      (r) => { results.macroRegime = { ok: true, regime: r?.regime || r?.label || "unknown" }; },
      (e) => { results.macroRegime = { ok: false, error: e.message }; }
    ),
    fetchNseEventCalendar().then(
      (events) => {
        catalystCache.set("nse_events", events);
        results.nseEvents = { ok: true, count: events?.length || 0 };
      },
      (e) => { results.nseEvents = { ok: false, error: e.message }; }
    ),
  ]);

  res.json({ ok: true, elapsedMs: Date.now() - started, ...results });
});

/**
 * GET /api/cron/enrich-fundamentals
 *
 * Weekly Vercel cron (Sundays pre-market, see vercel.json). Fetches fresh
 * quality metrics — ROE, Debt/Equity, profit margin, YoY revenue growth —
 * from Yahoo Finance for all ~112 stocks in the universe, then persists the
 * enriched snapshot to Vercel KV.
 *
 * Why a cron and not on-demand:
 *   Fundamentals move slowly. Quarterly earnings → quarterly restatements.
 *   A weekly refresh catches every quarterly update comfortably without
 *   hammering Yahoo during every page load. The in-memory cache (primed
 *   from KV at function cold-start) serves all read requests in microseconds.
 *
 * Runtime budget:
 *   Vercel cron functions have a 60-second max duration. Empirically, 112
 *   stocks at concurrency=4 completes in ~15-20 seconds — plenty of margin.
 *   The existing fundamentals.json on disk is used as the starting seed so
 *   we only need to fill in the 4 quality fields, not refetch prices.
 *
 * Security: matches scan-precompute — checks CRON_SECRET bearer token if set.
 *
 * Manual testing: curl http://localhost:3000/api/cron/enrich-fundamentals
 * (no auth header required in local dev because CRON_SECRET isn't set).
 */
app.get("/api/cron/enrich-fundamentals", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const startTime = Date.now();
    console.log("[CRON] Starting weekly fundamentals enrichment...");

    // Seed the enrichment from the current cached snapshot. In production
    // (KV-primed) this is whatever last week's cron wrote. In local dev it's
    // the committed fundamentals.json. Either way we preserve the existing
    // symbol list + NSE price data and overlay fresh Yahoo quality metrics.
    const current = loadFundamentalsFromDisk();
    if (!current || !current.snapshots) {
      return res.status(500).json({
        error: "No seed snapshot available. Run refresh-fundamentals.mjs first.",
      });
    }

    // Deep-clone so we don't mutate the cached object while it's being read
    // by concurrent request handlers. The scoring hot-path reads this same
    // cache synchronously, so an in-place mutation race could briefly expose
    // half-enriched rows to the scanner.
    const data = JSON.parse(JSON.stringify(current));

    // Dynamic import so the enrichFundamentals module (which pulls in
    // yahoo-finance2, ~400KB) only loads when the cron actually fires — not
    // on every cold start.
    const { enrichSnapshot } = await import("./enrichFundamentals.js");

    const result = await enrichSnapshot(data, {
      concurrency: 4,
      // No onProgress — Vercel logs truncate at ~4KB so 112 lines would get
      // dropped anyway. We log the summary at the end instead.
    });

    // Persist to KV (production) or disk (local dev, as a convenience).
    const savedToKV = await saveFundamentalsToKV(data);
    let savedToDisk = false;
    if (!savedToKV && existsSync(FUNDAMENTALS_PATH_SERVER)) {
      try {
        writeFileSync(FUNDAMENTALS_PATH_SERVER, JSON.stringify(data, null, 2), "utf-8");
        savedToDisk = true;
      } catch (err) {
        console.error("[CRON] disk write failed:", err.message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[CRON] Enrichment complete in ${elapsed}s. ` +
      `Enriched: ${result.enriched}, Skipped: ${result.skipped}, Failed: ${result.failed}. ` +
      `Sink: ${savedToKV ? "KV" : (savedToDisk ? "disk" : "none")}`
    );

    res.json({
      ok: true,
      enriched: result.enriched,
      skipped: result.skipped,
      failed: result.failed,
      elapsedSec: Number(elapsed),
      sink: savedToKV ? "kv" : (savedToDisk ? "disk" : "none"),
      enrichedAt: data.enrichedAt,
    });
  } catch (err) {
    console.error("[CRON] Fundamentals enrichment failed:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Volume Breakout scanner
 * Finds stocks where today's volume is spiking well above historical average.
 * Uses a short TTL cache (60s) so data stays fresh intraday.
 */
const volumeBreakoutCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });

app.get("/api/scan/volume-breakout", async (req, res) => {
  try {
    const cacheKey = "scan_volume_breakout";
    const cached = volumeBreakoutCache.get(cacheKey);
    if (cached) return res.json(cached);

    let stocksToScan = getNifty100();
    // No truncation — maxDuration=60s handles the timeout
    const failureTracker = createFailureTracker();
    const results = [];

    // What fraction of the trading day has elapsed (IST 9:15–15:30)?
    const now = new Date();
    const istMinutes =
      now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30;
    const marketStart = 9 * 60 + 15; // 9:15 IST in minutes
    const marketEnd = 15 * 60 + 30; // 15:30 IST
    const elapsedFraction = Math.min(
      1,
      Math.max(0.1, (istMinutes - marketStart) / (marketEnd - marketStart))
    );

    const BATCH_SIZE = 8;
    for (let i = 0; i < stocksToScan.length; i += BATCH_SIZE) {
      const batch = stocksToScan.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (stock) => {
          try {
            const [quote, historical] = await Promise.all([
              fetchQuote(stock.symbol),
              fetchHistorical(stock.symbol),
            ]);
            if (!quote) { failureTracker.record(stock.symbol, "quote_null"); return null; }
            if (!historical) { failureTracker.record(stock.symbol, "historical_null"); return null; }
            if (historical.length < 20) { failureTracker.record(stock.symbol, "insufficient_bars"); return null; }

            const currentVolume = quote.regularMarketVolume;
            if (!currentVolume) { failureTracker.record(stock.symbol, "no_volume"); return null; }

            // Average daily volume over last 20 trading days
            const avgVolume =
              historical
                .slice(-20)
                .reduce((s, d) => s + (d.volume || 0), 0) / 20;

            if (!avgVolume || avgVolume === 0) return null;

            // Annualised ratio: compare today's partial volume to a full day
            const projectedVolume = currentVolume / elapsedFraction;
            const volumeRatio = projectedVolume / avgVolume;

            // Raw ratio (unscaled) – useful for display
            const rawRatio = currentVolume / avgVolume;

            // Only flag genuine spikes
            if (volumeRatio < 1.5) return null;

            const changePercent = quote.regularMarketChangePercent || 0;
            const direction =
              changePercent > 0.3 ? "BULLISH" : changePercent < -0.3 ? "BEARISH" : "NEUTRAL";

            // Momentum quality: high volume + big price move = strong signal
            const signalStrength =
              volumeRatio >= 4
                ? "EXPLOSIVE"
                : volumeRatio >= 2.5
                ? "VERY HIGH"
                : volumeRatio >= 1.5
                ? "HIGH"
                : "MODERATE";

            let action, actionColor;
            if (direction === "BULLISH") {
              action = "BUY / LONG";
              actionColor = "green";
            } else if (direction === "BEARISH") {
              action = "SELL / SHORT";
              actionColor = "red";
            } else {
              action = "WATCH";
              actionColor = "yellow";
            }

            // Simple ATR-based stop / target from historical
            const closes = historical.map((d) => d.close);
            const highs = historical.map((d) => d.high);
            const lows = historical.map((d) => d.low);

            // rough ATR (last 14 days)
            let atr = null;
            if (historical.length >= 15) {
              const trs = [];
              for (let j = 1; j < Math.min(15, historical.length); j++) {
                trs.push(
                  Math.max(
                    highs[highs.length - j] - lows[lows.length - j],
                    Math.abs(highs[highs.length - j] - closes[closes.length - j - 1]),
                    Math.abs(lows[lows.length - j] - closes[closes.length - j - 1])
                  )
                );
              }
              atr = trs.reduce((s, v) => s + v, 0) / trs.length;
            }

            const price = quote.regularMarketPrice;
            const stopLoss = atr
              ? direction === "BULLISH"
                ? (price - atr * 1.2).toFixed(2)
                : (price + atr * 1.2).toFixed(2)
              : null;
            const target = atr
              ? direction === "BULLISH"
                ? (price + atr * 2).toFixed(2)
                : (price - atr * 2).toFixed(2)
              : null;

            const reasoning =
              `Volume is ${volumeRatio.toFixed(1)}x the 20-day average (${rawRatio.toFixed(1)}x raw so far today). ` +
              `Price is ${changePercent >= 0 ? "up" : "down"} ${Math.abs(changePercent).toFixed(2)}% ` +
              `suggesting ${direction === "BULLISH" ? "institutional buying" : direction === "BEARISH" ? "heavy selling / distribution" : "indecision — wait for price confirmation"}.` +
              (signalStrength === "EXPLOSIVE" ? " EXPLOSIVE breakout — high conviction." : "");

            return {
              symbol: stock.symbol,
              name: stock.name,
              sector: stock.sector,
              price,
              change: quote.regularMarketChange,
              changePercent,
              currentVolume,
              avgVolume,
              volumeRatio,
              rawRatio,
              projectedVolume,
              signalStrength,
              direction,
              action,
              actionColor,
              stopLoss,
              target,
              reasoning,
              dayHigh: quote.regularMarketDayHigh,
              dayLow: quote.regularMarketDayLow,
            };
          } catch (e) {
            return null;
          }
        })
      );

      results.push(...batchResults.filter(Boolean));
      if (i + BATCH_SIZE < stocksToScan.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // Sort by volume ratio descending, show top 12
    const sorted = results
      .sort((a, b) => b.volumeRatio - a.volumeRatio)
      .slice(0, 12);

    const response = {
      stocks: sorted,
      scannedCount: stocksToScan.length,
      elapsedFraction: Math.round(elapsedFraction * 100),
      ...failureTracker.summary(),
      lastUpdated: new Date().toISOString(),
    };

    volumeBreakoutCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("Volume breakout scan error:", err.message);
    res.status(500).json({ error: "Volume breakout scan failed: " + err.message });
  }
});

/**
 * Market overview / indices
 */
// ==================== FUNDAMENTAL VALUE SCANNER ====================

const fundamentalsCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// ==================== SECTOR HEATMAP ====================

// ==================== MARKET VERDICT ====================

/**
 * GET /api/market-verdict
 *
 * Combines all 5 signals into a single "is today a good day to buy?" verdict.
 * Reads from existing cached data (macro regime, sector heatmap, scan results)
 * so it's fast (~50ms) and doesn't make any new external calls.
 *
 * Returns: { verdict, signals[], overallScore, actionText }
 */
const verdictCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

app.get("/api/market-verdict", async (req, res) => {
  try {
    const cached = verdictCache.get("verdict");
    if (cached) return res.json(cached);

    const signals = [];
    let score = 0; // -10 to +10 scale

    // Signal 1: Macro Regime
    const regime = macroRegimeCache.get(MACRO_CACHE_KEY) || defaultCalmRegime();
    const regimeId = regime.regime || "CALM";
    const severity = regime.severity || 1;
    let regimeSignal, regimeAction;

    if (regimeId === "CALM") {
      regimeSignal = "green"; regimeAction = "Safe to deploy capital. No macro headwinds."; score += 3;
    } else if (regimeId === "RATE_CUT" || regimeId === "WAR_DE_ESCALATION" || regimeId === "POLICY_STIMULUS") {
      regimeSignal = "green"; regimeAction = "Favorable environment. Risk-on rotation likely."; score += 4;
    } else if (regimeId === "OIL_SHOCK" && severity >= 4) {
      regimeSignal = "red"; regimeAction = "High oil = inflation risk. Be selective, favor energy longs only."; score -= 4;
    } else if (regimeId === "WAR_ESCALATION" && severity >= 4) {
      regimeSignal = "red"; regimeAction = "Conflict escalation. Trim risk assets. Favor defence, pharma."; score -= 5;
    } else if (regimeId === "GLOBAL_RISK_OFF") {
      regimeSignal = "red"; regimeAction = "Global selloff. Move to defensives."; score -= 4;
    } else if (regimeId === "RATE_HIKE") {
      regimeSignal = "yellow"; regimeAction = "Tightening cycle. Avoid rate-sensitive sectors."; score -= 2;
    } else {
      regimeSignal = "yellow"; regimeAction = "Mixed signals. Be selective."; score -= 1;
    }

    signals.push({
      name: "Macro Regime",
      signal: regimeSignal,
      value: `${regimeId.replace(/_/g, " ")} · Severity ${severity}/5`,
      action: regimeAction,
      icon: regimeSignal === "green" ? "✅" : regimeSignal === "red" ? "🔴" : "⚠️",
    });

    // Signal 2: Market Breadth (from heatmap cache or live)
    let breadthSignal = "yellow", breadthAction = "Mixed breadth.";
    let advancing = 0, declining = 0;
    try {
      const heatmap = sectorHeatmapCache.get("heatmap");
      if (heatmap?.marketBreadth) {
        advancing = heatmap.marketBreadth.advancing || 0;
        declining = heatmap.marketBreadth.declining || 0;
      } else {
        // Quick fetch if not cached
        const stocks = getNifty100().slice(0, 30); // sample 30 for speed
        const quotes = await Promise.all(stocks.map((s) => fetchQuote(s.symbol).catch(() => null)));
        advancing = quotes.filter((q) => q && (q.regularMarketChangePercent || 0) > 0).length;
        declining = quotes.filter((q) => q && (q.regularMarketChangePercent || 0) < 0).length;
      }
      const total = advancing + declining || 1;
      const ratio = (advancing / total) * 100;
      if (ratio >= 70) { breadthSignal = "green"; breadthAction = `Strong buying — ${ratio.toFixed(0)}% stocks advancing.`; score += 3; }
      else if (ratio >= 55) { breadthSignal = "green"; breadthAction = `More stocks up than down (${ratio.toFixed(0)}%). Mild buying day.`; score += 1; }
      else if (ratio >= 45) { breadthSignal = "yellow"; breadthAction = `Mixed — no clear direction (${ratio.toFixed(0)}% advancing).`; score += 0; }
      else if (ratio >= 30) { breadthSignal = "yellow"; breadthAction = `More stocks falling (${ratio.toFixed(0)}% advancing). Trim weak positions.`; score -= 2; }
      else { breadthSignal = "red"; breadthAction = `Risk-off — ${(100 - ratio).toFixed(0)}% stocks declining. Protect capital.`; score -= 4; }
    } catch { /* silent */ }

    signals.push({
      name: "Market Breadth",
      signal: breadthSignal,
      value: `${advancing}↑ ${declining}↓`,
      action: breadthAction,
      icon: breadthSignal === "green" ? "📈" : breadthSignal === "red" ? "📉" : "📊",
    });

    // Signal 3: Buy Now pick count
    let pickSignal = "yellow", pickAction = "Moderate pickings.";
    let pickCount = 0;
    try {
      const scanKey = "precomputed_buynow_nifty100";
      const scanData = scanCache.get(scanKey) || scanCache.get("scan_buynow_nifty100");
      pickCount = scanData?.stocks?.length || 0;
      if (pickCount >= 8) { pickSignal = "green"; pickAction = `${pickCount} stocks pass strict quality filters. Plenty of value.`; score += 2; }
      else if (pickCount >= 5) { pickSignal = "yellow"; pickAction = `${pickCount} picks. Be selective — focus on DEEP VALUE names.`; score += 1; }
      else if (pickCount >= 1) { pickSignal = "yellow"; pickAction = `Only ${pickCount} stocks pass. Market is mostly expensive.`; score -= 1; }
      else { pickSignal = "red"; pickAction = "Zero stocks pass quality filter. Stay in cash."; score -= 3; }
    } catch { /* silent */ }

    signals.push({
      name: "Buy Opportunities",
      signal: pickSignal,
      value: `${pickCount} picks available`,
      action: pickAction,
      icon: pickCount >= 8 ? "🎯" : pickCount >= 1 ? "🔍" : "⛔",
    });

    // Signal 4: Regime Transition
    let transSignal = "neutral", transAction = "No recent regime shift.";
    if (lastRegimeTransition && lastRegimeTransition.signal) {
      const sig = lastRegimeTransition.signal;
      if (sig.action.includes("BUY")) { transSignal = "green"; transAction = `Regime shifted → ${sig.action}. ${sig.summary?.slice(0, 80)}`; score += 3; }
      else if (sig.action.includes("SELL") || sig.action.includes("TRIM")) { transSignal = "red"; transAction = `Regime shifted → ${sig.action}. ${sig.summary?.slice(0, 80)}`; score -= 3; }
      else { transSignal = "yellow"; transAction = `Regime shifted. ${sig.summary?.slice(0, 80)}`; }
    }

    signals.push({
      name: "Regime Transition",
      signal: transSignal,
      value: lastRegimeTransition ? `${lastRegimeTransition.from} → ${lastRegimeTransition.to}` : "Stable",
      action: transAction,
      icon: transSignal === "green" ? "⚡" : transSignal === "red" ? "⚡" : "—",
    });

    // Signal 5: Track Record trust
    let trustSignal = "yellow", trustAction = "Moderate confidence.";
    try {
      const trades = await readAllTrades();
      const withReturns = trades.filter((t) => t.returns?.beatsNifty != null || t.niftyAtSnapshot);
      const total = withReturns.length;
      // Approximate beats-nifty from recent data
      if (total >= 30) {
        // Use the track performance endpoint logic would be too heavy here,
        // so just check the total count for trust calibration
        trustSignal = "green"; trustAction = `${total}+ picks tracked. Signal has proven edge.`; score += 1;
      } else if (total >= 10) {
        trustSignal = "yellow"; trustAction = `${total} picks tracked. Still calibrating — early data.`;
      } else {
        trustSignal = "yellow"; trustAction = "< 10 picks tracked. Very early — treat signals as suggestions."; score -= 1;
      }
    } catch { /* silent */ }

    signals.push({
      name: "Signal Maturity",
      signal: trustSignal,
      value: trustSignal === "green" ? "Proven" : "Calibrating",
      action: trustAction,
      icon: trustSignal === "green" ? "✅" : "🔄",
    });

    // Compute overall verdict
    let verdict, verdictColor, verdictAction;
    if (score >= 6) {
      verdict = "STRONG BUY DAY"; verdictColor = "green";
      verdictAction = "Multiple signals align bullish. Deploy capital with confidence.";
    } else if (score >= 3) {
      verdict = "BUY DAY"; verdictColor = "green";
      verdictAction = "Environment is favorable. Follow the Buy Now picks.";
    } else if (score >= 0) {
      verdict = "SELECTIVE"; verdictColor = "yellow";
      verdictAction = "Mixed signals. Only buy DEEP VALUE picks with strict stop-losses.";
    } else if (score >= -3) {
      verdict = "CAUTIOUS"; verdictColor = "yellow";
      verdictAction = "More headwinds than tailwinds. Trim weak positions. Hold cash.";
    } else {
      verdict = "STAY OUT"; verdictColor = "red";
      verdictAction = "Not a buying day. Protect capital. Wait for regime shift.";
    }

    const response = {
      verdict,
      verdictColor,
      verdictAction,
      score,
      signals,
      generatedAt: new Date().toISOString(),
    };

    verdictCache.set("verdict", response);
    res.json(response);
  } catch (err) {
    console.error("Verdict error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sector-heatmap
 *
 * Returns all Nifty 100 sectors with average daily change %, winners/losers
 * count, and top movers per sector. Cached 2 minutes.
 */
const sectorHeatmapCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

app.get("/api/sector-heatmap", async (req, res) => {
  try {
    const cached = sectorHeatmapCache.get("heatmap");
    if (cached) return res.json(cached);

    const stocksToScan = getNifty100();
    const quotes = await Promise.all(
      stocksToScan.map((s) => fetchQuote(s.symbol).catch(() => null))
    );

    const bySector = {};
    for (let i = 0; i < stocksToScan.length; i++) {
      const q = quotes[i];
      const stock = stocksToScan[i];
      if (!q) continue;
      const sector = normalizeSector(stock.sector) || stock.sector || "Unknown";
      if (!bySector[sector]) bySector[sector] = { sector, stocks: [], totalChange: 0, count: 0 };
      const chg = q.regularMarketChangePercent || 0;
      bySector[sector].stocks.push({
        symbol: stock.symbol,
        name: stock.name,
        change: chg,
        price: q.regularMarketPrice,
      });
      bySector[sector].totalChange += chg;
      bySector[sector].count += 1;
    }

    const sectors = Object.values(bySector).map((s) => {
      s.avgChange = s.count > 0 ? parseFloat((s.totalChange / s.count).toFixed(2)) : 0;
      s.winners = s.stocks.filter((st) => st.change > 0).length;
      s.losers = s.stocks.filter((st) => st.change < 0).length;
      s.topGainer = s.stocks.sort((a, b) => b.change - a.change)[0] || null;
      s.topLoser = s.stocks.sort((a, b) => a.change - b.change)[0] || null;
      // Remove full stock list to keep response compact
      delete s.totalChange;
      s.stockCount = s.count;
      delete s.count;
      delete s.stocks;
      return s;
    }).sort((a, b) => b.avgChange - a.avgChange);

    const response = {
      sectors,
      marketBreadth: {
        totalStocks: quotes.filter(Boolean).length,
        advancing: quotes.filter((q) => q && (q.regularMarketChangePercent || 0) > 0).length,
        declining: quotes.filter((q) => q && (q.regularMarketChangePercent || 0) < 0).length,
        unchanged: quotes.filter((q) => q && (q.regularMarketChangePercent || 0) === 0).length,
      },
      lastUpdated: new Date().toISOString(),
    };

    sectorHeatmapCache.set("heatmap", response);
    res.json(response);
  } catch (err) {
    console.error("Sector heatmap error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== FII / DII FLOW DATA ====================

/**
 * GET /api/fii-dii
 *
 * Returns FII and DII net buy/sell data from NSE. This is one of the strongest
 * leading indicators for Indian markets — when FIIs are net sellers, the market
 * typically corrects within 2-5 days.
 *
 * Falls back to a "data unavailable" response on Vercel (NSE blocks non-Indian IPs).
 * Cached for 30 minutes since the data updates only once per day (after market close).
 */
const fiiDiiCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

app.get("/api/fii-dii", async (req, res) => {
  try {
    const cached = fiiDiiCache.get("fii_dii");
    if (cached) return res.json(cached);

    // Try NSE's FII/DII activity endpoint
    let fiiDiiData = null;
    try {
      const data = await nseGet("/api/fiidiiActivity/WDM");
      if (data && Array.isArray(data)) {
        fiiDiiData = data;
      }
    } catch (e) {
      console.warn("NSE FII/DII fetch failed:", e.message);
    }

    // Alternative: try the market turnover endpoint
    if (!fiiDiiData) {
      try {
        const data = await nseGet("/api/marketTurnover");
        if (data?.data) fiiDiiData = data.data;
      } catch (e) {
        // Silent fallback
      }
    }

    if (!fiiDiiData) {
      const response = {
        available: false,
        message: "FII/DII data unavailable (NSE access required from Indian IP). Available when running locally.",
        lastUpdated: new Date().toISOString(),
      };
      fiiDiiCache.set("fii_dii", response);
      return res.json(response);
    }

    // Parse and structure the FII/DII data
    const response = {
      available: true,
      data: fiiDiiData,
      lastUpdated: new Date().toISOString(),
    };
    fiiDiiCache.set("fii_dii", response);
    res.json(response);
  } catch (err) {
    console.error("FII/DII error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Return the fundamental snapshot + score + verdict for a single stock.
 * Reads from the daily snapshot file (fundamentals.json) — always works on Vercel.
 */
app.get("/api/fundamentals/:symbol", async (req, res) => {
  try {
    let symbol = req.params.symbol.toUpperCase();
    if (!symbol.endsWith(".NS") && !symbol.endsWith(".BO")) symbol += ".NS";

    const snap = getFundamentals(symbol);
    if (!snap) {
      return res.status(404).json({
        error: "No fundamental data for this symbol",
        symbol,
        snapshotGeneratedAt: getSnapshotGeneratedAt(),
      });
    }

    // Enrich with 200-day moving average from historical
    let dma200 = null;
    try {
      const historical = await fetchHistorical(symbol);
      if (historical && historical.length >= 200) {
        const closes = historical.map((d) => d.close);
        dma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
      }
    } catch { /* optional */ }

    const scored = scoreFundamentals(snap, dma200);

    res.json({
      ...scored,
      source: "nse_snapshot",
      snapshotGeneratedAt: getSnapshotGeneratedAt(),
    });
  } catch (err) {
    console.error("Fundamentals endpoint error:", err.message);
    res.status(500).json({ error: "Failed to load fundamentals: " + err.message });
  }
});

/**
 * Fundamental Value Scanner — returns categorised stocks for the UI.
 * Supported categories: deepValue, qualityGrowth, fairValue, fullyValued, overvalued, all
 */
const VALID_FUND_CATEGORIES = ["all", "deepValue", "qualityGrowth", "fairValue", "fullyValued", "overvalued"];

app.get("/api/scan/fundamentals", async (req, res) => {
  try {
    const category = req.query.category || "all";
    if (!VALID_FUND_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Unknown category "${category}". Valid categories: ${VALID_FUND_CATEGORIES.join(", ")}`,
      });
    }
    const cacheKey = `fund_${category}`;
    const cached = fundamentalsCache.get(cacheKey);
    if (cached) return res.json(cached);

    const allSnapshots = getAllFundamentals();
    if (allSnapshots.length === 0) {
      return res.json({
        stocks: [],
        category,
        error: "No fundamental data available. Run `node scripts/refresh-fundamentals.mjs` locally to generate fundamentals.json.",
        lastUpdated: new Date().toISOString(),
      });
    }

    // Score every snapshot (no 200DMA lookup for the scanner — it would be too slow
    // with 100+ historical fetches; the per-stock endpoint gets 200DMA on demand)
    const scored = allSnapshots.map((snap) => scoreFundamentals(snap)).filter(Boolean);

    // ─── Macro regime overlay (half-weight) ───
    // Fundamentals move slowly; macro shouldn't overpower them. Apply half-weight
    // macro delta so the fundamental value-investor character stays intact —
    // macro just surfaces the safest-in-context picks first. Clamped to ±8.
    let macroRegime = null;
    try {
      macroRegime = await getMacroRegime();
    } catch (e) {
      console.warn("[MACRO] fundamental scan: failed to load regime:", e.message);
      macroRegime = defaultCalmRegime();
    }
    const FUND_WEIGHT = 0.5;
    const FUND_CLAMP = 5;

    for (const s of scored) {
      const { delta: rawDelta, reason, sector: canonicalSector } =
        computeMacroDelta(macroRegime, s.snapshot?.sector || s.sector);
      const macroBoost = Math.max(
        -FUND_CLAMP,
        Math.min(FUND_CLAMP, parseFloat((rawDelta * FUND_WEIGHT).toFixed(1)))
      );
      s.macroBoost = macroBoost;
      s.macroReason = reason;
      s.macroSector = canonicalSector;
      s.baseScore = s.score;
      s.adjustedScore = Math.max(0, Math.min(100, s.score + macroBoost));
    }

    // Re-sort scored array by adjusted score so macro-tilted picks surface first
    // in the "all" view. Categorisation logic is unaffected — it still reads the
    // raw `score` for deepValue/fairValue/etc buckets (macro shouldn't override
    // fundamental valuation buckets).
    const scoredForSort = [...scored].sort((a, b) => (b.adjustedScore ?? b.score) - (a.adjustedScore ?? a.score));

    // Categorise (unchanged — still uses raw `score` for bucketing)
    const buckets = categoriseBatch(scored, 15);

    let stocks;
    if (category === "deepValue")         stocks = buckets.deepValue;
    else if (category === "qualityGrowth") stocks = buckets.qualityGrowth;
    else if (category === "fairValue")     stocks = buckets.fairValue;
    else if (category === "fullyValued")   stocks = buckets.fullyValued;
    else if (category === "overvalued")    stocks = buckets.overvalued;
    else                                    stocks = scoredForSort.slice(0, 30);

    const response = {
      category,
      stocks,
      scannedCount: scored.length,
      source: "nse_snapshot",
      snapshotGeneratedAt: getSnapshotGeneratedAt(),
      regime: macroRegime,
      lastUpdated: new Date().toISOString(),
    };

    // Paper-trade snapshot: capture deep-value picks once per day. Picks are
    // pulled from the deepValue bucket regardless of which category was
    // requested, so the trade record always reflects the best fundamental
    // candidates from this snapshot.
    if (buckets.deepValue.length > 0 && !(await hasSnapshotToday("fundamental_deep_value"))) {
      try {
        const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
        const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
        const result = await snapshotPicks(buckets.deepValue.slice(0, 10), "fundamental_deep_value", {
          regime: macroRegime,
          niftyPrice,
          rationale: "Auto-snapshot: top 10 DEEP_VALUE picks",
        });
        console.log(`[PAPERTRADES] Snapshotted ${result.written} fundamental deep-value picks`);
      } catch (e) {
        console.warn("[PAPERTRADES] Fundamental snapshot failed:", e.message);
      }
    }

    fundamentalsCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("Fundamental scan error:", err.message);
    res.status(500).json({ error: "Fundamental scan failed: " + err.message });
  }
});

// ==================== SME / SMALL-CAP SCANNER ====================

/**
 * Sector map for the ~130 small-caps in the Yahoo fallback path.
 *
 * WHY THIS EXISTS: NSE's index-stockIndices endpoint returns a `meta.industry`
 * field for every stock — that's the primary sector source for small-caps.
 * But NSE blocks Vercel's US IPs, so on production we fall back to Yahoo
 * Finance's chart endpoint, which does NOT return sector data. Without this
 * map, every Yahoo-sourced small-cap would land with `sector: null` and the
 * macro overlay would have no effect on the Small-Cap Scanner in production.
 *
 * The values are chosen to match the canonical sectors in macroRegime.js
 * (normalizeSector handles substring matching generously, so "Pharma",
 * "IT Services", "Oil & Gas" etc. all map cleanly).
 */
const SMALLCAP_SECTOR_MAP = {
  // Banking
  BANDHANBNK: "Banking", IDBI: "Banking", KARURVYSYA: "Banking", RBLBANK: "Banking",
  UCOBANK: "Banking", CENTRALBK: "Banking", IOB: "Banking", KTKBANK: "Banking",
  UJJIVANSFB: "Banking", EQUITASBNK: "Banking",

  // NBFC (includes insurance, brokers, exchanges, microfinance)
  CDSL: "NBFC", ANGELONE: "NBFC", MANAPPURAM: "NBFC", IEX: "NBFC", IFCI: "NBFC",
  PIRAMALFIN: "NBFC", CANFINHOME: "NBFC", STARHEALTH: "NBFC", CHOLAHLDNG: "NBFC",
  PTC: "NBFC", CREDITACC: "NBFC", POONAWALLA: "NBFC", PNBHOUSING: "NBFC",

  // IT Services
  REDINGTON: "IT Services", BSOFT: "IT Services", TATATECH: "IT Services",
  ZENSARTECH: "IT Services", AFFLE: "IT Services", CYIENT: "IT Services",
  INTELLECT: "IT Services", ECLERX: "IT Services", TANLA: "IT Services",
  JUSTDIAL: "IT Services", NETWEB: "IT Services", MASTEK: "IT Services",
  QUESS: "IT Services", BLS: "IT Services",

  // Pharma / Healthcare
  NATCOPHARM: "Pharma", SYNGENE: "Pharma", LALPATHLAB: "Pharma", GRANULES: "Pharma",
  EMCURE: "Pharma", KIMS: "Pharma", GLAND: "Pharma",

  // Chemicals
  NAVINFLUOR: "Chemicals", TATACHEM: "Chemicals", CLEAN: "Chemicals",
  DEEPAKNTR: "Chemicals", AARTIIND: "Chemicals", ATUL: "Chemicals", RAIN: "Chemicals",
  GNFC: "Chemicals", RALLIS: "Chemicals", RCF: "Chemicals", HSCL: "Chemicals",
  FACT: "Chemicals", DEEPAKFERT: "Chemicals", DCMSHRIRAM: "Chemicals",
  GHCL: "Chemicals", BAYERCROP: "Chemicals",

  // Oil & Gas
  CHENNPETRO: "Oil & Gas", MGL: "Oil & Gas", IGL: "Oil & Gas", CASTROLIND: "Oil & Gas",

  // Power / Utilities
  RPOWER: "Power", JPPOWER: "Power", CESC: "Power", INOXWIND: "Power", INOXGREEN: "Power",

  // Automobile (includes auto components, tyres, EV)
  JKTYRE: "Automobile", CEATLTD: "Automobile", FORCEMOT: "Automobile",
  OLAELEC: "Automobile", OLECTRA: "Automobile",

  // Metals / Mining
  JINDALSAW: "Metals", GRAVITA: "Metals", MOIL: "Metals", HINDCOPPER: "Metals",
  GALLANTT: "Metals", WELCORP: "Metals", NAVA: "Metals", LLOYDSENT: "Metals",

  // Real Estate
  ANANTRAJ: "Real Estate", BRIGADE: "Real Estate", SOBHA: "Real Estate",

  // Infrastructure / Construction
  DELHIVERY: "Infrastructure", NBCC: "Infrastructure", IRCON: "Infrastructure",
  NCC: "Infrastructure", IRB: "Infrastructure", RITES: "Infrastructure",
  KNRCON: "Infrastructure", KEC: "Infrastructure", SCI: "Infrastructure",
  CENTURYPLY: "Infrastructure",

  // Capital Goods (includes graphite electrodes, electronics mfg, bearings)
  PGEL: "Capital Goods", CROMPTON: "Capital Goods", HEG: "Capital Goods",
  ENGINERSIN: "Capital Goods", GRAPHITE: "Capital Goods", JWL: "Capital Goods",
  BEML: "Capital Goods", TIMKEN: "Capital Goods", ACE: "Capital Goods",
  SCHNEIDER: "Capital Goods", ELGIEQUIP: "Capital Goods", KAYNES: "Capital Goods",
  AMBER: "Capital Goods", KIRLOSENG: "Capital Goods", OPTIEMUS: "Capital Goods",
  VGUARD: "Capital Goods",

  // Defence
  GRSE: "Defence",

  // Cement
  RAMCOCEM: "Cement", NUVOCO: "Cement",

  // Telecom
  HFCL: "Telecom", ITI: "Telecom", TEJASNET: "Telecom",

  // FMCG (includes sugar, agri, personal care, food)
  BALRAMCHIN: "FMCG", EIDPARRY: "FMCG", TRIDENT: "FMCG", EMAMILTD: "FMCG",
  JYOTHYLAB: "FMCG", RENUKA: "FMCG", WELSPUNLIV: "FMCG", DOMS: "FMCG",
  BIKAJI: "FMCG",

  // Retail
  ABFRL: "Retail", DEVYANI: "Retail", INDIAMART: "Retail", BATAINDIA: "Retail",
  MMTC: "Retail", PCJEWELLER: "Retail", CAMPUS: "Retail", SAFARI: "Retail",

  // Media / Entertainment
  ZEEL: "Media", PVRINOX: "Media", NAZARA: "Media", SUNTV: "Media",
};

const smeCache = new NodeCache({ stdTTL: 120, checkperiod: 30 });

/**
 * SME Scanner — fetches Smallcap 250 + Microcap 250 from NSE,
 * merges, deduplicates, and categorises into midterm picks.
 */
const VALID_SME_CATEGORIES = ["all", "midterm", "buynow", "sell", "volume", "top-gainers", "top-losers"];

app.get("/api/sme/scan", async (req, res) => {
  try {
    const category = req.query.category || "all"; // all, midterm, buynow, sell, volume, top-gainers, top-losers
    if (!VALID_SME_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Unknown SME category "${category}". Valid categories: ${VALID_SME_CATEGORIES.join(", ")}`,
      });
    }
    const cacheKey = `sme_${category}`;
    const cached = smeCache.get(cacheKey);
    if (cached) return res.json(cached);

    // Try NSE first (works from Indian IPs), Yahoo Finance as fallback (works globally)
    let allStocks = [];
    let dataSource = "nse";

    // Attempt NSE
    try {
      const [smallcap, microcap] = await Promise.all([
        fetchNseIndex("NIFTY SMALLCAP 250").catch(() => null),
        fetchNseIndex("NIFTY MICROCAP 250").catch(() => null),
      ]);

      const seen = new Set();
      for (const source of [smallcap, microcap]) {
        if (!source?.stocks) continue;
        for (const s of source.stocks) {
          if (!seen.has(s.symbol)) {
            seen.add(s.symbol);
            allStocks.push(s);
          }
        }
      }
    } catch (e) {
      console.error("NSE smallcap fetch failed:", e.message);
    }

    // Fallback: Yahoo Finance for top 150 most liquid smallcaps
    if (allStocks.length === 0) {
      dataSource = "yahoo";
      const TOP_SMALLCAPS = [
        "CDSL","ANGELONE","BANDHANBNK","PGEL","ZEEL","CHENNPETRO","IDBI","RPOWER","DELHIVERY",
        "KARURVYSYA","NATCOPHARM","RBLBANK","JPPOWER","HFCL","MANAPPURAM","JKTYRE","NBCC",
        "ANANTRAJ","REDINGTON","CROMPTON","NAVINFLUOR","HEG","ENGINERSIN","GRAPHITE","IRCON",
        "MGL","JWL","IEX","IFCI","BRIGADE","SYNGENE","LALPATHLAB","GRANULES","JINDALSAW",
        "PIRAMALFIN","PVRINOX","GRAVITA","TATACHEM","BSOFT","IGL","ABFRL","BALRAMCHIN",
        "BEML","NCC","DEVYANI","RAMCOCEM","TATATECH","CEATLTD","CASTROLIND","ZENSARTECH",
        "UCOBANK","CESC","AFFLE","CENTRALBK","CLEAN","IOB","DEEPAKNTR","CYIENT","AARTIIND",
        "IRB","INDIAMART","ITI","EMCURE","KIMS","TIMKEN","EMAMILTD","INTELLECT","SOBHA",
        "ACE","ECLERX","SCHNEIDER","EIDPARRY","TRIDENT","BATAINDIA","MMTC","RITES",
        "ELGIEQUIP","CANFINHOME","STARHEALTH","ATUL","PCJEWELLER","KTKBANK","LLOYDSENT",
        "NAZARA","UJJIVANSFB","EQUITASBNK","MOIL","RAIN","KNRCON","TANLA","RENUKA",
        "PTC","JYOTHYLAB","JUSTDIAL","GNFC","RALLIS","INOXWIND","INOXGREEN","RCF",
        "CHOLAHLDNG","KAYNES","HINDCOPPER","NETWEB","AMBER","HSCL","TEJASNET","FORCEMOT",
        "OLAELEC","GRSE","BLS","GALLANTT","OLECTRA","CREDITACC","SCI","WELCORP",
        "POONAWALLA","PNBHOUSING","KEC","KIRLOSENG","FACT","DEEPAKFERT","WELSPUNLIV",
        "NAVA","SUNTV","NUVOCO","DCMSHRIRAM","DOMS","BIKAJI","GLAND","OPTIEMUS",
        "CAMPUS","MASTEK","CENTURYPLY","VGUARD","GHCL","QUESS","SAFARI","BAYERCROP"
      ];

      // Fetch in batches of 10 from Yahoo
      for (let i = 0; i < TOP_SMALLCAPS.length; i += 10) {
        const batch = TOP_SMALLCAPS.slice(i, i + 10);
        const batchResults = await Promise.all(
          batch.map(async (sym) => {
            try {
              const quote = await fetchQuote(sym + ".NS");
              if (!quote) return null;
              return {
                symbol: sym + ".NS",
                name: sym,
                // Yahoo's chart endpoint doesn't return sector info — we paste
                // it in from SMALLCAP_SECTOR_MAP so the macro overlay has a
                // sector to match against on Vercel (where NSE is blocked).
                sector: SMALLCAP_SECTOR_MAP[sym] || null,
                lastPrice: quote.regularMarketPrice,
                change: quote.regularMarketChange,
                pChange: quote.regularMarketChangePercent,
                open: quote.regularMarketOpen,
                dayHigh: quote.regularMarketDayHigh,
                dayLow: quote.regularMarketDayLow,
                previousClose: quote.regularMarketPreviousClose,
                totalTradedVolume: quote.regularMarketVolume,
                yearHigh: quote.fiftyTwoWeekHigh,
                yearLow: quote.fiftyTwoWeekLow,
                source: "yahoo",
              };
            } catch { return null; }
          })
        );
        allStocks.push(...batchResults.filter(Boolean));
        if (i + 10 < TOP_SMALLCAPS.length) await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (allStocks.length === 0) {
      return res.json({ stocks: [], error: "No smallcap data available right now. Please try again later.", lastUpdated: new Date().toISOString() });
    }

    // ─── Macro regime lookup (once per scan) ───
    // Small-caps amplify macro moves: FII outflows hit them harder than
    // large-caps, defence small-caps rally more in war regimes, etc. We apply
    // a 1.3× amplifier on the canonical macro delta, clamped to ±20.
    let macroRegime = null;
    try {
      macroRegime = await getMacroRegime();
    } catch (e) {
      console.warn("[MACRO] smallcap scan: failed to load regime:", e.message);
      macroRegime = defaultCalmRegime();
    }
    const SMALLCAP_AMPLIFIER = 1.3;
    const SMALLCAP_CLAMP = 13;

    // Resolve each stock's sector. Lookup order:
    //   1. SMALLCAP_SECTOR_MAP by bare symbol — PREFERRED because its values
    //      are already canonical (match macroRegime.normalizeSector exactly).
    //      NSE's meta.industry labels like "Stockbroking & Allied" or "Telecom -
    //      Equipment & Accessories" don't normalize cleanly, so we prefer our
    //      canonical map when we have a match for the symbol.
    //   2. Inline sector on the stock (NSE meta.industry or Yahoo path)
    //   3. ALL_STOCKS (Nifty 100 + midcap curated list)
    //   4. fundamentals.json snapshot
    function resolveSmallcapSector(stock) {
      const bareSym = (stock.symbol || "").replace(/\.(NS|BO)$/, "");
      if (SMALLCAP_SECTOR_MAP[bareSym]) return SMALLCAP_SECTOR_MAP[bareSym];
      if (stock.sector) return stock.sector;
      const sym = stock.symbol?.endsWith(".NS") ? stock.symbol : (stock.symbol || "") + ".NS";
      const info = ALL_STOCKS.find((s) => s.symbol === sym);
      if (info?.sector) return info.sector;
      const fundSnap = getFundamentals(sym);
      return fundSnap?.sector || fundSnap?.industry || null;
    }

    // Enrich with derived metrics for scanning
    const enriched = allStocks.map((s) => {
      const volatility = s.dayHigh && s.dayLow && s.previousClose
        ? ((s.dayHigh - s.dayLow) / s.previousClose) * 100
        : 0;

      // Simple score based on available data
      let intradayScore = 0;
      let midtermScore = 50;

      // Intraday: favour high volatility + high volume + clear direction
      if (volatility > 5) intradayScore += 30;
      else if (volatility > 3) intradayScore += 20;
      else if (volatility > 2) intradayScore += 10;

      if (s.totalTradedVolume > 5000000) intradayScore += 25;
      else if (s.totalTradedVolume > 1000000) intradayScore += 15;
      else if (s.totalTradedVolume > 500000) intradayScore += 5;

      if (Math.abs(s.pChange || 0) > 3) intradayScore += 20;
      else if (Math.abs(s.pChange || 0) > 1.5) intradayScore += 10;

      const direction = (s.pChange || 0) > 0.5 ? "LONG" : (s.pChange || 0) < -0.5 ? "SHORT" : "NEUTRAL";

      // Midterm: favour positive 30d/365d momentum + reasonable volume
      if ((s.perChange30d || 0) > 5) midtermScore += 15;
      else if ((s.perChange30d || 0) < -10) midtermScore -= 15;

      if ((s.perChange365d || 0) > 20) midtermScore += 10;
      else if ((s.perChange365d || 0) < -20) midtermScore -= 10;

      if ((s.pChange || 0) > 0) midtermScore += 5;
      else midtermScore -= 5;

      // Stop-loss and target based on volatility
      const price = s.lastPrice;
      const atrEstimate = price * (volatility / 100);
      const stopLoss = direction === "LONG"
        ? (price - atrEstimate * 1.2).toFixed(2)
        : (price + atrEstimate * 1.2).toFixed(2);
      const target = direction === "LONG"
        ? (price + atrEstimate * 2).toFixed(2)
        : (price - atrEstimate * 2).toFixed(2);

      // Resolve sector + compute macro tilt (with small-cap amplifier)
      const sector = resolveSmallcapSector(s);
      const { delta: rawMacroDelta, reason: macroReason, sector: canonicalSector } =
        computeMacroDelta(macroRegime, sector);
      // Amplify small-cap macro sensitivity
      const macroBoost = Math.max(
        -SMALLCAP_CLAMP,
        Math.min(SMALLCAP_CLAMP, parseFloat((rawMacroDelta * SMALLCAP_AMPLIFIER).toFixed(1)))
      );
      // Adjust midterm score by macro tilt, clamped to 0-100. This is what
      // category=buynow sorts on, so defence small-caps rise in a war regime
      // and aviation small-caps fall.
      const adjustedMidterm = Math.max(0, Math.min(100, midtermScore + macroBoost));
      // Headwind flag: -5 or worse triggers a UI warning strip.
      const macroHeadwind = macroBoost <= -5;

      return {
        ...s,
        sector,
        volatility: volatility.toFixed(2),
        intradayScore,
        midtermScore: Math.max(0, Math.min(100, midtermScore)),
        baseMidtermScore: midtermScore,
        adjustedMidtermScore: adjustedMidterm,
        macroBoost,
        macroReason,
        macroSector: canonicalSector,
        macroHeadwind,
        direction,
        stopLoss: volatility > 1 ? stopLoss : null,
        target: volatility > 1 ? target : null,
      };
    });

    // Filter and sort based on category
    let result;
    if (category === "buynow") {
      // ── ENHANCED small-cap Buy Now: run proper technical analysis on top
      // candidates instead of using the simplistic volatility+volume score.
      //
      // Step 1: Pre-filter to the ~25 most promising candidates (positive
      //         momentum, decent volume) — this keeps the analysis cost low.
      // Step 2: Fetch 30-day historical data + run analyzeStock() for each.
      // Step 3: Use the REAL technical score (RSI, MACD, Bollinger etc)
      //         blended with macro tilt for the final ranking.
      const preCandidates = enriched
        .filter((s) => (s.pChange || 0) > 0.3 && (s.totalTradedVolume || 0) > 100000)
        .sort((a, b) => (b.adjustedMidtermScore + b.intradayScore) - (a.adjustedMidtermScore + a.intradayScore))
        .slice(0, 25);

      // Fetch historical + run proper technical analysis in batches
      const ANALYSIS_BATCH = 5;
      for (let ai = 0; ai < preCandidates.length; ai += ANALYSIS_BATCH) {
        const batch = preCandidates.slice(ai, ai + ANALYSIS_BATCH);
        await Promise.all(batch.map(async (s) => {
          try {
            const hist = await fetchHistorical(s.symbol);
            if (hist && hist.length >= 30) {
              const quote = await fetchQuote(s.symbol);
              if (quote) {
                const analysis = analyzeStock(hist, quote);
                s.technicalScore = analysis.score;
                s.technicalRec = analysis.recommendation;
                s.rsi = analysis.indicators?.rsi || s.rsi || "N/A";
                s.trend = analysis.indicators?.trend?.trend || "N/A";
                s.volume = analysis.indicators?.volume?.description || "N/A";
                // Recompute adjusted score using real technical analysis
                const rawDelta = s.macroBoost || 0;
                s.adjustedMidtermScore = Math.max(0, Math.min(100, analysis.score + rawDelta));
                // ATR for stop-loss/target
                const atr = analysis.indicators?.atr ? parseFloat(analysis.indicators.atr) : null;
                if (atr && s.lastPrice) {
                  s.stopLoss = parseFloat((s.lastPrice - atr * 1.5).toFixed(2));
                  s.target = parseFloat((s.lastPrice + atr * 2).toFixed(2));
                  s.riskReward = parseFloat(((s.target - s.lastPrice) / (s.lastPrice - s.stopLoss)).toFixed(2));
                }
              }
            }
          } catch { /* silent — fall back to basic score */ }
        }));
        if (ai + ANALYSIS_BATCH < preCandidates.length) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      result = preCandidates
        .filter((s) => s.adjustedMidtermScore >= 55)
        .sort((a, b) => b.adjustedMidtermScore - a.adjustedMidtermScore)
        .slice(0, 10);
    } else if (category === "volume") {
      // Volume breakout: very high volume + high volatility
      result = enriched
        .filter((s) => (s.totalTradedVolume || 0) > 500000 && parseFloat(s.volatility) > 2)
        .sort((a, b) => {
          // Score by volatility × volume combo
          const aScore = parseFloat(a.volatility) * Math.log10(a.totalTradedVolume || 1);
          const bScore = parseFloat(b.volatility) * Math.log10(b.totalTradedVolume || 1);
          return bScore - aScore;
        })
        .slice(0, 10);
    } else if (category === "midterm") {
      result = enriched
        .filter((s) => s.midtermScore >= 55)
        .sort((a, b) => b.midtermScore - a.midtermScore)
        .slice(0, 10);
    } else if (category === "sell") {
      // Sell alerts: negative momentum, poor scores
      result = enriched
        .filter((s) => (s.pChange || 0) < -0.5 && s.midtermScore <= 45)
        .sort((a, b) => a.midtermScore - b.midtermScore)
        .slice(0, 10);
    } else if (category === "top-gainers") {
      result = enriched
        .filter((s) => (s.pChange || 0) > 0)
        .sort((a, b) => (b.pChange || 0) - (a.pChange || 0))
        .slice(0, 30);
    } else if (category === "top-losers") {
      result = enriched
        .filter((s) => (s.pChange || 0) < 0)
        .sort((a, b) => (a.pChange || 0) - (b.pChange || 0))
        .slice(0, 30);
    } else {
      // All — return top 50 by volume (most active)
      result = enriched
        .sort((a, b) => (b.totalTradedVolume || 0) - (a.totalTradedVolume || 0))
        .slice(0, 50);
    }

    const response = {
      category,
      stocks: result,
      totalScanned: allStocks.length,
      source: dataSource,
      regime: macroRegime,
      lastUpdated: new Date().toISOString(),
    };

    // Paper-trade snapshot: only on the buynow category, only once per day.
    // Snapshots the small-cap buy-now picks specifically (not intraday/volume
    // picks, which are momentum trades that mature in hours, not weeks).
    if (category === "buynow" && result.length > 0 && !(await hasSnapshotToday("smallcap_buynow"))) {
      try {
        const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
        const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
        // Map small-cap-specific fields to the canonical price field
        const picksForSnapshot = result.map((s) => ({
          ...s,
          price: s.lastPrice,
          score: s.adjustedMidtermScore || s.midtermScore,
        }));
        const snapResult = await snapshotPicks(picksForSnapshot, "smallcap_buynow", {
          regime: macroRegime,
          niftyPrice,
          rationale: "Auto-snapshot from /api/sme/scan?category=buynow",
        });
        console.log(`[PAPERTRADES] Snapshotted ${snapResult.written} small-cap buynow picks`);
      } catch (e) {
        console.warn("[PAPERTRADES] Small-cap snapshot failed:", e.message);
      }
    }

    smeCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error("SME scan error:", err.message);
    res.status(500).json({ error: "SME scan failed: " + err.message });
  }
});

// 30s cache for the market indices ticker. The Nifty/Sensex/Bank Nifty values
// genuinely change at most once per second, but every page load + the auto-
// refresh ticker hits this endpoint. Without a cache, every visitor pays the
// 12s NSE-cold-session penalty, and concurrent users hammer the upstream APIs
// for data they all share.
//
// 30s strikes the balance: fresh enough that the user never sees data older
// than half a minute, but cached enough that the heavy NSE call only fires
// twice per minute even under load.
const marketCache = new NodeCache({ stdTTL: 30, checkperiod: 10 });

app.get("/api/market", async (req, res) => {
  try {
    const cached = marketCache.get("market");
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(cached);
    }

    // Try NSE India first (official source), Yahoo as fallback
    let indices = [];
    let source = "yahoo";

    try {
      const nseIndices = await fetchNseIndices();
      if (nseIndices && nseIndices.length > 0) {
        indices = nseIndices;
        source = "nse";
      }
    } catch (e) {
      console.error("NSE indices failed, falling back to Yahoo:", e.message);
    }

    // Fallback: Yahoo Finance for SENSEX (NSE doesn't serve BSE index)
    // and if NSE failed entirely
    if (indices.length === 0) {
      const yahooSymbols = ["^NSEI", "^BSESN", "^NSEBANK"];
      const quotes = await Promise.all(yahooSymbols.map((i) => fetchQuote(i)));
      indices = quotes.filter(Boolean).map((q) => ({
        symbol: q.symbol,
        name: q.shortName || q.longName,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        dayHigh: q.regularMarketDayHigh,
        dayLow: q.regularMarketDayLow,
        previousClose: q.regularMarketPreviousClose,
        source: "yahoo",
      }));
    } else {
      // Also add SENSEX from Yahoo since NSE doesn't serve BSE indices
      try {
        const sensex = await fetchQuote("^BSESN");
        if (sensex) {
          indices.splice(1, 0, {
            symbol: "^BSESN",
            name: "SENSEX",
            price: sensex.regularMarketPrice,
            change: sensex.regularMarketChange,
            changePercent: sensex.regularMarketChangePercent,
            source: "yahoo",
          });
        }
      } catch (e) { /* sensex optional */ }
    }

    const response = {
      indices,
      source,
      lastUpdated: new Date().toISOString(),
      marketStatus: isMarketOpen() ? "OPEN" : "CLOSED",
    };
    marketCache.set("market", response);
    res.set("X-Cache", "MISS");
    res.json(response);
  } catch (err) {
    console.error("Market error:", err.message);
    res.status(500).json({ error: "Market data failed" });
  }
});

/**
 * Market news aggregator — pulls from ET, Google News, LiveMint.
 * Cached for 5 minutes. Frontend refreshes every 10 minutes.
 */
const newsAggregatorCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

app.get("/api/news/market", async (req, res) => {
  try {
    const cached = newsAggregatorCache.get("market_news");
    if (cached) return res.json(cached);

    const RSS_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };

    // Fetch from multiple Indian financial news sources in parallel
    const [etXml, lmXml, googleXml] = await Promise.all([
      fetch("https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", { headers: RSS_HEADERS })
        .then((r) => r.text()).catch(() => ""),
      fetch("https://www.livemint.com/rss/markets", { headers: RSS_HEADERS })
        .then((r) => r.text()).catch(() => ""),
      fetch("https://news.google.com/rss/search?q=Indian+stock+market+NSE+BSE+Nifty&hl=en-IN&gl=IN&ceid=IN:en", { headers: RSS_HEADERS })
        .then((r) => r.text()).catch(() => ""),
    ]);

    const articles = [];

    // Parse Economic Times
    parseRSS(etXml, "Economic Times").forEach((a) => articles.push(a));

    // Parse LiveMint
    parseRSS(lmXml, "LiveMint").forEach((a) => articles.push(a));

    // Parse Google News
    parseRSS(googleXml, "Google News").forEach((a) => articles.push(a));

    // Deduplicate by title similarity
    const seen = new Set();
    const unique = articles.filter((a) => {
      const key = a.title?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by date (newest first)
    unique.sort((a, b) => {
      const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return db - da;
    });

    // Score sentiment on each headline (keyword-based, fast)
    const scored = unique.slice(0, 50).map((a) => {
      const lower = (a.title || "").toLowerCase();
      let label = "neutral";
      const bullWords = ["rally", "surge", "gain", "jump", "rise", "bull", "buy", "profit", "growth", "record", "beat", "upgrade", "strong", "recover", "rebound", "high", "positive"];
      const bearWords = ["fall", "crash", "drop", "slip", "sell", "bear", "loss", "decline", "weak", "concern", "negative", "correction", "plunge", "cut", "downgrade", "pressure", "fear", "risk"];
      const bCount = bullWords.filter((w) => lower.includes(w)).length;
      const brCount = bearWords.filter((w) => lower.includes(w)).length;
      if (bCount > brCount) label = "bullish";
      else if (brCount > bCount) label = "bearish";
      return { ...a, sentiment: label };
    });

    // ── AI Market Digest ──
    // Generate a structured summary from the top 30 headlines so users
    // get a morning-briefing-style digest instead of clicking through 50 links.
    // Falls back to null when OpenAI is unavailable — the raw headlines still render.
    let digest = null;
    try {
      const client = getOpenAI();
      if (client && scored.length >= 5) {
        console.log(`[NEWS] Generating digest from ${scored.length} headlines...`);
        const headlineBlock = scored.slice(0, 30).map((a, i) => {
          return `${i + 1}. [${a.sentiment.toUpperCase()}] [${a.publisher || "?"}] ${a.title}`;
        }).join("\n");

        // Direct call with AbortController timeout (15s max)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const digestResponse = await client.chat.completions.create({
            model: "gpt-5.4",
            temperature: 0.3,
            max_completion_tokens: 4000, // GPT-5.4 reasoning model: needs ~2000 for thinking + ~800 for output
            messages: [
              {
                role: "system",
                content: "You are a senior Indian market analyst writing a morning briefing for professional traders. Given today's market headlines, produce a structured JSON digest. Be concise, specific, and actionable. Reference specific stocks/sectors/numbers from the headlines.\n\nOutput strict JSON only:\n{\n  \"marketMood\": \"bullish\" or \"bearish\" or \"mixed\",\n  \"moodSummary\": \"one sentence: what is driving the market today\",\n  \"keyTakeaways\": [\"bullet 1\", \"bullet 2\", \"bullet 3\", \"bullet 4\"],\n  \"bullishDrivers\": [\"what is pushing stocks up, be specific\"],\n  \"bearishRisks\": [\"what to watch out for, be specific\"],\n  \"sectorsToWatch\": [\"sector: reason\"]\n}"
              },
              {
                role: "user",
                content: "Today's " + scored.length + " Indian market headlines:\n\n" + headlineBlock + "\n\nGenerate the market digest JSON."
              }
            ],
          });
          clearTimeout(timeout);

          // GPT-5.4 may return content in .output_text (reasoning model) or .choices[0].message.content
          let text = "";
          if (digestResponse.choices?.[0]?.message?.content) {
            text = digestResponse.choices[0].message.content;
          } else if (digestResponse.output_text) {
            text = digestResponse.output_text;
          } else if (digestResponse.choices?.[0]?.text) {
            text = digestResponse.choices[0].text;
          }
          console.log(`[NEWS] Digest response: ${text.length} chars, model=${digestResponse.model || '?'}`);
          if (!text) {
            // Dump structure to find where content lives
            console.log(`[NEWS] Response structure: ${JSON.stringify(digestResponse).slice(0, 500)}`);
          }
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            digest = JSON.parse(jsonMatch[0]);
            console.log(`[NEWS] Digest generated: mood=${digest.marketMood}, takeaways=${digest.keyTakeaways?.length}`);
          }
        } catch (innerErr) {
          clearTimeout(timeout);
          console.error("[NEWS] Digest LLM call failed:", innerErr.message);
        }
      }
    } catch (err) {
      console.error("[NEWS] Digest generation failed:", err.message);
      // digest stays null — frontend handles gracefully
    }

    const response = {
      articles: scored,
      digest,
      count: scored.length,
      sources: ["Economic Times", "LiveMint", "Google News India"],
      lastUpdated: new Date().toISOString(),
    };

    newsAggregatorCache.set("market_news", response);
    res.json(response);
  } catch (err) {
    console.error("News aggregator error:", err.message);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

function safeDateParse(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

// ==================== MACRO REGIME LAYER ====================

/**
 * Trusted news sources we aggregate into the macro regime classifier.
 *
 * Sources are organised into TIER GROUPS (regulator / wire / indian) and
 * within each group split into PRIMARY and FALLBACK sources. fetchMacroHeadlines
 * runs in two passes: primaries first, then fallbacks ONLY if a tier-group's
 * primaries didn't meet the coverage target. This means that when Vercel's US
 * IPs get blocked by Reuters IN / Bloomberg Quint / RBI (a known issue), the
 * system automatically reaches for Reuters Business / AP Biz / FT Markets for
 * wires, PIB / MoSPI for regulators, and Hindu BusinessLine / Financial Express
 * for Indian dailies — without wasting requests in the common case.
 *
 * Tier A+ = official regulator/central bank (most authoritative)
 * Tier A  = global wire service (fast + credible on geopolitics)
 * Tier B  = Indian financial daily (high coverage, some noise)
 *
 * Group coverage target: ≥1 A+, ≥1 A, ≥2 B. If any group is short after
 * Pass 1, its fallbacks are fetched in Pass 2.
 */
const TRUSTED_MACRO_SOURCES = [
  // ─── Tier A+: Regulators ──────────────────────────────────────
  { name: "RBI Press",         url: "https://www.rbi.org.in/Scripts/Bs_viewRSS.aspx?Id=Press",                                   tier: "A+", group: "regulator", primary: true  },
  { name: "SEBI Press",        url: "https://www.sebi.gov.in/sebirss.xml",                                                       tier: "A+", group: "regulator", primary: true  },
  { name: "PIB Economy",       url: "https://pib.gov.in/RssMain.aspx?ModId=8&Lang=1",                                            tier: "A+", group: "regulator", primary: false },
  { name: "MoSPI",             url: "https://mospi.gov.in/rss.xml",                                                              tier: "A+", group: "regulator", primary: false },

  // ─── Tier A: Global wires ─────────────────────────────────────
  { name: "Reuters India",     url: "https://feeds.reuters.com/reuters/INtopNews",                                               tier: "A",  group: "wire",      primary: true  },
  { name: "Bloomberg Quint",   url: "https://www.bqprime.com/feed",                                                              tier: "A",  group: "wire",      primary: true  },
  { name: "Reuters Business",  url: "https://feeds.reuters.com/reuters/businessNews",                                            tier: "A",  group: "wire",      primary: false },
  { name: "AP Business",       url: "https://rsshub.app/apnews/topics/apf-business",                                             tier: "A",  group: "wire",      primary: false },
  { name: "FT Markets",        url: "https://www.ft.com/markets?format=rss",                                                     tier: "A",  group: "wire",      primary: false },

  // ─── Tier B: Indian financial dailies ─────────────────────────
  { name: "Moneycontrol",      url: "https://www.moneycontrol.com/rss/MCtopnews.xml",                                            tier: "B",  group: "indian",    primary: true  },
  { name: "Business Standard", url: "https://www.business-standard.com/rss/markets-106.rss",                                     tier: "B",  group: "indian",    primary: true  },
  { name: "Economic Times",    url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",                      tier: "B",  group: "indian",    primary: true  },
  { name: "LiveMint",          url: "https://www.livemint.com/rss/markets",                                                      tier: "B",  group: "indian",    primary: true  },
  { name: "Hindu BusinessLine",url: "https://www.thehindubusinessline.com/markets/feeder/default.rss",                            tier: "B",  group: "indian",    primary: false },
  { name: "Financial Express", url: "https://www.financialexpress.com/market/feed/",                                             tier: "B",  group: "indian",    primary: false },
];

// Coverage targets per tier-group — if a group falls short after Pass 1, its
// fallbacks get fetched in Pass 2. Loose targets so a single regulator/wire
// success is enough to call that tier "covered".
const MACRO_COVERAGE_TARGET = { "A+": 1, "A": 1, "B": 2 };

const RSS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "application/rss+xml, application/xml, text/xml, */*",
};

/**
 * Fetch headlines from a single RSS source. Returns an array of headline
 * objects (empty array on any failure — never throws). Tracks failure
 * counters so chronic broken feeds bubble up in /api/macro/debug.
 */
async function fetchFromSource(src, cutoff) {
  try {
    const res = await fetchWithRetry(
      src.url,
      { headers: RSS_HEADERS },
      { retries: 1, timeoutMs: 8000 }
    );
    if (!res || !res.ok) {
      bumpSourceFailure(src.name);
      return { src, headlines: [], ok: false };
    }
    const xml = await res.text();
    const articles = parseRSS(xml, src.name);
    macroSourceFailures.set(src.name, 0); // success → reset
    const headlines = articles
      .map((a) => ({
        title: a.title,
        source: src.name,
        sourceTier: src.tier,
        group: src.group,
        publishedAt: a.publishedAt,
        url: a.link,
      }))
      // Filter to recent window upfront so the coverage check doesn't count
      // ancient headlines from a stale feed as "ok".
      .filter((h) => {
        if (!h.publishedAt) return true;
        const ts = new Date(h.publishedAt).getTime();
        return Number.isFinite(ts) && ts >= cutoff;
      });
    return { src, headlines, ok: headlines.length > 0 };
  } catch (err) {
    bumpSourceFailure(src.name);
    return { src, headlines: [], ok: false };
  }
}

/**
 * Fetch macro headlines from trusted sources using a two-pass strategy:
 *
 *   Pass 1 — fetch all PRIMARY sources in parallel.
 *   Check coverage per tier-group against MACRO_COVERAGE_TARGET.
 *   Pass 2 — for any tier-group that fell short, fetch that group's
 *            FALLBACK sources in parallel.
 *
 * This keeps steady-state cost low (primaries are the best feeds) while
 * automatically recovering on Vercel where Reuters IN / Bloomberg Quint /
 * RBI Press are blocked. Returns an object with headlines + sourceHealth
 * metadata so /api/macro/debug can expose exactly which feeds worked and
 * which fallbacks took over.
 *
 * Never throws — on total failure returns { headlines: [], ... } with a
 * fully populated sourceHealth map so the UI can surface the problem.
 */
async function fetchMacroHeadlines({ hours = 48 } = {}) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const sourceHealth = {}; // name → "ok" | "ok-fallback" | "blocked" | "empty"
  const tierCoverage = { "A+": 0, "A": 0, "B": 0 };
  const fallbacksUsed = [];
  const allHeadlines = [];

  // ─── Pass 1: primaries ───
  const primaries = TRUSTED_MACRO_SOURCES.filter((s) => s.primary);
  const pass1 = await Promise.all(primaries.map((s) => fetchFromSource(s, cutoff)));

  for (const r of pass1) {
    if (r.ok) {
      sourceHealth[r.src.name] = "ok";
      tierCoverage[r.src.tier] = (tierCoverage[r.src.tier] || 0) + 1;
      allHeadlines.push(...r.headlines);
    } else {
      sourceHealth[r.src.name] = "blocked";
    }
  }

  // ─── Pass 2: fallbacks, only for tier-groups that fell short ───
  // Group coverage is checked against MACRO_COVERAGE_TARGET. We fetch ALL
  // fallbacks in a short-coverage group in parallel and take whatever succeeds.
  const shortGroups = new Set();
  for (const tier of Object.keys(MACRO_COVERAGE_TARGET)) {
    if (tierCoverage[tier] < MACRO_COVERAGE_TARGET[tier]) {
      shortGroups.add(tier);
    }
  }

  if (shortGroups.size > 0) {
    const fallbackCandidates = TRUSTED_MACRO_SOURCES.filter(
      (s) => !s.primary && shortGroups.has(s.tier)
    );
    if (fallbackCandidates.length > 0) {
      console.log(
        `[MACRO] Pass 1 short on tiers [${[...shortGroups].join(",")}] — ` +
        `trying ${fallbackCandidates.length} fallback source(s)`
      );
      const pass2 = await Promise.all(
        fallbackCandidates.map((s) => fetchFromSource(s, cutoff))
      );
      for (const r of pass2) {
        if (r.ok) {
          sourceHealth[r.src.name] = "ok-fallback";
          tierCoverage[r.src.tier] = (tierCoverage[r.src.tier] || 0) + 1;
          allHeadlines.push(...r.headlines);
          fallbacksUsed.push(r.src.name);
        } else {
          sourceHealth[r.src.name] = "blocked";
        }
      }
    }
  }

  // Mark any source we didn't touch as "skipped" so the debug view is complete
  for (const src of TRUSTED_MACRO_SOURCES) {
    if (!(src.name in sourceHealth)) sourceHealth[src.name] = "skipped";
  }

  // ─── Dedupe by normalized title prefix, sort newest first, cap at 60 ───
  const seen = new Set();
  const unique = [];
  for (const h of allHeadlines) {
    if (!h.title) continue;
    const key = h.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
  }
  unique.sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db - da;
  });
  const top = unique.slice(0, 60);

  // Per-request log so we can diagnose on Vercel
  const okSources = Object.values(sourceHealth).filter((v) => v === "ok" || v === "ok-fallback").length;
  const fbStr = fallbacksUsed.length > 0 ? ` fallbacks-used=${fallbacksUsed.join(",")}` : "";
  console.log(
    `[MACRO] headlines=${top.length} sources=ok(${okSources}/${TRUSTED_MACRO_SOURCES.length}) ` +
    `tierCoverage={A+:${tierCoverage["A+"]},A:${tierCoverage["A"]},B:${tierCoverage["B"]}}${fbStr}`
  );

  // Attach metadata as a non-enumerable field on the headlines array so callers
  // that only read `.length` / iterate still work, but refreshMacroRegime can
  // reach into it for logging.
  Object.defineProperty(top, "meta", {
    value: { sourceHealth, tierCoverage, fallbacksUsed, okSources, totalSources: TRUSTED_MACRO_SOURCES.length },
    enumerable: false,
  });
  return top;
}

function bumpSourceFailure(name) {
  const count = (macroSourceFailures.get(name) || 0) + 1;
  macroSourceFailures.set(name, count);
  if (count === 3) {
    console.warn(`[MACRO] ⚠ Source "${name}" failed 3 times in a row. It may be blocked or down.`);
  }
}

/**
 * In-flight promise for `refreshMacroRegime` — ensures concurrent callers
 * dedupe onto the same classification instead of each kicking off a separate
 * LLM call. Matters for two reasons:
 *   1. COST: an unprotected burst of 5 concurrent tabs on cache-expiry would
 *      otherwise fire 5 parallel OpenAI requests (5× the cost).
 *   2. CONSISTENCY: all 5 tabs will see identical regime data. Without dedup,
 *      small timing differences between concurrent refreshes can produce
 *      different classifications and different cache writes, and whichever
 *      finishes last wins — users briefly see inconsistent data.
 */
let _inflightMacroRefresh = null;

/**
 * Refresh the macro regime cache. Non-blocking — caller should fire-and-forget
 * or `await` as appropriate. Writes to macroRegimeCache on success.
 *
 * Concurrency-safe: if a refresh is already in flight, returns the same
 * promise so both callers get the same result.
 */
async function refreshMacroRegime() {
  if (_inflightMacroRefresh) return _inflightMacroRefresh;
  _inflightMacroRefresh = (async () => {
    try {
      return await _doRefreshMacroRegime();
    } finally {
      _inflightMacroRefresh = null;
    }
  })();
  return _inflightMacroRefresh;
}

async function _doRefreshMacroRegime() {
  try {
    const headlines = await fetchMacroHeadlines();
    const meta = headlines.meta || { sourceHealth: {}, tierCoverage: { "A+": 0, "A": 0, "B": 0 }, fallbacksUsed: [] };
    if (headlines.length === 0) {
      const calm = {
        ...defaultCalmRegime(),
        reasoning: "No macro headlines fetched (all sources unavailable).",
        sourceHealth: meta.sourceHealth,
        tierCoverage: meta.tierCoverage,
      };
      macroRegimeCache.set(MACRO_CACHE_KEY, calm);
      pushMacroHistory(calm, []);
      return calm;
    }
    const regime = await classifyRegime(headlines);

    // If tier-A wire coverage is zero, cap confidence at 0.4 so the regime
    // doesn't aggressively reshuffle rankings based on tier-B alone. This is a
    // failsafe for the case where every geopolitical wire source is blocked
    // on Vercel and we're classifying purely off Indian dailies.
    if (meta.tierCoverage["A"] === 0 && regime.confidence > 0.4) {
      regime.confidence = 0.4;
      regime.reasoning = `${regime.reasoning} [Confidence capped: no tier-A wire sources available]`;
    }

    // Attach source-health metadata so it flows through to the debug endpoint
    // and the frontend banner can render "sources: Reuters ✓, RBI ✗ (PIB fallback ✓)"
    regime.sourceHealth = meta.sourceHealth;
    regime.tierCoverage = meta.tierCoverage;
    regime.fallbacksUsed = meta.fallbacksUsed;

    macroRegimeCache.set(MACRO_CACHE_KEY, regime);
    pushMacroHistory(regime, headlines);
    console.log(
      `[MACRO] Regime=${regime.regime} sev=${regime.severity} conf=${regime.confidence.toFixed(2)} ` +
      `sectors=${regime.sectorImpacts.length} headlines=${headlines.length}`
    );
    return regime;
  } catch (err) {
    console.error("[MACRO] refreshMacroRegime failed:", err.message);
    // Keep whatever was previously cached. If nothing cached, fall back to calm.
    const existing = macroRegimeCache.get(MACRO_CACHE_KEY);
    if (existing) return existing;
    const calm = { ...defaultCalmRegime(), reasoning: `Refresh failed: ${err.message}` };
    macroRegimeCache.set(MACRO_CACHE_KEY, calm);
    return calm;
  }
}

// ── Regime transition tracking ──
//
// Detects when the macro regime CHANGES (e.g., CALM → OIL_SHOCK, or
// WAR_ESCALATION → WAR_DE_ESCALATION). Transition events are powerful
// timing signals — the shift itself often triggers sector rotations.
//
// The last transition is stored and exposed via /api/macro/regime so the
// frontend can render "Regime just shifted — consider these sectors" alerts.
let lastRegimeTransition = null;

// Predefined transition → action mapping. Based on what typically happens
// when Indian markets transition between regimes.
const TRANSITION_SIGNALS = {
  // De-escalation signals → BUY opportunities
  "WAR_ESCALATION→WAR_DE_ESCALATION": { action: "BUY", summary: "Ceasefire/peace talks detected. Aviation, auto, and consumer stocks typically rally 3-8% in the week following de-escalation.", sectors: ["Aviation", "Automobile", "FMCG", "Retail"] },
  "WAR_ESCALATION→CALM": { action: "BUY", summary: "Conflict resolved. Broad risk-on rally expected. FIIs return to Indian equities.", sectors: ["Banking", "NBFC", "IT Services", "Real Estate"] },
  "OIL_SHOCK→CALM": { action: "BUY", summary: "Oil crisis easing. Airlines, chemicals, and auto benefit from lower input costs.", sectors: ["Aviation", "Automobile", "Chemicals", "FMCG"] },
  "OIL_SHOCK→WAR_DE_ESCALATION": { action: "BUY", summary: "Oil supply fears receding + geopolitical easing. Double tailwind for oil-consuming sectors.", sectors: ["Aviation", "Automobile", "Chemicals"] },
  "GLOBAL_RISK_OFF→CALM": { action: "BUY", summary: "Global risk appetite returning. FII flows resume into emerging markets.", sectors: ["Banking", "IT Services", "NBFC"] },
  "RATE_HIKE→RATE_CUT": { action: "STRONG BUY", summary: "Policy pivot from hawkish to dovish. Rate-sensitive sectors rally hard on pivot.", sectors: ["Real Estate", "NBFC", "Banking", "Infrastructure"] },
  // Escalation signals → SELL/TRIM signals
  "CALM→WAR_ESCALATION": { action: "SELL/TRIM", summary: "Conflict emerging. Trim aviation, consumer discretionary. Consider defence, gold-linked stocks.", sectors: ["Defence", "Oil & Gas", "Power"] },
  "CALM→OIL_SHOCK": { action: "TRIM", summary: "Oil spiking. Airlines and chemicals hurt. Energy producers benefit.", sectors: ["Oil & Gas", "Power", "Energy"] },
  "CALM→GLOBAL_RISK_OFF": { action: "TRIM", summary: "Global selloff. Reduce beta, move to defensives (FMCG, Pharma, IT).", sectors: ["FMCG", "Pharma", "IT Services"] },
  "RATE_CUT→RATE_HIKE": { action: "SELL", summary: "Policy reversal. Rate-sensitive sectors (realty, NBFC) face headwinds.", sectors: ["FMCG", "Pharma", "IT Services"] },
  "WAR_DE_ESCALATION→WAR_ESCALATION": { action: "SELL/TRIM", summary: "Peace talks failed. Risk-off mode returning. Trim risk assets.", sectors: ["Defence", "Oil & Gas"] },
};

function pushMacroHistory(regime, headlines) {
  // Detect regime transition by comparing to the previous classification
  if (macroHistory.length > 0) {
    const prev = macroHistory[0].regime?.regime;
    const curr = regime.regime;
    if (prev && curr && prev !== curr && curr !== "CALM" || (prev !== "CALM" && curr === "CALM")) {
      const transitionKey = `${prev}→${curr}`;
      const signal = TRANSITION_SIGNALS[transitionKey] || null;
      lastRegimeTransition = {
        from: prev,
        to: curr,
        transitionKey,
        detectedAt: new Date().toISOString(),
        signal: signal || {
          action: curr === "CALM" ? "NEUTRAL" : "WATCH",
          summary: `Regime shifted from ${prev.replace(/_/g, ' ')} to ${curr.replace(/_/g, ' ')}. Monitor sector rotation.`,
          sectors: [],
        },
      };
      console.log(`[MACRO] ⚡ REGIME TRANSITION: ${transitionKey} → ${lastRegimeTransition.signal.action}`);
    }
  }

  macroHistory.unshift({
    regime,
    headlines: headlines.map((h) => ({ title: h.title, source: h.source, sourceTier: h.sourceTier, publishedAt: h.publishedAt })),
    at: new Date().toISOString(),
  });
  if (macroHistory.length > 10) macroHistory.length = 10; // keep more history for transition tracking
}

/**
 * Get the current macro regime — lazy refresh if missing.
 * On Vercel serverless we use stale-while-revalidate: return cached immediately,
 * kick off a refresh in the background if the cache is stale.
 */
async function getMacroRegime() {
  const cached = macroRegimeCache.get(MACRO_CACHE_KEY);
  if (cached) return cached;
  // Nothing cached yet — fetch synchronously (first call only)
  return await refreshMacroRegime();
}

/**
 * Macro regime endpoint — returns the current regime + staleness info.
 * Optional ?refresh=1 forces a recompute.
 */
app.get("/api/macro/regime", async (req, res) => {
  try {
    if (req.query.refresh === "1") {
      const fresh = await refreshMacroRegime();
      return res.json({ ...fresh, staleness: 0, sources: TRUSTED_MACRO_SOURCES.map((s) => ({ name: s.name, tier: s.tier })), transition: lastRegimeTransition });
    }
    const regime = await getMacroRegime();
    const staleness = regime.generatedAt
      ? Date.now() - new Date(regime.generatedAt).getTime()
      : null;
    res.json({
      ...regime,
      staleness,
      sources: TRUSTED_MACRO_SOURCES.map((s) => ({ name: s.name, tier: s.tier })),
      // Regime transition alert — non-null when the regime recently changed
      transition: lastRegimeTransition,
    });
  } catch (err) {
    console.error("[MACRO] /api/macro/regime error:", err.message);
    res.status(500).json({ ...defaultCalmRegime(), error: err.message });
  }
});

/**
 * Debug endpoint — current regime + last 5 classifications + source health.
 * Not gated behind auth since the data is non-sensitive, but it's deliberately
 * un-documented (no frontend link). Useful for verifying Vercel fallback
 * behaviour after deploy: check `current.sourceHealth` and `current.tierCoverage`.
 */
app.get("/api/macro/debug", (req, res) => {
  const current = macroRegimeCache.get(MACRO_CACHE_KEY) || null;
  res.json({
    current,
    sourceHealth: current?.sourceHealth || null,
    tierCoverage: current?.tierCoverage || null,
    fallbacksUsed: current?.fallbacksUsed || [],
    history: macroHistory,
    sourceFailures: Object.fromEntries(macroSourceFailures),
    sources: TRUSTED_MACRO_SOURCES.map((s) => ({
      name: s.name,
      tier: s.tier,
      group: s.group,
      primary: s.primary,
    })),
    coverageTargets: MACRO_COVERAGE_TARGET,
  });
});

/**
 * Dev-only override endpoint — force a specific regime for testing UI without
 * waiting for real macro news. Gated by MACRO_OVERRIDE_TOKEN env var or by
 * running outside Vercel production. Example:
 *
 *   curl '/api/macro/override?regime=WAR_ESCALATION&sector=Defence&impact=3&severity=4'
 *
 * Writes directly to macroRegimeCache. Cleared on next scheduled refresh or by
 * calling /api/macro/regime?refresh=1.
 */
app.get("/api/macro/override", (req, res) => {
  // Allowed when:
  //   (a) running locally (VERCEL env var not set), OR
  //   (b) running on Vercel AND a matching MACRO_OVERRIDE_TOKEN env var is set
  //       AND the request passes the token in ?token=...
  //
  // The explicit token-presence check prevents the "undefined === undefined"
  // loophole that would otherwise let any unauthenticated Vercel request
  // force-set the regime.
  const envToken = process.env.MACRO_OVERRIDE_TOKEN;
  const queryToken = req.query.token;
  const isLocal = !process.env.VERCEL;
  const tokenOk = envToken && queryToken && queryToken === envToken;
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: "Override not allowed in this environment. Set MACRO_OVERRIDE_TOKEN env var and pass ?token=... to enable." });
  }

  // Validate regime against the canonical enum — anything else would silently
  // poison the cache with an unknown regime ID that no downstream code knows
  // how to handle.
  const regimeId = String(req.query.regime || "CALM").toUpperCase();
  if (!REGIMES.includes(regimeId)) {
    return res.status(400).json({
      error: `Unknown regime "${regimeId}". Must be one of: ${REGIMES.join(", ")}`,
    });
  }

  const severity = Math.max(1, Math.min(5, parseInt(req.query.severity || "3", 10)));
  const confidence = Math.max(0, Math.min(1, parseFloat(req.query.confidence || "0.85")));

  // Build sector impacts from repeatable query params: sector=Defence&impact=3
  // Supports multiple: ?sector=Defence&impact=3&sector=Aviation&impact=-2
  // Each sector is validated against the canonical SECTORS enum so the
  // downstream lookup in computeMacroDelta actually finds them.
  const sectors = [].concat(req.query.sector || []);
  const impacts = [].concat(req.query.impact || []);
  const invalidSectors = sectors.filter((s) => !SECTORS.includes(String(s)));
  if (invalidSectors.length > 0) {
    return res.status(400).json({
      error: `Unknown sector(s): ${invalidSectors.join(", ")}. Must be one of: ${SECTORS.join(", ")}`,
    });
  }
  const sectorImpacts = sectors.map((s, i) => ({
    sector: String(s),
    impact: Math.max(-3, Math.min(3, parseInt(impacts[i] || "1", 10))),
    reason: `Forced via /api/macro/override for testing`,
  })).filter((s) => s.impact !== 0);

  const override = {
    ...defaultCalmRegime(),
    regime: regimeId,
    regimeLabel: regimeId.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
    severity,
    confidence,
    sectorImpacts,
    reasoning: `⚠ OVERRIDE: regime forced to ${regimeId} for testing. This is not real data.`,
    keyEvents: ["(override)"],
    generatedAt: new Date().toISOString(),
    sourceHealth: { override: "forced" },
    tierCoverage: { "A+": 0, "A": 0, "B": 0 },
    override: true,
  };
  macroRegimeCache.set(MACRO_CACHE_KEY, override);
  console.log(`[MACRO] ⚠ Regime overridden: ${regimeId} sev=${severity} sectors=${sectorImpacts.length}`);
  res.json(override);
});

// ==================== PAPER-TRADE TRACKER ====================

/**
 * 5-minute cache for the track history endpoint. Forward returns don't change
 * every second, and computing them requires fetching live prices for every
 * unique symbol in the trades file — which gets expensive once we have weeks
 * of history (200+ unique symbols).
 */
const trackCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

/**
 * GET /api/track/history
 *
 * Returns all paper-trade entries with their forward returns vs the current
 * Nifty benchmark. Sorted newest-first.
 *
 * Query params:
 *   ?type=buynow_nifty100|smallcap_buynow|fundamental_deep_value  — filter
 *   ?days=30                                                      — last N days
 *   ?bust=1                                                       — skip cache
 */
app.get("/api/track/history", async (req, res) => {
  try {
    const filterType = req.query.type || null;
    const dayLimit = req.query.days ? parseInt(req.query.days, 10) : null;
    const cacheKey = `track_history_${filterType || "all"}_${dayLimit || "all"}`;

    if (!req.query.bust) {
      const cached = trackCache.get(cacheKey);
      if (cached) {
        res.set("X-Cache", "HIT");
        return res.json(cached);
      }
    }

    let trades = await readAllTrades();

    if (filterType) trades = trades.filter((t) => t.type === filterType);
    if (dayLimit) {
      const cutoff = Date.now() - dayLimit * 86400000;
      trades = trades.filter((t) => new Date(t.snapshotAt).getTime() >= cutoff);
    }

    if (trades.length === 0) {
      const empty = {
        trades: [],
        performance: aggregatePerformance([]),
        currentNifty: null,
        totalCount: 0,
        message: "No paper trades recorded yet. Run the Buy Now / Small-Cap / Fundamental scanners to start collecting picks.",
      };
      trackCache.set(cacheKey, empty);
      return res.json(empty);
    }

    // Fetch current prices for all unique symbols + Nifty in parallel.
    // Yahoo's individual chart endpoint is the cheapest reliable price source.
    const uniqueSymbols = [...new Set(trades.map((t) => t.symbol))];
    const [niftyQuote, ...quotes] = await Promise.all([
      fetchQuote("^NSEI").catch(() => null),
      ...uniqueSymbols.map((sym) => fetchQuote(sym).catch(() => null)),
    ]);
    const currentNifty = niftyQuote?.regularMarketPrice ?? null;
    const priceBySymbol = {};
    uniqueSymbols.forEach((sym, i) => {
      const q = quotes[i];
      if (q?.regularMarketPrice) priceBySymbol[sym] = q.regularMarketPrice;
    });

    // Compute returns for each trade
    const tradesWithReturns = trades.map((t) => {
      const currentPrice = priceBySymbol[t.symbol];
      const returns = currentPrice
        ? computeReturns(t, currentPrice, currentNifty)
        : { error: "no_current_price" };
      return { ...t, returns };
    });

    // Sort newest first
    tradesWithReturns.sort((a, b) => new Date(b.snapshotAt) - new Date(a.snapshotAt));

    // Aggregate metrics overall + by type + by regime + by sector
    const performance = aggregatePerformance(tradesWithReturns);
    const byType = groupAndAggregate(tradesWithReturns, "type");
    const byRegime = groupAndAggregate(tradesWithReturns, "regimeAtSnapshot");
    const bySector = groupAndAggregate(tradesWithReturns, "sector");

    const response = {
      trades: tradesWithReturns,
      performance,
      byType,
      byRegime,
      bySector,
      currentNifty,
      totalCount: tradesWithReturns.length,
      uniqueSymbols: uniqueSymbols.length,
      lastComputedAt: new Date().toISOString(),
    };

    trackCache.set(cacheKey, response);
    res.set("X-Cache", "MISS");
    res.json(response);
  } catch (err) {
    console.error("[PAPERTRADES] /api/track/history failed:", err.message);
    res.status(500).json({ error: "Track history failed: " + err.message });
  }
});

/**
 * GET /api/track/stats
 *
 * Lightweight summary endpoint. Returns storage stats + count by type.
 * Used by the empty-state placeholder on the Track Record tab.
 */
app.get("/api/track/stats", async (req, res) => {
  try {
    const [trades, stats] = await Promise.all([readAllTrades(), getStorageStats()]);
    const byType = {};
    for (const t of trades) {
      byType[t.type] = (byType[t.type] || 0) + 1;
    }
    res.json({
      ...stats,
      byType,
      todayKey: getISTDateKey(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/track/snapshot
 *
 * Manual snapshot trigger — useful for testing or for forcing a fresh
 * snapshot mid-day. Body: { type: "buynow_nifty100", picks: [...] }
 */
app.post("/api/track/snapshot", express.json(), async (req, res) => {
  try {
    const { type, picks, force } = req.body || {};
    if (!type || !Array.isArray(picks)) {
      return res.status(400).json({ error: "Body must contain { type, picks: [] }" });
    }
    if (!force && (await hasSnapshotToday(type))) {
      return res.status(409).json({ error: `Snapshot for type ${type} already exists today. Use force: true to override.` });
    }
    const niftyQuote = await fetchQuote("^NSEI").catch(() => null);
    const niftyPrice = niftyQuote?.regularMarketPrice ?? null;
    const result = await snapshotPicks(picks, type, {
      regime: macroRegimeCache.get(MACRO_CACHE_KEY) || defaultCalmRegime(),
      niftyPrice,
      rationale: "Manual snapshot via /api/track/snapshot",
    });
    res.json({ ...result, niftyPrice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/track/migrate
 *
 * One-shot migration: read entries from a JSON body and append them to
 * whatever storage backend is currently active. Used when moving from local
 * file storage to Vercel KV — POST the contents of .paper-trades.json once
 * after KV is provisioned. Idempotent thanks to the per-(date×type×symbol)
 * dedup keys built into the storage adapters.
 *
 * Gated behind MACRO_OVERRIDE_TOKEN on Vercel (same security model as the
 * macro override endpoint) so random Vercel callers can't poison the trade
 * log with arbitrary entries.
 *
 * Usage:
 *   curl -X POST https://stock-platform-gamma.vercel.app/api/track/migrate?token=XXX \
 *     -H 'Content-Type: application/json' \
 *     --data @.paper-trades-export.json
 */
app.post("/api/track/migrate", express.json({ limit: "5mb" }), async (req, res) => {
  // Same security gate as /api/macro/override
  const envToken = process.env.MACRO_OVERRIDE_TOKEN;
  const queryToken = req.query.token;
  const isLocal = !process.env.VERCEL;
  const tokenOk = envToken && queryToken && queryToken === envToken;
  if (!isLocal && !tokenOk) {
    return res.status(403).json({ error: "Migration requires MACRO_OVERRIDE_TOKEN. Set the env var on Vercel and pass ?token=..." });
  }

  try {
    // Body can be either an array of entries OR a JSONL string
    let entries = [];
    if (Array.isArray(req.body)) {
      entries = req.body;
    } else if (typeof req.body === "string") {
      entries = req.body
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } else if (req.body && Array.isArray(req.body.entries)) {
      entries = req.body.entries;
    }
    if (entries.length === 0) {
      return res.status(400).json({ error: "Body must be an array of trade entries or { entries: [...] }" });
    }

    // Validate shape — every entry must have id, type, symbol, snapshotAt
    const valid = entries.filter((e) => e && e.id && e.type && e.symbol && e.snapshotAt && e.priceAtSnapshot);
    if (valid.length === 0) {
      return res.status(400).json({ error: "No valid entries (each must have id, type, symbol, snapshotAt, priceAtSnapshot)" });
    }

    const result = await appendTrades(valid);
    const stats = await getStorageStats();
    res.json({
      ...result,
      received: entries.length,
      validShape: valid.length,
      backendNow: stats.backend,
      totalAfter: stats.lineCount,
    });
  } catch (err) {
    console.error("[PAPERTRADES] Migration failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Parse RSS XML into article objects */
function parseRSS(xml, defaultSource) {
  if (!xml) return [];
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || "").trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || "").trim();
    const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || "").trim();

    if (title) {
      articles.push({
        title: title.replace(/<!\[CDATA\[|\]\]>/g, "").trim(),
        link: link || null,
        publishedAt: safeDateParse(pubDate),
        publisher: source || defaultSource,
        description: desc ? desc.replace(/<[^>]*>/g, "").slice(0, 200) : null,
      });
    }
  }
  return articles;
}

// ==================== HELPERS ====================

function isMarketOpen() {
  const now = new Date();
  const istOffset = 5.5 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = utcMinutes + istOffset;
  const day = new Date(now.getTime() + istOffset * 60 * 1000).getUTCDay();

  if (day === 0 || day === 6) return false;
  return istMinutes >= 555 && istMinutes <= 930;
}

function formatQuote(q) {
  if (!q) return null;
  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: q.regularMarketPrice,
    change: q.regularMarketChange,
    changePercent: q.regularMarketChangePercent,
    dayHigh: q.regularMarketDayHigh,
    dayLow: q.regularMarketDayLow,
    open: q.regularMarketOpen,
    previousClose: q.regularMarketPreviousClose,
    volume: q.regularMarketVolume,
    avgVolume: q.averageDailyVolume3Month,
    marketCap: q.marketCap,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow,
    fiftyDayAvg: q.fiftyDayAverage,
    twoHundredDayAvg: q.twoHundredDayAverage,
    pe: q.trailingPE,
    eps: q.epsTrailingTwelveMonths,
    dividendYield: q.dividendYield,
    exchange: q.exchange,
    currency: q.currency || "INR",
    marketState: q.marketState,
  };
}

// ==================== PORTFOLIO ====================

import { readFileSync, writeFileSync, existsSync } from "fs";
import { getPortfolioStorage } from "./portfolioStorage.js";

// Lazy @vercel/kv client for the portfolio response cache L2. Memoised
// so we don't re-import on every request. Returns null when KV isn't
// configured (local dev) — callers must handle null and skip L2.
let _portfolioKVClient = null;
async function getKVClientForPortfolio() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  if (_portfolioKVClient) return _portfolioKVClient;
  const mod = await import("@vercel/kv");
  _portfolioKVClient = mod.kv;
  return _portfolioKVClient;
}

// Adapter-based portfolio storage (file in dev, Vercel KV in prod) — see
// portfolioStorage.js. Previously portfolio.json was written directly to
// disk, which silently failed on Vercel's read-only filesystem.
async function readPortfolio() {
  return await getPortfolioStorage().read();
}

async function savePortfolio(data) {
  return await getPortfolioStorage().write(data);
}

// ==================== WATCHLIST ====================
// Uses the same dual-backend pattern as paperTradesStorage.js:
// FileStorage for local dev, VercelKVStorage for production.

import { getWatchlistStorage } from "./watchlistStorage.js";

app.get("/api/watchlist", async (req, res) => {
  try {
    const storage = getWatchlistStorage();
    const list = await storage.readAll();
    // Enrich with live prices
    const enriched = await Promise.all(list.map(async (item) => {
      try {
        const q = await fetchQuote(item.symbol);
        return {
          ...item,
          price: q?.regularMarketPrice ?? null,
          change: q?.regularMarketChange ?? null,
          changePercent: q?.regularMarketChangePercent ?? null,
        };
      } catch { return item; }
    }));
    res.json({ stocks: enriched, count: enriched.length, backend: storage.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/watchlist/add", express.json(), async (req, res) => {
  const { symbol, name, sector } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const storage = getWatchlistStorage();
  const result = await storage.add({ symbol, name: name || symbol, sector: sector || null, addedAt: new Date().toISOString() });
  res.json({ ok: true, ...result });
});

app.post("/api/watchlist/remove", express.json(), async (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const storage = getWatchlistStorage();
  const result = await storage.remove(symbol);
  res.json({ ok: true, ...result });
});

/** GET portfolio — returns saved holdings + live prices */
app.get("/api/portfolio", async (req, res) => {
  try {
    const portfolio = await readPortfolio();

    if ((!portfolio.stocks || portfolio.stocks.length === 0) &&
        (!portfolio.mutualFunds || portfolio.mutualFunds.length === 0)) {
      return res.json({
        stocks: [],
        mutualFunds: [],
        lastUpdated: portfolio.lastUpdated,
        message: "No portfolio data yet. Click 'Refresh from Groww' to import.",
      });
    }

    // Fix #2: Portfolio orchestration is expensive (~1s even with warm quote
    // caches). Cache the full response for 30 seconds so auto-refresh,
    // tab-switch, and rapid navigation don't rebuild the whole pipeline.
    // The frontend Refresh button passes ?bust=1 to force a recompute.
    //
    // Cache key includes portfolio.lastUpdated so importing a new snapshot
    // from Groww automatically invalidates — the key changes.
    // Two-tier cache: NodeCache (L1, per-instance, instant) + Vercel KV (L2,
    // shared across lambdas, ~10-30ms). On a new cold lambda, NodeCache is
    // always empty but KV is almost always warm — this shaves the full
    // enrichment+intel pipeline off every second user after any cold start.
    const cacheKey = `port_${portfolio.lastUpdated}`;
    if (!req.query.bust) {
      const l1 = portfolioCache.get(cacheKey);
      if (l1) {
        res.set("X-Cache", "HIT-L1");
        return res.json(l1);
      }
      // L2 check — best-effort, never blocks
      try {
        const kv = await getKVClientForPortfolio();
        if (kv) {
          const l2 = await kv.get(`portfolio:resp:${cacheKey}`);
          if (l2) {
            portfolioCache.set(cacheKey, l2); // promote to L1
            res.set("X-Cache", "HIT-L2");
            return res.json(l2);
          }
        }
      } catch (e) { /* silent — fall through to recompute */ }
    }

    // Enrich stocks with live prices from NSE/Yahoo
    const enrichedStocks = await Promise.all(
      (portfolio.stocks || []).map(async (holding) => {
        let symbol = holding.symbol;
        if (!symbol.endsWith(".NS") && !symbol.endsWith(".BO")) symbol += ".NS";

        // investedValue is always computable from portfolio data
        const investedValue = holding.avgPrice * holding.quantity;

        // Resolve sector for the diversification calculation. Lookup order:
        //   1. portfolio.json (user-maintained, most authoritative)
        //   2. stockList.js (canonical for tracked stocks)
        //   3. fundamentals.json NSE snapshot
        //   4. "Unknown" fallback
        //
        // Without any of these, every holding ends up as "Unknown" and the
        // diversification metric collapses to 0 — which would lie about the
        // portfolio's actual risk profile.
        let sector = holding.sector || null;
        if (!sector) {
          const stockInfo = ALL_STOCKS.find((s) => s.symbol === symbol);
          sector = stockInfo?.sector || null;
        }
        if (!sector) {
          const fundSnap = getFundamentals(symbol);
          sector = fundSnap?.sector || fundSnap?.industry || "Unknown";
        }

        try {
          const quote = await fetchQuote(symbol);
          if (quote) {
            const currentPrice = quote.regularMarketPrice;
            const currentValue = currentPrice * holding.quantity;
            const pnl = currentValue - investedValue;
            const pnlPercent = investedValue > 0 ? (pnl / investedValue) * 100 : 0;

            return {
              ...holding,
              symbol,
              sector,
              currentPrice,
              change: quote.regularMarketChange,
              changePercent: quote.regularMarketChangePercent,
              currentValue,
              investedValue,
              pnl,
              pnlPercent,
              dayHigh: quote.regularMarketDayHigh,
              dayLow: quote.regularMarketDayLow,
              // 52-week range is used by the recovery-probability heuristic
              // (portfolioIntelligence.js → computeRecoveryMath) to distinguish
              // "at 52W low, bounce likely" from "at 52W high, you over-entered"
              fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ?? null,
              fiftyTwoWeekLow: quote.fiftyTwoWeekLow ?? null,
            };
          }
        } catch (e) { /* live quote failed — still return invested data */ }

        // Quote failed: still include investedValue so totals are correct
        return { ...holding, symbol, sector, currentPrice: null, investedValue, currentValue: null, pnl: null, pnlPercent: null };
      })
    );

    // ── Portfolio Intelligence enrichment ──
    // For each holding with live data, run a lightweight technical analysis
    // and look up the pre-computed fundamental snapshot. We deliberately
    // skip the LLM news classifier here — news is too noisy for structural
    // position decisions and we want this to load fast. The user can click
    // any holding to see the full news analysis in the detail view.
    //
    // Uses batches of 8 with 250ms spacing to stay under Yahoo's rate limit
    // when the user has a large portfolio (26+ stocks).
    const analysesBySymbol = new Map();
    const intelBatchSize = 8;
    const holdingsNeedingAnalysis = enrichedStocks.filter((h) => h.currentPrice != null);

    for (let i = 0; i < holdingsNeedingAnalysis.length; i += intelBatchSize) {
      const batch = holdingsNeedingAnalysis.slice(i, i + intelBatchSize);
      const batchResults = await Promise.all(
        batch.map(async (h) => {
          try {
            // Historical is cached so repeat calls are essentially free
            const historical = await fetchHistorical(h.symbol);
            let technicalScore = null;
            if (historical && historical.length >= 30) {
              // COLD-START FIX: don't re-fetch the quote — reuse the one the
              // enrichment step above already got. Same quote, same tick,
              // saves an entire round-trip per holding (26 holdings × ~400ms
              // cold-start latency each = ~10s off the portfolio load).
              const quote = {
                regularMarketPrice: h.currentPrice,
                regularMarketChange: h.change,
                regularMarketChangePercent: h.changePercent,
                regularMarketDayHigh: h.dayHigh,
                regularMarketDayLow: h.dayLow,
                fiftyTwoWeekHigh: h.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: h.fiftyTwoWeekLow,
              };
              const analysis = analyzeStock(historical, quote);
              technicalScore = analysis?.score ?? null;
            }

            // Fundamentals snapshot (from disk, instant)
            const fundSnap = getFundamentals(h.symbol);
            let fundamentalScore = null;
            let fundamentalVerdict = null;
            if (fundSnap) {
              let dma200 = null;
              if (historical && historical.length >= 200) {
                const closes = historical.map((d) => d.close);
                dma200 = closes.slice(-200).reduce((s, v) => s + v, 0) / 200;
              }
              const fundResult = scoreFundamentals(fundSnap, dma200);
              if (fundResult) {
                fundamentalScore = fundResult.score;
                fundamentalVerdict = fundResult.verdict;
              }
            }

            const combinedScore = computePortfolioCombinedScore(technicalScore, fundamentalScore);

            return {
              symbol: h.symbol,
              scores: { combinedScore, technicalScore, fundamentalScore, fundamentalVerdict },
            };
          } catch (e) {
            return { symbol: h.symbol, scores: {} };
          }
        })
      );

      for (const r of batchResults) analysesBySymbol.set(r.symbol, r.scores);

      // Inter-batch pause to be gentle on Yahoo Finance
      if (i + intelBatchSize < holdingsNeedingAnalysis.length) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Fetch the current macro regime for the intelligence engine.
    //
    // COLD-START FIX (Apr 2026): Never block the portfolio response on this.
    // On a cold Vercel lambda, getMacroRegime() does ~10 RSS fetches + an
    // OpenAI call with 3 retries — 15-25s before we can respond. Meanwhile
    // Vercel's 60s function timeout looms. Strategy:
    //   1. Serve the macro regime from the in-memory cache if present
    //   2. On miss: return a neutral CALM regime immediately, fire the real
    //      refresh in the background so the NEXT request gets the real data
    //   3. The /api/cron/warm-caches hourly job keeps the cache primed so
    //      the miss path is rare in steady state
    let portfolioRegime = macroRegimeCache.get(MACRO_CACHE_KEY);
    if (!portfolioRegime) {
      portfolioRegime = defaultCalmRegime();
      // Fire-and-forget refresh. Swallow errors — they'll log inside the
      // refresher and the next caller will retry automatically.
      refreshMacroRegime().catch((e) => {
        console.warn("[MACRO] background refresh failed:", e.message);
      });
    }

    // Build the intelligence block: per-stock actions + health score + urgent queue
    const intelligence = buildPortfolioIntelligence(enrichedStocks, analysesBySymbol, {
      regime: portfolioRegime,
      computeMacroDelta,
    });

    // ── Catalyst calendar (Phase 3 B3) ──
    // Fetch NSE's corporate events calendar once per portfolio request (cached
    // for 2 hours) and match upcoming events to the user's holdings. Two kinds
    // of events matter for a long-only investor:
    //   • "Financial Results" board meetings → upcoming earnings announcements
    //   • "Dividend" / "Bonus" / "Split" → corporate actions to plan around
    // NSE skips from Indian IPs only, so on Vercel this will often be empty —
    // we silently skip if it's unavailable rather than failing the request.
    let catalystsBySymbol = {};
    try {
      // COLD-START FIX: NSE blocks Vercel US IPs, so fetchNseEventCalendar()
      // typically burns its full 12s timeout on cold start. Don't block on it.
      // Serve from cache if present; otherwise trigger a background refresh
      // and move on (warm-caches cron also keeps this fresh).
      let events = catalystCache.get("nse_events");
      if (!events) {
        events = [];
        fetchNseEventCalendar()
          .then((e) => catalystCache.set("nse_events", e))
          .catch(() => {});
      }
      const portfolioSymbols = new Set(
        enrichedStocks.map((h) => h.symbol.replace(".NS", "").replace(".BO", "").toUpperCase())
      );
      // Also include NSE's own symbol variants (e.g. ARE&M maps to our ARE&M)
      const matched = events.filter((e) => portfolioSymbols.has(e.symbol));
      // Categorise each event: earnings, dividend, other
      for (const e of matched) {
        const cat = /financial result/i.test(e.purpose) ? "earnings"
                  : /dividend/i.test(e.purpose) ? "dividend"
                  : /bonus|split/i.test(e.purpose) ? "corporate_action"
                  : "other";
        const sym = e.symbol + ".NS";
        if (!catalystsBySymbol[sym]) catalystsBySymbol[sym] = [];
        catalystsBySymbol[sym].push({
          date: e.date,
          purpose: e.purpose,
          category: cat,
          description: e.description,
        });
      }
    } catch (e) {
      // Silent — catalyst data is a nice-to-have, don't fail the portfolio request
      console.error("Catalyst calendar fetch failed:", e.message);
    }

    // Merge per-stock intelligence + catalyst info into each stock so the
    // frontend has everything in one place
    const enrichedWithIntel = enrichedStocks.map((h) => ({
      ...h,
      intelligence: intelligence.perStock[h.symbol] || null,
      catalysts: catalystsBySymbol[h.symbol] || null,
    }));

    // Calculate stock portfolio totals (invested is always available; current only when quotes loaded)
    const totalInvested = enrichedStocks.reduce((s, h) => s + (h.investedValue || 0), 0);
    const totalCurrent = enrichedStocks.reduce((s, h) => s + (h.currentValue || 0), 0);
    const quotesLoaded = enrichedStocks.filter((h) => h.currentPrice != null).length;
    const totalPnl = totalCurrent - totalInvested;
    const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    // Calculate mutual fund totals
    const mfs = portfolio.mutualFunds || [];
    const mfTotalInvested = mfs.reduce((s, m) => s + (m.invested || 0), 0);
    const mfTotalCurrent = mfs.reduce((s, m) => s + (m.current || 0), 0);
    const mfTotalPnl = mfTotalCurrent - mfTotalInvested;
    const mfTotalPnlPercent = mfTotalInvested > 0 ? (mfTotalPnl / mfTotalInvested) * 100 : 0;

    const response = {
      stocks: enrichedWithIntel,
      mutualFunds: mfs,
      summary: { totalInvested, totalCurrent, totalPnl, totalPnlPercent, quotesLoaded, totalStocks: enrichedStocks.length },
      mfSummary: { totalInvested: mfTotalInvested, totalCurrent: mfTotalCurrent, totalPnl: mfTotalPnl, totalPnlPercent: mfTotalPnlPercent },
      intelligence: {
        healthScore: intelligence.healthScore,
        healthVerdict: intelligence.healthVerdict,
        healthBreakdown: intelligence.healthBreakdown,
        healthStats: intelligence.healthStats,
        urgentActions: intelligence.urgentActions,
        sectorAllocation: intelligence.sectorAllocation,
        topWinners: intelligence.topWinners,
        topLosers: intelligence.topLosers,
        catalystCount: Object.values(catalystsBySymbol).reduce((s, arr) => s + arr.length, 0),
      },
      // Macro regime context for the banner + sector chips on the Portfolio tab
      regime: portfolioRegime,
      lastUpdated: portfolio.lastUpdated,
    };

    // Two-tier write. L1 serves this instance for 30s; L2 serves other
    // warm lambdas for 60s (slightly longer so the shared copy outlives
    // individual instances' L1 windows).
    portfolioCache.set(cacheKey, response);
    try {
      const kv = await getKVClientForPortfolio();
      if (kv) await kv.set(`portfolio:resp:${cacheKey}`, response, { ex: 60 });
    } catch (e) { /* silent — cache write failure is non-fatal */ }
    res.set("X-Cache", "MISS");
    res.json(response);
  } catch (err) {
    console.error("Portfolio error:", err.message);
    res.status(500).json({ error: "Failed to load portfolio" });
  }
});

/** POST portfolio — save holdings from Groww scrape */
app.post("/api/portfolio", async (req, res) => {
  try {
    const { stocks, mutualFunds } = req.body;
    const data = {
      stocks: stocks || [],
      mutualFunds: mutualFunds || [],
      lastUpdated: new Date().toISOString(),
    };
    await savePortfolio(data);
    res.json({ ok: true, stockCount: data.stocks.length, mfCount: data.mutualFunds.length });
  } catch (err) {
    console.error("Portfolio save error:", err.message);
    res.status(500).json({ error: "Failed to save portfolio" });
  }
});

// Serve frontend (local dev only — Vercel serves public/ statically)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Only listen when running directly (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`\n  StarBhai · Indian Stock Intelligence`);
    console.log(`  ========================================`);
    console.log(`  Running on: http://localhost:${PORT}`);
    console.log(`  Market Status: ${isMarketOpen() ? "OPEN" : "CLOSED"}`);
    console.log(`  Tracking ${ALL_STOCKS.length} stocks (${getStocksByIndex("NIFTY50").length} Nifty 50 + ${getStocksByIndex("NIFTY_NEXT_50").length} Nifty Next 50 + ${getStocksByIndex("MIDCAP").length} midcap)`);
    console.log(`  Data: NSE India (primary) + Yahoo Finance (fallback)`);

    // Validate stock list
    const issues = validateStockList();
    if (issues.duplicates.length > 0) console.warn(`  ⚠ Duplicate symbols: ${issues.duplicates.join(", ")}`);
    if (issues.invalid.length > 0) console.warn(`  ⚠ Invalid symbols: ${issues.invalid.join(", ")}`);

    await nseWarmup();

    // Prime the fundamentals in-memory cache from Vercel KV if configured.
    // No-op in local dev (no KV env vars) — the sync disk fallback handles
    // that case on the first getFundamentals() call. This is the ONE async
    // path that loads from KV; every subsequent read is served from cache.
    primeFundamentalsFromKV().catch((e) =>
      console.warn("[FUNDAMENTALS] KV prime failed at startup:", e.message)
    );

    // Warm macro regime cache at startup + schedule 15-min background refresh.
    // Non-blocking: we don't await the first refresh so the server starts fast.
    refreshMacroRegime().then((r) => {
      console.log(`  Macro regime warmed: ${r.regime} (sev ${r.severity}, conf ${r.confidence.toFixed(2)})`);
    });
    setInterval(() => {
      refreshMacroRegime().catch((e) => console.error("[MACRO] scheduled refresh failed:", e.message));
    }, 15 * 60 * 1000);

    console.log("");
  });
}

// On Vercel (serverless) the app.listen block above never runs — each cold
// start imports this module and handles a single request through the
// exported `app`. We still need the fundamentals cache primed from KV on
// that path, so do it here at the module top level. Top-level await is
// supported because package.json has "type": "module". Timeout after 2s so
// a KV outage doesn't block cold starts indefinitely.
if (process.env.VERCEL) {
  await Promise.race([
    primeFundamentalsFromKV().catch((e) =>
      console.warn("[FUNDAMENTALS] KV prime failed on cold start:", e.message)
    ),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
}

// Export for Vercel serverless
export default app;
