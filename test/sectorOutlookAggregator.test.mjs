import {
  aggregateAllSectors,
  routeNewsToSectors,
  TESTING_CONSTANTS,
} from "../services/sectorOutlook/sectorNewsAggregator.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

const NOW_MS = Date.parse("2026-05-20T00:00:00Z");

// ─── routeNewsToSectors: single-sector tickers ──────────────────────
console.log("aggregator: routeNewsToSectors single-sector");
{
  // Healthcare → Pharma via normalizeSector
  const out = routeNewsToSectors("CIPLA", "Pharmaceuticals", { title: "Test", body: "" });
  assert("single sector → full attribution", out.length === 1 && out[0].weight === 1.0, out);
  assert("  resolves to canonical", out[0].sector === "Pharma", out);

  // SWS "Materials" → null in normalizeSector → unclassifiable
  const out2 = routeNewsToSectors("IMFA", "Materials", { title: "Test", body: "" });
  assert("Materials → unclassifiable (empty)", out2.length === 0, out2);
}

// ─── routeNewsToSectors: RELIANCE body routing (THE KEY TEST) ────────
console.log("aggregator: RELIANCE body routing — petrochemical → 100% Oil&Gas");
{
  const petrochemical = {
    title: "Reliance: Petrochemical capacity expansion at Jamnagar refinery",
    body: "The petrochemical division reported strong margins",
  };
  const out = routeNewsToSectors("RELIANCE", "Energy", petrochemical);
  assert("petrochemical news routes to 1 sector", out.length === 1, out);
  assert("  routes to Oil & Gas", out[0].sector === "Oil & Gas", out);
  assert("  weight = 1.0 (NOT 1/3)", out[0].weight === 1.0, out);
}

console.log("aggregator: RELIANCE Jio/telecom → 100% Telecom");
{
  const telecom = {
    title: "Reliance Jio: 5G rollout completes 99% pin codes",
    body: "Jio reported strong telecom subscriber additions and broadband growth",
  };
  const out = routeNewsToSectors("RELIANCE", "Energy", telecom);
  assert("Jio news routes to 1 sector", out.length === 1, out);
  assert("  routes to Telecom", out[0].sector === "Telecom", out);
  assert("  weight = 1.0", out[0].weight === 1.0, out);
}

console.log("aggregator: RELIANCE retail/JioMart → 100% Retail");
{
  const retail = {
    title: "Reliance Retail expands JioMart presence",
    body: "Retail revenue growth driven by JioMart e-commerce",
  };
  const out = routeNewsToSectors("RELIANCE", "Energy", retail);
  assert("retail news routes to 1 sector", out.length === 1, out);
  assert("  routes to Retail", out[0].sector === "Retail", out);
}

console.log("aggregator: RELIANCE non-routable → 1/N fallback");
{
  const generic = {
    title: "Reliance Industries: Annual general meeting scheduled for next month",
    body: "The company filed standard exchange disclosure with no specific sector context",
  };
  const out = routeNewsToSectors("RELIANCE", "Energy", generic);
  assert("non-routable → 3 sectors", out.length === 3, out);
  const totalWeight = out.reduce((s, r) => s + r.weight, 0);
  assert("  weights sum to ~1.0", Math.abs(totalWeight - 1.0) < 1e-9, totalWeight);
  for (const r of out) {
    assert(`  ${r.sector} weight = 1/3`, Math.abs(r.weight - 1 / 3) < 1e-9, r);
  }
}

console.log("aggregator: RELIANCE multi-match → equal split among matched");
{
  // Body mentions BOTH telecom AND retail → split between them only,
  // not Oil&Gas
  const multi = {
    title: "Reliance launches JioMart-integrated 5G telecom offering",
    body: "The new platform combines Jio broadband with JioMart e-commerce retail",
  };
  const out = routeNewsToSectors("RELIANCE", "Energy", multi);
  assert("multi-match → 2 sectors", out.length === 2, out);
  const sectors = out.map((r) => r.sector).sort();
  assert("  matches Retail + Telecom", JSON.stringify(sectors) === '["Retail","Telecom"]', sectors);
  const totalWeight = out.reduce((s, r) => s + r.weight, 0);
  assert("  weights sum to ~1.0", Math.abs(totalWeight - 1.0) < 1e-9, totalWeight);
}

