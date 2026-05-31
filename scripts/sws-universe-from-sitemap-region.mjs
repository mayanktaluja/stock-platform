// Build a region's SWS universe from the public sitemap — the generalization of
// sws-universe-from-sitemap-us.mjs, driven by the region registry.
//
// Why: SWS publishes a canonical company sitemap per region. Korea + Taiwan both
// live in the `as-asia` region (12 shards) alongside India. Public, no login, no
// risk to the subscription. We dedup to one entry per company slug and keep only
// the liquid exchanges (KOSPI/KOSDAQ for KR, TWSE/TPEx for TW) by default; KONEX
// (the illiquid KR startup board) is excluded unless --include-konex is passed.
//
// THE CANONICAL TICKER KEY is assigned HERE and only here (region.tickerKey):
// KR ids are 'a'-prefixed (kose-a005930 → 005930.KS), TW ids bare numeric
// (twse-2330 → 2330.TW). The dotted suffix makes the key globally unique and —
// critically — never pure-numeric, so the India BSE filters stay inert and the
// key survives intact through scrape → parse → score → route → UI. Every entry
// is asserted to carry a non-empty, non-pure-numeric ticker before write.
//
// CLI:
//   node scripts/sws-universe-from-sitemap-region.mjs --region kr --dry-run
//   node scripts/sws-universe-from-sitemap-region.mjs --region kr --write
//   node scripts/sws-universe-from-sitemap-region.mjs --region kr --include-konex --write
//   node scripts/sws-universe-from-sitemap-region.mjs --region tw --max-shards 1 --dry-run

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { makeRegionConfig } from "./sws-config-region.mjs";
import { getRegion, sitemapRegex } from "./sws-regions.mjs";

