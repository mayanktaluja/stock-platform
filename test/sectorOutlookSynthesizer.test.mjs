import {
  synthesizeSectorAtHorizon,
  synthesizeAll,
  TESTING_CONSTANTS,
} from "../services/sectorOutlook/outlookSynthesizer.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

// Helper to build a sector aggregate with custom per-window stats
function buildAggregate(sector, perWindow) {
  const defaultSummary = (overrides = {}) => ({
    theme_distribution: { CAPACITY_CAPEX: 0.2, M_AND_A: 0.1, ORDER_WINS: 0.1, REGULATORY_EVENT: 0.1, MARGIN_MOVE: 0.1, EARNINGS_MOVE: 0.2, STRATEGIC_GEOPOLITICAL: 0.1, NEUTRAL: 0.1 },
    signed_index: 0,
    breadth_pct: 0,
    catalyst_proximity_count: 0,
    evidence_top5: [],
    avg_confidence: 0.8,
    n_tickers: 0,
    n_news: 0,
    ...overrides,
  });
  return {
    sector,
    n_tickers_total: 10,
    windows: {
      "30d": defaultSummary(perWindow["30d"] || {}),
      "90d": defaultSummary(perWindow["90d"] || {}),
      "365d": defaultSummary(perWindow["365d"] || {}),
    },
  };
}

// ─── horizon blend math ──────────────────────────────────────────────
console.log("synthesizer: horizon blend math");
{
  // Pure +1 signal at 30d, 0 elsewhere
  const agg = buildAggregate("Pharma", {
    "30d": { signed_index: 1.0, breadth_pct: 0.6, n_news: 10 },
    "90d": { signed_index: 0.5, breadth_pct: 0.6, n_news: 20 },
    "365d": { signed_index: 0.0, breadth_pct: 0.6, n_news: 50 },
  });
  // 3_12m blend: 30d×0.5 + 90d×0.3 + 365d×0.2 = 0.5 + 0.15 + 0 = 0.65
  const short = synthesizeSectorAtHorizon(agg, null, "3_12m");
  assert("3_12m blend ~0.65", Math.abs(short.bottom_up.score - 0.65) < 1e-9, short.bottom_up.score);
  // 12_24m blend: 30d×0.1 + 90d×0.3 + 365d×0.6 = 0.1 + 0.15 + 0 = 0.25
  const long = synthesizeSectorAtHorizon(agg, null, "12_24m");
  assert("12_24m blend ~0.25", Math.abs(long.bottom_up.score - 0.25) < 1e-9, long.bottom_up.score);
}

// ─── outlook label thresholds ────────────────────────────────────────
console.log("synthesizer: outlook label thresholds");
{
  // Pure bottom-up 0.6, uncorroborated top_down → composite = 0.6 (de-biased) → TAILWIND
  const t = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
      "90d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
      "365d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
    }),
    null,
    "3_12m",
  );
  assert("uncorroborated composite 0.6 → TAILWIND", t.outlook_label === "TAILWIND", t);

  // Strong agreement without HIGH trust demotes to normal TAILWIND.
  const s = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: 0.8, breadth_pct: 0.5, n_news: 10 },
      "90d": { signed_index: 0.8, breadth_pct: 0.5, n_news: 10 },
      "365d": { signed_index: 0.8, breadth_pct: 0.5, n_news: 10 },
    }),
    { regime: "BOOM", sectorImpacts: [{ sector: "Pharma", impact: 3, reason: "x" }] },
    "3_12m",
  );
  assert("strong both sides with MED confidence → TAILWIND", s.outlook_label === "TAILWIND", s);

  const shigh = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: 0.8, breadth_pct: 0.9, n_news: 50, n_tickers: 9, avg_confidence: 0.95 },
      "90d": { signed_index: 0.8, breadth_pct: 0.9, n_news: 50, n_tickers: 9, avg_confidence: 0.95 },
      "365d": { signed_index: 0.8, breadth_pct: 0.9, n_news: 50, n_tickers: 9, avg_confidence: 0.95 },
    }),
    {
      regime: "BOOM",
      generatedAt: new Date().toISOString(),
      sectorImpacts: [{ sector: "Pharma", impact: 3, reason: "x" }],
    },
    "3_12m",
    { externalContext: { sector_price: { sectors: { Pharma: { score: 0.8 } } } } },
  );
  assert("strong both sides with HIGH confidence → STRONG_TAILWIND", shigh.outlook_label === "STRONG_TAILWIND", shigh);

  // Negative bottom-up -0.4, uncorroborated → composite = -0.4 (de-biased) → HEADWIND
  const h = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: -0.4, breadth_pct: 0.5, n_news: 10 },
      "90d": { signed_index: -0.4, breadth_pct: 0.5, n_news: 10 },
      "365d": { signed_index: -0.4, breadth_pct: 0.5, n_news: 10 },
    }),
    null,
    "3_12m",
  );
  assert("uncorroborated composite -0.4 → HEADWIND", h.outlook_label === "HEADWIND", h);

  // Strong-negative both sides
  const sh = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: -0.8, breadth_pct: 0.5, n_news: 10 },
      "90d": { signed_index: -0.8, breadth_pct: 0.5, n_news: 10 },
      "365d": { signed_index: -0.8, breadth_pct: 0.5, n_news: 10 },
    }),
    { regime: "CRASH", sectorImpacts: [{ sector: "Pharma", impact: -3, reason: "x" }] },
    "3_12m",
  );
  assert("strong-neg both with MED confidence → HEADWIND", sh.outlook_label === "HEADWIND", sh);

  // Neutral both sides
  const n = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: 0.05, breadth_pct: 0.5, n_news: 10 },
      "90d": { signed_index: 0.05, breadth_pct: 0.5, n_news: 10 },
      "365d": { signed_index: 0.05, breadth_pct: 0.5, n_news: 10 },
    }),
    null,
    "3_12m",
  );
  assert("near-zero → NEUTRAL", n.outlook_label === "NEUTRAL", n);
}

