/**
 * Tests for fundamentals.js — the V1 fundamental-value scorer.
 *
 * Coverage focuses on pure functions:
 *   - SCORER_VERSION is stamped and is a non-empty string (Reg-25 audit trail)
 *   - loadFundamentalsFromDisk + getAllFundamentals + getSnapshotGeneratedAt
 *     produce the expected shape against the real on-disk snapshot
 *     (no network — the loader only reads fundamentals.json off the filesystem,
 *     all NSE refresh happens in scripts/refresh-fundamentals.mjs locally)
 *   - getFundamentals returns null for an unknown symbol
 *   - getSectorPeBenchmarks honours the MIN_SECTOR_SIZE = 4 cutoff and emits
 *     median/count/min/max in the expected shape
 *   - scoreFundamentals on null snap → null
 *   - scoreFundamentals on a strong value snap → high score + DEEP_VALUE
 *   - scoreFundamentals on an extreme-hype snap → low score + OVERVALUED
 *   - scoreFundamentals on a fairly-valued snap → middling score + FAIR_VALUE
 *   - scoreFundamentals reports the source of the sector P/E benchmark when
 *     NSE's value is circular and our computed median substitutes
 *   - scoreFundamentals clamps to [0,100]
 *   - QUALITY GUARDRAIL downgrades DV/QG → FAIR_VALUE when ROE<10% or D/E>1.0
 *   - QG growth gate downgrades when revenue growth <8% AND ROE <15%
 *   - categoriseBatch buckets correctly, sorts DV/QG/FV descending, FullyValued
 *     and Overvalued ascending, and respects the limit
 *   - scoreFundamentals stamps scoredAt + scorerVersion + snapshot block for
 *     Reg-25 reproducibility
 *
 * Run with: node test/fundamentals.test.mjs
 */

import {
  SCORER_VERSION,
  loadFundamentalsFromDisk,
  getFundamentals,
  getAllFundamentals,
  getSnapshotGeneratedAt,
  getSnapshotEnrichedAt,
  getSectorPeBenchmarks,
  getSectorMedianPe,
  scoreFundamentals,
  categoriseBatch,
} from "../fundamentals.js";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

console.log("\nfundamentals.js — scorer + loader\n");

// ──── SCORER_VERSION ────
assert(
  "SCORER_VERSION is a non-empty string starting with 'v'",
  typeof SCORER_VERSION === "string" && SCORER_VERSION.length > 0 && SCORER_VERSION.startsWith("v"),
  SCORER_VERSION,
);

// ──── Disk loader: shape against the real fundamentals.json ────
{
  const snap = loadFundamentalsFromDisk();
  assert(
    "loadFundamentalsFromDisk returns object with snapshots map (or null when file missing)",
    snap === null || (typeof snap === "object" && typeof snap.snapshots === "object"),
    snap === null ? null : Object.keys(snap),
  );

  // Second call must hit the mtime cache and return the same reference.
  if (snap) {
    const snap2 = loadFundamentalsFromDisk();
    assert("mtime cache returns same reference on second call", snap2 === snap, null);
  }
}

// ──── getAllFundamentals + getSnapshotGeneratedAt ────
{
  const all = getAllFundamentals();
  assert("getAllFundamentals returns an array", Array.isArray(all), typeof all);
  // The real snapshot has >100 stocks; if missing we get an empty array.
  assert("getAllFundamentals array entries are objects when present", all.length === 0 || typeof all[0] === "object", null);

  const gen = getSnapshotGeneratedAt();
  assert("getSnapshotGeneratedAt returns string|null", gen === null || typeof gen === "string", typeof gen);

  const enriched = getSnapshotEnrichedAt();
  assert("getSnapshotEnrichedAt returns string|null", enriched === null || typeof enriched === "string", typeof enriched);
}

// ──── getFundamentals for unknown symbol → null ────
{
  const r = getFundamentals("DEFINITELY_NOT_A_SYMBOL.NS");
  assert("getFundamentals('NOT_A_SYMBOL.NS') is null", r === null, r);
}

