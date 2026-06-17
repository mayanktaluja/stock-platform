import { reconcileFairValue } from "./fvReconciliation.js";
import { normalizeSector } from "../macroRegime.js";
import { resolveSectorsForTicker } from "./riskLab/macro/sectorOverrides.js";
import { compareIndiaSectionRank } from "./swsIndiaSectionPolicy.js";

const MIN_MCAP_INR = 5_000_000_000;
const MIN_V4_SCORE = 47;
const MIN_UPSIDE_PCT = 25;
const MIN_COVERAGE_RATIO = 0.6;
const STALE_HOURS = 36;
const MACRO_FALLBACK_STALE_HOURS = 18;
const MIN_MACRO_FALLBACK_CONFIDENCE = 0.3;
const FUTURE_GROWTH_MIN_STRICT = 4;
const FUTURE_GROWTH_MIN_RELAXED = 3;
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
  "Tech": "Information Technology",
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

function directOrSubstringSectorAlias(sector) {
  const raw = String(sector || "").trim();
  if (!raw) return null;
  if (DIRECT_SECTOR_MAP.has(raw)) return DIRECT_SECTOR_MAP.get(raw);
  for (const [pattern, mapped] of SUBSTRING_SECTOR_MAP) {
    if (pattern.test(raw)) return mapped;
  }
  return null;
}

function addSectorKey(keys, value) {
  const raw = String(value || "").trim();
  if (raw) keys.add(raw);
}

function sectorKeyCandidates(sector) {
  const raw = String(sector || "").trim();
  if (!raw) return [];
  const keys = new Set();
  addSectorKey(keys, raw);
  addSectorKey(keys, normalizeSector(raw));
  addSectorKey(keys, mapSwsSectorToOutlookSector(raw));
  addSectorKey(keys, directOrSubstringSectorAlias(raw));
  return [...keys];
}

function candidateOutlookSectors(stock) {
  const resolved = resolveSectorsForTicker(stock?.ticker, stock?.sector);
  const sectors = Array.isArray(resolved) ? [...resolved] : [resolved];
  for (const industryHint of [stock?.industry, stock?.overview?.industry, stock?.v4_breakdown?.fv_pe_industry_name]) {
    // SWS often stores defence names under broad "Capital Goods" while the FV
    // peer group is the more precise "Aerospace & Defence". Use that precision
    // only for Defence; do not let peer-industry labels remap unrelated sectors.
    if (mapSwsSectorToOutlookSector(industryHint) === "Defence") sectors.push(industryHint);
  }
  const keys = new Set();
  for (const sector of sectors) {
    for (const key of sectorKeyCandidates(sector)) keys.add(key);
  }
  return [...keys];
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

function coverageWarning(audit) {
  const base = audit?.base_eligible_count || 0;
  const mapped = audit?.mapped_count || 0;
  const pct = Number.isFinite(audit?.coverage_ratio)
    ? Math.round(audit.coverage_ratio * 100)
    : null;
  const floorPct = Math.round(MIN_COVERAGE_RATIO * 100);
  return {
    ui_warning_label: `Sector mapping coverage below floor${pct != null ? ` · ${pct}%` : ""}`,
    ui_warning_message:
      `Candidates are withheld because only ${mapped} of ${base} base-eligible stocks ` +
      `mapped to Sector Outlook sectors${pct != null ? ` (${pct}%)` : ""}; ` +
      `the trust floor is ${floorPct}%. Refresh/fix the Sector Outlook taxonomy before showing this section.`,
  };
}

function macroGeneratedAt(macroRegime) {
  return macroRegime?.generatedAt || macroRegime?.generated_at || null;
}

function indexPositiveMacroImpacts(macroRegime, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const generatedAt = macroGeneratedAt(macroRegime);
  const ageHours = ageHoursFromIso(generatedAt, now);
  if (!Number.isFinite(ageHours) || ageHours > (opts.macroFallbackStaleHours || MACRO_FALLBACK_STALE_HOURS)) {
    return { ok: false, reason: "macro_regime_stale", bySector: new Map(), age_hours: Number.isFinite(ageHours) ? Math.round(ageHours * 10) / 10 : null };
  }
  const confidence = Number(macroRegime?.confidence);
  if (Number.isFinite(confidence) && confidence < MIN_MACRO_FALLBACK_CONFIDENCE) {
    return { ok: false, reason: "macro_regime_low_confidence", bySector: new Map(), age_hours: Math.round(ageHours * 10) / 10 };
  }
  const bySector = new Map();
  for (const impact of macroRegime?.sectorImpacts || []) {
    const score = Number(impact?.impact);
    if (!(score > 0)) continue;
    const sector = mapSwsSectorToOutlookSector(impact?.sector);
    if (!sector) continue;
    bySector.set(sector, {
      sector,
      impact: score,
      reason: impact?.reason || null,
    });
  }
  if (bySector.size === 0) {
    return { ok: false, reason: "macro_regime_no_positive_sector_impacts", bySector, age_hours: Math.round(ageHours * 10) / 10 };
  }
  return {
    ok: true,
    reason: "ok",
    bySector,
    age_hours: Math.round(ageHours * 10) / 10,
    generated_at: generatedAt,
    current_regime: macroRegime?.regime || null,
  };
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
    for (const key of sectorKeyCandidates(s?.sector)) {
      const row = { ...s, source_sector: s.sector };
      const existing = bySector.get(key);
      if (!existing || compareSectorOutlookRows(row, existing) < 0) {
        bySector.set(key, row);
      }
    }
  }
  return {
    ok: true,
    reason: "ok",
    bySector,
    age_hours: Math.round(ageHours * 10) / 10,
    generated_at: sectorOutlook.generated_at || null,
  };
}

