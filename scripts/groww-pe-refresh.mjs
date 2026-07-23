#!/usr/bin/env node
/**
 * Groww/Refinitiv stock fundamentals cache for the SWS India pipeline.
 *
 * Groww's stock pages expose Refinitiv-backed fundamentals in __NEXT_DATA__:
 *   props.pageProps.stockData.{header,stats,priceData,financialStatementV2,...}
 *
 * The SWS nightly calls this script before parsing raw SWS API payloads. It
 * writes the canonical rich cache plus a legacy groww-pe-latest.json alias
 * from the same network pass so the relative-P/E scorer cannot diverge during
 * migration.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_STOCK_CACHE_PATH = path.join(REPO_ROOT, "data/sws/groww-stock-latest.json");
export const DEFAULT_PE_CACHE_PATH = path.join(REPO_ROOT, "data/sws/groww-pe-latest.json");
export const DEFAULT_CACHE_PATH = DEFAULT_STOCK_CACHE_PATH;
export const DEFAULT_FAILURE_PATH = path.join(REPO_ROOT, "data/sws/groww-stock-failed.json");
export const DEFAULT_PE_FAILURE_PATH = path.join(REPO_ROOT, "data/sws/groww-pe-failed.json");
const DEFAULT_UNIVERSE_PATH = path.join(REPO_ROOT, "data/sws/universe.json");
const BASE_URL = "https://groww.in";
const FILTER_URL = `${BASE_URL}/stocks/filter`;
const SEARCH_URL = `${BASE_URL}/v1/api/search/v3/query/global/st_p_query`;
export const DEFAULT_SEARCHID_MAP_PATH = path.join(REPO_ROOT, "data/sws/groww-searchid-map.json");

// How long a "this ticker cannot be resolved" verdict is trusted before we retry
// it. Bounded so a newly-listed SME that Groww hasn't indexed yet gets picked up
// within a week instead of being negative-cached forever.
const SEARCHID_NEGATIVE_TTL_DAYS = 7;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (minMs = 120, maxMs = 550) =>
  minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs));

function daysToMs(days) {
  return Number(days) * 86400 * 1000;
}

function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function sanePe(value) {
  const n = asNumber(value);
  return n != null && n > 0 && n < 500 ? n : null;
}

function saneNumber(value, { min = -Infinity, max = Infinity, inclusiveMin = true } = {}) {
  const n = asNumber(value);
  if (n == null) return null;
  if (inclusiveMin ? n < min : n <= min) return null;
  if (n > max) return null;
  return n;
}

function marketCapCrToInr(value) {
  const n = saneNumber(value, { min: 0, inclusiveMin: false });
  return n == null ? null : Math.round(n * 1e7);
}

function percentRatio(value) {
  const n = saneNumber(value, { min: 0, max: 100 });
  return n == null ? null : n;
}

function debtRatioToPct(value) {
  const n = saneNumber(value, { min: 0, max: 20 });
  return n == null ? null : n * 100;
}

function ratio(value, max = 1000) {
  return saneNumber(value, { min: 0, max });
}

// Groww migrated stockData.stats (a keyed object: stats.peRatio, stats.epsTtm,
// stats.industryPe, ...) to stockData.fundamentals (an array of
// {name, shortName, value} with DISPLAY-STRING values, e.g. "18.31", "8.94%",
// "₹17,53,005Cr") around 2026-07-14. That silently nulled every valuation field
// and dropped groww_pe coverage to 0%, hard-blocking the nightly sanity gate.
// These helpers parse the display strings and rebuild the legacy `stats` shape
// so the rest of parseGrowwNextData keeps reading stats.* unchanged.
function displayNum(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[₹,%\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function displayCrore(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[₹,\s]/g, "");
  let mult = 1;
  if (/cr$/i.test(s)) s = s.replace(/cr$/i, "");
  else if (/(lakh|lac|l)$/i.test(s)) { s = s.replace(/(lakh|lac|l)$/i, ""); mult = 0.01; }
  const n = Number(s);
  return Number.isFinite(n) ? n * mult : null;
}

function statsFromFundamentals(fundamentals) {
  if (!Array.isArray(fundamentals)) return {};
  const byName = {};
  for (const f of fundamentals) {
    if (f && typeof f.name === "string") byName[f.name.trim().toLowerCase()] = f.value;
  }
  const get = (name) => byName[name];
  return {
    peRatio: displayNum(get("p/e ratio(ttm)")),
    epsTtm: displayNum(get("eps(ttm)")),
    pbRatio: displayNum(get("p/b ratio")),
    industryPe: displayNum(get("industry p/e")),
    marketCap: displayCrore(get("market cap")),
    roe: displayNum(get("roe")),
    dividendYieldInPercent: displayNum(get("dividend yield")),
    bookValue: displayNum(get("book value")),
    debtToEquity: displayNum(get("debt to equity")),
    faceValue: displayNum(get("face value")),
  };
}

export function normalizeTicker(value) {
  if (value == null) return null;
  const t = String(value).trim().toUpperCase();
  if (!t) return null;
  return t
    .replace(/^NSE:/, "")
    .replace(/^BSE:/, "")
    .replace(/\.NS$/, "")
    .replace(/\.BO$/, "");
}

function extractNextData(html) {
  if (typeof html !== "string" || !html) return null;
  const m = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function pickLiveQuote(pageProps, header) {
  const live = pageProps?.livePriceData || {};
  const keys = [
    header?.nseScriptCode,
    header?.bseScriptCode,
    header?.nseTradingSymbol,
    header?.bseTradingSymbol,
  ].map(normalizeTicker).filter(Boolean);
  for (const key of keys) {
    const quote = live[key];
    if (quote && typeof quote === "object") return quote;
  }
  return null;
}

function pickPriceData(stockData, header) {
  const hasNse = !!header?.nseScriptCode;
  const hasBse = !!header?.bseScriptCode;
  if (hasNse && stockData?.priceData?.nse) return stockData.priceData.nse;
  if (hasBse && stockData?.priceData?.bse) return stockData.priceData.bse;
  return stockData?.priceData?.nse || stockData?.priceData?.bse || null;
}

function latestShareholding(pattern) {
  if (!pattern || typeof pattern !== "object") return null;
  const entries = Object.entries(pattern)
    .map(([label, value]) => ({ label, value }))
    .filter((entry) => entry.value && typeof entry.value === "object");
  if (!entries.length) return null;
  const latest = entries[entries.length - 1];
  const row = latest.value;
  const promoterPct =
    asNumber(row.promoters?.individual?.percent) +
    asNumber(row.promoters?.government?.percent) +
    asNumber(row.promoters?.corporation?.percent);
  const insurancePct = asNumber(row.otherDomesticInstitutions?.insurance?.percent);
  const otherDomesticPct = asNumber(row.otherDomesticInstitutions?.otherFirms?.percent);
  return {
    period: latest.label,
    promoter_pct: Number.isFinite(promoterPct) ? promoterPct : null,
    mutual_fund_pct: asNumber(row.mutualFunds?.percent),
    fii_pct: asNumber(row.foreignInstitutions?.percent),
    insurance_pct: insurancePct,
    other_domestic_institution_pct: otherDomesticPct,
    retail_pct: asNumber(row.retailAndOthers?.percent),
  };
}

function shapeFinancials(stockData) {
  const v2 = stockData?.financialStatementV2 || {};
  const primary = v2.CONSOLIDATED || v2.STANDALONE || stockData?.financialStatement || null;
  if (!Array.isArray(primary)) return null;
  const out = {
    basis: v2.CONSOLIDATED ? "CONSOLIDATED" : (v2.STANDALONE ? "STANDALONE" : "UNKNOWN"),
    yearly: {},
    quarterly: {},
  };
  for (const row of primary) {
    const title = String(row?.title || "").trim().toLowerCase().replace(/\s+/g, "_");
    if (!title) continue;
    if (row.yearly && typeof row.yearly === "object") out.yearly[title] = row.yearly;
    if (row.quarterly && typeof row.quarterly === "object") out.quarterly[title] = row.quarterly;
  }
  return out;
}

function shapeNews(newsData) {
  const rows = Array.isArray(newsData) ? newsData : [];
  return rows.slice(0, 2).map((n) => ({
    id: n.id != null ? String(n.id) : null,
    title: typeof n.title === "string" ? n.title.slice(0, 320) : null,
    url: n.url || null,
    source: n.source || null,
    published_at: toIso(n.pubDate) || null,
  })).filter((n) => n.title || n.summary);
}

function shapeEvents(eventsData) {
  const rows = Array.isArray(eventsData) ? eventsData : [];
  return rows.slice(0, 5).map((e) => ({
    title: e.eventTitle || null,
    type: e.corporateEventFilter || e.eventTitle || null,
    status: e.eventType || null,
    primary_date: toIso(e.primaryDate) || null,
    announcement_date: toIso(e.announcementDate) || null,
    ex_date: toIso(e.exDate) || null,
    record_date: toIso(e.recordDate) || null,
    value: e.eventDetail?.value || null,
  })).filter((e) => e.title || e.type);
}

function shapePeers(similarAssets) {
  const rows = Array.isArray(similarAssets?.peerList) ? similarAssets.peerList : [];
  return rows.slice(0, 3).map((p) => ({
    ticker: normalizeTicker(p.companyHeader?.nseScriptCode || p.companyHeader?.bseScriptCode),
    name: p.companyHeader?.displayName || p.companyHeader?.shortName || null,
    searchId: p.companyHeader?.searchId || null,
    market_cap_inr: marketCapCrToInr(p.marketCap),
    pe: sanePe(p.peRatio),
    pb: ratio(p.pbRatio, 100),
  })).filter((p) => p.ticker || p.name);
}

export function parseGrowwNextData(html, url = null, fetchedAt = new Date().toISOString()) {
  const next = extractNextData(html);
  const pageProps = next?.props?.pageProps || {};
  const stockData = pageProps.stockData;
  const header = stockData?.header || {};
  // Prefer the legacy keyed stats object when present; fall back to the new
  // fundamentals array (Groww schema change 2026-07-14). Forward-compatible:
  // if Groww restores stats.*, that path wins again.
  const stats = stockData?.stats && Object.keys(stockData.stats).length
    ? stockData.stats
    : statsFromFundamentals(stockData?.fundamentals);
  const quote = pickLiveQuote(pageProps, header);
  const priceData = pickPriceData(stockData, header);
  const peRatio = sanePe(stats.peRatio);
  const industryPe = sanePe(stats.industryPe ?? stats.sectorPe);
  const sectorPe = sanePe(stats.sectorPe);
  const currentPriceInr = saneNumber(quote?.ltp ?? quote?.close, { min: 0, inclusiveMin: false });
  const yearLow = saneNumber(quote?.yearLowPrice ?? priceData?.yearLowPrice, { min: 0, inclusiveMin: false });
  const yearHigh = saneNumber(quote?.yearHighPrice ?? priceData?.yearHighPrice, { min: 0, inclusiveMin: false });
  const shareholding = latestShareholding(stockData?.shareHoldingPattern);

  return {
    searchId: header.searchId || null,
    growwCompanyId: header.growwCompanyId || header.growwContractId || null,
    isin: header.isin || null,
    industryId: header.industryId ?? null,
    industryName: header.industryName || null,
    nseScriptCode: header.nseScriptCode || null,
    bseScriptCode: header.bseScriptCode != null ? String(header.bseScriptCode) : null,
    name: header.displayName || header.shortName || stockData?.details?.fullName || null,
    details: stockData?.details ? {
      fullName: stockData.details.fullName || null,
      parentCompany: stockData.details.parentCompany || null,
      headquarters: stockData.details.headquarters || null,
      ceo: stockData.details.ceo || null,
      managingDirector: stockData.details.managingDirector || null,
      foundedYear: stockData.details.foundedYear ?? null,
      websiteUrl: stockData.details.websiteUrl || null,
    } : null,
    currentPriceInr,
    previousCloseInr: saneNumber(quote?.close, { min: 0, inclusiveMin: false }),
    dayChangePct: saneNumber(quote?.dayChangePerc, { min: -100, max: 1000 }),
    volume: saneNumber(quote?.volume, { min: 0 }),
    marketCapInr: marketCapCrToInr(stats.marketCap),
    marketCapCr: saneNumber(stats.marketCap, { min: 0, inclusiveMin: false }),
    fiftyTwoWeek: (yearLow != null || yearHigh != null) ? { low: yearLow, high: yearHigh } : null,
    peRatio,
    epsTtm: asNumber(stats.epsTtm),
    pbRatio: ratio(stats.pbRatio, 100),
    psRatio: ratio(stats.priceToSales, 100),
    evToEbitda: ratio(stats.evToEbitda, 500),
    evToSales: ratio(stats.evToSales, 500),
    pegRatio: saneNumber(stats.pegRatio, { min: -500, max: 500 }),
    bookValue: saneNumber(stats.bookValue),
    faceValue: saneNumber(stats.faceValue, { min: 0 }),
    industryPe,
    sectorPe,
    sectorPb: ratio(stats.sectorPb, 100),
    sectorRoePct: percentRatio(stats.sectorRoe),
    sectorRocePct: percentRatio(stats.sectorRoce),
    dividendYieldPct: percentRatio(stats.dividendYieldInPercent ?? stats.divYield),
    roePct: percentRatio(stats.roe ?? stats.returnOnEquity),
    roaPct: percentRatio(stats.returnOnAssets),
    rocePct: null,
    roicPct: percentRatio(stats.roic),
    netMarginPct: percentRatio(stats.netProfitMargin),
    operatingMarginPct: percentRatio(stats.operatingProfitMargin),
    debtToEquityPct: debtRatioToPct(stats.debtToEquity),
    debtToAssetPct: percentRatio(stats.debtToAsset != null ? Number(stats.debtToAsset) * 100 : null),
    currentRatio: ratio(stats.currentRatio),
    quickRatio: ratio(stats.quickRatio),
    cashRatio: ratio(stats.cashRatio),
    earningsYieldPct: percentRatio(stats.earningsYield),
    pePremiumVsSector: saneNumber(stats.pePremiumVsSector, { min: -100, max: 1000 }),
    pbPremiumVsSector: saneNumber(stats.pbPremiumVsSector, { min: -100, max: 1000 }),
    divYieldVsSector: saneNumber(stats.divYieldVsSector, { min: -100, max: 1000 }),
    shareholding,
    financials: shapeFinancials(stockData),
    news: shapeNews(pageProps.newsData),
    events: shapeEvents(pageProps.eventsData),
    peers: shapePeers(stockData?.similarAssets),
    fetchedAt,
    url: url || (header.searchId ? `${BASE_URL}/stocks/${header.searchId}` : null),
  };
}

export function parseGrowwScreenerRecords(html) {
  const next = extractNextData(html);
  const screener = next?.props?.pageProps?.screenerData;
  const records = Array.isArray(screener?.records) ? screener.records : [];
  return {
    records,
    totalRecords: Number.isFinite(Number(screener?.totalRecords))
      ? Number(screener.totalRecords)
      : null,
  };
}

export function isCacheFresh(cache, now = new Date(), maxAgeDays = 7) {
  if (!cache || typeof cache !== "object") return false;
  const fetchedAt = Date.parse(cache.fetched_at || cache.fetchedAt || "");
  if (!Number.isFinite(fetchedAt)) return false;
  const expiresAt = Date.parse(cache.expires_at || "");
  if (Number.isFinite(expiresAt)) return now.getTime() < expiresAt;
  return now.getTime() - fetchedAt < daysToMs(maxAgeDays);
}

export function isCacheUsable(cache, now = new Date(), staleGraceDays = 21) {
  if (!cache || typeof cache !== "object") return false;
  const fetchedAt = Date.parse(cache.fetched_at || cache.fetchedAt || "");
  if (!Number.isFinite(fetchedAt)) return false;
  if (now.getTime() - fetchedAt > daysToMs(staleGraceDays)) return false;
  const byTicker = cache.by_ticker || {};
  return Object.keys(byTicker).length > 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}

function loadUniverseTickers(file) {
  const raw = readJson(file);
  const arr = Array.isArray(raw) ? raw : (raw?.stocks || raw?.universe || []);
  return arr
    .map((row) => normalizeTicker(row?.ticker || row?.symbol || row))
    .filter(Boolean);
}

export function buildTickerMap(records) {
  const map = new Map();
  for (const rec of records || []) {
    const keys = [
      rec.nseScriptCode,
      rec.bseScriptCode,
      rec.nseTradingSymbol,
      rec.bseTradingSymbol,
    ].map(normalizeTicker).filter(Boolean);
    for (const key of keys) {
      if (!map.has(key)) map.set(key, rec);
    }
  }
  return map;
}

function parseArgs(argv) {
  const opts = {
    out: DEFAULT_CACHE_PATH,
    peOut: DEFAULT_PE_CACHE_PATH,
    failureOut: DEFAULT_FAILURE_PATH,
    peFailureOut: DEFAULT_PE_FAILURE_PATH,
    universe: DEFAULT_UNIVERSE_PATH,
    maxAgeDays: 1,
    staleGraceDays: 3,
    // P/E-alias stale grace: how old the last-good groww-pe-latest.json may be and
    // still be preserved when a fresh fetch's P/E collapses to zero. Defaults to 21
    // to match sws-sanity-gate.mjs GROWW_PE_STALE_GRACE_DAYS, so an ad-hoc run stays
    // consistent with the gate even when --stale-grace-days (stock) is left at 3.
    peStaleGraceDays: 21,
    concurrency: 6,
    retries: 2,
    // Bound the search-fallback request budget per run. Overflow is deferred to
    // the next run rather than dropped, and already-resolved tickers come from
    // the persisted map at zero cost, so steady state is near-zero lookups.
    maxSearchLookups: 900,
    searchIdMap: DEFAULT_SEARCHID_MAP_PATH,
    noSearchFallback: false,
    timeoutMs: 15000,
    minCoveragePct: 70,
    force: false,
    dryRun: false,
    validateOnly: false,
    tickers: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") opts.force = true;
    else if (arg === "--validate-only") opts.validateOnly = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--out") opts.out = path.resolve(argv[++i]);
    else if (arg === "--pe-out") opts.peOut = path.resolve(argv[++i]);
    else if (arg === "--failure-out") opts.failureOut = path.resolve(argv[++i]);
    else if (arg === "--pe-failure-out") opts.peFailureOut = path.resolve(argv[++i]);
    else if (arg === "--universe") opts.universe = path.resolve(argv[++i]);
    else if (arg === "--max-age-days") opts.maxAgeDays = Number(argv[++i]);
    else if (arg === "--stale-grace-days") opts.staleGraceDays = Number(argv[++i]);
    else if (arg === "--pe-stale-grace-days") opts.peStaleGraceDays = Number(argv[++i]);
    else if (arg === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (arg === "--retries") opts.retries = Number(argv[++i]);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (arg === "--min-coverage-pct") opts.minCoveragePct = Number(argv[++i]);
    else if (arg === "--max-search-lookups") opts.maxSearchLookups = Number(argv[++i]);
    else if (arg === "--searchid-map") opts.searchIdMap = path.resolve(argv[++i]);
    else if (arg === "--no-search-fallback") opts.noSearchFallback = true;
    else if (arg === "--tickers") {
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.tickers.push(argv[++i]);
    } else if (!arg.startsWith("--")) {
      opts.tickers.push(arg);
    }
  }
  opts.tickers = opts.tickers.map(normalizeTicker).filter(Boolean);
  return opts;
}

async function fetchText(url, { timeoutMs = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) await sleep((attempt + 1) * 700 + jitter());
    }
  }
  throw lastErr || new Error("fetch failed");
}

async function fetchScreenerRecords(opts) {
  const records = [];
  let totalRecords = null;
  for (let page = 0; page < 80; page++) {
    const url = `${FILTER_URL}?page=${page}&size=100`;
    const html = await fetchText(url, opts);
    const parsed = parseGrowwScreenerRecords(html);
    if (totalRecords == null && parsed.totalRecords != null) totalRecords = parsed.totalRecords;
    if (!parsed.records.length) break;
    records.push(...parsed.records);
    if (totalRecords != null && records.length >= totalRecords) break;
    await sleep(jitter(150, 450));
  }
  return { records, totalRecords };
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Is this ticker even a candidate for search-based resolution?
 *
 * The search endpoint is keyed on the NSE scrip code, so anything that isn't
 * NSE-symbol-shaped can never match: `BSE_500041`-style pseudo-tickers (our
 * universe's placeholder for BSE-only listings) and bare numeric BSE codes have
 * no NSE code to compare against. Skipping them is not a shortcut — it removes
 * ~52% of the unmapped set from the request budget for zero lost coverage.
 */