// ─── routeNewsToSectors: L&T body routing ───────────────────────────
console.log("aggregator: L&T construction → Infrastructure, LTIMindtree → IT Services");
{
  const construction = {
    title: "L&T wins large EPC contract for metro construction",
    body: "Infrastructure division reported strong order book",
  };
  const out1 = routeNewsToSectors("LT", "Capital Goods", construction);
  assert("construction → Infrastructure", out1.length === 1 && out1[0].sector === "Infrastructure", out1);

  const itServices = {
    title: "LTIMindtree wins technology services contract from US client",
    body: "LTI software services revenue grew",
  };
  const out2 = routeNewsToSectors("LT", "Capital Goods", itServices);
  assert("LTIMindtree → IT Services", out2.length === 1 && out2[0].sector === "IT Services", out2);
}

// ─── aggregateAllSectors: empty / null inputs ────────────────────────
console.log("aggregator: empty + null inputs");
{
  const out1 = aggregateAllSectors([]);
  assert("empty array → empty sectors", Object.keys(out1.sectors).length === 0);
  const out2 = aggregateAllSectors(null);
  assert("null → empty sectors", Object.keys(out2.sectors).length === 0);
  const out3 = aggregateAllSectors(undefined);
  assert("undefined → empty sectors", Object.keys(out3.sectors).length === 0);
}

// ─── aggregateAllSectors: orphaned tickers counter ───────────────────
console.log("aggregator: orphaned ticker telemetry");
{
  const entries = [
    { ticker: "IMFA", sourceSector: "Materials", mcap: 1e10, date: "2026-05-15",
      title: "Q4 results", theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short" },
    { ticker: "CIPLA", sourceSector: "Pharmaceuticals", mcap: 1e12, date: "2026-05-15",
      title: "Capacity expansion", theme: "CAPACITY_CAPEX", sign: 1, intensity: 2, confidence: 0.8, time_hint: "long" },
  ];
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS });
  // IMFA (Materials → null) is orphaned, CIPLA (Pharmaceuticals → Pharma) is not
  assert("1 orphaned ticker", out.orphaned_tickers === 1, out.orphaned_tickers);
  assert("Pharma sector present", out.sectors.Pharma !== undefined);
  assert("CIPLA contributed to Pharma", out.sectors.Pharma.n_tickers_total === 1);
}

// ─── aggregateAllSectors: window enforcement ─────────────────────────
console.log("aggregator: rolling windows isolate news correctly");
{
  // News at different ages → land in different windows
  const entries = [
    // 5d ago — in all 3 windows
    { ticker: "CIPLA", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "Recent", theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short" },
    // 60d ago — in 90d + 365d only
    { ticker: "SUNPHARMA", sourceSector: "Pharma", mcap: 2e12, date: "2026-03-21",
      title: "Mid-age", theme: "REGULATORY_EVENT", sign: 1, intensity: 2, confidence: 0.8, time_hint: "medium" },
    // 200d ago — in 365d only
    { ticker: "DRREDDY", sourceSector: "Pharma", mcap: 1e12, date: "2025-11-01",
      title: "Old", theme: "CAPACITY_CAPEX", sign: 1, intensity: 2, confidence: 0.8, time_hint: "long" },
    // 500d ago — outside all windows
    { ticker: "AUROPHARMA", sourceSector: "Pharma", mcap: 5e11, date: "2025-01-05",
      title: "Ancient", theme: "M_AND_A", sign: 1, intensity: 2, confidence: 0.8, time_hint: "medium" },
  ];
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS });
  const pharma = out.sectors.Pharma;
  assert("Pharma sector exists", pharma !== undefined);
  assert("30d window has 1 news", pharma.windows["30d"].n_news === 1, pharma.windows["30d"]);
  assert("90d window has 2 news", pharma.windows["90d"].n_news === 2, pharma.windows["90d"]);
  assert("365d window has 3 news", pharma.windows["365d"].n_news === 3, pharma.windows["365d"]);
}

// ─── aggregateAllSectors: signed_index math ─────────────────────────
console.log("aggregator: signed_index respects sign + intensity + mcap");
{
  // Two tickers, equal mcap, opposite signs → signed_index near 0
  const entries = [
    { ticker: "POS", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "Beat", theme: "EARNINGS_MOVE", sign: 1, intensity: 3, confidence: 0.8, time_hint: "short" },
    { ticker: "NEG", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "Miss", theme: "EARNINGS_MOVE", sign: -1, intensity: 3, confidence: 0.8, time_hint: "short" },
  ];
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS });
  assert("equal opposing → signed_index ≈ 0",
    Math.abs(out.sectors.Pharma.windows["30d"].signed_index) < 0.01,
    out.sectors.Pharma.windows["30d"].signed_index);
}

