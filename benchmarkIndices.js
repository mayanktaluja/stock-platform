/**
 * Benchmark indices — Improvement #1 (Nifty TRI alpha).
 *
 * Maps each SEBI category to a canonical Direct-Growth index fund whose
 * NAV history serves as a TRI proxy. The Direct plan's CAGR is the index
 * TRI minus ~15-25bps TER — i.e. the realistic passive alternative an
 * investor actually has access to. That's the right benchmark for a
 * mutual-fund investor (not the raw, frictionless TRI series).
 *
 * Why proxy via index funds rather than NSE TRI CSVs:
 *   • Re-uses the existing AMFI ingestion (fetchSchemeHistory + cache)
 *   • Free, no scraping
 *   • Same metrics math (CAGR, Sharpe, max-DD) as user holdings
 *   • Apples-to-apples — comparing NAV-derived numbers on both sides
 *
 * Resolution strategy:
 *   1. Look up by AMFI scheme code first (cached, O(1))
 *   2. If the code has rotated, fall back to name-pattern search against
 *      the AMFI master (fundHouse + name regex)
 *   3. Persist whichever code resolved into module-level cache so we
 *      don't re-resolve every call
 *
 * Hybrid + debt categories deliberately have NO benchmark — comparing a
 * conservative-hybrid fund to Nifty 50 TRI is a category error and would
 * mislead the user. Those holdings get `benchmark: null` and the
 * recommender skips alpha computation for them.
 */

// ──────────────────── Proxy registry ────────────────────
//
// Scheme codes are AMFI's canonical identifiers — extremely stable
// (rotations are rare), but we still keep a name-pattern fallback for
// resilience. Names below are exactly as AMFI publishes them in NAVAll.txt.

const PROXY_REGISTRY = {
  nifty50_tri: {
    indexName: "Nifty 50 TRI",
    schemeCode: "120716",
    proxyName: "UTI Nifty 50 Index Fund - Direct Plan - Growth Option",
    proxyAmcPattern: /UTI/i,
    namePattern: /UTI.*Nifty\s*50.*Index.*Direct.*Growth/i,
    notes: "Index fund TRI proxy ≈ Nifty 50 TRI − ~17bps TER",
  },
  nifty500_tri: {
    indexName: "Nifty 500 TRI",
    schemeCode: "147623",
    proxyName: "Motilal Oswal Nifty 500 Index Fund - Direct Plan - Growth",
    proxyAmcPattern: /Motilal/i,
    namePattern: /Motilal.*Nifty\s*500.*Index.*Direct.*Growth/i,
    notes: "Index fund TRI proxy for multi-cap / flexi exposures",
  },
  midcap150_tri: {
    indexName: "Nifty Midcap 150 TRI",
    schemeCode: "147625",
    proxyName: "Motilal Oswal Nifty Midcap 150 Index Fund - Direct Plan - Growth",
    proxyAmcPattern: /Motilal/i,
    namePattern: /Motilal.*Nifty\s*Midcap\s*150.*Index.*Direct.*Growth/i,
    notes: "Pure mid-cap TRI proxy",
  },
  smallcap250_tri: {
    indexName: "Nifty Smallcap 250 TRI",
    schemeCode: "147622",
    proxyName: "Nippon India Nifty Smallcap 250 Index Fund - Direct Plan - Growth",
    proxyAmcPattern: /Nippon/i,
    namePattern: /Nippon.*Nifty\s*Smallcap\s*250.*Index.*Direct.*Growth/i,
    notes: "Pure small-cap TRI proxy",
  },
};

// ──────────────────── Category → proxy map ────────────────────
//
// Keys match xirrOptimizer.mfCategoryKey output. Categories without an
// entry get no benchmark (debt, hybrid — see file header for rationale).

const CATEGORY_TO_PROXY = {
  large_cap:     "nifty50_tri",
  index_nifty50: "nifty50_tri",
  flexi_cap:     "nifty500_tri",
  // ELSS schemes are tax-saver multi-cap with a 3y lock-in. Their stock-
  // picking universe is the Nifty 500 (not just Nifty 50), so Nifty 500
  // TRI is the correct passive bar — same universe, no tax-saver wrapper.
  elss:          "nifty500_tri",
  mid_cap:       "midcap150_tri",
  small_cap:     "smallcap250_tri",
};

