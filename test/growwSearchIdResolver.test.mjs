/**
 * scripts/groww-pe-refresh.mjs — strict searchId fallback resolver.
 *
 * Context: Groww's /stocks/filter screener serves only ~4476 records while
 * reporting totalRecords 5019, and exhausting its pagination does not change
 * that. On 2026-07-23 that left 1348 target tickers unmapped, dropped coverage to
 * 62.25% against a 70% floor, and hard-blocked the entire SWS ship.
 *
 * The safety property under test is EXACTNESS. Groww search for the retired
 * `TATAMOTORS` returns `tata-motors-ltd`, whose nse_scrip_code is TMPV (Tata
 * Motors demerged into TMPV/TMCV). Accepting that would file TMPV's P/E under
 * TATAMOTORS — one company's valuation written into another's row, in a field
 * that feeds V4 scoring. A miss is cheap; a wrong match is silent corruption.
 *
 * Run with: node test/growwSearchIdResolver.test.mjs
 */

import assert from "node:assert/strict";
import { resolveSearchIdStrict, isSearchResolvableTicker } from "../scripts/groww-pe-refresh.mjs";

let pass = 0;
let fail = 0;
function ok(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ok:", name);
  } else {
    fail++;
    console.log("  FAIL:", name, got !== undefined ? `-- got ${JSON.stringify(got)}` : "");
  }
}

/** Stub the network with a canned search payload. */
function stubFetch(payload) {
  return async () => (typeof payload === "string" ? payload : JSON.stringify(payload));
}
const hit = (nse, id) => ({ nse_scrip_code: nse, search_id: id });

console.log("growwSearchIdResolver: exact nse_scrip_code match is required");
{
  const r = await resolveSearchIdStrict("WOL3D", {
    fetchImpl: stubFetch({ data: { content: [hit("WOL3D", "wol-d-india-ltd")] } }),
  });
  ok("exact match resolves", r === "wol-d-india-ltd", r);
}
{
  // THE canonical trap, verbatim from the live endpoint on 2026-07-23.
  const r = await resolveSearchIdStrict("TATAMOTORS", {
    fetchImpl: stubFetch({
      data: {
        content: [
          hit("TMPV", "tata-motors-ltd"),
          hit("TMCV", "tata-motors-ltd-22"),
        ],
      },
    }),
  });
  ok("TATAMOTORS -> TMPV/TMCV is REFUSED (no wrong-entity P/E)", r === null, r);
}
{
  const r = await resolveSearchIdStrict("FOO", {
    fetchImpl: stubFetch({ data: { content: [hit("FOOBAR", "foobar-ltd")] } }),
  });
  ok("a prefix/substring near-match is refused", r === null, r);
}
{
  const r = await resolveSearchIdStrict("silky", {
    fetchImpl: stubFetch({ data: { content: [hit("SILKY", "silky-overseas-ltd")] } }),
  });
  ok("comparison is case-insensitive", r === "silky-overseas-ltd", r);
}
{
  const r = await resolveSearchIdStrict("ABC", {
    fetchImpl: stubFetch({ data: { content: [{ nse_scrip_code: "ABC" }] } }),
  });
  ok("a matching code with no search_id is refused", r === null, r);
}
{
  const r = await resolveSearchIdStrict("ABC", {
    fetchImpl: stubFetch({ data: { content: [hit("", "some-ltd"), hit("ABC", "abc-ltd")] } }),
  });
  ok("scans past a blank code to a later exact match", r === "abc-ltd", r);
}

console.log("growwSearchIdResolver: never throws on bad input or transport");
for (const [label, payload] of [
  ["malformed JSON", "not json at all"],
  ["empty content", { data: { content: [] } }],
  ["missing data key", {}],
  ["content not an array", { data: { content: { nope: 1 } } }],
]) {
  const r = await resolveSearchIdStrict("ABC", { fetchImpl: stubFetch(payload) });
  ok(`${label} -> null, no throw`, r === null, r);
}
{
  const r = await resolveSearchIdStrict("ABC", {
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });
  ok("transport error -> null, no throw", r === null, r);
}
for (const bad of [null, undefined, "", "   "]) {
  const r = await resolveSearchIdStrict(bad, { fetchImpl: stubFetch({ data: { content: [] } }) });
  ok(`empty ticker ${JSON.stringify(bad)} -> null without a request`, r === null, r);
}

console.log("growwSearchIdResolver: request-budget prefilter");
{
  // ~52% of the unmapped set were BSE_* pseudo-tickers with no NSE code to match.
  // Excluding them costs no coverage and keeps the lookup budget for real gaps.
  for (const t of ["WOL3D", "SILKY", "TIRUPATIFL", "M&M", "BAJAJ-AUTO", "RELIANCE"])
    ok(`${t} is a resolvable candidate`, isSearchResolvableTicker(t) === true);
  for (const t of ["BSE_500041", "BSE_532440", "500041", "", null, undefined, "WAY-TOO-LONG-TICKER-NAME-HERE"])
    ok(`${JSON.stringify(t)} is skipped`, isSearchResolvableTicker(t) === false);
}

assert.equal(fail, 0, `${fail} assertion(s) failed`);
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
