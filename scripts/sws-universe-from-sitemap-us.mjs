// Build the US SWS universe from the public North-America sitemap.
//
// Why: SWS publishes a canonical company sitemap per region. For US listings the
// region is `na-north-america` — an index plus 7 paginated shards (0..6) that
// together enumerate every US company SWS has a page for. Public, no login, no
// risk to the subscription. We dedup to one entry per company and keep only the
// liquid, analyst-covered exchanges (NASDAQ/NYSE/NYSEMKT) by default; OTC pink
// shells (no Snowflake/FV) are excluded unless --include-otc is passed.
//
// US stock URLs differ from India: there is NO `-shares` suffix —
//   https://simplywall.st/stocks/us/<sector>/<exchange>-<id>/<slug>
//
// CLI:
//   node scripts/sws-universe-from-sitemap-us.mjs --dry-run                 # preview, side file only
//   node scripts/sws-universe-from-sitemap-us.mjs --write                   # commit data/sws-us/universe.json
//   node scripts/sws-universe-from-sitemap-us.mjs --include-otc --write      # add the OTC long tail
//   node scripts/sws-universe-from-sitemap-us.mjs --max-shards 1 --dry-run   # quick regex check on shard 0

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { PATHS, UNIVERSE, SHARED_FINGERPRINT } from "./sws-config-us.mjs";

const USER_AGENT = SHARED_FINGERPRINT.userAgent;

// US base-URL pattern, matched against raw sitemap XML. The `(?=<\/loc>)`
// lookahead anchors on the closing <loc> tag so sub-tab variants (…/valuation)
// don't match; locale alternates (…/es/stocks/…) are excluded because they
// carry a locale segment before /stocks/. The <id> may contain dots (share
// class / foreign suffix, e.g. brk.b).
const US_BASE_RE =
  /https:\/\/simplywall\.st\/stocks\/us\/([a-z0-9-]+)\/(nasdaq|nyse|nysemkt|otc)-([a-z0-9][a-z0-9.\-]*)\/([a-z0-9-]+)(?=<\/loc>)/g;