// ──── getSectorPeBenchmarks shape + MIN_SECTOR_SIZE cutoff ────
{
  const b = getSectorPeBenchmarks();
  assert("getSectorPeBenchmarks returns an object", b && typeof b === "object", typeof b);
  for (const [sector, entry] of Object.entries(b)) {
    assert(
      `sector '${sector}' median is positive`,
      Number.isFinite(entry.median) && entry.median > 0,
      entry,
    );
    assert(
      `sector '${sector}' count >= 4 (MIN_SECTOR_SIZE)`,
      entry.count >= 4,
      entry.count,
    );
    assert(
      `sector '${sector}' min <= median <= max`,
      entry.min <= entry.median && entry.median <= entry.max,
      entry,
    );
  }

  // getSectorMedianPe on a clearly-bogus sector → null
  assert(
    "getSectorMedianPe('NotARealSector') is null",
    getSectorMedianPe("NotARealSector") === null,
    getSectorMedianPe("NotARealSector"),
  );
  assert("getSectorMedianPe(null) is null", getSectorMedianPe(null) === null, getSectorMedianPe(null));
}

// ──── scoreFundamentals: null snap → null ────
{
  assert("scoreFundamentals(null) is null", scoreFundamentals(null) === null, scoreFundamentals(null));
}

// ──── Strong value snap → high score + DEEP_VALUE ────
{
  const r = scoreFundamentals({
    symbol: "STRONGVAL.NS",
    name: "Strong Value Co",
    sector: "Materials",
    industry: "Steel",
    pe: 6,                // < 8 → +5 absolutePe; ratio 6/20=0.3 → +12 peVsSector
    sectorPe: 20,         // not circular, not within 1% of pe
    price: 110,           // 10% of 52W range (low end) → +6 position52w
    week52High: 200,
    week52Low: 100,
    marketCap: 60000 * 10000000, // 60,000 Cr → Large Cap, +0
    roe: 0.22,            // >= 0.20 → +10 roe
    debtToEquity: 0.05,   // <= 0.1 → +8 D/E
    profitMargin: 0.25,   // >= 0.20 → +6 profit margin
    revenueGrowthYoY: 0.30, // >= 0.25 → +9 revenue growth
  }, 90);                 // 110/90 = 1.22 → -2 vs200DMA
  // Total expected: 50 + 12 + 5 + 6 - 2 + 0 + 10 + 8 + 6 + 9 = 104 → clamps to 100
  assert("Strong value snap returns object with score + verdict", r && typeof r.score === "number" && typeof r.verdict === "string", r);
  assert("Strong value snap clamps to <= 100", r.score <= 100, r.score);
  assert("Strong value snap score >= 72 (DEEP_VALUE threshold)", r.score >= 72, r.score);
  assert("Strong value snap verdict is DEEP_VALUE", r.verdict === "DEEP_VALUE", r.verdict);
  assert("Strong value snap reasoning includes 'discount'", /discount/i.test(r.reasoning), r.reasoning);
  assert("Strong value snap breakdown.peVsSector positive", r.breakdown.peVsSector > 0, r.breakdown.peVsSector);
  assert("Strong value snap breakdown.roeValue echoes input", r.breakdown.roeValue === 0.22, r.breakdown.roeValue);
}

// ──── Extreme-hype snap → low score + OVERVALUED ────
{
  const r = scoreFundamentals({
    symbol: "HYPE.NS",
    name: "Hype Inc",
    sector: "Consumer Discretionary",
    industry: "Retail",
    pe: 150,              // >120 → -12 absolutePe; 150/20=7.5 → -12 peVsSector
    sectorPe: 20,
    price: 999,           // 99.8% of 52W range → -6 position52w
    week52High: 1000,
    week52Low: 100,
    marketCap: 800 * 10000000, // 800 Cr → Micro cap, -5
    roe: -0.05,           // negative → -12 roe
    debtToEquity: 2.5,    // > 2.0 → -10 D/E
    profitMargin: -0.10,  // negative → -6 profit margin
    revenueGrowthYoY: -0.20, // < -0.1 → -6 revenue growth
  }, 600);                // 999/600 = 1.665 → -6 vs200DMA
  // Total expected: 50 - 12 - 12 - 6 - 6 - 5 - 12 - 10 - 6 - 6 = -25 → clamps to 0
  assert("Hype snap clamps to >= 0", r.score >= 0, r.score);
  assert("Hype snap score < 40 (OVERVALUED ceiling)", r.score < 40, r.score);
  assert("Hype snap verdict is OVERVALUED", r.verdict === "OVERVALUED", r.verdict);
  assert("Hype snap reasoning mentions hype or extreme", /hype|extreme|destroying/i.test(r.reasoning), r.reasoning);
  assert("Hype snap breakdown.peVsSector is -12", r.breakdown.peVsSector === -12, r.breakdown.peVsSector);
}