// ─── cross_check classifications ─────────────────────────────────────
console.log("synthesizer: cross_check STRONG / PARTIAL / DIVERGENT / NEUTRAL");
{
  const strongAgg = buildAggregate("IT Services", {
    "30d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 12 },
    "90d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 12 },
    "365d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 12 },
  });
  const strongMacro = { regime: "BOOM", sectorImpacts: [{ sector: "IT Services", impact: 3, reason: "rupee weak helps" }] };
  const s = synthesizeSectorAtHorizon(strongAgg, strongMacro, "3_12m");
  assert("strong agreement → cross_check=STRONG", s.cross_check === "STRONG", s);

  // Same sign but lower magnitude — PARTIAL
  const partialMacro = { regime: "CALM", sectorImpacts: [{ sector: "IT Services", impact: 1, reason: "" }] };
  const partialAgg = buildAggregate("IT Services", {
    "30d": { signed_index: 0.2, breadth_pct: 0.4, n_news: 12 },
    "90d": { signed_index: 0.2, breadth_pct: 0.4, n_news: 12 },
    "365d": { signed_index: 0.2, breadth_pct: 0.4, n_news: 12 },
  });
  const p = synthesizeSectorAtHorizon(partialAgg, partialMacro, "3_12m");
  assert("weak agreement → cross_check=PARTIAL", p.cross_check === "PARTIAL", p);

  // Signs disagree — DIVERGENT
  const divMacro = { regime: "RATE_HIKE", sectorImpacts: [{ sector: "IT Services", impact: -2, reason: "rupee weak" }] };
  const divAgg = buildAggregate("IT Services", {
    "30d": { signed_index: 0.4, breadth_pct: 0.5, n_news: 12 },
    "90d": { signed_index: 0.4, breadth_pct: 0.5, n_news: 12 },
    "365d": { signed_index: 0.4, breadth_pct: 0.5, n_news: 12 },
  });
  const d = synthesizeSectorAtHorizon(divAgg, divMacro, "3_12m");
  assert("opposite signs → cross_check=DIVERGENT", d.cross_check === "DIVERGENT", d);

  // One side zero — NEUTRAL
  const n = synthesizeSectorAtHorizon(partialAgg, null, "3_12m");
  assert("missing macro → cross_check=NEUTRAL", n.cross_check === "NEUTRAL", n);
}

