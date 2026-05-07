// Unit tests for services/swsSectorFit.js — the "perfect fit" engine
// behind Tier B sector-aware top-ups.
//
// Run with: node test/swsSectorFit.test.mjs

import {
  buildSectorContext,
  scoreSectorFit,
  selectSectorGapPicks,
  detectTailwindSectors,
  buildPerfectFitReason,
  PERFECT_FIT_FLOOR,
  OVERWEIGHT_PCT_THRESHOLD,
  UNDERWEIGHT_PCT_THRESHOLD,
} from "../services/swsSectorFit.js";

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

// ──────────────────── buildSectorContext: banding ────────────────────

console.log("\nbuildSectorContext: sector banding\n");

{
  const overlay = [
    { sector: "Banking", pct: 38 },
    { sector: "IT Services", pct: 22 },
    { sector: "FMCG", pct: 12 },
    { sector: "Pharma", pct: 4 },
    { sector: "Cement", pct: 1.5 },
  ];
  const ctx = buildSectorContext(overlay, null, null);
  assert(
    "Banking 38% → overweight",
    ctx.overweight.has("Banking"),
    [...ctx.overweight],
  );
  assert(
    "IT Services 22% → overweight (≥20)",
    ctx.overweight.has("IT Services"),
    [...ctx.overweight],
  );
  assert(
    "FMCG 12% → healthy",
    ctx.healthy.has("FMCG") && !ctx.overweight.has("FMCG") && !ctx.underweight.has("FMCG"),
    { healthy: [...ctx.healthy], overweight: [...ctx.overweight], underweight: [...ctx.underweight] },
  );
  assert(
    "Pharma 4% → underweight (<6 and >0)",
    ctx.underweight.has("Pharma"),
    [...ctx.underweight],
  );
  assert(
    "Cement 1.5% → underweight",
    ctx.underweight.has("Cement"),
    [...ctx.underweight],
  );
  // missing is implicit (anything not in byCanonical)
  assert(
    "Defence not in byCanonical → missing",
    !ctx.byCanonical.has("Defence"),
    [...ctx.byCanonical.keys()],
  );
}

{
  // Sector-name canonicalisation: SWS sometimes returns "Healthcare" /
  // "Materials" — these must canonicalise to "Pharma" / "Metals".
  const overlay = [{ sector: "Healthcare", pct: 25 }];
  const ctx = buildSectorContext(overlay, null, null);
  assert(
    "Healthcare 25% → canonicalises to Pharma → overweight",
    ctx.overweight.has("Pharma") && ctx.byCanonical.get("Pharma") === 25,
    { overweight: [...ctx.overweight], byCanonical: [...ctx.byCanonical] },
  );
}

// ──────────────────── detectTailwindSectors: 3 layers ────────────────────

console.log("\ndetectTailwindSectors: three-layer evidence\n");

{
  // Empty inputs → only Layer 1 (structural list) fires
  const tw = detectTailwindSectors({ picks: null, regime: null });
  assert(
    "Layer 1 only → 6 structural sectors at score 6",
    tw.size === 6 &&
      tw.get("Defence")?.score === 6 &&
      tw.get("Capital Goods")?.score === 6 &&
      tw.get("Power")?.score === 6 &&
      tw.get("Infrastructure")?.score === 6 &&
      tw.get("Pharma")?.score === 6 &&
      tw.get("Chemicals")?.score === 6,
    [...tw.entries()].map(([k, v]) => [k, v.score]),
  );
  assert(
    "Layer 1 evidence shape includes layer + reason",
    tw.get("Defence")?.evidence?.[0]?.layer === "structural" &&
      typeof tw.get("Defence")?.evidence?.[0]?.reason === "string",
    tw.get("Defence")?.evidence,
  );
}

{
  // Layer 2: 5 Defence picks averaging +35% upside, v3 60+ → +6 on Defence
  const picks = {
    sections: {
      top_ranked_30_v3: [
        { ticker: "HAL",      sector: "Aerospace & Defense", v3_score_100: 70, upside_pct: 30 },
        { ticker: "BEL",      sector: "Aerospace & Defense", v3_score_100: 68, upside_pct: 35 },
        { ticker: "BDL",      sector: "Aerospace & Defense", v3_score_100: 65, upside_pct: 40 },
        { ticker: "MAZDOCK",  sector: "Defence",             v3_score_100: 62, upside_pct: 32 },
        { ticker: "DATAPATTNS", sector: "Defence",           v3_score_100: 60, upside_pct: 38 },
      ],
    },
  };
  const tw = detectTailwindSectors({ picks, regime: null });
  // Defence has Layer 1 (+6) AND Layer 2 (+6) → total 12
  assert(
    "Layer 1 + Layer 2 (5 Defence picks @ +35% avg) → score 12",
    tw.get("Defence")?.score === 12,
    tw.get("Defence"),
  );
  assert(
    "Defence evidence includes both structural + fv_upside",
    tw.get("Defence")?.evidence?.length === 2 &&
      tw.get("Defence")?.evidence?.some((e) => e.layer === "structural") &&
      tw.get("Defence")?.evidence?.some((e) => e.layer === "fv_upside"),
    tw.get("Defence")?.evidence,
  );
}

