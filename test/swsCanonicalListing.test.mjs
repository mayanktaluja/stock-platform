/**
 * Tests for canonical-listing resolution of dual-listed Indian companies.
 *
 * The bug these prevent: scripts/sws-scoring.mjs globs data/sws/deep/*.json and treats
 * one file as one stock, but an NSE+BSE dual listing is one COMPANY with two briefs.
 * On 2026-07-30 that put 618 companies on disk twice and wasted 4 of the 30 Top-30
 * slots (Shanti Gold, WPIL, Yatharth, Manorama), each shown as an NSE row and a
 * BSE_<code> row with different prices and scores — and the BSE_ row's detail modal
 * 400s, because server.js:8443 rejects the underscore.
 *
 * The rule ORDER is the delicate part and most of these tests defend it. Freshness
 * must be the LAST tie-break, not an early one: on live data the BSE sibling is
 * fresher in ~509 of 511 pairs purely because the restored NSE rows sit at the tail of
 * universe.json and get scraped last. Letting recency pick the canonical ticker makes
 * identity flip whenever scrape order changes.
 *
 * Run with: node test/swsCanonicalListing.test.mjs
 */

import {
  companySlugFromSwsUrl,
  exchangeFromSwsUrl,
  companyKeyFromRow,
  compareListingPreference,
  dedupeByCompany,
} from "../services/swsCanonicalListing.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}

const IN = (exch, shortId, slug) => `https://simplywall.st/stocks/in/consumer-durables/${exch}-${shortId}/${slug}-shares`;

function row(ticker, opts = {}) {
  return {
    ticker,
    sws_url: opts.sws_url ?? IN(opts.exchange || "nse", ticker.toLowerCase(), opts.slug || "acme-corp"),
    parsed_at: opts.parsed_at ?? "2026-07-01T00:00:00.000Z",
    indices: opts.indices ?? [],
  };
}

// Pick the winner of a group the way dedupeByCompany does.
const winnerOf = (rows) => rows.slice().sort(compareListingPreference)[0].ticker;

console.log("\n[companySlugFromSwsUrl]");
assert("India URL → slug, -shares stripped",
  companySlugFromSwsUrl("https://simplywall.st/stocks/in/consumer-durables/nse-shantigold/shanti-gold-international-shares") === "shanti-gold-international");
assert("BSE sibling yields the SAME slug",
  companySlugFromSwsUrl("https://simplywall.st/stocks/in/consumer-durables/bse-544459/shanti-gold-international-shares") === "shanti-gold-international");
// Market-agnostic: US briefs have no -shares suffix. The extractor must not silently
// return null for them, or a future US caller would get 100% fallback and a dedup
// that collapses nothing while every gate reports zero duplicates.
assert("US URL (no -shares suffix) still parses",
  companySlugFromSwsUrl("https://simplywall.st/stocks/us/materials/nyse-aa/alcoa") === "alcoa");
assert("query string ignored",
  companySlugFromSwsUrl("https://simplywall.st/stocks/in/x/nse-a/acme-corp-shares?tab=news") === "acme-corp");
assert("trailing slash tolerated",
  companySlugFromSwsUrl("https://simplywall.st/stocks/in/x/nse-a/acme-corp-shares/") === "acme-corp");
for (const bad of [null, undefined, "", 42, {}]) {
  assert(`hostile input ${JSON.stringify(bad)} → null`, companySlugFromSwsUrl(bad) === null);
}

console.log("\n[exchangeFromSwsUrl]");
assert("nse → NSE", exchangeFromSwsUrl(IN("nse", "acme", "acme-corp")) === "NSE");
assert("bse → BSE", exchangeFromSwsUrl(IN("bse", "500123", "acme-corp")) === "BSE");
assert("unparseable → null", exchangeFromSwsUrl("https://example.com/nope") === null);

console.log("\n[rule 1 — exchange: NSE beats BSE]");
{
  // The reported bug, exactly.
  const g = [
    row("BSE_544459", { exchange: "bse", slug: "shanti-gold-international", parsed_at: "2026-07-29T22:28:41.983Z" }),
    row("SHANTIGOLD", { exchange: "nse", slug: "shanti-gold-international", parsed_at: "2026-06-11T01:15:59.409Z" }),
  ];
  assert("SHANTIGOLD wins despite being 7 weeks staler", winnerOf(g) === "SHANTIGOLD", winnerOf(g));
}