// ─── trust score + confidence classifications ────────────────────────
console.log("synthesizer: trust score + confidence HIGH / MED / LOW");
{
  const freshMacro = {
    regime: "BOOM",
    generatedAt: new Date().toISOString(),
    sectorImpacts: [{ sector: "Pharma", impact: 3, reason: "x" }],
  };
  const confirmingPrice = {
    sector_price: {
      sectors: {
        Pharma: { status: "AVAILABLE", score: 1, return_pct: 12, vs_nifty_pct: 10 },
      },
    },
  };

  const high = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: 0.8, breadth_pct: 0.9, n_news: 50, avg_confidence: 0.95 },
      "90d": { signed_index: 0.8, breadth_pct: 0.9, n_news: 50, avg_confidence: 0.95 },
      "365d": { signed_index: 0.75, breadth_pct: 0.9, n_news: 50, avg_confidence: 0.95 },
    }),
    freshMacro,
    "3_12m",
    { externalContext: confirmingPrice },
  );
  assert("trust >= 75 → HIGH", high.confidence === "HIGH" && high.trust_score >= 75, high);
  assert("trust_factors emitted", Array.isArray(high.trust_factors) && high.trust_factors.length >= 7, high.trust_factors);

  const lowDiv = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: 0.4, breadth_pct: 0.2, n_news: 2, avg_confidence: 0.3 },
      "90d": { signed_index: 0.4, breadth_pct: 0.2, n_news: 2, avg_confidence: 0.3 },
      "365d": { signed_index: -0.4, breadth_pct: 0.2, n_news: 2, avg_confidence: 0.3 },
    }),
    { ...freshMacro, sectorImpacts: [{ sector: "Pharma", impact: -3, reason: "x" }] },
    "3_12m",
    { externalContext: { sector_price: { sectors: { Pharma: { score: -1 } } } } },
  );
  assert("thin divergent evidence → LOW", lowDiv.confidence === "LOW" && lowDiv.trust_score < 45, lowDiv);

  const med = synthesizeSectorAtHorizon(
    buildAggregate("Pharma", {
      "30d": { signed_index: 0.35, breadth_pct: 0.45, n_news: 25, avg_confidence: 0.75 },
      "90d": { signed_index: 0.3, breadth_pct: 0.45, n_news: 25, avg_confidence: 0.75 },
      "365d": { signed_index: 0.25, breadth_pct: 0.45, n_news: 25, avg_confidence: 0.75 },
    }),
    freshMacro,
    "3_12m",
  );
  assert("middle trust band → MED", med.confidence === "MED" && med.trust_score >= 45 && med.trust_score < 75, med);
  const priceFactor = med.trust_factors.find((f) => f.key === "price_confirmation");
  assert("missing price context is UNCORROBORATED, not failure", priceFactor.status === "UNCORROBORATED", priceFactor);
}

// ─── synthesizeAll: output shape ─────────────────────────────────────
console.log("synthesizer: synthesizeAll output shape");
{
  const aggregatorResult = {
    sectors: {
      Pharma: buildAggregate("Pharma", {
        "30d": { signed_index: 0.5, breadth_pct: 0.5, n_news: 10 },
        "90d": { signed_index: 0.5, breadth_pct: 0.5, n_news: 10 },
        "365d": { signed_index: 0.5, breadth_pct: 0.5, n_news: 10 },
      }),
      "IT Services": buildAggregate("IT Services", {
        "30d": { signed_index: -0.4, breadth_pct: 0.5, n_news: 10 },
        "90d": { signed_index: -0.4, breadth_pct: 0.5, n_news: 10 },
        "365d": { signed_index: -0.4, breadth_pct: 0.5, n_news: 10 },
      }),
    },
    orphaned_tickers: 12,
    total_entries: 100,
  };
  const macroRegime = {
    regime: "RATE_HIKE",
    severity: 3,
    confidence: 0.7,
    generatedAt: "2026-05-19T18:30:29.237Z",
    sectorImpacts: [
      { sector: "IT Services", impact: -2, reason: "rupee weakness" },
    ],
  };

  const out = synthesizeAll(aggregatorResult, macroRegime);
  assert("schema_version stamped", out.schema_version === "sector-outlook-v1");
  assert("generated_at present", typeof out.generated_at === "string");
  assert("regime_at_generation present", out.regime_at_generation?.regime === "RATE_HIKE");
  assert("audit.orphaned_tickers passed through", out.audit.orphaned_tickers === 12);
  assert("audit.sector_count = 2", out.audit.sector_count === 2);
  assert("gate_met = false (v1)", out.gate_met === false);
  assert("caveats array present", Array.isArray(out.caveats) && out.caveats.length > 0);

  assert("2 sectors in array", out.sectors.length === 2);
  for (const s of out.sectors) {
    assert(`${s.sector}: has horizons.3_12m`, s.horizons["3_12m"] != null);
    assert(`${s.sector}: has horizons.12_24m`, s.horizons["12_24m"] != null);
    assert(`${s.sector}: outlook_label set`, typeof s.horizons["3_12m"].outlook_label === "string");
    assert(`${s.sector}: confidence set`, ["HIGH", "MED", "LOW"].includes(s.horizons["3_12m"].confidence));
    assert(`${s.sector}: trust_score set`, typeof s.horizons["3_12m"].trust_score === "number");
    assert(`${s.sector}: trust_factors set`, Array.isArray(s.horizons["3_12m"].trust_factors));
  }

  // Sort order: GROWTH outlook first (strongest tailwind on top), NOT trust.
  for (const s of out.sectors) {
    assert(`${s.sector}: growth_rank_score finite`, Number.isFinite(s.horizons["3_12m"].growth_rank_score));
    assert(`${s.sector}: growth_rank_score === composite`, s.horizons["3_12m"].growth_rank_score === s.horizons["3_12m"].composite);
    assert(`${s.sector}: growth_rank_score on 12_24m too`, Number.isFinite(s.horizons["12_24m"].growth_rank_score));
  }
  const grows = out.sectors.map((s) => s.horizons["3_12m"].growth_rank_score);
  assert("sectors sorted by growth_rank_score descending", grows.every((v, i, arr) => i === 0 || arr[i - 1] >= v - 1e-9), grows);
}

