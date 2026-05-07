#!/usr/bin/env node
/**
 * SWS availability probe.
 *
 * Determines, for every ticker in our coverage gap, whether SWS has a stock
 * page for it. The output drives `data/coverage/sws_universe_delta.json` —
 * we only merge into universe.json the tickers SWS can actually serve.
 *
 * Strategy: SWS publishes a public sitemap index at /sitemap.xml. The Asia
 * branch (`sitemap/companies/as-asia.xml`) fans out into 12 paginated shards
 * each containing every Asian company URL SWS knows about. India URLs follow
 *   https://simplywall.st/stocks/in/<sector>/<nse|bse>-<id>/<slug>-shares
 *
 * So the probe is just: download the 12 shards once, extract India URLs,
 * index by exchange+ticker, then look up each candidate. No per-ticker HTTP
 * roundtrip, no Cloudflare friction, no rate-limit concerns.
 *
 * Output:
 *   data/coverage/sws_availability_probe.json
 *     {
 *       generatedAt, sitemapAt,
 *       indexedCount,             // total India URLs SWS lists
 *       byNseTicker:    { TICKER: { url, sector, slug } }
 *       byBseCode:      { "500285": { url, sector, slug } }
 *       probeResults: [
 *         { ticker, source, swsAvailable, swsUrl, sector, swsTickerForm }
 *       ]
 *     }
 *
 * Cache: by default reuses sitemap shards already on disk (data/coverage/sws-sitemap-cache/);
 * pass --refresh to force re-download.
 *
 * Usage:
 *   node scripts/sws-probe-availability.mjs              # probe with cached sitemap
 *   node scripts/sws-probe-availability.mjs --refresh    # re-download sitemap
 *   node scripts/sws-probe-availability.mjs --gap-file <path>  # alt input
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SITEMAP_INDEX_URL = "https://simplywall.st/sitemap/companies/as-asia.xml";
const SITEMAP_CACHE_DIR = path.join(ROOT, "data/coverage/sws-sitemap-cache");
const SITEMAP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week — sitemap rarely changes
const GAP_FILE_DEFAULT = path.join(ROOT, "data/coverage/coverage_gap.json");
const OUT_PATH = path.join(ROOT, "data/coverage/sws_availability_probe.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// ─────────────────────────────────────────── Sitemap fetch / cache ───────────

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/xml, text/xml, */*" },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function cachePathFor(url) {
  // Stable filename derived from the last two URL segments.
  const m = url.match(/\/([^/]+)\/([^/]+)$/);
  return path.join(SITEMAP_CACHE_DIR, `${m?.[1] || "x"}__${m?.[2] || "x"}`);
}

function isFresh(p) {
  if (!fs.existsSync(p)) return false;
  return Date.now() - fs.statSync(p).mtimeMs < SITEMAP_CACHE_TTL_MS;
}

async function fetchCached(url, { refresh = false } = {}) {
  fs.mkdirSync(SITEMAP_CACHE_DIR, { recursive: true });
  const cp = cachePathFor(url);
  if (!refresh && isFresh(cp)) return fs.readFileSync(cp, "utf-8");
  const text = await fetchText(url);
  fs.writeFileSync(cp, text);
  return text;
}

async function listShardUrls({ refresh }) {
  const idx = await fetchCached(SITEMAP_INDEX_URL, { refresh });
  // <loc>https://simplywall.st/sitemap/companies/as-asia/N.xml</loc>
  return [...idx.matchAll(/<loc>([^<]+as-asia\/\d+\.xml)<\/loc>/g)].map(
    (m) => m[1]
  );
}

// ─────────────────────────────────────── Index extraction (India only) ───────

// Capture the canonical stock URL plus the exchange code/ticker from it.
// Examples we want to match:
//   /stocks/in/food-beverage-tobacco/bse-523672/flex-foods-shares
//   /stocks/in/banks/nse-hdfcbank/hdfc-bank-shares
//
// We deliberately discard the trailing tab segments (.../valuation, .../past)
// and HTML-attribute artefacts (.../foo"/>) so each company shows up once.
const URL_RE =
  /https:\/\/simplywall\.st\/stocks\/in\/([a-z0-9-]+)\/(nse|bse)-([a-z0-9&-]+)\/([a-z0-9-]+?-shares)(?:[\/"]|$)/gi;

function extractIndia(text, sink) {
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text)) !== null) {
    const [, sector, exchange, idRaw, slug] = m;
    const exchangeUpper = exchange.toUpperCase();
    const id = idRaw.toUpperCase();
    const url = `https://simplywall.st/stocks/in/${sector}/${exchange}-${idRaw}/${slug}`;
    const key = `${exchangeUpper}:${id}`;
    if (sink.has(key)) continue;
    sink.set(key, { url, sector, slug, exchange: exchangeUpper, id });
  }
}

