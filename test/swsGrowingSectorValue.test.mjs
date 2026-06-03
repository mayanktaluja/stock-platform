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
    overview: {
      current_price_inr: overrides.price ?? 100,
      fair_value_inr: overrides.fairValue ?? 140,
      market_cap_inr: overrides.marketCap ?? 1e11,
      snowflake_total: 22,
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
  assert.equal(result.audit.reason, "ok");
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
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