// ─── de-bias + growth ranking regression guard (the user's complaint) ───────
console.log("synthesizer: growth ranking beats trust ordering");
{
  // Uncorroborated top-down (regime CALM, no matching sectorImpacts) must NOT
  // halve the bottom-up signal — composite = bottom_up, not bottom_up/2.
  const uncorr = synthesizeSectorAtHorizon(
    buildAggregate("Automobiles", {
      "30d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
      "90d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
      "365d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
    }),
    { regime: "CALM", sectorImpacts: [] },
    "3_12m",
  );
  assert("uncorroborated composite = bottom_up (not halved)", Math.abs(uncorr.composite - 0.6) < 1e-9, uncorr.composite);
  assert("uncorroborated top_down UNCORROBORATED", uncorr.top_down.status === "UNCORROBORATED", uncorr.top_down);

  // Corroborated sector keeps the blended composite.
  const corr = synthesizeSectorAtHorizon(
    buildAggregate("Software", {
      "30d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
      "90d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
      "365d": { signed_index: 0.6, breadth_pct: 0.6, n_news: 10 },
    }),
    { regime: "BOOM", sectorImpacts: [{ sector: "Software", impact: 3, reason: "x" }] },
    "3_12m",
  );
  assert("corroborated composite stays blended ~0.8", Math.abs(corr.composite - 0.8) < 1e-9, corr.composite);

  // A HEADWIND sector with genuinely HIGHER trust (more evidence/breadth) must
  // still rank BELOW a TAILWIND sector. This is the exact bug the user hit:
  // trust-sorting floated a headwind to the top.
  const out = synthesizeAll(
    {
      sectors: {
        Tailwind: buildAggregate("Tailwind", {
          "30d": { signed_index: 0.5, breadth_pct: 0.3, n_news: 8 },
          "90d": { signed_index: 0.5, breadth_pct: 0.3, n_news: 8 },
          "365d": { signed_index: 0.5, breadth_pct: 0.3, n_news: 8 },
        }),
        Headwind: buildAggregate("Headwind", {
          "30d": { signed_index: -0.5, breadth_pct: 0.9, n_news: 50, n_tickers: 9, avg_confidence: 0.95 },
          "90d": { signed_index: -0.5, breadth_pct: 0.9, n_news: 50, n_tickers: 9, avg_confidence: 0.95 },
          "365d": { signed_index: -0.5, breadth_pct: 0.9, n_news: 50, n_tickers: 9, avg_confidence: 0.95 },
        }),
      },
      orphaned_tickers: 0,
      total_entries: 58,
    },
    { regime: "CALM", sectorImpacts: [] },
  );
  const th = out.sectors.find((s) => s.sector === "Tailwind").horizons["3_12m"];
  const hh = out.sectors.find((s) => s.sector === "Headwind").horizons["3_12m"];
  assert("headwind earned higher trust than tailwind", hh.trust_score > th.trust_score, { tail: th.trust_score, head: hh.trust_score });
  assert("tailwind still ranks first despite lower trust", out.sectors[0].sector === "Tailwind", out.sectors.map((s) => s.sector));
  assert("headwind ranks last", out.sectors[out.sectors.length - 1].sector === "Headwind", out.sectors.map((s) => s.sector));
}

