import {
  buildBestToBuyTiers,
  TRUST_GATE_CODES,
  QUALITY_SCORE_FLOOR,
  WAIT_FOR_PRICE_CAP,
  WATCHLIST_ONLY_CAP,
} from "../services/swsBestToBuyTiers.js";

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// Card factory — only the fields the tier builder reads.
function card(ticker, { score = 60, state = "UNAVAILABLE", fresh = false, codes = [] } = {}) {
  return {
    ticker,
    v4_score_100: score,
    entry_band: {
      entry_state: state,
      fresh_buy_eligible: fresh,
      reasons: codes.map((code) => ({ code, message: code })),
    },
  };
}

// ──── Buy now mirrors best_to_buy_now verbatim ────
{
  const sections = {
    best_to_buy_now: [card("A", { state: "BUY_ZONE", fresh: true }), card("B", { state: "STAGGER_ONLY", fresh: true })],
  };
  const t = buildBestToBuyTiers(sections);
  assert("buy_now = best_to_buy_now list", t.buy_now.length === 2 && t.buy_now[0].ticker === "A", t.buy_now.map(c => c.ticker));
  assert("wait/watch empty when no pool", t.wait_for_price.length === 0 && t.watchlist_only.length === 0, t);
}

// ──── Wait for price: NO_BUY_ABOVE, only price code, clears quality floor ────
{
  const sections = {
    best_to_buy_now: [],
    deep_value: [card("WAIT1", { score: 70, state: "NO_BUY_ABOVE", codes: ["above_no_buy_cap"] })],
  };
  const t = buildBestToBuyTiers(sections);
  assert("wait_for_price catches priced-out quality name", t.wait_for_price.length === 1 && t.wait_for_price[0].ticker === "WAIT1", t.wait_for_price);
  assert("priced-out name not in watchlist", t.watchlist_only.length === 0, t.watchlist_only);
}

// ──── NO_BUY_ABOVE with a trust code is neither wait nor watch ────
{
  const sections = {
    best_to_buy_now: [],
    deep_value: [card("X", { score: 70, state: "NO_BUY_ABOVE", codes: ["above_no_buy_cap", "snowflake_below_floor"] })],
  };
  const t = buildBestToBuyTiers(sections);
  assert("priced-out + trust fail dropped from wait", t.wait_for_price.length === 0, t.wait_for_price);
  assert("priced-out + trust fail dropped from watch (state is NO_BUY_ABOVE)", t.watchlist_only.length === 0, t.watchlist_only);
}

// ──── Watchlist only: exactly one trust code, not NO_BUY_ABOVE, clears floor ────
{
  const sections = {
    best_to_buy_now: [],
    quality_growth: [card("WATCH1", { score: 65, state: "UNAVAILABLE", codes: ["snowflake_below_floor"] })],
  };
  const t = buildBestToBuyTiers(sections);
  assert("watchlist catches single-trust-fail quality name", t.watchlist_only.length === 1 && t.watchlist_only[0].ticker === "WATCH1", t.watchlist_only);
}

// ──── Two trust codes → not watchlist (must be exactly one) ────
{
  const sections = {
    best_to_buy_now: [],
    quality_growth: [card("Y", { score: 65, codes: ["snowflake_below_floor", "data_stale"] })],
  };
  const t = buildBestToBuyTiers(sections);
  assert("two trust fails excluded from watchlist", t.watchlist_only.length === 0, t.watchlist_only);
}

// ──── Quality floor: weak score excluded from both buckets ────
{
  const below = QUALITY_SCORE_FLOOR - 1;
  const sections = {
    best_to_buy_now: [],
    smallcap_gems: [
      card("WEAKWAIT", { score: below, state: "NO_BUY_ABOVE", codes: ["above_no_buy_cap"] }),
      card("WEAKWATCH", { score: below, codes: ["snowflake_below_floor"] }),
    ],
  };
  const t = buildBestToBuyTiers(sections);
  assert("weak score excluded from wait", t.wait_for_price.length === 0, t.wait_for_price);
  assert("weak score excluded from watchlist", t.watchlist_only.length === 0, t.watchlist_only);
}

// ──── Dedup: a ticker in buy_now never reappears in wait/watch ────
{
  const sections = {
    best_to_buy_now: [card("DUP", { state: "BUY_ZONE", fresh: true, score: 80 })],
    deep_value: [card("DUP", { score: 80, state: "NO_BUY_ABOVE", codes: ["above_no_buy_cap"] })],
  };
  const t = buildBestToBuyTiers(sections);
  assert("buy_now ticker excluded from wait", !t.wait_for_price.some(c => c.ticker === "DUP"), t.wait_for_price);
}

// ──── Dedup across pool: ticker counted once (suffix-insensitive) ────
{
  const sections = {
    best_to_buy_now: [],
    deep_value: [card("RELIANCE.NS", { score: 70, state: "NO_BUY_ABOVE", codes: ["above_no_buy_cap"] })],
    quality_growth: [card("RELIANCE.BO", { score: 70, state: "NO_BUY_ABOVE", codes: ["above_no_buy_cap"] })],
  };
  const t = buildBestToBuyTiers(sections);
  assert("suffix variants dedup to one wait entry", t.wait_for_price.length === 1, t.wait_for_price.map(c => c.ticker));
}

// ──── Caps + sort by v4_score_100 desc ────
{
  const many = [];
  for (let i = 0; i < WAIT_FOR_PRICE_CAP + 5; i++) {
    many.push(card("W" + i, { score: 50 + i, state: "NO_BUY_ABOVE", codes: ["above_no_buy_cap"] }));
  }
  const t = buildBestToBuyTiers({ best_to_buy_now: [], deep_value: many });
  assert("wait_for_price capped", t.wait_for_price.length === WAIT_FOR_PRICE_CAP, t.wait_for_price.length);
  assert("wait_for_price sorted by score desc", t.wait_for_price[0].v4_score_100 >= t.wait_for_price[1].v4_score_100, t.wait_for_price.slice(0, 2).map(c => c.v4_score_100));
}

// ──── Defensive: junk input never throws ────
{
  assert("null sections → empty tiers", JSON.stringify(buildBestToBuyTiers(null)) === JSON.stringify({ buy_now: [], wait_for_price: [], watchlist_only: [] }), buildBestToBuyTiers(null));
  assert("non-array section ignored", buildBestToBuyTiers({ best_to_buy_now: "nope", deep_value: 5 }).buy_now.length === 0, "ok");
}

// ──── TRUST set excludes the pure price-band + construction codes ────
{
  assert("above_no_buy_cap is NOT a trust code", !TRUST_GATE_CODES.has("above_no_buy_cap"));
  assert("fair_value_missing is NOT a trust code", !TRUST_GATE_CODES.has("fair_value_missing"));
  assert("score_below_floor IS a trust code", TRUST_GATE_CODES.has("score_below_floor"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
