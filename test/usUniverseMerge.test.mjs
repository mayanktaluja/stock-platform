// Regression cover for the 2026-08-05 US universe truncation: the sitemap
// builder replaced universe.json wholesale, so a short fetch silently deleted
// 2056 tracked tickers (5452 → 3619, incl. AMZN/XOM/ABNB) and prod served stale
// blue chips for six days. The builder now merges (membership is monotonic) and
// refuses to write on a materially short fetch.
import { mergeWithExisting, reindex, universeKey } from "../scripts/sws-universe-from-sitemap-us.mjs";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

const row = (ticker, over = {}) => ({
  index: 0,
  ticker,
  sws_short_id: ticker.toLowerCase(),
  exchange: "nasdaq",
  sector: "tech",
  slug: `${ticker.toLowerCase()}-inc`,
  sws_url: `https://simplywall.st/stocks/us/tech/nasdaq-${ticker.toLowerCase()}/${ticker.toLowerCase()}-inc`,
  indices: [],
  curated: false,
  market_cap_usd: null,
  industry: null,
  name: null,
  source: "sitemap",
  ...over,
});

// ──── universeKey ────
{
  assert("universeKey: prefers slug", universeKey(row("AAPL")) === "slug:aapl-inc");
  assert(
    "universeKey: falls back to exchange:ticker when slug missing",
    universeKey({ ticker: "AAPL", exchange: "nasdaq" }) === "xt:nasdaq:AAPL",
  );
}

// ──── reindex ────
{
  const out = reindex([row("MSFT"), row("AAPL"), row("XOM", { exchange: "nyse" })]);
  assert("reindex: nasdaq sorts before nyse", out.map((e) => e.ticker).join(",") === "AAPL,MSFT,XOM", out.map((e) => e.ticker));
  assert("reindex: index is contiguous from 0", out.every((e, i) => e.index === i), out.map((e) => e.index));

  // Codepoint, not locale — shard slices must be reproducible across machines.
  const cased = reindex([row("aapl"), row("AAPL", { slug: "apple-upper" })]);
  assert("reindex: codepoint order puts 'AAPL' before 'aapl'", cased[0].ticker === "AAPL", cased.map((e) => e.ticker));
}

// ──── mergeWithExisting — the truncation regression ────
{
  const existing = ["AAPL", "MSFT", "AMZN", "XOM", "ABNB"].map((t) => row(t));
  const shortFetch = ["AAPL", "MSFT"].map((t) => row(t)); // the 2026-08-05 shape
  const { entries, added, updated, retained } = mergeWithExisting(shortFetch, existing);

  assert("merge: no tracked ticker is dropped by a short fetch", entries.length === 5, entries.length);
  assert(
    "merge: AMZN/XOM/ABNB survive absence from the fetch",
    ["AMZN", "XOM", "ABNB"].every((t) => entries.some((e) => e.ticker === t)),
    entries.map((e) => e.ticker),
  );
  assert("merge: counts — 0 added, 2 updated, 3 retained", added === 0 && updated === 2 && retained === 3, { added, updated, retained });
  assert("merge: result is reindexed contiguously", entries.every((e, i) => e.index === i), entries.map((e) => e.index));
}

// ──── mergeWithExisting — genuine additions + metadata refresh ────
{
  const existing = [row("AAPL", { sector: "stale-sector", market_cap_usd: 123 })];
  const fresh = [row("AAPL", { sector: "tech" }), row("NVDA")];
  const { entries, added, updated, retained } = mergeWithExisting(fresh, existing);

  assert("merge: new sitemap ticker is added", entries.some((e) => e.ticker === "NVDA"), entries.map((e) => e.ticker));
  assert("merge: counts — 1 added, 1 updated, 0 retained", added === 1 && updated === 1 && retained === 0, { added, updated, retained });

  const aapl = entries.find((e) => e.ticker === "AAPL");
  assert("merge: sitemap metadata wins on a tracked row", aapl.sector === "tech", aapl.sector);
  assert("merge: locally-enriched field the sitemap nulls is preserved", aapl.market_cap_usd === 123, aapl.market_cap_usd);
}

// ──── mergeWithExisting — empty existing (first build) ────
{
  const fresh = ["AAPL", "MSFT"].map((t) => row(t));
  const { entries, added, retained } = mergeWithExisting(fresh, []);
  assert("merge: first build takes the fetch as-is", entries.length === 2 && added === 2 && retained === 0, { len: entries.length, added, retained });
}

// ──── mergeWithExisting — total blackout ────
{
  const existing = ["AAPL", "MSFT"].map((t) => row(t));
  const { entries, added, updated, retained } = mergeWithExisting([], existing);
  assert(
    "merge: a zero-row fetch retains everything (the shrink guard blocks the write upstream)",
    entries.length === 2 && added === 0 && updated === 0 && retained === 2,
    { len: entries.length, added, updated, retained },
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