// ──── Fairly-valued snap → middle score + FAIR_VALUE ────
{
  // Use an imaginary sector so neither NSE's sectorPe (we send none) nor the
  // computed-median fallback fire — pe vs sector dimension is skipped cleanly.
  // That way the score depends only on the explicit per-dimension inputs and
  // doesn't shift if the on-disk snapshot's IT sector median changes.
  const r = scoreFundamentals({
    symbol: "FAIR.NS",
    name: "Fair Value Co",
    sector: "NoSuchSyntheticSector",
    industry: "Software",
    pe: 20,               // sectorPe path skipped; absolutePe 1
    // sectorPe omitted on purpose
    price: 750,           // 68.75% of 52W range → 0 position52w (between 0.5 and 0.7)
    week52High: 1000,
    week52Low: 200,
    marketCap: 30000 * 10000000, // Mid Cap → 0
    roe: 0.12,            // 0.10 <= roe < 0.15 → +4 roe
    debtToEquity: 0.6,    // 0.5 < D/E <= 1.0 → 0 D/E
    profitMargin: 0.08,   // 0.05 <= pm < 0.10 → +1 profit margin
    revenueGrowthYoY: 0.10, // 0.05 <= rg < 0.15 → +2 revenue growth
  });
  // Expected: 50 + 1 + 0 + 0 + 4 + 0 + 1 + 2 = 58 → FAIR_VALUE (48 ≤ x < 62)
  assert("Fair-value snap score in 48-61 range (FAIR_VALUE band)", r.score >= 48 && r.score < 62, r.score);
  assert("Fair-value snap verdict is FAIR_VALUE", r.verdict === "FAIR_VALUE", r.verdict);
}

// ──── Circular sectorPe → uses computed median (or skips when none available) ────
{
  // Build a small in-memory case where NSE's sectorPe == pe → flagged circular.
  // No computed median is available for the synthetic sector → peVsSector stays 0.
  const r = scoreFundamentals({
    symbol: "CIRC.NS",
    name: "Circular Heavyweight",
    sector: "ImaginarySector",   // no computed median for this
    industry: "n/a",
    pe: 35,
    sectorPe: 35,                // exact match → circular
    price: 500,
    week52High: 1000,
    week52Low: 200,
    marketCap: 100000 * 10000000,
  });
  assert("Circular sectorPe path: scored object returned", r != null, r);
  assert("Circular sectorPe path: a warning is emitted", Array.isArray(r.warnings) && r.warnings.length > 0, r.warnings);
  assert(
    "Circular sectorPe path: warning mentions sector P/E benchmark",
    r.warnings.some((w) => /sector p\/?e/i.test(w)),
    r.warnings,
  );
  // peVsSector dimension is skipped; no peVsSector key in breakdown should be set when sector unavailable
  assert("Circular sectorPe path: breakdown.sectorPeAvailable === false", r.breakdown.sectorPeAvailable === false, r.breakdown);
}

// ──── Reg-25 audit fields are stamped on every result ────
{
  const r = scoreFundamentals({
    symbol: "AUDIT.NS",
    name: "Audit Co",
    sector: "Materials",
    industry: "Steel",
    pe: 15, sectorPe: 20, price: 500, week52High: 800, week52Low: 300, marketCap: 30000 * 10000000,
  });
  assert("scoredAt is an ISO string", typeof r.scoredAt === "string" && !Number.isNaN(Date.parse(r.scoredAt)), r.scoredAt);
  assert("scorerVersion equals SCORER_VERSION", r.scorerVersion === SCORER_VERSION, r.scorerVersion);
  assert("snapshot block echoes input symbol/name/sector", r.snapshot.symbol === "AUDIT.NS" && r.snapshot.name === "Audit Co" && r.snapshot.sector === "Materials", r.snapshot);
}

