// Build / refresh the SWS universe from the public sitemap.
//
// Why: the legacy seed builder + manual list-page scraping miss the BSE-only
// long tail. The sitemap is the canonical SWS coverage list — fetch it once,
// dedup India URLs, and we have every stock SWS has a page for.
//
// SWS publishes sitemaps under https://simplywall.st/sitemap/companies/as-asia/{N}.xml
// (12 paginated shards covering all of Asia). This is public — no login, no
// risk to the subscription, allowed by robots.txt. Total transfer ~580 MB.
//
// CLI:
//   node scripts/sws-universe-from-sitemap.mjs --dry-run      # show diff
//   node scripts/sws-universe-from-sitemap.mjs                # write side
//                                                              # file only
//   node scripts/sws-universe-from-sitemap.mjs --merge        # commit into
//                                                              # universe.json
//   node scripts/sws-universe-from-sitemap.mjs --reset-progress  # rewrite
//                                                              # progress-N
//
// Notes:
// - Curated entries (NIFTY50/NEXT50/NIFTY500 index memberships) are preserved
//   on merge; sitemap entries are appended only if they don't already exist.
// - Sharding contract (modular i % 3) means adding entries shifts ownership
//   for everything past the insertion point. After --merge, also pass
//   --reset-progress to rewind progress-{1,2,3}.json so previously-scraped
//   tickers aren't re-scraped (we re-derive done state from data/sws/deep/).

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { PATHS } from "./sws-config.mjs";

