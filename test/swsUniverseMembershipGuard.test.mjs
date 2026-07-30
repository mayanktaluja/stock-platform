/**
 * Regression tests for the SWS universe membership contract.
 *
 * Background — the outage these tests exist to prevent:
 *
 *   mergeAndSort() built its output by walking ONLY the sitemap, so any existing
 *   entry the sitemap didn't return was silently deleted. The sitemap crawl is
 *   ~580 MB across 12 shards and skips a shard on any fetch error, so a short
 *   crawl is routine. On 2026-07-23 one cut universe.json from 5500 → 3847
 *   entries, dropping 2178 tickers — 193 of them curated NIFTY-50 members
 *   (ICICIBANK, HINDUNILVR, BHARTIARTL, MARUTI, LT, KOTAKBANK…). Nothing blocked
 *   the write. The truncated list then froze for 6 days behind the 264h
 *   universe-meta freshness gate, while the 2331 orphaned deep briefs kept being
 *   scored and served — 33.7% of all picks rows, including 10 of the 30 rows in
 *   both headline Top-30 leaderboards, computed from 2-to-90-day-old data.
 *
 * Two independent defences, one test file:
 *   1. Pass 2 — an existing entry with no sitemap match is RETAINED, not dropped.
 *   2. assessMembershipLoss() — refuses the write when membership loss looks
 *      like a bad crawl rather than a deliberate delisting.
 *
 * Run with: node test/swsUniverseMembershipGuard.test.mjs
 */

import { assessMembershipLoss } from "../scripts/sws-universe-from-sitemap.mjs";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, "→ got", JSON.stringify(got)); }
}

function entry(ticker, opts = {}) {
  return {
    ticker,
    exchange: opts.exchange || "NSE",
    curated: opts.curated ?? false,
    indices: opts.indices || [],
    name: opts.name || ticker,
    sws_url: opts.sws_url ?? `https://simplywall.st/stocks/in/banks/nse-${ticker.toLowerCase()}/${ticker.toLowerCase()}-shares`,
  };
}

// Build the shape assessMembershipLoss() consumes without running a crawl.
function result(mergedTickers, droppedEntries) {
  return {
    merged: mergedTickers.map((t) => (typeof t === "string" ? entry(t) : t)),
    droppedFromExisting: droppedEntries.map((e) => ({ ...e, _drop_reason: e._drop_reason || "truly_missing_from_sitemap" })),
  };
}

console.log("\n[assessMembershipLoss — healthy rebuilds pass]");

// A rebuild that grows the universe is the normal case.
{
  const existing = Array.from({ length: 5000 }, (_, i) => entry(`T${i}`));
  const merged = Array.from({ length: 5200 }, (_, i) => entry(`T${i}`));
  const r = assessMembershipLoss({ merged, droppedFromExisting: [] }, existing);
  assert("growth, zero drops → ok", r.ok === true, r.violations);
  assert("shrink_pct is negative on growth", r.stats.shrink_pct < 0, r.stats);
}

// Calibration against the real healthy run: 2026-05-22 dropped 105 of 5455
// entries (1.92%), none curated. This must stay under the thresholds.
{
  const existing = Array.from({ length: 5455 }, (_, i) => entry(`T${i}`));
  const dropped = Array.from({ length: 105 }, (_, i) => entry(`T${i}`));
  const merged = Array.from({ length: 5480 }, (_, i) => entry(`M${i}`));
  const r = assessMembershipLoss(result(merged.map((e) => e.ticker), dropped), existing);
  assert("real 2026-05-22 run (105/5455 dropped, 0 curated) → ok", r.ok === true, r.violations);
  assert("drop_pct ≈ 1.92", Math.abs(r.stats.drop_pct - 1.92) < 0.05, r.stats);
}

console.log("\n[assessMembershipLoss — the 2026-07-23 outage is rejected]");