const EXCHANGE_PRIORITY = { nasdaq: 1, nyse: 2, nysemkt: 3, otc: 4 };

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml,*/*" } }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`${url}: HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// Canonical identity: "EXCHANGE:short_id" (case-insensitive on the id). Stable
// across SWS resectorisation (only the URL's sector slug changes).
function joinKey(exchange, shortId) {
  return `${exchange.toUpperCase()}:${String(shortId).toLowerCase()}`;
}

function parseShard(xml) {
  const out = new Map();
  let m;
  US_BASE_RE.lastIndex = 0;
  while ((m = US_BASE_RE.exec(xml)) !== null) {
    const [full, sector, exchangeRaw, id, slug] = m;
    const exchange = exchangeRaw.toLowerCase();
    const key = joinKey(exchange, id);
    if (!out.has(key)) {
      out.set(key, {
        join_key: key,
        ticker: id.toUpperCase(),
        sws_short_id: id,
        exchange,
        sector,
        slug,
        sws_url: full,
      });
    }
  }
  return out;
}

async function fetchAllShards(maxShards) {
  const n = maxShards ?? UNIVERSE.sitemapShardCount;
  const all = new Map();
  const byExchange = {};
  for (let i = 0; i < n; i++) {
    const url = UNIVERSE.sitemapShardUrl(i);
    process.stderr.write(`[${i + 1}/${n}] ${url} ... `);
    let xml;
    try {
      xml = await fetchText(url);
    } catch (e) {
      process.stderr.write(`FAILED (${e.message})\n`);
      continue;
    }
    const entries = parseShard(xml);
    let added = 0;
    for (const [k, e] of entries) {
      if (!all.has(k)) {
        all.set(k, e);
        added++;
        byExchange[e.exchange] = (byExchange[e.exchange] || 0) + 1;
      }
    }
    process.stderr.write(`${entries.size} US URLs (+${added} new), running total ${all.size}\n`);
    await new Promise((r) => setTimeout(r, 3000)); // polite pause between shards
  }
  return { all, byExchange };
}

// Dedup dual-listings by slug (= SWS company id; Snowflake/FV are company-level,
// identical across listings), preferring the higher-liquidity exchange.
function buildUniverse(all, includeOtc) {
  const allowed = new Set(UNIVERSE.exchanges.concat(includeOtc ? [UNIVERSE.otcExchange] : []));
  const bySlug = new Map();
  for (const e of all.values()) {
    if (!allowed.has(e.exchange)) continue;
    const incumbent = bySlug.get(e.slug);
    if (!incumbent || EXCHANGE_PRIORITY[e.exchange] < EXCHANGE_PRIORITY[incumbent.exchange]) {
      bySlug.set(e.slug, e);
    }
  }
  const out = [...bySlug.values()];
  return reindex(
    out.map((e) => ({
      ticker: e.ticker,
      sws_short_id: e.sws_short_id,
      exchange: e.exchange,
      sector: e.sector,
      slug: e.slug,
      sws_url: e.sws_url,
      indices: [],
      curated: false,
      market_cap_usd: null,
      industry: null,
      name: null,
      source: "sitemap",
    })),
  );
}

// Stable ordering + contiguous 0..n-1 `index`. The scrape shards slice this
// array by index (shardSliceContiguous), so the order must be reproducible
// across machines — hence codepoint comparison, never localeCompare.
function reindex(entries) {
  const sorted = [...entries].sort((a, b) => {
    const pa = EXCHANGE_PRIORITY[a.exchange] || 9;
    const pb = EXCHANGE_PRIORITY[b.exchange] || 9;
    if (pa !== pb) return pa - pb;
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  });
  return sorted.map((e, i) => ({ ...e, index: i }));
}

// Identity for merging. Slug is the SWS company id and is what buildUniverse
// dedups on; exchange+ticker is the fallback for older rows written before the
// slug was persisted.
function universeKey(e) {
  return e.slug ? `slug:${e.slug}` : `xt:${e.exchange}:${e.ticker}`;
}

// The sitemap is authoritative for METADATA, not for MEMBERSHIP. A short or
// partially-failed shard fetch must never delete tickers we already track —
// that is exactly how the 2026-08-05 truncation dropped 2056 names (5452 →
// 3619, incl. AMZN/XOM/ABNB) and served stale blue chips for six days.
// Two passes: retain every existing row, overlay fresh sitemap metadata on top.
function mergeWithExisting(fresh, existing) {
  const merged = new Map();
  for (const e of existing) merged.set(universeKey(e), e);
  let updated = 0;
  let added = 0;
  for (const e of fresh) {
    const key = universeKey(e);
    const prior = merged.get(key);
    if (prior) {
      updated++;
      // Fresh metadata wins; keep locally-enriched fields the sitemap nulls out.
      merged.set(key, {
        ...prior,
        ticker: e.ticker,
        sws_short_id: e.sws_short_id,
        exchange: e.exchange,
        sector: e.sector,
        slug: e.slug,
        sws_url: e.sws_url,
        source: "sitemap",
      });
    } else {
      added++;
      merged.set(key, e);
    }
  }
  const retained = merged.size - added - updated;
  return { entries: reindex([...merged.values()]), added, updated, retained };
}

function readExistingUniverse() {
  try {
    if (!fs.existsSync(PATHS.universe)) return [];
    const parsed = JSON.parse(fs.readFileSync(PATHS.universe, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`Could not read existing universe (${err.message}) — treating as empty.`);
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  const includeOtc = args.includes("--include-otc");
  const msIdx = args.indexOf("--max-shards");
  const maxShards = msIdx >= 0 ? parseInt(args[msIdx + 1], 10) : undefined;

  console.error(
    `Fetching na-north-america sitemap (${maxShards ?? UNIVERSE.sitemapShardCount} shards, public, no login)...`,
  );
  const { all, byExchange } = await fetchAllShards(maxShards);
  console.error(`\nRaw unique US companies (all exchanges): ${all.size}`);
  console.error(`By exchange (raw): ${JSON.stringify(byExchange)}`);

  const universe = buildUniverse(all, includeOtc);
  const exCounts = {};
  for (const e of universe) exCounts[e.exchange] = (exCounts[e.exchange] || 0) + 1;
  console.error(`\nFiltered universe (${includeOtc ? "incl OTC" : "liquid only"}): ${universe.length}`);
  console.error(`By exchange: ${JSON.stringify(exCounts)}`);
  console.error("Sample:");
  for (const e of universe.slice(0, 8)) {
    console.error(`  ${e.ticker} (${e.exchange}, ${e.sector}) → ${e.sws_url}`);
  }

  fs.mkdirSync(PATHS.dataDir, { recursive: true });
  const sidePath = path.join(PATHS.dataDir, "universe-from-sitemap.json");
  fs.writeFileSync(sidePath, JSON.stringify(universe, null, 2));
  console.error(`\nSide file: ${sidePath}`);

  if (dryRun) {
    console.error("Dry run — universe.json untouched.");
    return;
  }
  if (!write) {
    console.error("No --write flag — universe.json untouched. Re-run with --write to commit.");
    return;
  }

  const existing = readExistingUniverse();

  // Shrink guard — gated on what THIS run actually fetched, never on the merged
  // set (a merged-set gate is self-satisfying: the merge alone guarantees the
  // count never falls, so it would pass straight through a total fetch
  // blackout). A sitemap that comes back materially shorter than what we
  // already track means shards failed, not that 30% of US equities delisted.
  //
  // This deliberately does NOT reuse India's assessMembershipLoss() from
  // sws-universe-from-sitemap.mjs: that guard scores rows the merge would DROP,
  // and this merge is strictly monotonic, so it would read 0 drops / 0 shrink on
  // every run including a total blackout — a vacuous check. Same intent (block a
  // bad crawl), measured on the only axis that still moves here.
  const minRatio = Number(process.env.US_UNIVERSE_MIN_FETCH_RATIO || 0.9);
  if (existing.length > 0 && universe.length < existing.length * minRatio) {
    const pct = ((universe.length / existing.length) * 100).toFixed(1);
    console.error(
      `REFUSING to write: sitemap fetch returned ${universe.length} vs ${existing.length} tracked (${pct}%, floor ${(minRatio * 100).toFixed(0)}%).`,
    );
    console.error(
      "This is a short/failed fetch, not a delisting wave. universe.json + universe-meta.json left untouched;",
    );
    console.error(
      "the side file universe-from-sitemap.json holds what was fetched. Re-run once the sitemap is healthy.",
    );
    process.exit(1);
  }

  const { entries: mergedUniverse, added, updated, retained } = mergeWithExisting(universe, existing);
  const mergedExCounts = {};
  for (const e of mergedUniverse) mergedExCounts[e.exchange] = (mergedExCounts[e.exchange] || 0) + 1;
  console.error(
    `\nMerge vs existing (${existing.length} tracked): +${added} new, ${updated} refreshed, ${retained} retained (absent from this fetch).`,
  );

  const tmp = PATHS.universe + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(mergedUniverse, null, 2));
  fs.renameSync(tmp, PATHS.universe);
  const meta = {
    generatedAt: new Date().toISOString(),
    source: "sws-public-sitemap",
    region: "us",
    includeOtc,
    count: mergedUniverse.length,
    exchanges: mergedExCounts,
    fetched_count: universe.length,
    merge: { added, updated, retained },
  };
  const metaTmp = PATHS.universeMeta + ".tmp." + process.pid;
  fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2));
  fs.renameSync(metaTmp, PATHS.universeMeta);
  console.error(`✓ ${PATHS.universe} → ${mergedUniverse.length} entries.`);
  console.error(`✓ ${PATHS.universeMeta} stamped.`);
}

// Exported for test/usUniverseMerge.test.mjs. The entrypoint guard keeps that
// import from firing a live sitemap fetch.
export { mergeWithExisting, reindex, universeKey };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