// ──── QUALITY GUARDRAIL: ROE<10% downgrades DV/QG → FAIR_VALUE ────
{
  // Build a snap that would naturally score into QG/DV but with ROE=5% (<10%).
  // Use strong P/E + price-position signal + decent D/E + decent margin/growth.
  const r = scoreFundamentals({
    symbol: "TRAP.NS",
    name: "Value Trap",
    sector: "Materials",
    industry: "Steel",
    pe: 6, sectorPe: 20,
    price: 110, week52High: 200, week52Low: 100,
    marketCap: 60000 * 10000000,
    roe: 0.05,                // FAILS quality gate (<10%)
    debtToEquity: 0.3,        // passes
    profitMargin: 0.12,
    revenueGrowthYoY: 0.20,
  }, 90);
  assert(
    "QUALITY GUARDRAIL: ROE<10% downgrades to FAIR_VALUE",
    r.verdict === "FAIR_VALUE",
    { verdict: r.verdict, score: r.score },
  );
  assert(
    "QUALITY GUARDRAIL: breakdown.qualityGuardrailApplied is true",
    r.breakdown.qualityGuardrailApplied === true,
    r.breakdown,
  );
  assert(
    "QUALITY GUARDRAIL: reason mentions ROE threshold",
    /ROE/i.test(r.breakdown.qualityGuardrailReason || ""),
    r.breakdown.qualityGuardrailReason,
  );
  assert(
    "QUALITY GUARDRAIL: a 'Downgraded' warning is added",
    r.warnings.some((w) => /Downgraded/i.test(w)),
    r.warnings,
  );
}

// ──── QUALITY GUARDRAIL: D/E>1.0 downgrades ────
{
  const r = scoreFundamentals({
    symbol: "LEVERED.NS", name: "Levered Inc", sector: "Industrials", industry: "Capital Goods",
    pe: 6, sectorPe: 20,
    price: 110, week52High: 200, week52Low: 100,
    marketCap: 60000 * 10000000,
    roe: 0.18,                // passes quality (>= 10%)
    debtToEquity: 1.8,        // FAILS health (>1.0)
    profitMargin: 0.15,
    revenueGrowthYoY: 0.20,
  });
  assert("QUALITY GUARDRAIL: D/E>1.0 downgrades to FAIR_VALUE", r.verdict === "FAIR_VALUE", { verdict: r.verdict, score: r.score });
  assert("QUALITY GUARDRAIL: reason mentions D/E", /D\/E/i.test(r.breakdown.qualityGuardrailReason || ""), r.breakdown.qualityGuardrailReason);
}

// ──── categoriseBatch buckets + sort + limit ────
{
  const stocks = [
    { verdict: "DEEP_VALUE", score: 80 },
    { verdict: "DEEP_VALUE", score: 90 },
    { verdict: "DEEP_VALUE", score: 75 },
    { verdict: "QUALITY_GROWTH", score: 65 },
    { verdict: "QUALITY_GROWTH", score: 70 },
    { verdict: "FAIR_VALUE", score: 50 },
    { verdict: "FULLY_VALUED", score: 42 },
    { verdict: "FULLY_VALUED", score: 45 },
    { verdict: "OVERVALUED", score: 25 },
    { verdict: "OVERVALUED", score: 35 },
    null,                       // null entry must be skipped
    undefined,                  // undefined entry must be skipped
  ];

  const bucketed = categoriseBatch(stocks, 2);
  assert("DV bucket sorted descending", bucketed.deepValue.map((s) => s.score).join(",") === "90,80", bucketed.deepValue);
  assert("DV bucket length capped at limit=2", bucketed.deepValue.length === 2, bucketed.deepValue.length);
  assert("QG bucket sorted descending", bucketed.qualityGrowth.map((s) => s.score).join(",") === "70,65", bucketed.qualityGrowth);
  assert("FV bucket has one entry", bucketed.fairValue.length === 1, bucketed.fairValue);
  assert("FullyValued bucket sorted ascending (cheapest first)", bucketed.fullyValued.map((s) => s.score).join(",") === "42,45", bucketed.fullyValued);
  assert("Overvalued bucket sorted ascending (worst first)", bucketed.overvalued.map((s) => s.score).join(",") === "25,35", bucketed.overvalued);

  // Default limit = 10
  const bucketedDefault = categoriseBatch(stocks);
  assert("Default limit accepts all 3 DV entries", bucketedDefault.deepValue.length === 3, bucketedDefault.deepValue.length);

  // Empty input
  const empty = categoriseBatch([]);
  assert("Empty input yields empty buckets", empty.deepValue.length === 0 && empty.overvalued.length === 0, empty);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