console.log("aggregator: signed_index bounded in [-1, +1]");
{
  // 10 max-positive entries → signed_index should be capped at +1
  const entries = Array.from({ length: 10 }, (_, i) => ({
    ticker: `T${i}`,
    sourceSector: "Pharma",
    mcap: 1e12,
    date: "2026-05-15",
    title: "x",
    theme: "EARNINGS_MOVE",
    sign: 1,
    intensity: 3,
    confidence: 0.8,
    time_hint: "short",
  }));
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS });
  const idx = out.sectors.Pharma.windows["30d"].signed_index;
  assert("all positive → signed_index ≤ 1", idx <= 1, idx);
  assert("all positive → signed_index > 0.5", idx > 0.5, idx);
}

// ─── single-issuer breadth cap ───────────────────────────────────────
console.log("aggregator: single-issuer breadth cap (15%) prevents dominance");
{
  // 7 tickers in sector, 1 ticker has 50 news items, others have 1 each
  // Without cap: breadth would be driven by the dominant ticker
  // With cap: breadth reflects unique-ticker count, capped
  const entries = [];
  // Dominant ticker — 50 news items
  for (let i = 0; i < 50; i += 1) {
    entries.push({
      ticker: "DOMINANT", sourceSector: "Pharma", mcap: 1e12,
      date: "2026-05-15", title: `news ${i}`,
      theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short",
    });
  }
  // 6 other tickers — 1 news each
  for (let i = 0; i < 6; i += 1) {
    entries.push({
      ticker: `OTHER${i}`, sourceSector: "Pharma", mcap: 1e11,
      date: "2026-05-15", title: "x",
      theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short",
    });
  }
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS });
  const summary = out.sectors.Pharma.windows["30d"];
  assert("n_tickers = 7", summary.n_tickers === 7);
  // With 7 tickers and ALL having signal, breadth should be 1.0 (capped)
  assert("breadth_pct = 1.0 when all signaled", Math.abs(summary.breadth_pct - 1.0) < 0.01, summary.breadth_pct);
  // n_news = 56 (50 + 6)
  assert("n_news = 56", summary.n_news === 56);
}

// ─── theme_distribution sums to 1 ────────────────────────────────────
console.log("aggregator: theme_distribution is a proper distribution");
{
  const entries = [
    { ticker: "A", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "x", theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short" },
    { ticker: "B", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "x", theme: "CAPACITY_CAPEX", sign: 1, intensity: 2, confidence: 0.8, time_hint: "long" },
    { ticker: "C", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "x", theme: "M_AND_A", sign: 1, intensity: 2, confidence: 0.8, time_hint: "medium" },
  ];
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS });
  const dist = out.sectors.Pharma.windows["30d"].theme_distribution;
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  assert("theme_distribution sums to ~1", Math.abs(total - 1) < 0.01, total);
  assert("EARNINGS_MOVE has share", dist.EARNINGS_MOVE > 0);
  assert("CAPACITY_CAPEX has share", dist.CAPACITY_CAPEX > 0);
  assert("M_AND_A has share", dist.M_AND_A > 0);
  assert("ORDER_WINS has 0 share", dist.ORDER_WINS === 0);
}

