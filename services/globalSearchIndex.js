import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = process.env.SWS_REPO_ROOT_OVERRIDE
  ? path.resolve(process.cwd(), process.env.SWS_REPO_ROOT_OVERRIDE)
  : path.resolve(__dirname, "..");

const MARKET_CONFIGS = [
  { market: "india", marketLabel: "India", currency: "INR", relPath: "data/sws/sws-scored-universe.json", symbolFor: (ticker) => `${ticker}.NS` },
  { market: "us", marketLabel: "US", currency: "USD", relPath: "data/sws-us/sws-scored-universe.json", symbolFor: (ticker) => ticker },
  { market: "kr", marketLabel: "Korea", currency: "KRW", relPath: "data/sws-kr/sws-scored-universe.json", symbolFor: (ticker) => ticker },
  { market: "tw", marketLabel: "Taiwan", currency: "TWD", relPath: "data/sws-tw/sws-scored-universe.json", symbolFor: (ticker) => ticker },
];

const fileCache = new Map(); // abs path -> { mtimeMs, data }

function readJsonMtimeCached(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fileCache.delete(filePath);
    return null;
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return null;
  }
}

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

export function stripIndiaExchangeSuffix(value) {
  return String(value || "").trim().replace(/\.(ns|bo)$/i, "");
}

export function normaliseSearchQuery(query) {
  return norm(stripIndiaExchangeSuffix(query));
}

function scoreMatch(row, q) {
  if (!q) return null;
  const ticker = norm(row.ticker);
  const symbol = norm(row.symbol);
  const bareSymbol = norm(stripIndiaExchangeSuffix(row.symbol));
  const name = norm(row.name);
  const sector = norm(row.sector);

  if (ticker === q || symbol === q || bareSymbol === q) return 0;
  if (ticker.startsWith(q) || symbol.startsWith(q) || bareSymbol.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (ticker.includes(q) || symbol.includes(q) || bareSymbol.includes(q) || name.includes(q)) return 3;
  if (sector.includes(q)) return 4;
  return null;
}

function marketOrder(market) {
  return { india: 0, us: 1, kr: 2, tw: 3 }[market] ?? 99;
}

function rowToSearchResult(raw, config) {
  if (!raw || !raw.ticker) return null;
  const ticker = String(raw.ticker).trim();
  if (!ticker) return null;
  const currency = raw.currency || config.currency || null;
  return {
    symbol: config.symbolFor(ticker),
    ticker,
    name: raw.name || ticker,
    sector: raw.sector || "",
    exchange: config.marketLabel,
    type: "EQUITY",
    market: config.market,
    marketLabel: config.marketLabel,
    currency,
    source: "sws",
    score: raw.v4_score_100 ?? raw.v4_score ?? raw.score ?? null,
    verdict: raw.v4_verdict || raw.composite_verdict || raw.verdict || null,
  };
}

export function loadSwsSearchRows({ root = DEFAULT_ROOT } = {}) {
  const rows = [];
  for (const config of MARKET_CONFIGS) {
    const raw = readJsonMtimeCached(path.join(root, config.relPath));
    const stocks = Array.isArray(raw) ? raw : Array.isArray(raw?.stocks) ? raw.stocks : [];
    for (const stock of stocks) {
      const row = rowToSearchResult(stock, config);
      if (row) rows.push(row);
    }
  }
  return rows;
}

export function searchSwsMarkets(query, { root = DEFAULT_ROOT, limit = 40 } = {}) {
  const q = normaliseSearchQuery(query);
  if (!q) return [];
  const ranked = [];
  for (const row of loadSwsSearchRows({ root })) {
    const rank = scoreMatch(row, q);
    if (rank == null) continue;
    ranked.push({ row, rank });
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const marketCmp = marketOrder(a.row.market) - marketOrder(b.row.market);
    if (marketCmp !== 0) return marketCmp;
    const scoreA = typeof a.row.score === "number" ? a.row.score : -Infinity;
    const scoreB = typeof b.row.score === "number" ? b.row.score : -Infinity;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return String(a.row.symbol).localeCompare(String(b.row.symbol));
  });
  return ranked.slice(0, limit).map(({ row }) => row);
}

export function rankGlobalSearchResults(query, results, { limit = 15 } = {}) {
  const q = normaliseSearchQuery(query);
  if (!q || !Array.isArray(results)) return [];
  return results
    .map((row, inputOrder) => ({
      row,
      inputOrder,
      rank: scoreMatch(row, q) ?? 9,
    }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const marketCmp = marketOrder(a.row?.market) - marketOrder(b.row?.market);
      if (marketCmp !== 0) return marketCmp;
      const scoreA = typeof a.row?.score === "number" ? a.row.score : -Infinity;
      const scoreB = typeof b.row?.score === "number" ? b.row.score : -Infinity;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.inputOrder - b.inputOrder;
    })
    .slice(0, limit)
    .map(({ row }) => row);
}

function dedupeKey(row) {
  const market = row?.market || "india";
  if (market === "india") {
    return `${market}:${stripIndiaExchangeSuffix(row?.symbol || row?.ticker).toUpperCase()}`;
  }
  return `${market}:${String(row?.ticker || row?.symbol || "").toUpperCase()}`;
}

export function dedupeGlobalSearchResults(results) {
  if (!Array.isArray(results)) return [];
  const out = [];
  const seen = new Set();
  for (const row of results) {
    const key = dedupeKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function hasIndiaSearchResult(results) {
  return Array.isArray(results) && results.some((row) => row?.market === "india");
}