console.log("\n[rule 2 — ticker shape: plain > BSE_ > bare numeric]");
{
  // Real 3-member group: wpil.
  const g = [
    row("505872", { exchange: "bse", slug: "wpil" }),
    row("BSE_505872", { exchange: "bse", slug: "wpil" }),
    row("WPIL", { exchange: "nse", slug: "wpil" }),
  ];
  assert("WPIL beats both BSE forms", winnerOf(g) === "WPIL", winnerOf(g));
  // With NSE removed, shape must still order the two BSE forms.
  const bseOnly = g.filter((r) => r.ticker !== "WPIL");
  assert("BSE_505872 beats bare 505872", winnerOf(bseOnly) === "BSE_505872", winnerOf(bseOnly));
}

console.log("\n[rule 3 — derived series never outrank the parent line]");
{
  const upl = [row("UPLPP1", { slug: "upl" }), row("UPL", { slug: "upl" })];
  assert("UPL beats partly-paid UPLPP1", winnerOf(upl) === "UPL", winnerOf(upl));
  // LLOYDPP sorts BEFORE LLOYDSENT by codepoint, so only rule 3 saves this one.
  const lloyd = [row("LLOYDPP", { slug: "lloyds-enterprises" }), row("LLOYDSENT", { slug: "lloyds-enterprises" })];
  assert("LLOYDSENT beats LLOYDPP (codepoint alone would invert it)", winnerOf(lloyd) === "LLOYDSENT", winnerOf(lloyd));
  // JISLDVREQS ends "EQS", so an anchored /DVR$/ would miss it and rule 5 would then
  // pick the DVR line (JISLD... < JISLJ...). The substring match is load-bearing.
  const jisl = [row("JISLDVREQS", { slug: "jain-irrigation-systems" }), row("JISLJALEQS", { slug: "jain-irrigation-systems" })];
  assert("JISLJALEQS beats mid-string DVR line JISLDVREQS", winnerOf(jisl) === "JISLJALEQS", winnerOf(jisl));
  const fel = [row("FELDVR", { slug: "future-enterprises" }), row("FEL", { slug: "future-enterprises" })];
  assert("FEL beats FELDVR", winnerOf(fel) === "FEL", winnerOf(fel));
}

console.log("\n[rule 5 — codepoint order, and it must outrank freshness]");
{
  // "&" (0x26) sorts before "-" (0x2D), recovering the true NSE symbol from the
  // ampersand-normalisation artifact. Freshness is deliberately set to favour the
  // WRONG one, so this fails if freshness is ordered above codepoint.
  const cases = [
    ["M&M", "M-M", "mahindra-mahindra"],
    ["GVT&D", "GVT-D", "ge-vernova-td-india"],
    ["IL&FSENGG", "IL-FSENGG", "ilfs-engineering-and-construction"],
    ["SURANAT&P", "SURANAT-P", "surana-telecom-and-power"],
    ["GMRP&UI", "GMRP-UI", "gmr-power-and-urban-infra"],
  ];
  for (const [good, bad, slug] of cases) {
    const g = [
      row(bad, { slug, parsed_at: "2026-07-29T00:00:00.000Z" }),  // fresher, but wrong
      row(good, { slug, parsed_at: "2026-05-21T00:00:00.000Z" }), // staler, but right
    ];
    assert(`${good} beats ${bad} despite being staler`, winnerOf(g) === good, winnerOf(g));
  }
  // Real NSE-vs-NSE case where freshness previously decided.
  const tata = [
    row("TMCV", { slug: "tata-motors", parsed_at: "2026-07-29T00:00:00.000Z" }),
    row("TATAMOTORS", { slug: "tata-motors", parsed_at: "2026-05-21T00:00:00.000Z" }),
  ];
  assert("TATAMOTORS beats TMCV regardless of scrape recency", winnerOf(tata) === "TATAMOTORS", winnerOf(tata));
}

console.log("\n[determinism — identity must not depend on scrape order]");
{
  const slug = "tata-motors";
  const build = (aFresh) => [
    row("TATAMOTORS", { slug, parsed_at: aFresh ? "2026-07-29T00:00:00.000Z" : "2026-01-01T00:00:00.000Z" }),
    row("TMCV", { slug, parsed_at: aFresh ? "2026-01-01T00:00:00.000Z" : "2026-07-29T00:00:00.000Z" }),
  ];
  assert("winner identical whichever brief was scraped last",
    winnerOf(build(true)) === winnerOf(build(false)), [winnerOf(build(true)), winnerOf(build(false))]);

  // Input-array order must not matter either.
  const g = [row("WPIL", { slug: "wpil" }), row("BSE_505872", { exchange: "bse", slug: "wpil" }), row("505872", { exchange: "bse", slug: "wpil" })];
  const seen = new Set();
  for (let i = 0; i < 24; i++) {
    const shuffled = g.slice().sort(() => (i % 3) - 1);
    seen.add(winnerOf(shuffled));
  }
  assert("stable across input permutations", seen.size === 1 && seen.has("WPIL"), [...seen]);
}