export function isSearchResolvableTicker(ticker) {
  const t = String(ticker || "").trim().toUpperCase();
  if (!t) return false;
  if (t.startsWith("BSE_")) return false;
  if (/^\d+$/.test(t)) return false;
  return /^[A-Z0-9][A-Z0-9&-]{0,19}$/.test(t);
}

/**
 * Resolve one ticker to a Groww searchId — STRICTLY.
 *
 * Accepts a hit ONLY when its `nse_scrip_code` equals the ticker we asked for.
 *
 * This exactness is the whole safety property, not a nicety. Groww's search for
 * the retired `TATAMOTORS` returns `tata-motors-ltd`, whose nse_scrip_code is
 * **TMPV** — Tata Motors demerged into TMPV/TMCV. Taking the first hit (or a
 * fuzzy/name match) would silently file TMPV's P/E under TATAMOTORS, i.e. write
 * one company's valuation into another's row, in a field that feeds V4 scoring.
 * A miss here is cheap (the ticker stays unmapped, exactly as today); a wrong
 * match is silent data corruption. So: exact NSE code, or nothing.
 */
export async function resolveSearchIdStrict(ticker, { timeoutMs = 15000, retries = 1, fetchImpl } = {}) {
  const want = String(ticker || "").trim().toUpperCase();
  if (!want) return null;
  const url = `${SEARCH_URL}?page=0&query=${encodeURIComponent(want)}&size=5`;
  let raw;
  try {
    raw = fetchImpl ? await fetchImpl(url) : await fetchText(url, { timeoutMs, retries });
  } catch {
    return null;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = json?.data?.content || json?.content || [];
  if (!Array.isArray(list)) return null;
  for (const hit of list) {
    const code = String(hit?.nse_scrip_code || "").trim().toUpperCase();
    const searchId = hit?.search_id || hit?.searchId;
    if (code && code === want && searchId) return String(searchId);
  }
  return null;
}

function loadSearchIdMap(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      resolved: parsed?.resolved && typeof parsed.resolved === "object" ? parsed.resolved : {},
      unresolved: parsed?.unresolved && typeof parsed.unresolved === "object" ? parsed.unresolved : {},
    };
  } catch {
    return { resolved: {}, unresolved: {} };
  }
}