function outlookLabelRank(label) {
  if (label === "STRONG_TAILWIND") return 2;
  if (label === "TAILWIND") return 1;
  return 0;
}

function confidenceRank(confidence) {
  if (confidence === "HIGH") return 3;
  if (confidence === "MED") return 2;
  if (confidence === "LOW") return 1;
  return 0;
}

function compareSectorOutlookRows(a, b) {
  const ah = a?.horizons?.["3_12m"] || {};
  const bh = b?.horizons?.["3_12m"] || {};
  const checks = [
    outlookLabelRank(bh.outlook_label) - outlookLabelRank(ah.outlook_label),
    (bh.confidence === "LOW" ? 0 : 1) - (ah.confidence === "LOW" ? 0 : 1),
    confidenceRank(bh.confidence) - confidenceRank(ah.confidence),
    (Number(bh.composite) || 0) - (Number(ah.composite) || 0),
    (Number(bh.bottom_up?.score) || 0) - (Number(ah.bottom_up?.score) || 0),
    (Number(bh.bottom_up?.n_news) || 0) - (Number(ah.bottom_up?.n_news) || 0),
  ];
  return checks.find((v) => v !== 0) || 0;
}

function baseEligible(stock) {
  const ov = stock?.overview || {};
  const fv = reconcileFairValue(ov);
  const mcap = ov.market_cap_inr;
  const surv =
    stock?.regulatory_flags?.surveillance ||
    stock?.risk_overlay?.surveillance ||
    stock?.v4_breakdown?.surveillance ||
    stock?.v2_breakdown?.surveillance;
  if (!isFiniteNumber(mcap) || mcap < MIN_MCAP_INR) return false;
  if ((stock?.v4_score_100 || 0) < MIN_V4_SCORE) return false;
  if (stock?.v4_verdict === "AVOID" || stock?.composite_verdict === "AVOID") return false;
  if (surv?.list === "GSM") return false;
  if (fv.fair_value_confidence !== "HIGH") return false;
  if (!isFiniteNumber(fv.upside_pct) || fv.upside_pct < MIN_UPSIDE_PCT) return false;
  return true;
}

function futureGrowthScore(stock) {
  const snow = stock?.overview?.snowflake || {};
  const score = snow.future ?? snow.future_growth;
  return isFiniteNumber(score) ? score : null;
}

function applyFutureGrowthGate(candidates, opts = {}) {
  const strictMin = opts.strictMin || FUTURE_GROWTH_MIN_STRICT;
  const relaxedMin = opts.relaxedMin || FUTURE_GROWTH_MIN_RELAXED;
  const strict = candidates.filter(({ stock }) => {
    const score = futureGrowthScore(stock);
    return isFiniteNumber(score) && score >= strictMin;
  });
  if (strict.length > 0) {
    return {
      candidates: strict,
      minUsed: strictMin,
      relaxed: false,
      candidateCount: candidates.length,
      strictCount: strict.length,
      relaxedCount: candidates.filter(({ stock }) => {
        const score = futureGrowthScore(stock);
        return isFiniteNumber(score) && score >= relaxedMin;
      }).length,
    };
  }
  const relaxed = candidates.filter(({ stock }) => {
    const score = futureGrowthScore(stock);
    return isFiniteNumber(score) && score >= relaxedMin;
  });
  return {
    candidates: relaxed,
    minUsed: relaxed.length > 0 ? relaxedMin : strictMin,
    relaxed: relaxed.length > 0,
    candidateCount: candidates.length,
    strictCount: 0,
    relaxedCount: relaxed.length,
  };
}