console.log("synthesizer: fills India Market sector universe");
{
  const aggregatorResult = {
    sectors: {
      Banks: buildAggregate("Banks", {
        "30d": { signed_index: 0.2, breadth_pct: 0.4, n_news: 8 },
        "90d": { signed_index: 0.2, breadth_pct: 0.4, n_news: 8 },
        "365d": { signed_index: 0.2, breadth_pct: 0.4, n_news: 8 },
      }),
    },
    orphaned_tickers: 0,
    total_entries: 8,
  };
  const out = synthesizeAll(
    aggregatorResult,
    { regime: "RATE_CUT", sectorImpacts: [{ sector: "Banking", impact: 2, reason: "lower rates aid credit growth" }] },
    { sectorUniverse: ["Banks", "Materials"] },
  );
  const names = out.sectors.map((s) => s.sector).sort();
  assert("raw SWS sector universe is present", JSON.stringify(names) === '["Banks","Materials"]', names);
  assert("audit.sector_count includes filled sector", out.audit.sector_count === 2, out.audit);
  assert("audit.observed_sector_count tracks evidence sectors", out.audit.observed_sector_count === 1, out.audit);
  const banks = out.sectors.find((s) => s.sector === "Banks");
  const materials = out.sectors.find((s) => s.sector === "Materials");
  assert("Banks top-down maps to Banking macro bucket", banks.horizons["3_12m"].top_down.score > 0, banks.horizons["3_12m"]);
  assert("missing Materials row gets neutral bottom-up", materials.horizons["3_12m"].bottom_up.n_news === 0, materials.horizons["3_12m"]);
}

// ─── conservative-language audit: caveats avoid "predict" ────────────
console.log("synthesizer: caveats use SEBI-conservative language");
{
  const out = synthesizeAll({ sectors: {}, orphaned_tickers: 0, total_entries: 0 }, null);
  const joined = out.caveats.join(" ").toLowerCase();
  assert("no 'guarantee'", !joined.includes("guarantee"));
  assert("no 'will outperform'", !joined.includes("will outperform"));
  // Note: 'prediction' (noun) appears in "do not interpret as a prediction" — that's the disclaimer text itself
  assert("'indicative' OR similar present",
    joined.includes("indicative") || joined.includes("observed"));
}

// ─── unknown horizon throws ──────────────────────────────────────────
console.log("synthesizer: unknown horizon throws");
{
  let threw = false;
  try {
    synthesizeSectorAtHorizon(buildAggregate("X", {}), null, "999d");
  } catch { threw = true; }
  assert("unknown horizon throws", threw);
}

// ─── empty sector aggregate ──────────────────────────────────────────
console.log("synthesizer: handles missing aggregate gracefully");
{
  const r = synthesizeSectorAtHorizon(null, null, "3_12m");
  assert("null aggregate → null result", r === null);
}

// ─── TESTING_CONSTANTS shape ─────────────────────────────────────────
console.log("synthesizer: TESTING_CONSTANTS exposed");
{
  assert("HORIZONS has 2 entries", TESTING_CONSTANTS.HORIZONS.length === 2);
  assert("HORIZON_BLENDS has 3_12m + 12_24m",
    "3_12m" in TESTING_CONSTANTS.HORIZON_BLENDS && "12_24m" in TESTING_CONSTANTS.HORIZON_BLENDS);
  // Blends sum to 1 within rounding
  for (const h of TESTING_CONSTANTS.HORIZONS) {
    const sum = Object.values(TESTING_CONSTANTS.HORIZON_BLENDS[h]).reduce((a, b) => a + b, 0);
    assert(`${h} weights sum to ~1`, Math.abs(sum - 1) < 1e-9, sum);
  }
}

if (_failed > 0) {
  console.log(`\nsectorOutlookSynthesizer: ${_failed} failures`);
  process.exit(1);
}
console.log("\nsectorOutlookSynthesizer: all tests passed");