async function buildSwsIndiaIndex({ refresh }) {
  console.log(`[probe] sitemap index: ${SITEMAP_INDEX_URL}`);
  const shardUrls = await listShardUrls({ refresh });
  console.log(`[probe] ${shardUrls.length} Asia sitemap shards`);

  const sink = new Map(); // exchange:id -> meta
  let i = 0;
  for (const shardUrl of shardUrls) {
    i++;
    const cp = cachePathFor(shardUrl);
    const cached = !refresh && isFresh(cp);
    process.stdout.write(
      `[probe] shard ${i}/${shardUrls.length}: ${cached ? "cached" : "fetching"} … `
    );
    const text = await fetchCached(shardUrl, { refresh });
    const before = sink.size;
    extractIndia(text, sink);
    console.log(`+${sink.size - before} (running total: ${sink.size})`);
  }
  return sink;
}

// ─────────────────────────────────────────────── Probe candidates ────────────

function loadGapFile(p) {
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  // Expect either { actionableMissing: [...] } / { missing: [...] } /
  // or a flat array of candidates.
  if (Array.isArray(data)) return data;
  return data.actionableMissing || data.missing || [];
}

function probe(candidate, swsIndex) {
  const tries = [];
  const nse = (candidate.nseSymbol || "").toUpperCase();
  const bse = candidate.bseCode ? String(candidate.bseCode) : "";
  if (nse) tries.push({ form: "nse_symbol", key: `NSE:${nse}` });
  if (bse) tries.push({ form: "bse_code", key: `BSE:${bse}` });
  for (const t of tries) {
    const hit = swsIndex.get(t.key);
    if (hit) {
      return {
        swsAvailable: true,
        swsUrl: hit.url,
        sector: hit.sector,
        slug: hit.slug,
        swsTickerForm: t.form === "nse_symbol" ? nse : `BSE_${bse}`,
        swsExchange: hit.exchange,
      };
    }
  }
  return { swsAvailable: false };
}

// ──────────────────────────────────────────────────────────── Main ───────────

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const gapFileIdx = args.indexOf("--gap-file");
  const gapFile = gapFileIdx >= 0 ? args[gapFileIdx + 1] : GAP_FILE_DEFAULT;

  if (!fs.existsSync(gapFile)) {
    console.error(`Gap file not found: ${gapFile}`);
    console.error(`Run scripts/coverage-gap-analysis.mjs first.`);
    process.exit(2);
  }

  const swsIndex = await buildSwsIndiaIndex({ refresh });
  console.log(`\n[probe] SWS India index size: ${swsIndex.size} unique stocks`);

  const candidates = loadGapFile(gapFile);
  console.log(`[probe] Probing ${candidates.length} candidates from ${path.basename(gapFile)}`);

  const probeResults = [];
  let available = 0;
  let unavailable = 0;
  for (const c of candidates) {
    const result = probe(c, swsIndex);
    if (result.swsAvailable) available++;
    else unavailable++;
    probeResults.push({
      isin: c.isin,
      nseSymbol: c.nseSymbol,
      bseSymbol: c.bseSymbol,
      bseCode: c.bseCode,
      bseGroup: c.bseGroup,
      name: c.name,
      mktCapCr: c.mktCapCr,
      ...result,
    });
  }

  // Build flat lookups for downstream consumers (the Step-4 delta builder).
  const byNseTicker = {};
  const byBseCode = {};
  for (const [key, meta] of swsIndex.entries()) {
    if (key.startsWith("NSE:")) byNseTicker[key.slice(4)] = meta;
    else if (key.startsWith("BSE:")) byBseCode[key.slice(4)] = meta;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    sitemapIndexUrl: SITEMAP_INDEX_URL,
    indexedCount: swsIndex.size,
    candidatesProbed: candidates.length,
    available,
    unavailable,
    byNseTicker,
    byBseCode,
    probeResults,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  console.log(`\n[probe] available:   ${available}`);
  console.log(`[probe] unavailable: ${unavailable}`);
  console.log(`[probe] wrote: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