{
  // Layer 3: regime-driven. WAR_ESCALATION boosts Defence (+4), Oil & Gas (+2).
  const regime = {
    regime: "WAR_ESCALATION",
    severity: 4,
    confidence: 0.9,
    sectorImpacts: [
      { sector: "Defence", impact: 4, reason: "War events boost defence orders" },
      { sector: "Oil & Gas", impact: 2, reason: "Conflict raises crude price expectations" },
      { sector: "Aviation", impact: -3, reason: "Higher fuel costs squeeze margins" },
    ],
  };
  const picks = {
    sections: {
      top_ranked_30_v3: [
        { ticker: "HAL",     sector: "Defence", v3_score_100: 70, upside_pct: 30 },
        { ticker: "BEL",     sector: "Defence", v3_score_100: 68, upside_pct: 35 },
        { ticker: "BDL",     sector: "Defence", v3_score_100: 65, upside_pct: 40 },
      ],
    },
  };
  const tw = detectTailwindSectors({ picks, regime });
  assert(
    "All three layers fire on Defence → score 18",
    tw.get("Defence")?.score === 18,
    tw.get("Defence"),
  );
  assert(
    "Oil & Gas: only Layer 3 → score 6",
    tw.get("Oil & Gas")?.score === 6 &&
      tw.get("Oil & Gas")?.evidence?.[0]?.layer === "regime",
    tw.get("Oil & Gas"),
  );
  assert(
    "Aviation negative impact → no tailwind entry",
    !tw.has("Aviation"),
    [...tw.keys()],
  );
}

// ──────────────────── scoreSectorFit: gap × tailwind matrix ────────────────────

console.log("\nscoreSectorFit: gap × tailwind matrix\n");

{
  // Build a portfolio: heavy Banking (38%), some IT (22%), no Defence,
  // tiny Pharma (4%). Use regime to pump Defence to max tailwind (18).
  const overlay = [
    { sector: "Banking", pct: 38 },
    { sector: "IT Services", pct: 22 },
    { sector: "Pharma", pct: 4 },
    { sector: "FMCG", pct: 12 },
  ];
  const picks = {
    sections: {
      top_ranked_30_v3: [
        { ticker: "HAL",     sector: "Defence", v3_score_100: 70, upside_pct: 35 },
        { ticker: "BEL",     sector: "Defence", v3_score_100: 68, upside_pct: 35 },
        { ticker: "BDL",     sector: "Defence", v3_score_100: 65, upside_pct: 35 },
      ],
    },
  };
  const regime = {
    regime: "WAR_ESCALATION",
    sectorImpacts: [{ sector: "Defence", impact: 4, reason: "War boost" }],
  };
  const ctx = buildSectorContext(overlay, picks, regime);

  const defence = scoreSectorFit("Defence", ctx);
  // missing + tailwind=18 → 10 + 18*1.0 = 28
  assert(
    "Defence missing + 3-layer tailwind → fit score 28, gapType=missing",
    defence.score === 28 && defence.gapType === "missing" && defence.tailwindScore === 18,
    defence,
  );

  const banking = scoreSectorFit("Banking", ctx);
  assert(
    "Banking 38% → score=-999, gapType=overweight (hard gate)",
    banking.score === -999 && banking.gapType === "overweight",
    banking,
  );

  const pharma = scoreSectorFit("Pharma", ctx);
  // Pharma underweight (4%) + Layer 1 only (+6). 4 + 6*0.7 = 8.2
  assert(
    "Pharma underweight + L1-only tailwind 6 → 4 + 6*0.7 = 8.2",
    Math.abs(pharma.score - 8.2) < 0.001 && pharma.gapType === "underweight",
    pharma,
  );

  const fmcg = scoreSectorFit("FMCG", ctx);
  // FMCG healthy + 0 tailwind → 0
  assert(
    "FMCG 12% healthy + no tailwind → score 0, gapType=healthy",
    fmcg.score === 0 && fmcg.gapType === "healthy" && fmcg.tailwindScore === 0,
    fmcg,
  );
}