/**
 * Recover tickers the screener omits, via the strict resolver.
 *
 * Groww's /stocks/filter endpoint serves only ~4476 records while reporting
 * `totalRecords: 5019`, and exhausting its pagination does not change that — so a
 * chunk of the universe (notably recent SME/small-cap listings) simply has no
 * screener row to map from. Before this, those tickers were dropped outright,
 * which pushed coverage under the 70% floor and hard-blocked the whole SWS ship.
 *
 * Results persist to disk so a resolved ticker costs one search call ever, and
 * failures are negative-cached with a short TTL so we neither hammer the endpoint
 * nightly nor permanently write off a newly-listed name.
 */
async function resolveUnmappedSearchIds(unmapped, opts) {
  const out = { resolved: [], attempted: 0, fromCache: 0, skipped: 0, map: null };
  if (!unmapped.length || opts.noSearchFallback) return out;

  const mapFile = opts.searchIdMap || DEFAULT_SEARCHID_MAP_PATH;
  const store = loadSearchIdMap(mapFile);
  const nowMs = Date.now();
  const negativeTtlMs = daysToMs(SEARCHID_NEGATIVE_TTL_DAYS);

  const toQuery = [];
  for (const ticker of unmapped) {
    const cachedId = store.resolved[ticker];
    if (cachedId) {
      out.resolved.push({ ticker, searchId: cachedId });
      out.fromCache += 1;
      continue;
    }
    if (!isSearchResolvableTicker(ticker)) {
      out.skipped += 1;
      continue;
    }
    const negAt = Date.parse(store.unresolved[ticker] || "");
    if (Number.isFinite(negAt) && nowMs - negAt < negativeTtlMs) {
      out.skipped += 1;
      continue;
    }
    toQuery.push(ticker);
  }

  const budget = toQuery.slice(0, opts.maxSearchLookups);
  const deferred = toQuery.length - budget.length;
  console.log(
    `[groww-stock] searchId fallback: ${out.fromCache} from map, ${budget.length} to look up, ` +
      `${out.skipped} skipped (not NSE-shaped / negative-cached)${deferred > 0 ? `, ${deferred} deferred past budget` : ""}`
  );

  const looked = await mapLimit(budget, Math.min(opts.concurrency, 6), async (ticker) => {
    await sleep(jitter(120, 400));
    const searchId = await resolveSearchIdStrict(ticker, {
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
    });
    return { ticker, searchId };
  });
  out.attempted = budget.length;

  const stamp = new Date().toISOString();
  for (const row of looked) {
    if (!row) continue;
    if (row.searchId) {
      store.resolved[row.ticker] = row.searchId;
      delete store.unresolved[row.ticker];
      out.resolved.push(row);
    } else {
      store.unresolved[row.ticker] = stamp;
    }
  }

  out.map = { file: mapFile, store, stamp };
  console.log(`[groww-stock] searchId fallback recovered ${out.resolved.length} ticker(s)`);
  return out;
}

