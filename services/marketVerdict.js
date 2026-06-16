const MARKET_STATES = {
  CONSTRUCTIVE: "CONSTRUCTIVE",
  MIXED: "MIXED",
  RISK_OFF: "RISK_OFF",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
};

const FAVORABLE_MACRO = new Set(["RATE_CUT", "WAR_DE_ESCALATION", "POLICY_STIMULUS"]);
const SEVERE_MACRO = new Set(["GLOBAL_RISK_OFF"]);

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTime(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function ageHours(value, nowMs) {
  const ts = parseTime(value);
  if (ts == null) return null;
  return Math.max(0, (nowMs - ts) / 36e5);
}

function daysSinceYmd(dateYmd, nowMs) {
  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateYmd))) return null;
  const ts = Date.parse(`${dateYmd}T00:00:00+05:30`);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((nowMs - ts) / 86400000));
}

function quality({ available, usable, stale, ageHours: ageH = null, source = null, reason = null }) {
  return {
    available: available === true,
    usable: usable === true,
    stale: stale === true,
    ageHours: Number.isFinite(ageH) ? Number(ageH.toFixed(2)) : null,
    source,
    reason,
  };
}

function classifyMacro(regime, opts, nowMs) {
  const source = regime?.classifierProvider || "macroRegime";
  const generatedAt = regime?.generatedAt || regime?.generated_at || null;
  const ageH = ageHours(generatedAt, nowMs);
  const available = !!(regime && typeof regime === "object" && regime.regime);
  const stale = !available || ageH == null || ageH > opts.maxMacroAgeHours;
  const usable = available && !stale;
  const regimeId = available ? String(regime.regime || "CALM").toUpperCase() : null;
  const severity = toFiniteNumber(regime?.severity) ?? 1;
  const confidence = toFiniteNumber(regime?.confidence);

  let component = 0;
  let signal = "neutral";
  let action = "Macro regime is unavailable; market backdrop cannot be confirmed.";
  let value = "Unavailable";
  let severe = false;
  let favorable = false;

  if (available) {
    value = `${regimeId.replace(/_/g, " ")} · Severity ${severity}/5`;
  }

  if (!available) {
    // Missing macro is a quality blocker, not a bearish market call.
  } else if (stale) {
    action = "Macro regime is stale; treat the market read as incomplete.";
    signal = "yellow";
  } else if (regimeId === "CALM") {
    action = "No active macro shock detected; this is neutral, not a buy signal.";
    signal = "neutral";
  } else if (FAVORABLE_MACRO.has(regimeId)) {
    component = 2;
    favorable = true;
    signal = "green";
    action = "Macro backdrop is supportive, but still needs breadth and flow confirmation.";
  } else if (
    SEVERE_MACRO.has(regimeId) ||
    ((regimeId === "OIL_SHOCK" || regimeId === "WAR_ESCALATION" || regimeId === "REGULATORY_SHOCK") && severity >= 4)
  ) {
    component = -4;
    severe = true;
    signal = "red";
    action = "Severe macro pressure is active; fresh capital needs defensive handling.";
  } else if (regimeId === "RATE_HIKE") {
    component = -2;
    signal = "yellow";
    action = "Tightening pressure is a market headwind.";
  } else {
    component = -1;
    signal = "yellow";
    action = "Macro evidence is mixed; require stock-level confirmation.";
  }

  return {
    component,
    severe,
    favorable,
    signal,
    value,
    action,
    sourceQuality: quality({
      available,
      usable,
      stale,
      ageHours: ageH,
      source,
      reason: !available ? "missing_macro_regime" : stale ? "macro_regime_stale" : "fresh",
    }),
    meta: { regimeId, severity, confidence, generatedAt },
  };
}

