/**
 * Growing Sector Value section selector regression.
 *
 * Run with: node test/swsGrowingSectorValue.test.mjs
 */

import assert from "node:assert/strict";
import {
  buildGrowingSectorValueSection,
  mapSwsSectorToOutlookSector,
} from "../services/swsGrowingSectorValue.js";

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "→", e.message);
  }
}

function stock(ticker, overrides = {}) {
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: overrides.sector || "Automobile",
    v4_score_100: overrides.v4_score_100 ?? 60,
    v4_verdict: overrides.v4_verdict || "STRONG",
    v2_breakdown: overrides.v2_breakdown || {},
    v4_breakdown: overrides.v4_breakdown || {},
    overview: {
      current_price_inr: overrides.price ?? 100,
      fair_value_inr: overrides.fairValue ?? 140,
      market_cap_inr: overrides.marketCap ?? 1e11,
      snowflake_total: 22,
      snowflake: {
        valuation: 4,
        future: overrides.future ?? 4,
        future_growth: overrides.future ?? 4,
        past_performance: 4,
        financial_health: 5,
        dividends: 3,
        ...overrides.snowflake,
      },
      ...overrides.overview,
    },
  };
}

function outlook(overrides = {}) {
  return {
    generated_at: overrides.generated_at || "2026-06-03T00:00:00.000Z",
    regime_at_generation: { regime: overrides.regime || "CALM" },
    sectors: [
      {
        sector: "Automobile",
        horizons: {
          "3_12m": {
            outlook_label: overrides.label || "TAILWIND",
            confidence: overrides.confidence || "MED",
            composite: overrides.composite ?? 0.4,
            bottom_up: { score: overrides.bottomUp ?? 0.5 },
            top_down: { reason: "Auto demand improving" },
            evidence_top5: [],
          },
        },
      },
      {
        sector: "Pharma",
        horizons: {
          "3_12m": {
            outlook_label: "STRONG_TAILWIND",
            confidence: "HIGH",
            composite: 0.7,
            bottom_up: { score: 0.6 },
            top_down: { reason: "Healthcare demand" },
            evidence_top5: [],
          },
        },
      },
    ],
  };
}

const card = (s) => ({
  ticker: s.ticker,
  sector: s.sector,
  v4_score_100: s.v4_score_100,
  snowflake: s.overview.snowflake,
  upside_pct: Math.round((((s.overview.fair_value_inr - s.overview.current_price_inr) / s.overview.current_price_inr) * 100) * 10) / 10,
  fair_value_confidence: "HIGH",
});
const now = new Date("2026-06-03T06:00:00.000Z");

console.log("swsGrowingSectorValue selector\n");

check("maps SWS healthcare labels to Sector Outlook Pharma vocabulary", () => {
  assert.equal(mapSwsSectorToOutlookSector("Healthcare"), "Pharma");
});

check("maps SWS diversified financials to Sector Outlook NBFC vocabulary", () => {
  assert.equal(mapSwsSectorToOutlookSector("Diversified Financials"), "NBFC");
});

check("selects HIGH-confidence FV names in tailwind sectors and adds display metadata", () => {
  const result = buildGrowingSectorValueSection([stock("AUTOA")], {
    pickCardFields: card,
    sectorOutlook: outlook(),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].ticker, "AUTOA");
  assert.equal(result.items[0].sector_tailwind_label, "TAILWIND");
  assert.equal(result.items[0].sector_tailwind_confidence, "MED");
  assert.equal(result.items[0].fv_discount_badge_30plus, true);
  assert.equal(result.items[0].snowflake.future_growth, 4);
  assert.equal(result.audit.reason, "ok");
});