async function refreshCache(opts) {
  const now = new Date();
  const fetchedAt = now.toISOString();
  const targetTickers = opts.tickers.length
    ? [...new Set(opts.tickers)]
    : [...new Set(loadUniverseTickers(opts.universe))];
  if (!targetTickers.length) throw new Error(`no tickers found in ${opts.universe}`);

  console.log(`[groww-stock] target tickers=${targetTickers.length}`);
  console.log("[groww-stock] loading Groww screener map...");
  const { records, totalRecords } = await fetchScreenerRecords({
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });
  const tickerMap = buildTickerMap(records);
  console.log(`[groww-stock] screener records=${records.length}${totalRecords != null ? `/${totalRecords}` : ""}, ticker keys=${tickerMap.size}`);

  const unmapped = [];
  const targets = [];
  for (const ticker of targetTickers) {
    const rec = tickerMap.get(ticker);
    if (!rec?.searchId) {
      unmapped.push(ticker);
      continue;
    }
    targets.push({ ticker, rec });
  }

  // Second pass: the screener does not cover the full universe (it serves ~4476
  // of a claimed 5019), so ask the search endpoint for what it missed.
  const screenerMappedCount = targets.length;
  const fallback = await resolveUnmappedSearchIds(unmapped, opts);
  const recoveredTickers = new Set();
  for (const { ticker, searchId } of fallback.resolved) {
    targets.push({ ticker, rec: { searchId, source: "search_fallback" } });
    recoveredTickers.add(ticker);
  }
  const stillUnmapped = unmapped.filter((t) => !recoveredTickers.has(t));

  const byTicker = {};
  const fetchFailed = [];
  const fetched = await mapLimit(targets, opts.concurrency, async ({ ticker, rec }) => {
    const url = `${BASE_URL}/stocks/${rec.searchId}`;
    try {
      await sleep(jitter(80, 350));
      const html = await fetchText(url, { timeoutMs: opts.timeoutMs, retries: opts.retries });
      const parsed = parseGrowwNextData(html, url, fetchedAt);
      if (!parsed.searchId) throw new Error("stockData missing");
      return { ticker, parsed };
    } catch (err) {
      return { ticker, error: err?.message || String(err), searchId: rec.searchId, url };
    }
  });

  for (const item of fetched) {
    if (item?.parsed) byTicker[item.ticker] = item.parsed;
    else if (item) fetchFailed.push(item);
  }

  const usableCount = Object.values(byTicker)
    .filter((entry) => entry?.currentPriceInr != null || entry?.marketCapInr != null || sanePe(entry?.peRatio) != null)
    .length;
  const peUsableCount = Object.values(byTicker)
    .filter((entry) => sanePe(entry.peRatio) != null && sanePe(entry.industryPe) != null)
    .length;
  const coveragePct = targetTickers.length ? (usableCount / targetTickers.length) * 100 : 0;
  const peCoveragePct = targetTickers.length ? (peUsableCount / targetTickers.length) * 100 : 0;
  const cache = {
    schema_version: "groww-stock-v1",
    source: "groww_refinitiv",
    fetched_at: fetchedAt,
    expires_at: new Date(now.getTime() + daysToMs(opts.maxAgeDays)).toISOString(),
    max_age_days: opts.maxAgeDays,
    stale_grace_days: opts.staleGraceDays,
    coverage: {
      target_count: targetTickers.length,
      screener_records_count: records.length,
      screener_total_records: totalRecords,
      mapped_count: targets.length,
      // Split out so a future coverage drop is attributable: a falling
      // screener_mapped_count means Groww's filter shrank, whereas a falling
      // search_recovered_count means the fallback or the search endpoint broke.
      screener_mapped_count: screenerMappedCount,
      search_recovered_count: fallback.resolved.length,
      search_lookups_attempted: fallback.attempted,
      search_map_hits: fallback.fromCache,
      unmapped_count: stillUnmapped.length,
      fetched_count: Object.keys(byTicker).length,
      usable_count: usableCount,
      coverage_pct: Math.round(coveragePct * 100) / 100,
      pe_usable_count: peUsableCount,
      pe_coverage_pct: Math.round(peCoveragePct * 100) / 100,
    },
    by_ticker: byTicker,
    missing: {
      // Post-fallback: tickers the screener missed AND the strict resolver could
      // not confirm. Reporting the pre-fallback list here would overstate the gap
      // and hide whether the fallback is working.
      unmapped: stillUnmapped,
      fetch_failed: fetchFailed,
    },
  };

  // Persist the learned map only after a successful build, so a run that dies
  // mid-flight cannot leave behind negative verdicts it never really tested.
  if (fallback.map && !opts.dryRun) {
    writeJsonAtomic(fallback.map.file, {
      schema_version: "groww-searchid-map-v1",
      updated_at: fallback.map.stamp,
      note:
        "ticker -> Groww searchId, resolved by STRICT nse_scrip_code equality for tickers " +
        "the /stocks/filter screener does not serve. `unresolved` is negative-cached with a " +
        `${SEARCHID_NEGATIVE_TTL_DAYS}-day TTL. Never populate this by name/fuzzy match: ` +
        "Groww search for the retired TATAMOTORS returns TMPV's page.",
      resolved: fallback.map.store.resolved,
      unresolved: fallback.map.store.unresolved,
    });
  }

  return cache;
}

