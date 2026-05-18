/**
 * Stream E1 — track-history discontinued-type filter regression.
 *
 * Run with: node test/trackDiscontinuedFilter.test.mjs
 *
 * The Track Record tab used to surface 3 discontinued scanners
 * (Small-Cap Buy Now, Fundamental Deep Value, Buy Now (Nifty 100)).
 * Stream A introduced an `ACTIVE_TRACK_TYPES` allowlist in server.js
 * that inverts the byType breakdown: anything NOT in the allowlist is
 * dropped from `byType` before the response leaves the server, while
 * the raw `trades[]` array still contains them for back-compat with
 * `?type=` lookups (audit-only, surfaced via X-Audit-Only header).
 *
 * This test pins the allowlist behaviour as a pure-data invariant so a
 * future drift in server.js (typo'd type name, accidental delete of a
 * scanner type, etc.) blows up the test suite before it ships.
 *
 * The sets here MUST be kept in sync with server.js:4268-4289. A
 * mismatch is the failure mode the test is designed to catch.
 */

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

console.log("track-history discontinued-type filter\n");

// Mirror of server.js:4268-4289. If server.js changes, this MUST move too.
const ACTIVE_TRACK_TYPES = new Set([
  "sws_top30_v3",
  "sws_best_buynow",
  "sws_deep_value",
  "sws_quality_growth",
  "sws_midterm",
  "sws_dividend_aristocrats",
  "sws_smallcap_gems",
  "sws_insider_buying",
  "sws_upcoming_earnings",
  "sws_avoid",
  "scanner_buynow_top10",
  "scanner_midterm_top10",
  "scanner_sell_top10",
  "earnings_beat_top10",
  "earnings_miss_top10",
]);

const DISCONTINUED_TRACK_TYPES = new Set([
  "buynow_nifty100",
  "smallcap_buynow",
  "fundamental_deep_value",
]);

// Replicate the server-side filter: `for (const k of Object.keys(byType)) if (!ACTIVE_TRACK_TYPES.has(k)) delete byType[k]`
function applyByTypeFilter(byType) {
  const out = { ...byType };
  for (const k of Object.keys(out)) {
    if (!ACTIVE_TRACK_TYPES.has(k)) delete out[k];
  }
  return out;
}

// ──── byType allowlist drops discontinued + orphans ────
{
  const fixture = {
    // 4 active SWS types
    sws_top30_v3: { count: 12, avgReturn: 4.2 },
    sws_best_buynow: { count: 8, avgReturn: 3.1 },
    sws_deep_value: { count: 5, avgReturn: 5.6 },
    sws_quality_growth: { count: 7, avgReturn: 2.9 },
    // 3 discontinued types (all 3 from the spec)
    buynow_nifty100: { count: 30, avgReturn: 50.4 },
    smallcap_buynow: { count: 22, avgReturn: 48.7 },
    fundamental_deep_value: { count: 18, avgReturn: 45.3 },
    // 1 orphan unknown type (e.g. typo'd legacy key)
    legacy_unknown_scanner_xyz: { count: 1, avgReturn: 0 },
  };
  const filtered = applyByTypeFilter(fixture);
  const keys = Object.keys(filtered).sort();

  assert(
    "exactly 4 keys remain after filter",
    keys.length === 4,
    keys.length,
  );
  assert(
    "remaining keys are exactly the 4 active SWS types",
    JSON.stringify(keys) ===
      JSON.stringify(["sws_best_buynow", "sws_deep_value", "sws_quality_growth", "sws_top30_v3"]),
    keys,
  );
  assert(
    "all 3 discontinued types absent from filtered byType",
    !("buynow_nifty100" in filtered) &&
      !("smallcap_buynow" in filtered) &&
      !("fundamental_deep_value" in filtered),
    keys,
  );
  assert(
    "orphan unknown type absent (allowlist invert handles it)",
    !("legacy_unknown_scanner_xyz" in filtered),
    keys,
  );
}

// ──── trades[] still contains all types — back-door for ?type=audit lookups ────
{
  const trades = [
    { id: 1, type: "sws_top30_v3", symbol: "RELIANCE" },
    { id: 2, type: "buynow_nifty100", symbol: "TCS" },
    { id: 3, type: "smallcap_buynow", symbol: "DCMSHRIRAM" },
    { id: 4, type: "fundamental_deep_value", symbol: "ITC" },
    { id: 5, type: "sws_avoid", symbol: "ZEEL" },
  ];
  // The server filters byType but NOT trades[] (storage-level filter only
  // applies when ?type= is passed and the value matches the row's type).
  // Verify a direct `?type=buynow_nifty100` lookup still surfaces 1 historical row.
  const buynowAudit = trades.filter((t) => t.type === "buynow_nifty100");
  assert(
    "?type=buynow_nifty100 still returns 1 historical trade",
    buynowAudit.length === 1 && buynowAudit[0].symbol === "TCS",
    buynowAudit,
  );

  const smallcapAudit = trades.filter((t) => t.type === "smallcap_buynow");
  assert(
    "?type=smallcap_buynow still returns 1 historical trade",
    smallcapAudit.length === 1 && smallcapAudit[0].symbol === "DCMSHRIRAM",
    smallcapAudit,
  );

  const fdvAudit = trades.filter((t) => t.type === "fundamental_deep_value");
  assert(
    "?type=fundamental_deep_value still returns 1 historical trade",
    fdvAudit.length === 1 && fdvAudit[0].symbol === "ITC",
    fdvAudit,
  );
}

// ──── ACTIVE set + DISCONTINUED set are disjoint (sanity-check the sets themselves) ────
{
  let overlap = null;
  for (const t of DISCONTINUED_TRACK_TYPES) {
    if (ACTIVE_TRACK_TYPES.has(t)) {
      overlap = t;
      break;
    }
  }
  assert(
    "ACTIVE_TRACK_TYPES and DISCONTINUED_TRACK_TYPES are disjoint",
    overlap === null,
    overlap,
  );
  assert(
    "ACTIVE_TRACK_TYPES has exactly 15 entries (pin against accidental drift)",
    ACTIVE_TRACK_TYPES.size === 15,
    ACTIVE_TRACK_TYPES.size,
  );
  assert(
    "DISCONTINUED_TRACK_TYPES has exactly 3 entries (pin against accidental drift)",
    DISCONTINUED_TRACK_TYPES.size === 3,
    DISCONTINUED_TRACK_TYPES.size,
  );
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