check("preserves fine-grained Semiconductors Sector Outlook rows before broad IT aliases", () => {
  const result = buildGrowingSectorValueSection([
    stock("CHIP", { sector: "Semiconductors", v4_score_100: 68 }),
  ], {
    pickCardFields: card,
    sectorOutlook: {
      generated_at: "2026-06-03T00:00:00.000Z",
      regime_at_generation: { regime: "CALM" },
      sectors: [
        {
          sector: "Information Technology",
          horizons: {
            "3_12m": {
              outlook_label: "HEADWIND",
              confidence: "MED",
              composite: -0.2,
              bottom_up: { score: -0.4, n_news: 20 },
            },
          },
        },
        {
          sector: "Semiconductors",
          horizons: {
            "3_12m": {
              outlook_label: "STRONG_TAILWIND",
              confidence: "MED",
              composite: 0.5,
              bottom_up: { score: 1, n_news: 27 },
              top_down: { reason: "Chip demand tailwind" },
            },
          },
        },
      ],
    },
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].ticker, "CHIP");
  assert.equal(result.items[0].sector_tailwind_sector, "Semiconductors");
  assert.equal(result.items[0].sector_tailwind_label, "STRONG_TAILWIND");
});

check("prefers usable Retail row over lower-confidence Consumer Retailing duplicate", () => {
  const result = buildGrowingSectorValueSection([
    stock("RETAIL", { sector: "Retail", v4_score_100: 63 }),
  ], {
    pickCardFields: card,
    sectorOutlook: {
      generated_at: "2026-06-03T00:00:00.000Z",
      regime_at_generation: { regime: "CALM" },
      sectors: [
        {
          sector: "Consumer Retailing",
          horizons: {
            "3_12m": {
              outlook_label: "TAILWIND",
              confidence: "LOW",
              composite: 0.36,
              bottom_up: { score: 0.73, n_news: 29 },
            },
          },
        },
        {
          sector: "Retail",
          horizons: {
            "3_12m": {
              outlook_label: "TAILWIND",
              confidence: "MED",
              composite: 0.17,
              bottom_up: { score: 0.34, n_news: 158 },
              top_down: { reason: "Retail demand improving" },
            },
          },
        },
      ],
    },
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].sector_tailwind_sector, "Retail");
  assert.equal(result.items[0].sector_tailwind_confidence, "MED");
});