export function buildPeAliasCache(cache) {
  const byTicker = {};
  const source = cache?.by_ticker || {};
  let usableCount = 0;
  for (const [ticker, entry] of Object.entries(source)) {
    byTicker[ticker] = {
      searchId: entry.searchId || null,
      growwCompanyId: entry.growwCompanyId || null,
      isin: entry.isin || null,
      industryId: entry.industryId ?? null,
      industryName: entry.industryName || null,
      nseScriptCode: entry.nseScriptCode || null,
      bseScriptCode: entry.bseScriptCode != null ? String(entry.bseScriptCode) : null,
      peRatio: sanePe(entry.peRatio),
      epsTtm: asNumber(entry.epsTtm),
      industryPe: sanePe(entry.industryPe),
      sectorPe: sanePe(entry.sectorPe),
      fetchedAt: entry.fetchedAt || cache.fetched_at || null,
      url: entry.url || null,
    };
    if (byTicker[ticker].peRatio != null && byTicker[ticker].industryPe != null) usableCount++;
  }
  const targetCount = Number(cache?.coverage?.target_count ?? Object.keys(source).length);
  return {
    schema_version: "groww-pe-v1",
    source: cache?.source || "groww_refinitiv",
    fetched_at: cache?.fetched_at || null,
    expires_at: cache?.expires_at || null,
    max_age_days: cache?.max_age_days ?? null,
    stale_grace_days: cache?.stale_grace_days ?? null,
    coverage: {
      target_count: targetCount,
      screener_records_count: cache?.coverage?.screener_records_count ?? null,
      screener_total_records: cache?.coverage?.screener_total_records ?? null,
      mapped_count: cache?.coverage?.mapped_count ?? null,
      fetched_count: cache?.coverage?.fetched_count ?? Object.keys(source).length,
      usable_count: usableCount,
      coverage_pct: targetCount > 0 ? Math.round((usableCount / targetCount) * 10000) / 100 : 0,
    },
    by_ticker: byTicker,
    missing: cache?.missing || { unmapped: [], fetch_failed: [] },
  };
}