function futureGrowthAudit(gate) {
  return {
    future_growth_min_target: FUTURE_GROWTH_MIN_STRICT,
    future_growth_min_used: gate?.minUsed || FUTURE_GROWTH_MIN_STRICT,
    future_growth_candidate_count: gate?.candidateCount || 0,
    future_growth_strict_selected_count: gate?.strictCount || 0,
    future_growth_relaxed_selected_count: gate?.relaxedCount || 0,
    future_growth_gate_relaxed: Boolean(gate?.relaxed),
  };
}

function appendFutureGrowthWarning(audit) {
  const candidateCount = audit?.future_growth_candidate_count || 0;
  const filteredOutByFuture = candidateCount > 0 && audit.selected_count === 0;
  if (!audit?.future_growth_gate_relaxed && !filteredOutByFuture) return audit;
  const futureLabel = audit.future_growth_gate_relaxed
    ? `Future fallback · ≥${audit.future_growth_min_used}/6`
    : `Future Growth < ${FUTURE_GROWTH_MIN_RELAXED}/6`;
  const futureMessage = audit.future_growth_gate_relaxed
    ? `No strict Future Growth ≥${FUTURE_GROWTH_MIN_STRICT}/6 candidates passed the section gates, so this section is showing the clearly labelled ≥${FUTURE_GROWTH_MIN_RELAXED}/6 fallback.`
    : `Otherwise eligible candidates are withheld because none meet the minimum Future Growth ≥${FUTURE_GROWTH_MIN_RELAXED}/6 fallback floor.`;
  return {
    ...audit,
    available: false,
    reason: audit.reason === "ok"
      ? (audit.future_growth_gate_relaxed ? "future_growth_relaxed_fallback" : "future_growth_below_floor")
      : audit.reason,
    ui_warning_label: audit.ui_warning_label ? `${audit.ui_warning_label} · ${futureLabel}` : futureLabel,
    ui_warning_message: audit.ui_warning_message ? `${audit.ui_warning_message} ${futureMessage}` : futureMessage,
  };
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

function macroFallbackForStock(stock, macroIndex) {
  for (const mappedSector of candidateOutlookSectors(stock)) {
    const impact = macroIndex.bySector.get(mappedSector);
    if (impact) return { mappedSector, impact };
  }
  return null;
}

function enrichMacroFallbackCard(card, fallback, macroRegime) {
  const regime = macroRegime?.regime || null;
  const regimeLabel = humanRegime(regime);
  return {
    ...card,
    selection_basis: "macro_value_fallback",
    sector_outlook_used: false,
    macro_regime_at_selection: regime,
    macro_regime_label: regimeLabel,
    macro_impact_sector: fallback.mappedSector,
    macro_impact_score: fallback.impact.impact,
    macro_impact_reason: fallback.impact.reason,
    macro_fallback_label: `Macro fallback · ${regimeLabel}`,
    fv_discount_badge_30plus: isFiniteNumber(card.upside_pct) && card.upside_pct >= 30,
  };
}

function buildMacroFallbackSection(scoredStocks, opts, outlookIndex) {
  const macroIndex = indexPositiveMacroImpacts(opts.macroRegime || null, opts);
  if (!macroIndex.ok) return null;

  const base = scoredStocks.filter(baseEligible);
  const selected = [];
  for (const stock of base) {
    const fallback = macroFallbackForStock(stock, macroIndex);
    if (fallback) selected.push({ stock, fallback });
  }
  const futureGate = applyFutureGrowthGate(selected);

	  const items = futureGate.candidates
	    .sort((a, b) =>
	      (b.stock.v4_score_100 || 0) - (a.stock.v4_score_100 || 0) ||
	      (reconcileFairValue(b.stock.overview || {}).upside_pct || 0) - (reconcileFairValue(a.stock.overview || {}).upside_pct || 0) ||
	      (b.fallback.impact.impact || 0) - (a.fallback.impact.impact || 0) ||
	      compareIndiaSectionRank(a.stock, b.stock)
	    )
    .slice(0, opts.limit || 100)
    .map(({ stock, fallback }) => enrichMacroFallbackCard(opts.pickCardFields(stock), fallback, opts.macroRegime || null));

  const current = humanRegime(macroIndex.current_regime);
  const outlook = humanRegime(outlookIndex.outlook_regime || opts.sectorOutlook?.regime_at_generation?.regime || null);
  const sectors = [...macroIndex.bySector.keys()].join(", ");
  return {
    items,
    audit: appendFutureGrowthWarning({
      available: false,
      reason: outlookIndex.reason,
      display_mode: "macro_value_fallback",
      fallback_reason: "current_macro_positive_sector_impacts",
      generated_at: outlookIndex.generated_at || null,
      age_hours: outlookIndex.age_hours,
      current_regime: macroIndex.current_regime,
      outlook_regime: outlookIndex.outlook_regime || opts.sectorOutlook?.regime_at_generation?.regime || null,
      macro_generated_at: macroIndex.generated_at,
      macro_age_hours: macroIndex.age_hours,
      macro_positive_sectors: [...macroIndex.bySector.values()],
      ui_warning_label: `Macro fallback · ${current}`,
      ui_warning_message: `Sector Outlook was generated under ${outlook}, so stale Sector Outlook tailwinds are not used. Showing current-macro value candidates from positive ${current} sectors (${sectors}) until Sector Outlook refreshes.`,
      base_eligible_count: base.length,
      mapped_count: selected.length,
      selected_count: items.length,
      ...futureGrowthAudit(futureGate),
    }),
  };
}

export function buildGrowingSectorValueSection(scoredStocks, opts = {}) {
  const pickCardFields = opts.pickCardFields;
  if (typeof pickCardFields !== "function") {
    throw new Error("buildGrowingSectorValueSection requires opts.pickCardFields");
  }
	  const outlookIndex = indexSectorOutlook(opts.sectorOutlook || null, opts);
	  if (!outlookIndex.ok) {
	    const fallback = buildMacroFallbackSection(scoredStocks, opts, outlookIndex);
	    if (fallback) return fallback;
	    const macroIndex = indexPositiveMacroImpacts(opts.macroRegime || null, opts);
	    return {
	      items: [],
	      audit: {
        available: false,
        reason: outlookIndex.reason,
        generated_at: outlookIndex.generated_at || null,
        age_hours: outlookIndex.age_hours,
	        current_regime: outlookIndex.current_regime || opts.macroRegime?.regime || null,
	        outlook_regime: outlookIndex.outlook_regime || opts.sectorOutlook?.regime_at_generation?.regime || null,
	        macro_fallback_reason: macroIndex.reason,
	        macro_generated_at: macroIndex.generated_at || macroGeneratedAt(opts.macroRegime || null),
	        macro_age_hours: macroIndex.age_hours,
	        ...failClosedWarning(outlookIndex.reason, {
	          current_regime: outlookIndex.current_regime || opts.macroRegime?.regime || null,
          outlook_regime: outlookIndex.outlook_regime || opts.sectorOutlook?.regime_at_generation?.regime || null,
        }),
        base_eligible_count: 0,
        mapped_count: 0,
        selected_count: 0,
        ...futureGrowthAudit(null),
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
  const futureGate = applyFutureGrowthGate(selected);

  const coverageRatio = base.length > 0 ? mapped.length / base.length : 0;
  let audit = {
    available: true,
    reason: "ok",
    generated_at: outlookIndex.generated_at || null,
    age_hours: outlookIndex.age_hours,
    base_eligible_count: base.length,
    mapped_count: mapped.length,
    selected_count: futureGate.candidates.length,
    coverage_ratio: Math.round(coverageRatio * 1000) / 1000,
    ...futureGrowthAudit(futureGate),
  };
  audit = appendFutureGrowthWarning(audit);
  if (base.length > 0 && coverageRatio < MIN_COVERAGE_RATIO) {
    return {
      items: [],
      audit: {
        ...audit,
        available: false,
        reason: "sector_mapping_coverage_below_floor",
        ...coverageWarning(audit),
      },
    };
  }

	  const items = futureGate.candidates
	    .sort((a, b) =>
	      (b.stock.v4_score_100 || 0) - (a.stock.v4_score_100 || 0) ||
	      (reconcileFairValue(b.stock.overview || {}).upside_pct || 0) - (reconcileFairValue(a.stock.overview || {}).upside_pct || 0) ||
	      (b.tailwind.horizon.composite || 0) - (a.tailwind.horizon.composite || 0) ||
	      compareIndiaSectionRank(a.stock, b.stock)
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