function classifyBreadth(marketBreadth, opts, nowMs) {
  const source = marketBreadth?.source || "sectorHeatmapCache";
  const ageH = ageHours(marketBreadth?.lastUpdated, nowMs);
  const advancing = toFiniteNumber(marketBreadth?.advancing) ?? 0;
  const declining = toFiniteNumber(marketBreadth?.declining) ?? 0;
  const total = advancing + declining;
  const available = !!marketBreadth && total > 0;
  const stale = !available || ageH == null || ageH > opts.maxBreadthAgeHours;
  const usable = available && !stale;
  const ratio = usable ? (advancing / total) * 100 : null;

  let component = 0;
  let signal = "yellow";
  let action = "Market breadth is unavailable; cannot confirm a constructive backdrop.";
  let value = available ? `${advancing} up / ${declining} down` : "Unavailable";

  if (!available) {
    // Missing breadth is a hard cap, not a bearish call.
  } else if (stale) {
    action = "Market breadth is stale; do not infer a fresh buying backdrop.";
  } else if (ratio >= 70) {
    component = 3;
    signal = "green";
    action = `Broad participation is strong (${ratio.toFixed(0)}% advancing).`;
  } else if (ratio >= 55) {
    component = 2;
    signal = "green";
    action = `Breadth is positive (${ratio.toFixed(0)}% advancing).`;
  } else if (ratio >= 45) {
    action = `Breadth is mixed (${ratio.toFixed(0)}% advancing).`;
  } else if (ratio >= 30) {
    component = -2;
    action = `Breadth is weak (${ratio.toFixed(0)}% advancing).`;
  } else {
    component = -4;
    signal = "red";
    action = `Breadth is risk-off (${ratio.toFixed(0)}% advancing).`;
  }

  return {
    component,
    positive: usable && ratio >= 55,
    weak: usable && ratio < 45,
    riskOff: usable && ratio < 30,
    signal,
    value,
    action,
    sourceQuality: quality({
      available,
      usable,
      stale,
      ageHours: ageH,
      source,
      reason: !available ? "missing_breadth" : stale ? "breadth_stale" : "fresh",
    }),
    meta: { advancing, declining, ratio },
  };
}

function sumFlow(history, days) {
  if (!Array.isArray(history)) return null;
  let sum = 0;
  let count = 0;
  for (const row of history.slice(0, days)) {
    const value = toFiniteNumber(row?.fii ?? row?.fiiNet ?? row?.fii_net ?? row?.fii?.netValue);
    if (value == null) continue;
    sum += value;
    count += 1;
  }
  return count > 0 ? sum : null;
}

function classifyFlow(fiiDii, opts, nowMs) {
  const source = "fiiDiiCache";
  const available = !!(fiiDii && fiiDii.available !== false && fiiDii.fii);
  const lastUpdatedAge = ageHours(fiiDii?.lastUpdated, nowMs);
  const sessionAgeDays = daysSinceYmd(fiiDii?.date || fiiDii?.fii?.date, nowMs);
  const latestFii = toFiniteNumber(fiiDii?.fii?.netValue);
  const latestDii = toFiniteNumber(fiiDii?.dii?.netValue);
  const stale = !available ||
    latestFii == null ||
    lastUpdatedAge == null ||
    lastUpdatedAge > opts.maxFiiLastUpdatedHours ||
    sessionAgeDays == null ||
    sessionAgeDays > opts.maxFiiSessionAgeDays;
  const usable = available && !stale;
  const threeDayFii = sumFlow(fiiDii?.history, 3);
  const fiveDayFii = sumFlow(fiiDii?.history, 5);

  let component = 0;
  let signal = "yellow";
  let value = "Unavailable";
  let action = "Institutional flow is unavailable; do not treat flows as supportive.";
  let materialNegative = false;
  let severeNegative = false;
  let positive = false;

  if (available && latestFii != null) {
    value = `FII ${latestFii >= 0 ? "buy" : "sell"} INR ${Math.abs(Math.round(latestFii)).toLocaleString("en-IN")} Cr`;
  }

  if (!available || latestFii == null) {
    // Missing flow should not become positive evidence.
  } else if (stale) {
    action = "Institutional flow is stale; latest published session is not decision-grade.";
  } else if (latestFii <= opts.severeFiiSellCr || (threeDayFii != null && threeDayFii <= opts.severeFiiThreeDaySellCr) || (fiveDayFii != null && fiveDayFii <= opts.severeFiiFiveDaySellCr)) {
    component = -3;
    signal = "red";
    materialNegative = true;
    severeNegative = true;
    action = "FII selling pressure is severe on latest published flow.";
  } else if (latestFii <= opts.materialFiiSellCr) {
    component = -2;
    signal = "red";
    materialNegative = true;
    action = latestDii != null && latestDii > 0
      ? "FII selling is a drag; DII support offsets some pressure but does not clear the gate."
      : "FII selling is a drag on risk appetite.";
  } else if (latestFii >= opts.strongFiiBuyCr) {
    component = 2;
    signal = "green";
    positive = true;
    action = "Latest published FII flow supports risk appetite.";
  } else if (latestFii >= opts.materialFiiBuyCr) {
    component = 1;
    signal = "green";
    positive = true;
    action = "Latest published FII flow is mildly supportive.";
  } else {
    action = "Institutional flow is close to neutral.";
  }

  return {
    component,
    materialNegative,
    severeNegative,
    positive,
    signal,
    value,
    action,
    sourceQuality: quality({
      available,
      usable,
      stale,
      ageHours: lastUpdatedAge,
      source,
      reason: !available ? "missing_fii_dii" : stale ? "fii_dii_stale" : "fresh",
    }),
    meta: { latestFii, latestDii, threeDayFii, fiveDayFii, sessionAgeDays },
  };
}