// The real bad run: 2178 of 5500 dropped (39.6%), 193 curated, net 5500 → 3847.
{
  const existing = Array.from({ length: 5500 }, (_, i) => entry(`T${i}`));
  const dropped = [
    ...["ICICIBANK", "HINDUNILVR", "BHARTIARTL", "MARUTI", "LT", "KOTAKBANK",
        "ADANIPORTS", "APOLLOHOSP", "ULTRACEMCO", "BPCL", "SBILIFE", "SHRIRAMFIN"]
      .map((t) => entry(t, { curated: true, indices: ["NIFTY50"] })),
    ...Array.from({ length: 181 }, (_, i) => entry(`C${i}`, { curated: true })),
    ...Array.from({ length: 1985 }, (_, i) => entry(`X${i}`)),
  ];
  const merged = Array.from({ length: 3847 }, (_, i) => entry(`M${i}`));
  const r = assessMembershipLoss(result(merged.map((e) => e.ticker), dropped), existing);

  assert("rejected outright", r.ok === false, r);
  assert("counts all 193 curated drops", r.stats.curated_dropped === 193, r.stats);
  assert("reports 2178 dropped", r.stats.dropped_count === 2178, r.stats);
  assert("drop_pct ≈ 39.6", Math.abs(r.stats.drop_pct - 39.6) < 0.1, r.stats);
  assert("shrink_pct ≈ 30.1", Math.abs(r.stats.shrink_pct - 30.05) < 0.2, r.stats);
  // All three thresholds should fire — each is an independent tripwire, so a
  // future threshold retune can't silently disarm the whole guard.
  assert("all three violations reported", r.violations.length === 3, r.violations);
  assert("names the curated victims in the message",
    /ICICIBANK/.test(r.violations.join(" ")), r.violations);
}

console.log("\n[assessMembershipLoss — each tripwire fires independently]");

// A single curated drop is enough, even when the volume looks harmless.
{
  const existing = Array.from({ length: 5000 }, (_, i) => entry(`T${i}`));
  const merged = Array.from({ length: 4999 }, (_, i) => entry(`T${i}`));
  const r = assessMembershipLoss(result(merged.map((e) => e.ticker), [entry("ICICIBANK", { curated: true })]), existing);
  assert("1 curated drop out of 5000 → rejected", r.ok === false, r);
  assert("only the curated tripwire fires", r.violations.length === 1, r.violations);
}

// Volume alone is enough, with no curated entry involved.
{
  const existing = Array.from({ length: 1000 }, (_, i) => entry(`T${i}`));
  const dropped = Array.from({ length: 300 }, (_, i) => entry(`T${i}`));
  const merged = Array.from({ length: 700 }, (_, i) => entry(`T${i}`));
  const r = assessMembershipLoss(result(merged.map((e) => e.ticker), dropped), existing);
  assert("30% non-curated drop → rejected", r.ok === false, r);
  assert("drop + shrink tripwires fire", r.violations.length === 2, r.violations);
}

// Boundary: exactly at the drop threshold must PASS (guard is `>`, not `>=`),
// so a steady-state run sitting on the line doesn't flap red every night.
{
  const existing = Array.from({ length: 1000 }, (_, i) => entry(`T${i}`));
  const dropped = Array.from({ length: 50 }, (_, i) => entry(`T${i}`));   // exactly 5%
  const merged = Array.from({ length: 1000 }, (_, i) => entry(`M${i}`));  // no net shrink
  const r = assessMembershipLoss(result(merged.map((e) => e.ticker), dropped), existing);
  assert("exactly 5% dropped, no shrink → ok (boundary)", r.ok === true, r.violations);
}

// One past the line must fail, pinning the boundary from both sides.
{
  const existing = Array.from({ length: 1000 }, (_, i) => entry(`T${i}`));
  const dropped = Array.from({ length: 51 }, (_, i) => entry(`T${i}`));
  const merged = Array.from({ length: 1000 }, (_, i) => entry(`M${i}`));
  const r = assessMembershipLoss(result(merged.map((e) => e.ticker), dropped), existing);
  assert("5.1% dropped → rejected (boundary+1)", r.ok === false, r.violations);
}

console.log("\n[assessMembershipLoss — degenerate inputs never throw]");

{
  const r = assessMembershipLoss({ merged: [], droppedFromExisting: [] }, []);
  assert("empty existing + empty merged → ok, no divide-by-zero",
    r.ok === true && Number.isFinite(r.stats.drop_pct), r.stats);
}
{
  // droppedFromExisting absent entirely (older callers / partial results).
  const r = assessMembershipLoss({ merged: [entry("A")] }, [entry("A")]);
  assert("missing droppedFromExisting → treated as no drops", r.ok === true, r);
}
{
  // A total wipe is the most dangerous case and must never slip through.
  const existing = Array.from({ length: 100 }, (_, i) => entry(`T${i}`));
  const r = assessMembershipLoss(result([], existing), existing);
  assert("sitemap returned nothing → rejected", r.ok === false, r.violations);
  assert("shrink_pct is 100", r.stats.shrink_pct === 100, r.stats);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