check("falls back to broad IT-style alias when no exact Tech row exists", () => {
  const result = buildGrowingSectorValueSection([
    stock("TECH", { sector: "Tech", v4_score_100: 61 }),
    stock("SOFT", { sector: "Software", v4_score_100: 60 }),
  ], {
    pickCardFields: card,
    sectorOutlook: {
      generated_at: "2026-06-03T00:00:00.000Z",
      regime_at_generation: { regime: "CALM" },
      sectors: [
        {
          sector: "Information Technology",
          horizons: {
            "3_12m": {
              outlook_label: "TAILWIND",
              confidence: "MED",
              composite: 0.25,
              bottom_up: { score: 0.5, n_news: 40 },
              top_down: { reason: "IT spending improving" },
            },
          },
        },
      ],
    },
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.deepEqual(result.items.map((x) => x.ticker), ["TECH", "SOFT"]);
  assert.equal(result.items[0].sector_tailwind_sector, "Information Technology");
  assert.equal(result.items[1].sector_tailwind_sector, "IT Services");
});

check("requires Future Growth >=4 in tailwind mode and does not relax when strict candidates exist", () => {
  const result = buildGrowingSectorValueSection([
    stock("STRICT", { future: 4, v4_score_100: 62 }),
    stock("RELAXED", { future: 3, v4_score_100: 80 }),
  ], {
    pickCardFields: card,
    sectorOutlook: outlook(),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.deepEqual(result.items.map((x) => x.ticker), ["STRICT"]);
  assert.equal(result.audit.future_growth_min_target, 4);
  assert.equal(result.audit.future_growth_min_used, 4);
  assert.equal(result.audit.future_growth_strict_selected_count, 1);
  assert.equal(result.audit.future_growth_relaxed_selected_count, 2);
  assert.equal(result.audit.future_growth_gate_relaxed, false);
});

check("relaxes to Future Growth >=3 only when strict mode has zero candidates", () => {
  const result = buildGrowingSectorValueSection([
    stock("RELAXED", { future: 3, v4_score_100: 65 }),
    stock("TOOLOW", { future: 2, v4_score_100: 80 }),
  ], {
    pickCardFields: card,
    sectorOutlook: outlook(),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.deepEqual(result.items.map((x) => x.ticker), ["RELAXED"]);
  assert.equal(result.audit.available, false);
  assert.equal(result.audit.reason, "future_growth_relaxed_fallback");
  assert.equal(result.audit.future_growth_min_used, 3);
  assert.equal(result.audit.future_growth_gate_relaxed, true);
  assert.match(result.audit.ui_warning_label, /Future fallback/);
  assert.match(result.audit.ui_warning_message, /Future Growth ≥4\/6/);
});

check("excludes LOW-confidence sector outlook even when label is tailwind", () => {
  const result = buildGrowingSectorValueSection([stock("AUTOA")], {
    pickCardFields: card,
    sectorOutlook: outlook({ confidence: "LOW" }),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.audit.selected_count, 0);
});

check("enforces HIGH FV confidence via real FV+price, not quoted upside only", () => {
  const quotedOnly = stock("QUOTE", {
    fairValue: undefined,
    overview: { fair_value_inr: null, upside_pct: 50 },
  });
  const result = buildGrowingSectorValueSection([quotedOnly], {
    pickCardFields: card,
    sectorOutlook: outlook(),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.audit.base_eligible_count, 0);
});

check("excludes weak score, AVOID, micro-cap and GSM stocks", () => {
  const result = buildGrowingSectorValueSection([
    stock("LOW", { v4_score_100: 46 }),
    stock("AVOID", { v4_verdict: "AVOID" }),
    stock("MICRO", { marketCap: 1e8 }),
    stock("GSM", { v2_breakdown: { surveillance: { list: "GSM" } } }),
  ], {
    pickCardFields: card,
    sectorOutlook: outlook(),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.audit.base_eligible_count, 0);
});

check("sorts by v4 score before upside and sector composite", () => {
  const highUpsideLowerScore = stock("UP", { v4_score_100: 55, fairValue: 200 });
  const lowerUpsideHigherScore = stock("SCORE", { v4_score_100: 70, fairValue: 130 });
  const result = buildGrowingSectorValueSection([highUpsideLowerScore, lowerUpsideHigherScore], {
    pickCardFields: card,
    sectorOutlook: outlook(),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.deepEqual(result.items.map((x) => x.ticker), ["SCORE", "UP"]);
});

check("fails closed on stale or macro-mismatched Sector Outlook", () => {
  const stale = buildGrowingSectorValueSection([stock("AUTOA")], {
    pickCardFields: card,
    sectorOutlook: outlook({ generated_at: "2026-05-01T00:00:00.000Z" }),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.equal(stale.items.length, 0);
  assert.equal(stale.audit.reason, "sector_outlook_stale");

  const mismatch = buildGrowingSectorValueSection([stock("AUTOA")], {
    pickCardFields: card,
    sectorOutlook: outlook({ regime: "CALM" }),
    macroRegime: { regime: "OIL_SHOCK" },
    now,
  });
  assert.equal(mismatch.items.length, 0);
  assert.equal(mismatch.audit.reason, "sector_outlook_macro_mismatch");
  assert.equal(mismatch.audit.current_regime, "OIL_SHOCK");
  assert.equal(mismatch.audit.outlook_regime, "CALM");
  assert.equal(mismatch.audit.ui_warning_label, "Macro mismatch · Oil Shock");
  assert.match(mismatch.audit.ui_warning_message, /Sector Outlook was generated under Calm/);
  assert.match(mismatch.audit.ui_warning_message, /current macro is Oil Shock/);
});

check("uses current macro-only fallback when Sector Outlook is macro-mismatched", () => {
  const result = buildGrowingSectorValueSection([
    stock("OILVAL", { sector: "Energy", fairValue: 160, v4_score_100: 66 }),
    stock("DEFVAL", {
      sector: "Capital Goods",
      fairValue: 150,
      v4_score_100: 64,
      v4_breakdown: { fv_pe_industry_name: "Aerospace & Defence" },
    }),
    stock("AUTOA", { sector: "Automobile", fairValue: 180, v4_score_100: 70 }),
  ], {
    pickCardFields: card,
    sectorOutlook: outlook({ regime: "CALM" }),
    macroRegime: {
      regime: "WAR_ESCALATION",
      confidence: 0.55,
      generatedAt: "2026-06-03T05:00:00.000Z",
      sectorImpacts: [
        { sector: "Defence", impact: 4, reason: "War events boost defence orders" },
        { sector: "Oil & Gas", impact: 2, reason: "Conflict raises crude price expectations" },
        { sector: "Aviation", impact: -3, reason: "Fuel costs squeeze margins" },
      ],
    },
    now,
  });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((x) => x.ticker), ["OILVAL", "DEFVAL"]);
  assert.equal(result.audit.available, false);
  assert.equal(result.audit.reason, "sector_outlook_macro_mismatch");
  assert.equal(result.audit.display_mode, "macro_value_fallback");
  assert.equal(result.audit.selected_count, 2);
  assert.match(result.audit.ui_warning_label, /Macro fallback/);
  assert.match(result.audit.ui_warning_message, /stale Sector Outlook tailwinds are not used/);
  assert.equal(result.items[0].selection_basis, "macro_value_fallback");
  assert.equal(result.items[0].sector_outlook_used, false);
  assert.equal(result.items[0].macro_impact_sector, "Oil & Gas");
  assert.equal(result.items[0].sector_tailwind_label, undefined);
  assert.equal(result.items[0].fv_discount_badge_30plus, true);
});

check("applies Future Growth gate inside macro fallback mode", () => {
  const result = buildGrowingSectorValueSection([
    stock("OILLOW", { sector: "Energy", fairValue: 160, v4_score_100: 80, future: 2 }),
    stock("DEFSTRICT", {
      sector: "Capital Goods",
      fairValue: 150,
      v4_score_100: 64,
      future: 4,
      v4_breakdown: { fv_pe_industry_name: "Aerospace & Defence" },
    }),
  ], {
    pickCardFields: card,
    sectorOutlook: outlook({ regime: "CALM" }),
    macroRegime: {
      regime: "WAR_ESCALATION",
      confidence: 0.55,
      generatedAt: "2026-06-03T05:00:00.000Z",
      sectorImpacts: [
        { sector: "Defence", impact: 4, reason: "War events boost defence orders" },
        { sector: "Oil & Gas", impact: 2, reason: "Conflict raises crude price expectations" },
      ],
    },
    now,
  });
  assert.deepEqual(result.items.map((x) => x.ticker), ["DEFSTRICT"]);
  assert.equal(result.audit.display_mode, "macro_value_fallback");
  assert.equal(result.audit.future_growth_min_used, 4);
  assert.equal(result.audit.future_growth_gate_relaxed, false);
});

check("withholds section when mapped sector coverage falls below floor", () => {
  const result = buildGrowingSectorValueSection([
    stock("AUTOA"),
    stock("UNK1", { sector: "Unclassifiable One" }),
    stock("UNK2", { sector: "Unclassifiable Two" }),
  ], {
    pickCardFields: card,
    sectorOutlook: outlook(),
    macroRegime: { regime: "CALM" },
    now,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.audit.reason, "sector_mapping_coverage_below_floor");
  assert.equal(result.audit.ui_warning_label, "Sector mapping coverage below floor · 33%");
  assert.match(result.audit.ui_warning_message, /only 1 of 3 base-eligible stocks/);
  assert.match(result.audit.ui_warning_message, /trust floor is 60%/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