const SITEMAP_INDEX = "https://simplywall.st/sitemap/companies/as-asia.xml";
const TOTAL_SHARDS = 12; // currently as-asia/0.xml ... 11.xml
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// India base URL pattern — stops before any sub-tab suffix.
// Sector slug, exchange (nse|bse), exchange id (alphanumeric + hyphens — e.g.
// nse-bajaj-auto, nse-m-m, nse-tmcv, bse-500325), company slug.
const INDIA_BASE_RE = /https:\/\/simplywall\.st\/stocks\/in\/([a-z0-9-]+)\/(nse|bse)-([a-z0-9][a-z0-9-]*)\/([a-z0-9-]+)-shares(?![a-z\/-])/g;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": USER_AGENT, "Accept": "application/xml,text/xml,*/*" } }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Canonical join key: "EXCHANGE:short_id" (case-insensitive on the id).
// This is the SWS-internal identity. Stable across SWS resectorisation —
// only the URL's sector slug changes when SWS recategorises a stock.
function joinKey(exchange, shortId) {
  return `${exchange.toUpperCase()}:${String(shortId).toLowerCase()}`;
}

function parseShard(xml) {
  const out = new Map();
  let m;
  INDIA_BASE_RE.lastIndex = 0;
  while ((m = INDIA_BASE_RE.exec(xml)) !== null) {
    const [full, sector, exchangeRaw, exchId, slug] = m;
    const exchange = exchangeRaw.toUpperCase();
    const key = joinKey(exchange, exchId);
    if (!out.has(key)) {
      out.set(key, {
        join_key: key,
        sws_short_id: exchId,
        exchange,
        sector,
        slug,
        sws_url: full,
      });
    }
  }
  return out;
}

// Derive the join key from a stored entry's sws_url. Returns null for any
// entry whose URL doesn't conform (very old curated entries, manually edited).
function joinKeyFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/(nse|bse)-([a-z0-9][a-z0-9-]*?)\//);
  return m ? joinKey(m[1], m[2]) : null;
}

async function fetchAllShards() {
  const all = new Map();
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    const url = `https://simplywall.st/sitemap/companies/as-asia/${i}.xml`;
    process.stderr.write(`[${i + 1}/${TOTAL_SHARDS}] ${url} ... `);
    let xml;
    try {
      xml = await fetchText(url);
    } catch (e) {
      process.stderr.write(`FAILED (${e.message})\n`);
      continue;
    }
    const shardEntries = parseShard(xml);
    let added = 0;
    for (const [t, entry] of shardEntries) {
      if (!all.has(t)) { all.set(t, entry); added++; }
    }
    process.stderr.write(`${shardEntries.size} India URLs (+${added} new), running total ${all.size}\n`);
    // Polite pause between shard fetches (~3 s).
    await new Promise((r) => setTimeout(r, 3000));
  }
  return all;
}

function loadExistingUniverse() {
  if (!fs.existsSync(PATHS.universe)) return [];
  return JSON.parse(fs.readFileSync(PATHS.universe, "utf-8"));
}

// Score an existing entry's "richness" — curated + indices + name-known
// indicates real curation. Used to prefer one entry over a duplicate.
function richness(e) {
  return (e.curated ? 100 : 0)
    + (Array.isArray(e.indices) ? e.indices.length * 10 : 0)
    + (e.name ? 5 : 0)
    + (e.seed_only ? 0 : 1);
}

function indexByJoinKey(arr) {
  const map = new Map();
  let unkeyable = 0;
  for (const e of arr) {
    const k = joinKeyFromUrl(e.sws_url);
    if (!k) { unkeyable++; continue; }
    const incumbent = map.get(k);
    // On collision (two existing entries with the same URL), keep the richer.
    if (!incumbent || richness(e) > richness(incumbent)) map.set(k, e);
  }
  if (unkeyable) {
    process.stderr.write(`(${unkeyable} existing entries have no parseable sws_url — will try ticker-based fallback)\n`);
  }
  return map;
}

// Fallback resolver: when an existing entry's sws_url is a placeholder (e.g.,
// /search?query=...), try to match it to the sitemap by ticker. NSE short_ids
// in SWS URLs are usually the lowercased NSE ticker (with hyphens preserved).
// Returns the matched sitemap entry or null.
function fallbackResolveByTicker(existingEntry, sitemapMap) {
  if (!existingEntry.ticker) return null;
  const exch = existingEntry.exchange || "NSE";
  const candidates = [
    joinKey(exch, existingEntry.ticker),
    joinKey(exch, existingEntry.ticker.replace(/&/g, "-")), // M&M → m-m
    joinKey(exch, existingEntry.ticker.replace(/-/g, "")),  // BAJAJ-AUTO → bajajauto
    joinKey("NSE", existingEntry.ticker),                    // exchange flip safety
  ];
  for (const k of candidates) {
    if (sitemapMap.has(k)) return { key: k, entry: sitemapMap.get(k) };
  }
  return null;
}

// Pick between two entries representing the same company (slug match).
// NSE listing is preferred for URL/exchange (liquidity, primary listing in
// India). But the loser's curation metadata (indices, name, ticker) is
// carried over to the winner — prevents losing NIFTY50 membership when the
// curated entry happened to be tagged BSE.
function preferEntry(a, b) {
  // Step 1: pick by exchange (NSE > BSE).
  let winner, loser;
  if (a.exchange !== b.exchange) {
    winner = a.exchange === "NSE" ? a : b;
    loser = winner === a ? b : a;
  } else {
    // Same exchange — fall back to curation richness.
    const aRich = (a.curated ? 100 : 0) + ((a.indices || []).length * 10) + (a.name ? 5 : 0);
    const bRich = (b.curated ? 100 : 0) + ((b.indices || []).length * 10) + (b.name ? 5 : 0);
    winner = aRich >= bRich ? a : b;
    loser = winner === a ? b : a;
  }
  // Step 2: carry over loser's curation metadata if winner is missing it.
  const merged = { ...winner };
  if (!merged.curated && loser.curated) merged.curated = true;
  if ((!merged.indices || merged.indices.length === 0) && (loser.indices || []).length > 0) {
    merged.indices = loser.indices;
  }
  if (!merged.name && loser.name) merged.name = loser.name;
  // Preserve the user-facing ticker from the curated/named loser when winner
  // came from sitemap with a placeholder ticker.
  if (loser.curated && loser.ticker && winner.ticker !== loser.ticker
      && winner.source === "sitemap") {
    merged.ticker = loser.ticker;
  }
  return merged;
}

function priorityScore(entry) {
  const idx = entry.indices || [];
  if (idx.includes("NIFTY50")) return 1;
  if (idx.includes("NIFTY_NEXT_50")) return 2;
  if (idx.includes("NIFTY500")) return 3;
  if (idx.includes("MIDCAP")) return 4;
  if (idx.includes("MICROCAP 250")) return 5;
  if (idx.includes("NSE-EQ")) return 6;
  if (entry.exchange === "NSE") return 7;
  return 8; // BSE-only
}

function mergeAndSort(existing, sitemapMap) {
  const out = [];
  const existingByKey = indexByJoinKey(existing);
  // Build a second index keyed by ticker for fallback lookups (when an
  // existing entry had a placeholder /search URL but its ticker matches a
  // sitemap entry's short_id).
  const claimedExistingTickers = new Set();
  const usedExistingKeys = new Set();

  // Attempt ticker-fallback resolution for any existing entry whose URL-based
  // key doesn't actually exist in the sitemap. Catches:
  //   (a) placeholder /search URLs (LTIM, ZOMATO etc.)
  //   (b) cross-exchange listings (TITAN existing has bse-500114 but sitemap
  //       lists it as nse-titan)
  //   (c) SWS short-id renames (TATAMOTORS existing nse-tmcv, sitemap may have
  //       nse-tatamotors after their internal renumber)
  let recoveredByTicker = 0;
  for (const e of existing) {
    const urlKey = joinKeyFromUrl(e.sws_url);
    if (urlKey && sitemapMap.has(urlKey)) continue; // URL match already works
    const fb = fallbackResolveByTicker(e, sitemapMap);
    if (fb && !existingByKey.has(fb.key)) {
      existingByKey.set(fb.key, e);
      recoveredByTicker++;
    }
  }
  if (recoveredByTicker) {
    process.stderr.write(`(${recoveredByTicker} existing entries recovered via ticker fallback)\n`);
  }

  // Pass 1: walk the sitemap (canonical). For each entry:
  //   - if a matching existing entry exists by EXCHANGE:short_id → MERGE
  //     (preserve ticker / name / indices / curated; refresh URL+sector+slug
  //     from sitemap which is authoritative).
  //   - else → ADD as a new sitemap entry.
  let kept = 0, refreshed = 0, added = 0;
  for (const [key, fresh] of sitemapMap) {
    const e = existingByKey.get(key);
    if (e) {
      usedExistingKeys.add(key);
      claimedExistingTickers.add(e.ticker);
      const next = {
        ...e,
        sws_short_id: fresh.sws_short_id,
        exchange: fresh.exchange,
        sector: fresh.sector || e.sector,
        sws_url: fresh.sws_url,
        slug: fresh.slug || e.slug,
        seed_only: e.seed_only ?? false,
      };
      if (next.sws_url !== e.sws_url || next.sector !== e.sector) refreshed++;
      out.push(next);
      kept++;
    } else {
      // Sitemap-only: new ticker. Use sws_short_id upper-cased as a
      // placeholder ticker; backfill from a stock-page scrape later if needed.
      const ticker = fresh.exchange === "NSE"
        ? fresh.sws_short_id.toUpperCase()
        : `BSE_${fresh.sws_short_id}`;
      out.push({
        ticker,
        sws_short_id: fresh.sws_short_id,
        exchange: fresh.exchange,
        sector: fresh.sector,
        slug: fresh.slug,
        sws_url: fresh.sws_url,
        indices: [],
        seed_only: false,
        curated: false,
        market_cap_inr: null,
        industry: null,
        name: null,
        source: "sitemap",
      });
      added++;
    }
  }

  // ---------- Pass 3: dedup dual-listings by slug (= SWS company identifier).
  // Many companies are dual-listed on NSE + BSE; the sitemap returns BOTH
  // URLs. Snowflake/fair-value/rewards/risks data is identical across the
  // two listings (it's company-level, not exchange-level). So one entry per
  // company is correct.
  // Preference order: curated > non-curated; NSE > BSE; richer > sparser.
  const beforeDedup = out.length;
  const bySlug = new Map();
  for (const e of out) {
    const slug = e.slug || `_no-slug-${e.sws_short_id}`;
    const incumbent = bySlug.get(slug);
    if (!incumbent) { bySlug.set(slug, e); continue; }
    // Compare incumbent vs e: pick the better one.
    bySlug.set(slug, preferEntry(incumbent, e));
  }
  const dedup = [...bySlug.values()];
  const collapsedDuplicates = beforeDedup - dedup.length;

  // Re-sort + re-index after dedup.
  dedup.sort((a, b) => {
    const pa = priorityScore(a), pb = priorityScore(b);
    if (pa !== pb) return pa - pb;
    return (a.ticker || "").localeCompare(b.ticker || "");
  });
  for (let i = 0; i < dedup.length; i++) dedup[i].index = i;
  out.length = 0;
  for (const e of dedup) out.push(e);

  // Categorise dropped entries: "duplicate" if another existing entry with
  // the same URL got kept; "truly_missing" otherwise (SWS doesn't cover it).
  const claimedUrls = new Set();
  for (const m of out) if (m.sws_url) claimedUrls.add(m.sws_url);
  const claimedTickers = new Set(out.map((e) => e.ticker));
  const droppedFromExisting = [];
  for (const e of existing) {
    if (claimedTickers.has(e.ticker)) continue;
    const reason = (e.sws_url && claimedUrls.has(e.sws_url))
      ? "duplicate_of_kept"
      : (e.sws_url && e.sws_url.includes("/search?")) ? "placeholder_search_url"
      : "truly_missing_from_sitemap";
    droppedFromExisting.push({ ...e, _drop_reason: reason });
  }

  // Sort by priority, then ticker. Reassign index 0..n.
  out.sort((a, b) => {
    const pa = priorityScore(a), pb = priorityScore(b);
    if (pa !== pb) return pa - pb;
    return (a.ticker || "").localeCompare(b.ticker || "");
  });
  for (let i = 0; i < out.length; i++) out[i].index = i;

  return { merged: out, kept, refreshed, added, droppedFromExisting, collapsedDuplicates };
}

function diffSummary({ merged, kept, refreshed, added, droppedFromExisting, collapsedDuplicates }, existing, sitemapSize) {
  return {
    existing_count: existing.length,
    sitemap_unique_count: sitemapSize,
    merged_count: merged.length,
    kept_from_existing: kept,
    refreshed_in_place: refreshed,
    added_from_sitemap: added,
    collapsed_dual_listings: collapsedDuplicates || 0,
    dropped_from_existing: droppedFromExisting.length,
  };
}

function rewriteProgressFromDeep(merged) {
  // Map ticker → "scraped" by checking data/sws/deep/<TICKER>.json existence.
  const scraped = new Set(
    fs.existsSync(PATHS.deepDir)
      ? fs.readdirSync(PATHS.deepDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.replace(/\.json$/, ""))
      : [],
  );
  const SHARD_COUNT = 3;
  const result = { 1: 0, 2: 0, 3: 0 };
  for (const [shardId] of [[1], [2], [3]]) {
    const slice = merged.filter((e) => (e.index % SHARD_COUNT) === (shardId - 1));
    let firstUnscrapedLocal = slice.length; // default: all done
    let doneCount = 0;
    for (let i = 0; i < slice.length; i++) {
      if (scraped.has(slice[i].ticker)) {
        doneCount++;
      } else if (firstUnscrapedLocal === slice.length) {
        firstUnscrapedLocal = i;
      }
    }
    const progress = {
      shard_id: shardId,
      next_local_index: firstUnscrapedLocal,
      done_count: doneCount,
      last_global_index: null,
      last_ticker: null,
      last_run_at: null,
      started_at: new Date().toISOString(),
      complete: firstUnscrapedLocal >= slice.length,
      today_count: 0,
      today_date: new Date().toISOString().slice(0, 10),
      recent_completion_times: [],
      long_pause_due_after_count: 25,
      _slice_size: slice.length,
      _rebuilt_at: new Date().toISOString(),
      _rebuilt_reason: "universe_expanded_from_sitemap",
    };
    const fp = PATHS.progress(shardId);
    fs.writeFileSync(fp, JSON.stringify(progress, null, 2));
    result[shardId] = { slice_size: slice.length, done: doneCount, next: firstUnscrapedLocal };
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const merge = args.includes("--merge");
  const resetProgress = args.includes("--reset-progress");

  // 1. Pull sitemap.
  console.error("Fetching sitemap shards (no login required, ~3 min)...");
  const sitemapMap = await fetchAllShards();
  console.error(`\nTotal unique India SWS URLs: ${sitemapMap.size}`);

  // 2. Diff against existing.
  const existing = loadExistingUniverse();
  const result = mergeAndSort(existing, sitemapMap);
  const summary = diffSummary(result, existing, sitemapMap.size);
  console.error("\n--- Diff summary ---");
  console.error(JSON.stringify(summary, null, 2));

  if (result.droppedFromExisting.length > 0) {
    const byReason = {};
    for (const e of result.droppedFromExisting) {
      byReason[e._drop_reason] = (byReason[e._drop_reason] || 0) + 1;
    }
    console.error(`\n⚠ ${result.droppedFromExisting.length} existing entries dropped, by reason:`);
    for (const [r, n] of Object.entries(byReason)) console.error(`     ${r}: ${n}`);
    console.error("   First 10 truly_missing (worth investigating):");
    for (const e of result.droppedFromExisting.filter(e => e._drop_reason === "truly_missing_from_sitemap").slice(0, 10)) {
      console.error(`     - ${e.ticker} (${e.exchange}) → ${e.sws_url || "no URL"}`);
    }
    const droppedPath = path.join(PATHS.dataDir, "universe-sitemap-dropped.json");
    fs.writeFileSync(droppedPath, JSON.stringify(result.droppedFromExisting, null, 2));
    console.error(`   Full dropped list: ${droppedPath}`);
  }

  if (result.added > 0) {
    console.error(`\n✓ ${result.added} new tickers from sitemap (sample):`);
    const newOnes = result.merged.filter((e) => e.source === "sitemap").slice(0, 10);
    for (const e of newOnes) console.error(`     + ${e.ticker} (${e.exchange}, ${e.sector})`);
  }

  // 3. Always write the side file for inspection.
  const sidePath = path.join(PATHS.dataDir, "universe-from-sitemap.json");
  fs.mkdirSync(PATHS.dataDir, { recursive: true });
  fs.writeFileSync(sidePath, JSON.stringify(result.merged, null, 2));
  console.error(`\nSide file written: ${sidePath}`);

  if (dryRun) {
    console.error("Dry run — universe.json untouched.");
    return;
  }

  if (!merge) {
    console.error("No --merge flag — universe.json untouched. Side file is at " + sidePath);
    console.error("Re-run with --merge to commit, plus --reset-progress to rewind shard pointers.");
    return;
  }

  // 4. Atomic write to universe.json.
  const tmp = PATHS.universe + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(result.merged, null, 2));
  fs.renameSync(tmp, PATHS.universe);
  console.error(`✓ ${PATHS.universe} updated → ${result.merged.length} entries.`);

  if (resetProgress) {
    console.error("\nRebuilding progress-{1,2,3}.json from data/sws/deep/ ...");
    const r = rewriteProgressFromDeep(result.merged);
    console.error(JSON.stringify(r, null, 2));
  } else {
    console.error("\n⚠ universe.json grew — existing progress-{1,2,3}.json point to OLD shard slices.");
    console.error("   Re-run with --reset-progress to rebuild progress files from data/sws/deep/.");
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