function classifyTrackMaturity(trackedPickCount) {
  const total = Math.max(0, Number(trackedPickCount) || 0);
  if (total >= 30) {
    return {
      signal: "neutral",
      value: "Calibrating",
      action: `${total}+ tracked picks; enough history to start calibration, not a market signal.`,
    };
  }
  if (total >= 10) {
    return {
      signal: "neutral",
      value: "Early",
      action: `${total} tracked picks; historical confidence is still developing.`,
    };
  }
  return {
    signal: "yellow",
    value: "Very early",
    action: "< 10 tracked picks; use the backdrop as context only.",
  };
}

function classifyTransition(transition) {
  if (!transition?.signal) {
    return { signal: "neutral", value: "Stable", action: "No recent persisted regime shift." };
  }
  const action = String(transition.signal.action || "WATCH").toUpperCase();
  const value = `${transition.from || "?"} -> ${transition.to || "?"}`;
  return {
    signal: action.includes("TRIM") || action.includes("SELL") ? "yellow" : "neutral",
    value,
    action: `Recent regime transition context: ${action}. ${transition.signal.summary || ""}`.trim(),
  };
}

function legacyVerdictForState({ marketState, score, severe }) {
  if (marketState === MARKET_STATES.CONSTRUCTIVE) {
    if (score >= 6) {
      return {
        verdict: "STRONG BUY DAY",
        verdictColor: "green",
        verdictAction: "Constructive backdrop across fresh market signals; still use stock-level valuation, entry bands, and sizing discipline.",
      };
    }
    return {
      verdict: "BUY DAY",
      verdictColor: "green",
      verdictAction: "Constructive backdrop; use stock-level selection, entry bands, and staged sizing.",
    };
  }
  if (marketState === MARKET_STATES.RISK_OFF) {
    return {
      verdict: severe || score <= -4 ? "STAY OUT" : "CAUTIOUS",
      verdictColor: "red",
      verdictAction: "Risk-off backdrop; new buys need clear confirmation before adding exposure.",
    };
  }
  if (marketState === MARKET_STATES.INSUFFICIENT_EVIDENCE) {
    return {
      verdict: "SELECTIVE",
      verdictColor: "yellow",
      verdictAction: "Fresh evidence is incomplete; do not infer a buying backdrop from partial data.",
    };
  }
  return {
    verdict: score < 0 ? "CAUTIOUS" : "SELECTIVE",
    verdictColor: "yellow",
    verdictAction: score < 0
      ? "Evidence is mixed with active headwinds; new buys need extra confirmation."
      : "Evidence is mixed; use stricter stock selection and smaller tranches.",
  };
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

export function buildMarketVerdict(inputs = {}, options = {}) {
  const nowMs = parseTime(options.now) ?? Date.now();
  const opts = {
    maxMacroAgeHours: 18,
    maxBreadthAgeHours: 0.25,
    maxFiiLastUpdatedHours: 36,
    maxFiiSessionAgeDays: 7,
    materialFiiSellCr: -500,
    severeFiiSellCr: -2500,
    severeFiiThreeDaySellCr: -5000,
    severeFiiFiveDaySellCr: -7500,
    materialFiiBuyCr: 500,
    strongFiiBuyCr: 1500,
    ...options,
  };

  const macro = classifyMacro(inputs.regime || null, opts, nowMs);
  const breadth = classifyBreadth(inputs.marketBreadth || null, opts, nowMs);
  const flow = classifyFlow(inputs.fiiDii || null, opts, nowMs);
  const transition = classifyTransition(inputs.transition || null);
  const track = classifyTrackMaturity(inputs.trackedPickCount);

  const components = {
    macro: macro.component,
    breadth: breadth.component,
    flow: flow.component,
    transition: 0,
    signalMaturity: 0,
  };
  const score = Object.values(components).reduce((sum, n) => sum + (Number(n) || 0), 0);

  const gates = {
    macroMissingOrStale: !macro.sourceQuality.usable,
    severeMacroShock: macro.severe,
    breadthMissing: !breadth.sourceQuality.usable,
    weakBreadth: breadth.weak || breadth.riskOff,
    materialFiiSelling: flow.materialNegative,
    severeFiiPressure: flow.severeNegative,
  };

  const drivers = [];
  const blockers = [];
  const missing = [];
  const downgradeTriggers = [];

  if (macro.favorable) pushUnique(drivers, "Supportive macro regime");
  if (breadth.positive) pushUnique(drivers, "Positive market breadth");
  if (flow.positive) pushUnique(drivers, "Supportive latest published FII flow");

  if (!macro.sourceQuality.available) pushUnique(missing, "Macro regime");
  else if (!macro.sourceQuality.usable) pushUnique(blockers, "Macro regime is stale");
  if (!breadth.sourceQuality.available) pushUnique(missing, "Market breadth");
  else if (!breadth.sourceQuality.usable) pushUnique(blockers, "Market breadth is stale");
  if (!flow.sourceQuality.available) pushUnique(missing, "FII/DII flow");
  else if (!flow.sourceQuality.usable) pushUnique(blockers, "FII/DII flow is stale");
  if (macro.severe) pushUnique(blockers, "Severe macro pressure");
  if (breadth.weak) pushUnique(blockers, "Weak market breadth");
  if (flow.materialNegative) pushUnique(blockers, "FII selling pressure");

  pushUnique(downgradeTriggers, "Macro regime becomes stale or risk-off");
  pushUnique(downgradeTriggers, "Breadth falls below 45% advancing");
  pushUnique(downgradeTriggers, "Latest published FII flow turns materially negative");

  const hasAffirmativeTailwind = macro.favorable || breadth.positive || flow.positive;
  const canBeConstructive =
    macro.sourceQuality.usable &&
    breadth.sourceQuality.usable &&
    breadth.positive &&
    !macro.severe &&
    !flow.materialNegative &&
    hasAffirmativeTailwind &&
    score >= 3;

  let marketState = MARKET_STATES.MIXED;
  if (gates.severeMacroShock || gates.severeFiiPressure || (breadth.riskOff && score <= -4)) {
    marketState = MARKET_STATES.RISK_OFF;
  } else if (gates.macroMissingOrStale) {
    marketState = MARKET_STATES.INSUFFICIENT_EVIDENCE;
  } else if (canBeConstructive) {
    marketState = MARKET_STATES.CONSTRUCTIVE;
  } else {
    marketState = MARKET_STATES.MIXED;
  }

  if (drivers.length === 0) pushUnique(drivers, "No confirmed constructive market backdrop");

  const legacy = legacyVerdictForState({
    marketState,
    score,
    severe: gates.severeMacroShock || gates.severeFiiPressure,
  });

  const signals = [
    {
      name: "Macro Regime",
      signal: macro.signal,
      value: macro.value,
      action: macro.action,
      icon: macro.signal === "green" ? "+" : macro.signal === "red" ? "!" : "-",
    },
    {
      name: "Market Breadth",
      signal: breadth.signal,
      value: breadth.value,
      action: breadth.action,
      icon: breadth.signal === "green" ? "+" : breadth.signal === "red" ? "!" : "-",
    },
    {
      name: "Institutional Flow",
      signal: flow.signal,
      value: flow.value,
      action: flow.action,
      icon: flow.signal === "green" ? "+" : flow.signal === "red" ? "!" : "-",
    },
    {
      name: "Regime Transition",
      signal: transition.signal,
      value: transition.value,
      action: transition.action,
      icon: "-",
    },
    {
      name: "Signal Maturity",
      signal: track.signal,
      value: track.value,
      action: track.action,
      icon: "-",
    },
  ];

  return {
    ...legacy,
    score,
    signals,
    marketState,
    sourceQuality: {
      macro: macro.sourceQuality,
      breadth: breadth.sourceQuality,
      flow: flow.sourceQuality,
    },
    decisionBasis: {
      drivers,
      blockers,
      missing,
      downgradeTriggers,
    },
    components: {
      score,
      ...components,
      hardGates: gates,
      affirmativeTailwinds: {
        macro: macro.favorable,
        breadth: breadth.positive,
        flow: flow.positive,
      },
      meta: {
        macro: macro.meta,
        breadth: breadth.meta,
        flow: flow.meta,
      },
    },
    generatedAt: new Date(nowMs).toISOString(),
  };
}

export { MARKET_STATES };
