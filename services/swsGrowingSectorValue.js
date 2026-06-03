import { reconcileFairValue } from "./fvReconciliation.js";
import { normalizeSector } from "../macroRegime.js";
import { resolveSectorsForTicker } from "./riskLab/macro/sectorOverrides.js";

const MIN_MCAP_INR = 5_000_000_000;
const MIN_V4_SCORE = 47;
const MIN_UPSIDE_PCT = 25;
const MIN_COVERAGE_RATIO = 0.6;
const STALE_HOURS = 36;
const TAILWIND_LABELS = new Set(["TAILWIND", "STRONG_TAILWIND"]);

const DIRECT_SECTOR_MAP = new Map(Object.entries({
  "Aerospace & Defense": "Industrials",
  "Airlines": "Aviation",
  "Auto Components": "Automobile",
  "Automobile": "Automobile",
  "Automobiles": "Automobile",
  "Banks": "Financial Services",
  "Biotech": "Healthcare",
  "Biotechnology": "Healthcare",
  "Capital Goods": "Industrials",
  "Chemicals": "Chemicals",
  "Commercial Services": "Services",
  "Communications": "Telecom",
  "Consumer Durables": "Consumer Discretionary",
  "Consumer Services": "Consumer Discretionary",
  "Consumer Staples": "FMCG",
  "Diversified Financials": "NBFC",
  "Electrical Equipment": "Industrials",
  "Energy": "Energy",
  "Financial Services": "NBFC",
  "Food Beverage & Tobacco": "FMCG",
  "Food Products": "FMCG",
  "Healthcare": "Healthcare",
  "Household Products": "FMCG",
  "Infrastructure": "Infrastructure",
  "Insurance": "Insurance",
  "IT": "Information Technology",
  "Materials": "Materials",
  "Media": "Media",
  "Metals & Mining": "Metals",
  "Oil & Gas": "Oil & Gas",
  "Pharmaceuticals": "Healthcare",
  "Real Estate": "Real Estate",
  "Retail": "Retail",
  "Semiconductors": "Information Technology",
  "Services": "Services",
  "Software": "Information Technology",
  "Technology": "Information Technology",
  "Telecom": "Telecom",
  "Transportation": "Transportation",
  "Utilities": "Utilities",
}));

const SUBSTRING_SECTOR_MAP = [
  [/bank|finance|capital market|asset management|credit/i, "Financial Services"],
  [/insurance/i, "Insurance"],
  [/auto|vehicle|tyre|tire|component/i, "Automobile"],
  [/pharma|health|hospital|diagnostic|biotech/i, "Healthcare"],
  [/software|technology|information technology|semiconductor|internet/i, "Information Technology"],
  [/oil|gas|energy|power/i, "Energy"],
  [/metal|mining|steel|aluminium|aluminum|material/i, "Metals"],
  [/chemical|fertili/i, "Chemicals"],
  [/consumer|retail|textile|apparel|leisure/i, "Consumer Discretionary"],
  [/food|beverage|tobacco|staple|fmcg|household/i, "FMCG"],
  [/real estate|reit/i, "Real Estate"],
  [/telecom|communication/i, "Telecom"],
  [/transport|logistic|shipping|rail/i, "Transportation"],
  [/aviation|airline/i, "Aviation"],
  [/infrastructure|construction|cement/i, "Infrastructure"],
  [/media|entertainment/i, "Media"],
  [/utility|utilities/i, "Utilities"],
  [/industrial|capital goods|engineering|defence|defense/i, "Industrials"],
  [/service/i, "Services"],
];

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const round4 = (v) => isFiniteNumber(v) ? Math.round(v * 10000) / 10000 : null;

function ageHoursFromIso(iso, now) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 3600000;
}

export function mapSwsSectorToOutlookSector(sector) {
  const raw = String(sector || "").trim();
  if (!raw) return null;
  const canonical = normalizeSector(raw);
  if (canonical) return canonical;
  if (DIRECT_SECTOR_MAP.has(raw)) return DIRECT_SECTOR_MAP.get(raw);
  for (const [pattern, mapped] of SUBSTRING_SECTOR_MAP) {
    if (pattern.test(raw)) return mapped;
  }
  return raw;
}