{
  // Healthy + max-tailwind boundary case
  const overlay = [{ sector: "Defence", pct: 10 }];
  const picks = {
    sections: {
      top_ranked_30_v3: [
        { ticker: "A", sector: "Defence", v3_score_100: 70, upside_pct: 35 },
        { ticker: "B", sector: "Defence", v3_score_100: 68, upside_pct: 35 },
        { ticker: "C", sector: "Defence", v3_score_100: 65, upside_pct: 35 },
      ],
    },
  };
  const regime = { sectorImpacts: [{ sector: "Defence", impact: 4, reason: "War" }] };
  const ctx = buildSectorContext(overlay, picks, regime);
  const fit = scoreSectorFit("Defence", ctx);
  // healthy + 18 tailwind → 0 + 18 * 0.3 = 5.4
  assert(
    "Defence healthy 10% + max tailwind 18 → score 5.4, gapType=healthy",
    Math.abs(fit.score - 5.4) < 0.001 && fit.gapType === "healthy",
    fit,
  );
}

// ──────────────────── selectSectorGapPicks: cap, ordering ────────────────────

console.log("\nselectSectorGapPicks: per-sector cap + priority ordering\n");

{
  const overlay = [
    { sector: "Banking", pct: 35 },
    { sector: "IT Services", pct: 18 },
  ]; // Defence/Pharma/Capital Goods/Cement = missing
  const ctx = buildSectorContext(overlay, null, null);

  // 10 candidates across 4 sectors. All clear the perfect-fit floor.
  const candidates = [
    // Defence — Layer 1 tailwind, missing → fit 16, total 16+v3
    { source: "fresh", ticker: "HAL", sector: "Defence",      v3_score: 70, snowflake_total: 18, upside_pct: 30 },
    { source: "fresh", ticker: "BEL", sector: "Defence",      v3_score: 65, snowflake_total: 17, upside_pct: 28 },
    // Pharma — Layer 1 tailwind, missing
    { source: "fresh", ticker: "CIPLA", sector: "Pharma",     v3_score: 60, snowflake_total: 18, upside_pct: 25 },
    { source: "fresh", ticker: "DRREDDY", sector: "Pharma",   v3_score: 58, snowflake_total: 17, upside_pct: 22 },
    // Capital Goods — Layer 1 tailwind, missing
    { source: "fresh", ticker: "ABB", sector: "Capital Goods", v3_score: 62, snowflake_total: 17, upside_pct: 18 },
    // Cement — NO tailwind, missing
    { source: "fresh", ticker: "ULTRA", sector: "Cement",     v3_score: 70, snowflake_total: 17, upside_pct: 15 },
    // Banking — overweight, should be excluded
    { source: "fresh", ticker: "HDFCBANK", sector: "Banking", v3_score: 80, snowflake_total: 19, upside_pct: 20 },
    // Below floor — should be excluded
    { source: "fresh", ticker: "LOW1", sector: "Defence",     v3_score: 30, snowflake_total: 18, upside_pct: 30 },
    { source: "fresh", ticker: "LOW2", sector: "Pharma",      v3_score: 60, snowflake_total: 10, upside_pct: 30 },
    { source: "fresh", ticker: "LOW3", sector: "Defence",     v3_score: 60, snowflake_total: 18, upside_pct: 5 },
  ];
  const picks = selectSectorGapPicks(candidates, ctx, { limit: 5 });

  assert(
    "Limit honoured — total ≤ 5",
    picks.length <= 5,
    picks.length,
  );
  assert(
    "1 per sector (eligible >= 3)",
    new Set(picks.map((p) => p.gapSector)).size === picks.length,
    picks.map((p) => p.gapSector),
  );
  assert(
    "No overweight Banking ticker",
    !picks.some((p) => p.ticker === "HDFCBANK"),
    picks.map((p) => p.ticker),
  );
  assert(
    "No below-floor tickers (LOW1/LOW2/LOW3)",
    !picks.some((p) => ["LOW1", "LOW2", "LOW3"].includes(p.ticker)),
    picks.map((p) => p.ticker),
  );
  assert(
    "First pick is missing+tailwind (Defence/Pharma/Capital Goods, NOT Cement)",
    ["Defence", "Pharma", "Capital Goods"].includes(picks[0]?.gapSector),
    picks[0],
  );
  assert(
    "Cement (missing but no tailwind) ranked after tailwind sectors",
    (() => {
      const firstNoTW = picks.findIndex((p) => p.gapSector === "Cement");
      if (firstNoTW === -1) return true; // not selected at all is fine
      const lastTW = Math.max(
        ...picks
          .map((p, i) => (["Defence", "Pharma", "Capital Goods"].includes(p.gapSector) ? i : -1))
          .filter((i) => i >= 0),
      );
      return firstNoTW > lastTW;
    })(),
    picks.map((p) => ({ ticker: p.ticker, sector: p.gapSector })),
  );
  assert(
    "whyFit set on every selected pick",
    picks.every((p) => typeof p.whyFit === "string" && p.whyFit.length > 0),
    picks.map((p) => p.whyFit),
  );
  assert(
    "perfectFitScore set and equals v3 + sectorFit.score",
    picks.every((p) => Math.abs(p.perfectFitScore - (p.v3_score + p._sectorFit.score)) < 0.001),
    picks.map((p) => ({ ticker: p.ticker, v3: p.v3_score, fit: p._sectorFit.score, total: p.perfectFitScore })),
  );
}