function fetchText(url, userAgent) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": userAgent, Accept: "application/xml,text/xml,*/*" } }, (res) => {
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

// Canonical identity for dedup: "EXCHANGE:short_id" (case-insensitive on the id).
function joinKey(exchange, shortId) {
  return `${exchange.toUpperCase()}:${String(shortId).toLowerCase()}`;
}

function parseShard(xml, region) {
  const re = sitemapRegex(region);
  re.lastIndex = 0;
  const out = new Map();
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [full, sector, exchangeRaw, id, slug] = m;
    const exchange = exchangeRaw.toLowerCase();
    const key = joinKey(exchange, id);
    if (!out.has(key)) {
      out.set(key, {
        join_key: key,
        ticker: region.tickerKey(exchange, id),
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

async function fetchAllShards(cfg, region, maxShards, userAgent) {
  const n = maxShards ?? cfg.UNIVERSE.sitemapShardCount;
  const all = new Map();
  const byExchange = {};
  for (let i = 0; i < n; i++) {
    const url = cfg.UNIVERSE.sitemapShardUrl(i);
    process.stderr.write(`[${i + 1}/${n}] ${url} ... `);
    let xml;
    try {
      xml = await fetchText(url, userAgent);
    } catch (e) {
      process.stderr.write(`FAILED (${e.message})\n`);
      continue;
    }
    const entries = parseShard(xml, region);
    let added = 0;
    for (const [k, e] of entries) {
      if (!all.has(k)) {
        all.set(k, e);
        added++;
        byExchange[e.exchange] = (byExchange[e.exchange] || 0) + 1;
      }
    }
    process.stderr.write(`${entries.size} ${region.code} URLs (+${added} new), total ${all.size}\n`);
    await new Promise((r) => setTimeout(r, 3000)); // polite pause between shards
  }
  return { all, byExchange };
}

// Dedup by slug (= SWS company id; Snowflake/FV are company-level), preferring the
// higher-liquidity exchange. Filter to the allowed exchange set (excluded tokens
// like KONEX/OTC are dropped here unless promoted via a flag).
function buildUniverse(all, region, promoted) {
  const allowed = new Set(region.exchangeTokens.concat(promoted));
  const priority = region.exchangePriority || {};
  const bySlug = new Map();
  const excludedCounts = {};
  for (const e of all.values()) {
    if (!allowed.has(e.exchange)) {
      excludedCounts[e.exchange] = (excludedCounts[e.exchange] || 0) + 1;
      continue;
    }
    const incumbent = bySlug.get(e.slug);
    if (!incumbent || (priority[e.exchange] || 9) < (priority[incumbent.exchange] || 9)) {
      bySlug.set(e.slug, e);
    }
  }
  const out = [...bySlug.values()];
  out.sort((a, b) => {
    const pa = priority[a.exchange] || 9;
    const pb = priority[b.exchange] || 9;
    if (pa !== pb) return pa - pb;
    return a.ticker.localeCompare(b.ticker);
  });
  const universe = out.map((e, i) => ({
    index: i,
    ticker: e.ticker,
    sws_short_id: e.sws_short_id,
    exchange: e.exchange,
    sector: e.sector,
    slug: e.slug,
    sws_url: e.sws_url,
    indices: [],
    curated: false,
    market_cap_native: null,
    industry: null,
    name: null,
    source: "sitemap",
  }));
  return { universe, excludedCounts };
}

// §6 invariant: every entry MUST carry a non-empty, non-pure-numeric dotted key.
// An empty/numeric ticker would make parseStock fall back to the payload symbol
// (pure-numeric for TW) and a downstream BSE filter could silently drop it.
function assertCanonicalTickers(universe, region) {
  const bad = [];
  const seen = new Set();
  for (const e of universe) {
    if (!e.ticker || !/\S/.test(e.ticker)) bad.push(`empty ticker for ${e.join_key || e.sws_url}`);
    else if (/^\d+$/.test(e.ticker)) bad.push(`pure-numeric ticker '${e.ticker}' (${e.sws_url})`);
    else if (seen.has(e.ticker)) bad.push(`duplicate ticker '${e.ticker}'`);
    seen.add(e.ticker);
  }
  if (bad.length) {
    throw new Error(`[${region.code}] canonical-ticker invariant violated (${bad.length}):\n  ` + bad.slice(0, 10).join("\n  "));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const rIdx = args.indexOf("--region");
  const code = rIdx >= 0 ? args[rIdx + 1] : null;
  if (!code) {
    console.error("Usage: --region <kr|tw> [--dry-run|--write] [--include-konex] [--max-shards N]");
    process.exit(2);
  }
  const region = getRegion(code);
  const cfg = makeRegionConfig(code);
  const userAgent = cfg.SHARED_FINGERPRINT.userAgent;

  const dryRun = args.includes("--dry-run");
  const write = args.includes("--write");
  const msIdx = args.indexOf("--max-shards");
  const maxShards = msIdx >= 0 ? parseInt(args[msIdx + 1], 10) : undefined;

  // Promote excluded exchanges via flags (--include-konex → xkon, --include-otc → otc).
  const promoted = [];
  if (args.includes("--include-konex") && region.excludedExchangeTokens?.includes("xkon")) promoted.push("xkon");
  if (args.includes("--include-otc") && region.excludedExchangeTokens?.includes("otc")) promoted.push("otc");

  console.error(
    `Fetching ${region.sitemapRegion} sitemap for region '${code}' (${maxShards ?? cfg.UNIVERSE.sitemapShardCount} shards, public, no login)...`,
  );
  const { all, byExchange } = await fetchAllShards(cfg, region, maxShards, userAgent);
  console.error(`\nRaw unique ${code} companies (all matched exchanges): ${all.size}`);
  console.error(`By exchange (raw): ${JSON.stringify(byExchange)}`);

  const { universe, excludedCounts } = buildUniverse(all, region, promoted);
  assertCanonicalTickers(universe, region);

  const exCounts = {};
  for (const e of universe) exCounts[e.exchange] = (exCounts[e.exchange] || 0) + 1;
  console.error(`\nFiltered universe: ${universe.length}`);
  console.error(`By exchange: ${JSON.stringify(exCounts)}`);
  if (Object.keys(excludedCounts).length) console.error(`Excluded (not allowed): ${JSON.stringify(excludedCounts)}`);
  console.error("Sample:");
  for (const e of universe.slice(0, 8)) {
    console.error(`  ${e.ticker} (${e.exchange}, ${e.sector}) → ${e.sws_url}`);
  }

  fs.mkdirSync(cfg.PATHS.dataDir, { recursive: true });
  const sidePath = path.join(cfg.PATHS.dataDir, "universe-from-sitemap.json");
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

  const tmp = cfg.PATHS.universe + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(universe, null, 2));
  fs.renameSync(tmp, cfg.PATHS.universe);
  const meta = {
    generatedAt: new Date().toISOString(),
    source: "sws-public-sitemap",
    region: code,
    promotedExchanges: promoted,
    count: universe.length,
    exchanges: exCounts,
    excluded: excludedCounts,
  };
  const metaTmp = cfg.PATHS.universeMeta + ".tmp." + process.pid;
  fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2));
  fs.renameSync(metaTmp, cfg.PATHS.universeMeta);
  console.error(`✓ ${cfg.PATHS.universe} → ${universe.length} entries.`);
  console.error(`✓ ${cfg.PATHS.universeMeta} stamped.`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