function candidateOutlookSectors(stock) {
  const resolved = resolveSectorsForTicker(stock?.ticker, stock?.sector);
  const sectors = Array.isArray(resolved) ? resolved : [resolved];
  return [...new Set(sectors.map(mapSwsSectorToOutlookSector).filter(Boolean))];
}

function macroCompatible(sectorOutlook, macroRegime) {
  if (!macroRegime) return true;
  const outlookRegime = sectorOutlook?.regime_at_generation?.regime || null;
  const currentRegime = macroRegime?.regime || null;
  return !outlookRegime || !currentRegime || outlookRegime === currentRegime;
}

function humanRegime(regime) {
  const raw = String(regime || "").trim().toUpperCase();
  if (raw === "GLOBAL_RISK_OFF") return "Global Risk-Off";
  if (!raw) return "Unknown";
  return raw.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function failClosedWarning(reason, details = {}) {
  if (reason === "sector_outlook_macro_mismatch") {
    const current = humanRegime(details.current_regime);
    const outlook = humanRegime(details.outlook_regime);
    return {
      ui_warning_label: `Macro mismatch · ${current}`,
      ui_warning_message: `Sector Outlook was generated under ${outlook}, but current macro is ${current}. Candidates are withheld until Sector Outlook refreshes.`,
    };
  }
  if (reason === "sector_outlook_stale") {
    return {
      ui_warning_label: "Sector Outlook stale",
      ui_warning_message: "Candidates are withheld until Sector Outlook refreshes with fresh 3-12m sector data.",
    };
  }
  if (reason === "sector_outlook_missing") {
    return {
      ui_warning_label: "Sector Outlook unavailable",
      ui_warning_message: "Candidates are withheld until Sector Outlook data is available.",
    };
  }
  return {};
}

export function indexSectorOutlook(sectorOutlook, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  if (!sectorOutlook || !Array.isArray(sectorOutlook.sectors)) {
    return { ok: false, reason: "sector_outlook_missing", bySector: new Map(), age_hours: null };
  }
  const ageHours = ageHoursFromIso(sectorOutlook.generated_at, now);
  if (ageHours > (opts.staleHours || STALE_HOURS)) {
    return {
      ok: false,
      reason: "sector_outlook_stale",
      bySector: new Map(),
      age_hours: Math.round(ageHours * 10) / 10,
      generated_at: sectorOutlook.generated_at || null,
    };
  }
  if (!macroCompatible(sectorOutlook, opts.macroRegime || null)) {
    return {
      ok: false,
      reason: "sector_outlook_macro_mismatch",
      bySector: new Map(),
      age_hours: Math.round(ageHours * 10) / 10,
      generated_at: sectorOutlook.generated_at || null,
      outlook_regime: sectorOutlook?.regime_at_generation?.regime || null,
      current_regime: opts.macroRegime?.regime || null,
    };
  }
  const bySector = new Map();
  for (const s of sectorOutlook.sectors) {
    if (s?.sector) bySector.set(s.sector, s);
  }
  return {
    ok: true,
    reason: "ok",
    bySector,
    age_hours: Math.round(ageHours * 10) / 10,
    generated_at: sectorOutlook.generated_at || null,
  };
}

function baseEligible(stock) {
  const ov = stock?.overview || {};
  const fv = reconcileFairValue(ov);
  const mcap = ov.market_cap_inr;
  const surv = stock?.v2_breakdown?.surveillance;
  if (!isFiniteNumber(mcap) || mcap < MIN_MCAP_INR) return false;
  if ((stock?.v4_score_100 || 0) < MIN_V4_SCORE) return false;
  if (stock?.v4_verdict === "AVOID" || stock?.composite_verdict === "AVOID") return false;
  if (surv?.list === "GSM") return false;
  if (fv.fair_value_confidence !== "HIGH") return false;
  if (!isFiniteNumber(fv.upside_pct) || fv.upside_pct < MIN_UPSIDE_PCT) return false;
  return true;
}

function tailwindForStock(stock, outlookIndex) {
  for (const mappedSector of candidateOutlookSectors(stock)) {
    const sectorRow = outlookIndex.bySector.get(mappedSector);
    const horizon = sectorRow?.horizons?.["3_12m"];
    if (!horizon) continue;
    if (!TAILWIND_LABELS.has(horizon.outlook_label)) continue;
    if (horizon.confidence === "LOW") continue;
    if (!(Number(horizon.composite) > 0)) continue;
    if (!(Number(horizon.bottom_up?.score) > 0)) continue;
    return { mappedSector, horizon };
  }
  return null;
}

function enrichCard(card, tailwind) {
  const h = tailwind.horizon;
  const reason = h.top_down?.reason || h.evidence_top5?.[0]?.title || null;
  return {
    ...card,
    sector_tailwind_label: h.outlook_label || null,
    sector_tailwind_confidence: h.confidence || null,
    sector_tailwind_generated_at: tailwind.generated_at || null,
    sector_tailwind_reason: reason,
    sector_tailwind_composite: round4(h.composite),
    sector_tailwind_sector: tailwind.mappedSector,
    fv_discount_badge_30plus: isFiniteNumber(card.upside_pct) && card.upside_pct >= 30,
  };
}

export function buildGrowingSectorValueSection(scoredStocks, opts = {}) {
  const pickCardFields = opts.pickCardFields;
  if (typeof pickCardFields !== "function") {
    throw new Error("buildGrowingSectorValueSection requires opts.pickCardFields");
  }
  const outlookIndex = indexSectorOutlook(opts.sectorOutlook || null, opts);
  if (!outlookIndex.ok) {
    return {
      items: [],
      audit: {
        available: false,
        reason: outlookIndex.reason,
        generated_at: outlookIndex.generated_at || null,
        age_hours: outlookIndex.age_hours,
        current_regime: outlookIndex.current_regime || opts.macroRegime?.regime || null,
        outlook_regime: outlookIndex.outlook_regime || opts.sectorOutlook?.regime_at_generation?.regime || null,
        ...failClosedWarning(outlookIndex.reason, {
          current_regime: outlookIndex.current_regime || opts.macroRegime?.regime || null,
          outlook_regime: outlookIndex.outlook_regime || opts.sectorOutlook?.regime_at_generation?.regime || null,
        }),
        base_eligible_count: 0,
        mapped_count: 0,
        selected_count: 0,
      },
    };
  }

  const base = scoredStocks.filter(baseEligible);
  const mapped = [];
  const selected = [];
  for (const stock of base) {
    if (candidateOutlookSectors(stock).some((sector) => outlookIndex.bySector.has(sector))) mapped.push(stock);
    const tailwind = tailwindForStock(stock, outlookIndex);
    if (tailwind) selected.push({ stock, tailwind: { ...tailwind, generated_at: outlookIndex.generated_at } });
  }

  const coverageRatio = base.length > 0 ? mapped.length / base.length : 0;
  const audit = {
    available: true,
    reason: "ok",
    generated_at: outlookIndex.generated_at || null,
    age_hours: outlookIndex.age_hours,
    base_eligible_count: base.length,
    mapped_count: mapped.length,
    selected_count: selected.length,
    coverage_ratio: Math.round(coverageRatio * 1000) / 1000,
  };
  if (base.length > 0 && coverageRatio < MIN_COVERAGE_RATIO) {
    return {
      items: [],
      audit: { ...audit, available: false, reason: "sector_mapping_coverage_below_floor" },
    };
  }

  const items = selected
    .sort((a, b) =>
      (b.stock.v4_score_100 || 0) - (a.stock.v4_score_100 || 0) ||
      (reconcileFairValue(b.stock.overview || {}).upside_pct || 0) - (reconcileFairValue(a.stock.overview || {}).upside_pct || 0) ||
      (b.tailwind.horizon.composite || 0) - (a.tailwind.horizon.composite || 0)
    )
    .slice(0, opts.limit || 100)
    .map(({ stock, tailwind }) => enrichCard(pickCardFields(stock), tailwind));

  return {
    items,
    audit: { ...audit, selected_count: items.length },
  };
}

export default {
  buildGrowingSectorValueSection,
  indexSectorOutlook,
  mapSwsSectorToOutlookSector,
};