{
  // Few eligible candidates → relax to 2/sector
  const overlay = [{ sector: "Banking", pct: 35 }];
  const ctx = buildSectorContext(overlay, null, null);
  const candidates = [
    { source: "fresh", ticker: "HAL", sector: "Defence", v3_score: 70, snowflake_total: 18, upside_pct: 30 },
    { source: "fresh", ticker: "BEL", sector: "Defence", v3_score: 68, snowflake_total: 17, upside_pct: 28 },
  ];
  const picks = selectSectorGapPicks(candidates, ctx, { limit: 5 });
  assert(
    "<3 eligible → 2/sector cap allows both Defence picks",
    picks.length === 2 && picks.every((p) => p.gapSector === "Defence"),
    picks.map((p) => p.ticker),
  );
}

{
  // Only holdings (no fresh) → returns empty
  const ctx = buildSectorContext([{ sector: "Banking", pct: 35 }], null, null);
  const candidates = [
    { source: "holding", ticker: "HAL", sector: "Defence", v3_score: 70, snowflake_total: 18, upside_pct: 30 },
  ];
  const picks = selectSectorGapPicks(candidates, ctx, { limit: 5 });
  assert(
    "Holdings excluded — only fresh picks eligible for spotlight",
    picks.length === 0,
    picks,
  );
}

// ──────────────────── buildPerfectFitReason: copy ────────────────────

console.log("\nbuildPerfectFitReason: copy variants\n");

{
  const overlay = [{ sector: "Banking", pct: 35 }];
  const ctx = buildSectorContext(overlay, null, null);

  const fitMissingTw = scoreSectorFit("Defence", ctx);
  const reason1 = buildPerfectFitReason({}, ctx, fitMissingTw);
  assert(
    "missing+tailwind copy mentions evidence",
    reason1.includes("Defence") && reason1.includes("missing") && reason1.includes("Indigenisation"),
    reason1,
  );

  const fitOverweight = scoreSectorFit("Banking", ctx);
  const reason2 = buildPerfectFitReason({}, ctx, fitOverweight);
  assert(
    "overweight copy says 'consider trimming'",
    reason2.includes("Banking") && reason2.includes("trimming"),
    reason2,
  );

  // Underweight test: Pharma 4% with picks-empty regime
  const ctx2 = buildSectorContext([{ sector: "Pharma", pct: 4 }], null, null);
  const fitUnder = scoreSectorFit("Pharma", ctx2);
  const reason3 = buildPerfectFitReason({}, ctx2, fitUnder);
  assert(
    "underweight + Layer 1 tailwind copy mentions current pct + evidence",
    reason3.includes("Pharma") && reason3.includes("4") && (reason3.includes("generics") || reason3.includes("biosimilar") || reason3.includes("formulations")),
    reason3,
  );
}

// ──────────────────── Constants exported ────────────────────

console.log("\nExported constants\n");
{
  assert(
    "PERFECT_FIT_FLOOR matches plan: v3=45, snowflake=16, upside=8",
    PERFECT_FIT_FLOOR.v3 === 45 && PERFECT_FIT_FLOOR.snowflake_total === 16 && PERFECT_FIT_FLOOR.upside_pct === 8,
    PERFECT_FIT_FLOOR,
  );
  assert(
    "OVERWEIGHT_PCT_THRESHOLD = 20 (user-confirmed)",
    OVERWEIGHT_PCT_THRESHOLD === 20,
    OVERWEIGHT_PCT_THRESHOLD,
  );
  assert(
    "UNDERWEIGHT_PCT_THRESHOLD = 6",
    UNDERWEIGHT_PCT_THRESHOLD === 6,
    UNDERWEIGHT_PCT_THRESHOLD,
  );
}

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed · ${fail} failed\n`);
if (fail > 0) process.exit(1);