// ─── catalyst_proximity_count ────────────────────────────────────────
console.log("aggregator: catalyst_proximity_count counts short-hint recent items");
{
  const entries = [
    // Short hint + 5d ago → counts
    { ticker: "A", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "x", theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short" },
    // Short hint + 60d ago → does NOT count (>30d)
    { ticker: "B", sourceSector: "Pharma", mcap: 1e12, date: "2026-03-21",
      title: "x", theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short" },
    // Long hint + 5d ago → does NOT count (not short)
    { ticker: "C", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "x", theme: "CAPACITY_CAPEX", sign: 1, intensity: 2, confidence: 0.8, time_hint: "long" },
  ];
  // Without `nowMs` override the catalyst window uses real Date.now() —
  // but we want a deterministic test. The aggregator's catalyst count
  // uses Date.now() directly, so we need to align the test data.
  // Adjust: use entries dated relative to NOW.
  const today = new Date();
  const todayMs = today.getTime();
  const recentDate = new Date(todayMs - 5 * 86400000).toISOString();
  const oldDate = new Date(todayMs - 60 * 86400000).toISOString();
  const aligned = [
    { ticker: "A", sourceSector: "Pharma", mcap: 1e12, date: recentDate,
      title: "x", theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short" },
    { ticker: "B", sourceSector: "Pharma", mcap: 1e12, date: oldDate,
      title: "x", theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.8, time_hint: "short" },
    { ticker: "C", sourceSector: "Pharma", mcap: 1e12, date: recentDate,
      title: "x", theme: "CAPACITY_CAPEX", sign: 1, intensity: 2, confidence: 0.8, time_hint: "long" },
  ];
  const out = aggregateAllSectors(aligned, { nowMs: todayMs });
  assert("catalyst_proximity_count = 1 (only short+recent)",
    out.sectors.Pharma.windows["30d"].catalyst_proximity_count === 1,
    out.sectors.Pharma.windows["30d"].catalyst_proximity_count);
}

// ─── evidence_top5 ────────────────────────────────────────────────────
console.log("aggregator: evidence_top5 picks highest signed magnitude");
{
  const entries = [
    { ticker: "A", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "Low intensity beat", theme: "EARNINGS_MOVE", sign: 1, intensity: 1, confidence: 0.8, time_hint: "short" },
    { ticker: "B", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "Blockbuster M&A", theme: "M_AND_A", sign: 1, intensity: 3, confidence: 0.8, time_hint: "medium" },
    { ticker: "C", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "Neutral filing", theme: "NEUTRAL", sign: 0, intensity: 1, confidence: 0.8, time_hint: "medium" },
  ];
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS });
  const evidence = out.sectors.Pharma.windows["30d"].evidence_top5;
  assert("evidence has 2 items (NEUTRAL with sign=0 dropped)",
    evidence.length === 2, evidence);
  assert("top evidence is blockbuster", evidence[0].title === "Blockbuster M&A", evidence);
}

// ─── conglomerate fractional weight respected in aggregation ─────────
console.log("aggregator: RELIANCE generic news 1/3 weighted across 3 sectors");
{
  const entries = [
    {
      ticker: "RELIANCE", sourceSector: "Energy", mcap: 1.6e13,
      date: "2026-05-15", title: "Reliance AGM scheduled",
      body: "Annual general meeting", theme: "NEUTRAL", sign: 1, intensity: 1,
      confidence: 0.8, time_hint: "medium",
    },
  ];
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS });
  assert("Oil & Gas sector created", out.sectors["Oil & Gas"] !== undefined);
  assert("Telecom sector created", out.sectors["Telecom"] !== undefined);
  assert("Retail sector created", out.sectors["Retail"] !== undefined);
  // Each sector has n_news = 1 because the conglomerate entry is split
  // into 3 partial-weight entries — but each one still counts as a news
  // item in its sector.
  for (const s of ["Oil & Gas", "Telecom", "Retail"]) {
    const sum = out.sectors[s].windows["365d"];
    assert(`${s}: n_news = 1`, sum.n_news === 1, sum);
    assert(`${s}: n_tickers = 1 (RELIANCE)`, sum.n_tickers === 1, sum);
  }
}

// ─── confidence floor ───────────────────────────────────────────────
console.log("aggregator: confidenceFloor drops low-confidence entries");
{
  const entries = [
    { ticker: "A", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "high-conf", theme: "EARNINGS_MOVE", sign: 1, intensity: 2, confidence: 0.9, time_hint: "short" },
    { ticker: "B", sourceSector: "Pharma", mcap: 1e12, date: "2026-05-15",
      title: "low-conf", theme: "M_AND_A", sign: 1, intensity: 2, confidence: 0.3, time_hint: "medium" },
  ];
  const out = aggregateAllSectors(entries, { nowMs: NOW_MS, confidenceFloor: 0.55 });
  assert("only high-conf reaches window",
    out.sectors.Pharma.windows["30d"].n_news === 1,
    out.sectors.Pharma.windows["30d"].n_news);
}

// ─── TESTING_CONSTANTS exposes config for downstream invariants ─────
console.log("aggregator: TESTING_CONSTANTS exposed");
{
  assert("SINGLE_ISSUER_BREADTH_CAP = 0.15", TESTING_CONSTANTS.SINGLE_ISSUER_BREADTH_CAP === 0.15);
  assert("WINDOW_DAYS has 3 entries", Object.keys(TESTING_CONSTANTS.WINDOW_DAYS).length === 3);
  assert("EVIDENCE_TOP_N = 5", TESTING_CONSTANTS.EVIDENCE_TOP_N === 5);
  assert("CONGLOMERATE_BODY_ROUTES has RELIANCE", "RELIANCE" in TESTING_CONSTANTS.CONGLOMERATE_BODY_ROUTES);
}

if (_failed > 0) {
  console.log(`\nsectorOutlookAggregator: ${_failed} failures`);
  process.exit(1);
}
console.log("\nsectorOutlookAggregator: all tests passed");