export function benchmarkProxyForCategory(catKey) {
  if (!catKey) return null;
  const proxyKey = CATEGORY_TO_PROXY[catKey];
  if (!proxyKey) return null;
  return { proxyKey, ...PROXY_REGISTRY[proxyKey] };
}

export function listAllBenchmarkProxies() {
  return Object.entries(PROXY_REGISTRY).map(([key, val]) => ({ proxyKey: key, ...val }));
}

// Public for tests + UI reference
export { PROXY_REGISTRY, CATEGORY_TO_PROXY };

// ──────────────────── Resolver (master-aware) ────────────────────
//
// Given the AMFI master (array from fetchAmfiMaster), confirm a proxy's
// scheme code is still valid. If not, search by name pattern + AMC and
// return the resolved code. Caller persists the result.
//
// Returns { schemeCode, schemeName, source: "registry"|"pattern" } | null.

export function resolveProxyAgainstMaster(proxy, master) {
  if (!proxy || !Array.isArray(master) || master.length === 0) return null;

  // 1. Confirm registered scheme code still exists in master
  const byCode = master.find((m) => m.schemeCode === proxy.schemeCode);
  if (byCode) {
    return {
      schemeCode: byCode.schemeCode,
      schemeName: byCode.name,
      source: "registry",
    };
  }

  // 2. Fall back to AMC + name pattern. This handles AMFI re-issuing a
  //    code (rare) without breaking the analyzer.
  const candidates = master.filter((m) => {
    if (!proxy.proxyAmcPattern.test(m.fundHouse || "")) return false;
    if (!proxy.namePattern.test(m.name || "")) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  // Prefer the shortest name (excludes "(Sub Plan)" / regional variants)
  candidates.sort((a, b) => a.name.length - b.name.length);
  return {
    schemeCode: candidates[0].schemeCode,
    schemeName: candidates[0].name,
    source: "pattern",
  };
}

// ──────────────────── Alpha math ────────────────────
//
// Trivial but kept here so the interpretation is documented next to the
// proxy registry. Alpha is REPORTED return less benchmark return — an
// observation, not a quality signal on its own (a fund can lag because
// the manager's mandate is defensive in a strong bull run).

export function alphaPp(holdingMetric, benchmarkMetric) {
  if (!Number.isFinite(holdingMetric) || !Number.isFinite(benchmarkMetric)) return null;
  return +(holdingMetric - benchmarkMetric).toFixed(2);
}

/**
 * Build per-window alpha + a verdict tag.
 *
 *   { alpha1yPp, alpha3yPp, alpha5yPp, primaryWindow, primaryAlphaPp, verdict }
 *
 * primaryWindow prefers 3y (SEBI-RA convention for cross-cycle comparison),
 * falls back to 5y if 3y missing, then 1y. Verdict is purely descriptive:
 * BEATS / TRACKS (±150bps) / LAGS. The recommender consumes this as a
 * non-decisive observation chip.
 */
export function buildAlpha(holdingMetrics, benchmarkMetrics) {
  if (!holdingMetrics || !benchmarkMetrics) return null;
  const a1 = alphaPp(holdingMetrics.cagr1yPct, benchmarkMetrics.cagr1yPct);
  const a3 = alphaPp(holdingMetrics.cagr3yPct, benchmarkMetrics.cagr3yPct);
  const a5 = alphaPp(holdingMetrics.cagr5yPct, benchmarkMetrics.cagr5yPct);

  let primaryWindow = null;
  let primaryAlphaPp = null;
  if (a3 != null) { primaryWindow = "3y"; primaryAlphaPp = a3; }
  else if (a5 != null) { primaryWindow = "5y"; primaryAlphaPp = a5; }
  else if (a1 != null) { primaryWindow = "1y"; primaryAlphaPp = a1; }

  let verdict = null;
  if (primaryAlphaPp != null) {
    if (primaryAlphaPp >= 1.5) verdict = "BEATS";
    else if (primaryAlphaPp <= -1.5) verdict = "LAGS";
    else verdict = "TRACKS";
  }

  return {
    alpha1yPp: a1,
    alpha3yPp: a3,
    alpha5yPp: a5,
    primaryWindow,
    primaryAlphaPp,
    verdict,
  };
}