function writeFailureReport(file, report) {
  try {
    writeJsonAtomic(file, {
      schema_version: "groww-stock-failure-v1",
      source: "groww_refinitiv",
      generated_at: new Date().toISOString(),
      ...report,
    });
  } catch (err) {
    console.warn(`[groww-stock] failed to write failure report: ${err.message}`);
  }
}

function writeFailureReports(opts, report) {
  writeFailureReport(opts.failureOut, report);
  if (opts.peFailureOut) {
    writeFailureReport(opts.peFailureOut, {
      ...report,
      schema_note: "legacy groww-pe alias report; canonical report is groww-stock-failed.json",
    });
  }
}

// Is the on-disk P/E alias good enough to keep instead of clobbering it with a
// zero-usable fresh fetch? True iff it has usable P/E rows AND is still within the
// caller's stale grace. Pure — the temporal input is `now` so tests can pin it.
export function peAliasPreservable(peAlias, staleGraceDays, now = Date.now()) {
  if (!peAlias || typeof peAlias !== "object") return false;
  const usable = Number(peAlias.coverage?.usable_count ?? 0);
  if (!(usable > 0)) return false; // nothing worth keeping
  const fetchedMs = Date.parse(peAlias.fetched_at || "");
  if (!Number.isFinite(fetchedMs)) return false; // undatable → cannot prove freshness
  return (now - fetchedMs) / 86400000 <= staleGraceDays;
}