console.log("\n[dedupeByCompany]");
{
  const rows = [
    row("SHANTIGOLD", { slug: "shanti-gold-international", parsed_at: "2026-06-11T00:00:00.000Z" }),
    row("BSE_544459", { exchange: "bse", slug: "shanti-gold-international", parsed_at: "2026-07-29T00:00:00.000Z" }),
    row("RELIANCE", { slug: "reliance-industries" }),
  ];
  const r = dedupeByCompany(rows);
  assert("collapses to 2 rows", r.kept.length === 2, r.kept.map((x) => x.ticker));
  assert("keeps the NSE listing", r.kept.some((x) => x.ticker === "SHANTIGOLD"), r.kept.map((x) => x.ticker));
  assert("drops the BSE listing", !r.kept.some((x) => x.ticker === "BSE_544459"), r.kept.map((x) => x.ticker));
  assert("untouched company survives", r.kept.some((x) => x.ticker === "RELIANCE"));
  assert("collapsed_count is 1", r.collapsed_count === 1, r.collapsed_count);
  assert("collapsed_by maps loser → winner", r.collapsed_by.BSE_544459 === "SHANTIGOLD", r.collapsed_by);
  assert("winner annotated with also_listed_as",
    JSON.stringify(r.kept.find((x) => x.ticker === "SHANTIGOLD").also_listed_as) === JSON.stringify(["BSE_544459"]));
  assert("stale winner is counted, not hidden", r.stale_vs_sibling_count === 1, r.stale_vs_sibling_count);
  // Ranking is the caller's job; reordering here would silently change leaderboards.
  assert("original relative order preserved",
    r.kept.map((x) => x.ticker).join(",") === "SHANTIGOLD,RELIANCE", r.kept.map((x) => x.ticker));
}

console.log("\n[fail-open: a parse failure must duplicate, never drop]");
{
  // Deep-brief tickers are NOT unique — MM.json and M&M.json both carry "M&M". If the
  // fallback keyed on ticker alone, these two unparseable rows would collide and one
  // would be silently dropped. That is the opposite of fail-open.
  const rows = [
    { ticker: "M&M", sws_url: null, parsed_at: "2026-06-10T00:00:00.000Z", indices: [] },
    { ticker: "M&M", sws_url: null, parsed_at: "2026-04-26T00:00:00.000Z", indices: [] },
  ];
  const r = dedupeByCompany(rows);
  assert("two unparseable rows sharing a ticker both survive", r.kept.length === 2, r.kept.length);
  assert("both counted as fallbacks", r.fallback_count === 2, r.fallback_count);
  assert("nothing collapsed", r.collapsed_count === 0, r.collapsed_count);
}
{
  const { key, viaFallback } = companyKeyFromRow({ ticker: "X", sws_url: "not a url" }, 7);
  assert("fallback key folds in the row index", key === "__row:7:X" && viaFallback === true, key);
}

console.log("\n[self-map guard]");
{
  // Real case: MM.json and M&M.json share the ticker "M&M" but have the same slug, so
  // the loser carries the winner's own ticker. Recording that alias would make the
  // winner its own alias and corrupt any consumer keyed on collapsed_by.
  const rows = [
    row("M&M", { slug: "mahindra-mahindra", parsed_at: "2026-06-10T00:00:00.000Z" }),
    row("M&M", { slug: "mahindra-mahindra", parsed_at: "2026-04-26T00:00:00.000Z" }),
    row("M-M", { slug: "mahindra-mahindra", parsed_at: "2026-05-21T00:00:00.000Z" }),
  ];
  const r = dedupeByCompany(rows);
  const w = r.kept[0];
  assert("one survivor", r.kept.length === 1, r.kept.map((x) => x.ticker));
  assert("winner is M&M", w.ticker === "M&M", w.ticker);
  assert("collapsed_by has no self-map", r.collapsed_by["M&M"] === undefined, r.collapsed_by);
  assert("also_listed_as excludes the winner's own ticker",
    !(w.also_listed_as || []).includes("M&M"), w.also_listed_as);
}

console.log("\n[degenerate input]");
{
  const r = dedupeByCompany([]);
  assert("empty input → empty output, no throw", r.kept.length === 0 && r.collapsed_count === 0);
}
{
  const r = dedupeByCompany([row("SOLO", { slug: "solo-co" })]);
  assert("single row untouched, no also_listed_as", r.kept.length === 1 && r.kept[0].also_listed_as === undefined);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