// The stock cache always ships fresh (we only reach here once its coverage cleared
// the floor). The P/E ALIAS gets a guard the stock cache lacks: when a schema break
// nulls every peRatio (cache.coverage.pe_usable_count === 0) but stock scraping is
// otherwise healthy, overwriting groww-pe-latest.json with a 0-usable file would
// destroy the last-good P/E and defeat sws-sanity-gate.mjs's 21-day stale-grace net
// (which passes the groww_pe block only via staleFallbackUsable at ~11% steady-state
// coverage). So on a total P/E collapse we preserve the existing in-grace alias
// untouched — keeping its real fetched_at so the grace still counts down — rather
// than rebuild it from `cache` (whose stock cache was itself just overwritten with
// null P/E). Returns whether the alias was preserved so main() can report it.
export function writeCacheOutputs(opts, cache) {
  writeJsonAtomic(opts.out, cache);
  if (!opts.peOut) return { pePreserved: false };

  const freshPeUsable = Number(cache?.coverage?.pe_usable_count ?? 0);
  if (freshPeUsable === 0) {
    const existingPe = readJson(opts.peOut);
    if (peAliasPreservable(existingPe, opts.peStaleGraceDays)) {
      return {
        pePreserved: true,
        preservedFrom: existingPe.fetched_at || null,
        preservedUsable: existingPe.coverage?.usable_count ?? null,
      };
    }
  }

  writeJsonAtomic(opts.peOut, buildPeAliasCache(cache));
  return { pePreserved: false };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const existing = readJson(opts.out);

  if (opts.validateOnly) {
    if (!isCacheUsable(existing, new Date(), opts.staleGraceDays)) {
      writeFailureReports(opts, {
        status: "validate_failed_no_usable_cache",
        previous_cache_fetched_at: existing?.fetched_at || null,
      });
      throw new Error(`Groww stock cache missing or older than ${opts.staleGraceDays}d stale grace`);
    }
    const cov = existing.coverage || {};
    if (opts.peOut && !opts.dryRun) writeJsonAtomic(opts.peOut, buildPeAliasCache(existing));
    writeFailureReports(opts, {
      status: "validate_ok",
      coverage: cov,
      previous_cache_fetched_at: existing?.fetched_at || null,
    });
    console.log(`[groww-stock] cache usable (${existing.fetched_at}); usable=${cov.usable_count ?? "?"}/${cov.target_count ?? "?"}, coverage=${cov.coverage_pct ?? "?"}%`);
    return;
  }

  if (!opts.force && isCacheFresh(existing, new Date(), opts.maxAgeDays)) {
    const cov = existing.coverage || {};
    if (opts.peOut && !opts.dryRun) writeJsonAtomic(opts.peOut, buildPeAliasCache(existing));
    console.log(`[groww-stock] cache fresh (${existing.fetched_at}); usable=${cov.usable_count ?? "?"}/${cov.target_count ?? "?"}, coverage=${cov.coverage_pct ?? "?"}%`);
    return;
  }

  let cache;
  try {
    cache = await refreshCache(opts);
  } catch (err) {
    const usableExisting = isCacheUsable(existing, new Date(), opts.staleGraceDays);
    writeFailureReports(opts, {
      status: usableExisting ? "refresh_failed_using_stale_cache" : "refresh_failed_no_usable_cache",
      error: err?.message || String(err),
      previous_cache_fetched_at: existing?.fetched_at || null,
    });
    if (usableExisting) {
      if (opts.peOut && !opts.dryRun) writeJsonAtomic(opts.peOut, buildPeAliasCache(existing));
      console.warn(`[groww-stock] refresh failed (${err.message}); using stale cache from ${existing.fetched_at}`);
      return;
    }
    throw err;
  }

  const coveragePct = Number(cache.coverage?.coverage_pct ?? 0);
  const previousUsable = isCacheUsable(existing, new Date(), opts.staleGraceDays);
  if (coveragePct < opts.minCoveragePct && previousUsable) {
    writeFailureReports(opts, {
      status: "coverage_below_floor_using_stale_cache",
      coverage: cache.coverage,
      previous_cache_fetched_at: existing?.fetched_at || null,
      missing: cache.missing,
    });
    if (opts.peOut && !opts.dryRun) writeJsonAtomic(opts.peOut, buildPeAliasCache(existing));
    console.warn(`[groww-stock] coverage ${coveragePct}% below ${opts.minCoveragePct}%; keeping stale cache from ${existing.fetched_at}`);
    return;
  }
  if (coveragePct < opts.minCoveragePct) {
    writeFailureReports(opts, {
      status: "coverage_below_floor_no_usable_cache",
      coverage: cache.coverage,
      missing: cache.missing,
    });
    throw new Error(`Groww P/E coverage ${coveragePct}% below floor ${opts.minCoveragePct}%`);
  }

  if (opts.dryRun) {
    console.log(`[groww-stock] dry-run: would write ${opts.out}`);
  } else {
    const peResult = writeCacheOutputs(opts, cache);
    writeFailureReports(opts, {
      status: peResult.pePreserved ? "ok_pe_collapse_preserved_stale_pe_alias" : "ok",
      coverage: cache.coverage,
      ...(peResult.pePreserved
        ? {
            pe_alias_preserved: {
              fetched_at: peResult.preservedFrom,
              usable_count: peResult.preservedUsable,
              fresh_pe_usable_count: cache.coverage.pe_usable_count,
            },
          }
        : {}),
      missing: {
        unmapped_count: cache.missing.unmapped.length,
        fetch_failed_count: cache.missing.fetch_failed.length,
        unmapped_sample: cache.missing.unmapped.slice(0, 25),
        fetch_failed_sample: cache.missing.fetch_failed.slice(0, 10),
      },
    });
    if (peResult.pePreserved) {
      console.warn(`[groww-stock] P/E collapse: fresh pe_usable=0; preserved last-good pe alias (${peResult.preservedFrom}, usable=${peResult.preservedUsable}) — stock cache shipped fresh, groww-pe-latest.json untouched`);
    }
  }
  console.log(`[groww-stock] cache ${opts.dryRun ? "validated" : "written"}: usable=${cache.coverage.usable_count}/${cache.coverage.target_count}, coverage=${cache.coverage.coverage_pct}%, pe=${cache.coverage.pe_coverage_pct}%`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[groww-stock] ERROR: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
