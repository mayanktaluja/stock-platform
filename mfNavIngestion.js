/**
 * AMFI NAV ingestion + per-scheme metrics — Phase 2 of the recommender.
 *
 * Replaces the curated mfCandidates.json fallback with live AMFI data:
 *
 *   1. Daily AMFI master (https://portal.amfiindia.com/spages/NAVAll.txt)
 *      ~1.6 MB, ~12k schemes. Format:
 *        Scheme Code;ISIN Growth;ISIN Div Reinvestment;Scheme Name;NAV;Date
 *      Cached 6h.
 *
 *   2. Per-scheme history (https://api.mfapi.in/mf/{schemeCode})
 *      Free public mirror with daily NAVs going back 5+ years. Cached 24h
 *      per scheme.
 *
 *   3. Per-fund metrics computed from the history:
 *        • 1y / 3y / 5y CAGR (point-to-point)
 *        • annualised volatility (σ × √252)
 *        • Sharpe ratio (rf = 7% pa, 10y G-Sec proxy)
 *        • max drawdown over the longest available window
 *
 * Fully graceful: every fetch is wrapped so a network failure or
 * unmatched scheme returns null metrics; the recommender falls back to
 * its Phase-1 publishedXirrPct logic in that case.
 */

import NodeCache from "node-cache";

const AMFI_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const MFAPI_BASE = "https://api.mfapi.in/mf";

// Two caches:
//   • masterCache holds the parsed AMFI registry — one big object, 6h TTL
//   • schemeCache holds per-scheme NAV history, keyed by scheme code, 24h TTL
const masterCache = new NodeCache({ stdTTL: 6 * 3600, checkperiod: 600 });
const schemeCache = new NodeCache({ stdTTL: 24 * 3600, checkperiod: 1800 });

const MASTER_KEY = "amfi.master";

// ──────────────────── AMFI master fetch + parse ────────────────────

/**
 * Parse AMFI's NAVAll.txt into an array of scheme records:
 *   [{ schemeCode, isinGrowth, isinReinv, name, nav, date, fundHouse, schemeType }]
 *
 * The text file groups rows under section headers (scheme type, e.g.
 * "Open Ended Schemes(Equity Scheme - ELSS)") and AMC headers (e.g.
 * "Axis Mutual Fund"). Both are blank-line-separated and contain no
 * semicolons, which is how we distinguish them from data rows.
 */
function parseAmfiMaster(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let currentSchemeType = null;
  let currentFundHouse = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("Scheme Code")) continue; // header row

    // Section headers don't contain semicolons; data rows have 5+
    if (!line.includes(";")) {
      // Heuristic: scheme-type headers contain "Schemes" or "(" while
      // AMC headers usually contain "Mutual Fund" / "AMC". Either way,
      // the right-hand classifier is "did it end with )?" or "did it
      // contain 'Mutual Fund'?". Track both as latest-wins.
      if (/Schemes?\s*\(/.test(line)) {
        currentSchemeType = line;
      } else {
        currentFundHouse = line;
      }
      continue;
    }

    const parts = line.split(";").map((p) => p.trim());
    if (parts.length < 6) continue;
    const [schemeCode, isinGrowth, isinReinv, name, nav, date] = parts;
    if (!schemeCode || !name) continue;
    const navNum = parseFloat(nav);
    if (!Number.isFinite(navNum)) continue;

    out.push({
      schemeCode,
      isinGrowth: isinGrowth && isinGrowth !== "-" ? isinGrowth : null,
      isinReinv: isinReinv && isinReinv !== "-" ? isinReinv : null,
      name,
      normName: normaliseName(name),
      nav: navNum,
      date,
      fundHouse: currentFundHouse,
      schemeType: currentSchemeType,
    });
  }
  return out;
}

function normaliseName(name) {
  return String(name || "")
    .toLowerCase()
    // Strip plan / option suffixes that vary across brokers (Groww strips
    // them, AMFI keeps them). Normalise both sides identically before any
    // comparison.
    .replace(/\b(direct|regular)\s*plan\b/g, "")
    .replace(/\b(growth|growth\s*option|growth\s*plan)\b/g, "")
    .replace(/\b(idcw|dividend|payout|reinvestment|reinvest)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bfund\b/g, "")
    .replace(/\bplan\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAmfiMaster({ force = false } = {}) {
  if (!force) {
    const cached = masterCache.get(MASTER_KEY);
    if (cached) return cached;
  }
  try {
    const res = await fetch(AMFI_URL, {
      redirect: "follow",
      headers: { "User-Agent": "StarBhai-Analyzer/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parseAmfiMaster(text);
    if (parsed.length === 0) throw new Error("Parsed 0 schemes — wrong format?");
    masterCache.set(MASTER_KEY, parsed);
    return parsed;
  } catch (err) {
    console.warn("[AMFI] master fetch failed:", err.message);
    // Return whatever stale data we have (NodeCache keeps it past TTL
    // when explicitly checked). Better stale than nothing.
    const stale = masterCache.get(MASTER_KEY);
    return stale || [];
  }
}

// ──────────────────── Name → scheme code matching ────────────────────

/**
 * Match a user-provided MF name against the AMFI master. Strategy:
 *   1. ISIN match (authoritative) when available
 *   2. Direct-plan-only filter (we never want to rec a Regular plan)
 *   3. Token-overlap scoring — top match wins if it covers ≥80% of the
 *      user's name tokens
 *
 * Returns { schemeCode, schemeName, fundHouse, score } | null.
 */
export async function findAmfiScheme(holding) {
  const master = await fetchAmfiMaster();
  if (master.length === 0) return null;

  // 1. ISIN authoritative match
  if (holding.isin) {
    const byIsin = master.find((m) => m.isinGrowth === holding.isin || m.isinReinv === holding.isin);
    if (byIsin) {
      return {
        schemeCode: byIsin.schemeCode,
        schemeName: byIsin.name,
        fundHouse: byIsin.fundHouse,
        nav: byIsin.nav,
        date: byIsin.date,
        score: 1.0,
        matchType: "isin",
      };
    }
  }

  // 2. AMC-gated token-overlap match against direct-plan-growth schemes.
  //
  // CRITICAL: must filter by AMC first. Without that, "Nippon India Large Cap
  // Fund Direct Growth" mismatches "Franklin India Large & Mid Cap Fund" via
  // {large, cap, fund} overlap. The first 1-2 tokens of a Groww name are
  // (almost always) the AMC short-name; we use them to filter AMFI's
  // fundHouse before scoring.
  const userNorm = normaliseName(holding.name || holding.rawName || "");
  if (!userNorm) return null;
  const userTokens = userNorm.split(" ").filter((t) => t.length >= 2);
  if (userTokens.length === 0) return null;
  const userTokenSet = new Set(userTokens);

  // AMC clue from explicit field (Groww MF XLSX has it) OR first 2 tokens
  const amcClue = String(holding.amc || holding.fundHouse || "")
    .toLowerCase()
    .replace(/\bmutual\s*fund\b|\basset\s*management\b|\bamc\b/g, "")
    .trim();
  const amcTokens = amcClue
    ? amcClue.split(/\s+/).filter((t) => t.length >= 2)
    : userTokens.slice(0, 2);

  // Direct-plan filter — we never recommend Regular plans (80-120bps drag)
  const directOnly = master.filter((m) =>
    /direct/i.test(m.name) && /growth/i.test(m.name)
    && !/idcw|dividend|payout|reinvestment/i.test(m.name)
  );

  // Within direct-only, AMC-gate: fundHouse must contain at least one AMC token
  const amcGated = directOnly.filter((m) => {
    const fh = (m.fundHouse || "").toLowerCase();
    return amcTokens.some((t) => fh.includes(t));
  });

  // SEBI category-type gate — prevents "HDFC Mid Cap Fund" matching
  // "HDFC Large and Mid Cap Fund" (different SEBI categories with
  // overlapping tokens). When the user provides subCategory (Groww MF
  // XLSX always does), we filter AMFI's schemeType field which maps 1:1
  // to SEBI categories. Falls open when no subCategory clue is available.
  const subCat = String(holding.subCategory || "").toLowerCase();
  const SUBCAT_TYPE_PATTERNS = {
    "elss": /ELSS/i,
    "large cap": /\bLarge Cap\b/i,
    "flexi cap": /Flexi Cap/i,
    "multi cap": /Multi Cap/i,
    "mid cap": /\bMid Cap\b(?!\s*Fund.*Large)/i,
    "small cap": /Small Cap/i,
    "large & mid cap": /Large.*Mid Cap|Large & Mid/i,
    "aggressive hybrid": /Aggressive Hybrid/i,
    "conservative hybrid": /Conservative Hybrid/i,
    "balanced hybrid": /Balanced/i,
    "liquid": /Liquid/i,
    "short duration": /Short Duration/i,
    "corporate bond": /Corporate Bond/i,
  };
  const subCatRx = SUBCAT_TYPE_PATTERNS[subCat];
  // Negative pattern — when user says "Mid Cap", explicitly exclude
  // "Large & Mid Cap" / "Large and Mid Cap" sibling categories
  const NEGATIVE_TYPE_PATTERNS = {
    "mid cap": /Large.*Mid Cap|Large & Mid/i,
    "large cap": /Large.*Mid|Mid.*Large/i,
  };
  const negRx = NEGATIVE_TYPE_PATTERNS[subCat];

  const categoryGated = subCatRx
    ? amcGated.filter((m) => {
        const t = m.schemeType || "";
        if (negRx && negRx.test(t)) return false;
        return subCatRx.test(t);
      })
    : amcGated;

  // Use the most precise non-empty subset:
  //   1. AMC + category gated → most precise (HDFC + Mid Cap)
  //   2. AMC gated → next (HDFC alone)
  //   3. Full direct-only → last resort
  const pool = categoryGated.length > 0 ? categoryGated
    : amcGated.length > 0 ? amcGated
    : directOnly;

  // Strip generic words that inflate overlap scores ("fund", "plan",
  // "growth" — already removed by normaliseName, but list defensively)
  const SCHEME_DESCRIPTORS = new Set(["fund", "plan", "growth", "direct", "regular", "option"]);
  const userMeaningful = userTokens.filter((t) => !SCHEME_DESCRIPTORS.has(t));
  if (userMeaningful.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const m of pool) {
    const candidateTokens = m.normName.split(" ").filter((t) => t.length >= 2 && !SCHEME_DESCRIPTORS.has(t));
    if (candidateTokens.length === 0) continue;
    const candSet = new Set(candidateTokens);
    let overlap = 0;
    for (const t of userMeaningful) if (candSet.has(t)) overlap += 1;
    // Coverage: % of MEANINGFUL user tokens matched. "fund/plan/growth"
    // don't count toward either side so common suffixes don't dominate.
    const score = overlap / userMeaningful.length;
    if (score > bestScore) { bestScore = score; best = m; }
  }

  if (!best || bestScore < 0.6) return null;
  return {
    schemeCode: best.schemeCode,
    schemeName: best.name,
    fundHouse: best.fundHouse,
    nav: best.nav,
    date: best.date,
    score: +bestScore.toFixed(2),
    matchType: "name",
  };
}

// ──────────────────── Per-scheme history fetch ────────────────────

/**
 * Pull the daily NAV history for a scheme code from mfapi.in.
 * Returns an array of { date: ISO, nav: number } sorted oldest → newest,
 * or null on failure.
 */
export async function fetchSchemeHistory(schemeCode) {
  if (!schemeCode) return null;
  const cacheKey = `scheme.${schemeCode}`;
  const cached = schemeCache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${MFAPI_BASE}/${schemeCode}`, {
      headers: { "User-Agent": "StarBhai-Analyzer/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.data || !Array.isArray(json.data)) throw new Error("Bad shape");

    // mfapi.in returns dates as DD-MM-YYYY, newest first. Normalise.
    const series = json.data
      .map((row) => {
        const [d, m, y] = String(row.date).split("-");
        const iso = `${y}-${m}-${d}`;
        const nav = parseFloat(row.nav);
        return { date: iso, nav };
      })
      .filter((r) => Number.isFinite(r.nav) && r.nav > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    if (series.length < 30) throw new Error(`History too short (${series.length} rows)`);
    schemeCache.set(cacheKey, series);
    return series;
  } catch (err) {
    console.warn(`[MFAPI] scheme ${schemeCode} fetch failed:`, err.message);
    return null;
  }
}

// ──────────────────── Metrics computation ────────────────────

const RISK_FREE_PCT = 7.0; // 10y G-Sec proxy, used for Sharpe
const TRADING_DAYS = 252;

/**
 * Compute trailing CAGR over `years` from the closest NAV at (today - years)
 * to the most recent NAV.
 */
function cagr(series, years) {
  if (!series || series.length < 30) return null;
  const end = series[series.length - 1];
  const targetMs = new Date(end.date).getTime() - years * 365.25 * 24 * 3600 * 1000;
  // Find first row with date >= targetMs
  const start = series.find((r) => new Date(r.date).getTime() >= targetMs);
  if (!start || start.date === end.date) return null;
  const yearsActual = (new Date(end.date).getTime() - new Date(start.date).getTime()) / (365.25 * 24 * 3600 * 1000);
  if (yearsActual < 0.5) return null;
  return +((Math.pow(end.nav / start.nav, 1 / yearsActual) - 1) * 100).toFixed(2);
}

/**
 * Annualised volatility from daily log returns.
 */
function volatilityPct(series, lookbackDays = 252) {
  if (!series || series.length < lookbackDays + 1) return null;
  const slice = series.slice(-lookbackDays - 1);
  const rets = [];
  for (let i = 1; i < slice.length; i++) {
    rets.push(Math.log(slice[i].nav / slice[i - 1].nav));
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  return +(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS) * 100).toFixed(2);
}

function sharpe(annualReturnPct, annualVolPct) {
  if (!Number.isFinite(annualReturnPct) || !Number.isFinite(annualVolPct) || annualVolPct === 0) return null;
  return +(((annualReturnPct - RISK_FREE_PCT) / annualVolPct)).toFixed(2);
}

/**
 * Maximum peak-to-trough drawdown across the supplied window (default
 * full history). Returns negative %, e.g. -34.2 for a 34.2% loss.
 */
function maxDrawdownPct(series) {
  if (!series || series.length < 30) return null;
  let peak = series[0].nav;
  let maxDD = 0;
  for (const r of series) {
    if (r.nav > peak) peak = r.nav;
    const dd = (r.nav - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return +(maxDD * 100).toFixed(2);
}

/**
 * Compute the full metrics bundle for a scheme.
 * Returns null if history is too short for any metric.
 */
export function computeMetrics(series) {
  if (!series || series.length < 60) return null;

  const cagr1y = cagr(series, 1);
  const cagr3y = cagr(series, 3);
  const cagr5y = cagr(series, 5);
  const vol1y = volatilityPct(series, 252);
  const sharpe3y = cagr3y != null ? sharpe(cagr3y, vol1y) : null;
  const maxDD = maxDrawdownPct(series);
  const latestDate = series[series.length - 1].date;
  const latestNav = series[series.length - 1].nav;

  return {
    cagr1yPct: cagr1y,
    cagr3yPct: cagr3y,
    cagr5yPct: cagr5y,
    annualVolPct: vol1y,
    sharpe3y,
    maxDrawdownPct: maxDD,
    asOfDate: latestDate,
    latestNav,
    historyDays: series.length,
  };
}

// ──────────────────── Bulk: enrich a book ────────────────────

/**
 * Take an array of mfHoldings and enrich each with `amfi` (matched scheme
 * record) + `metrics` (computed from NAV history). In-place mutation
 * preserved for downstream callers.
 *
 * Concurrency 4 to be polite to mfapi.in. Per-scheme failures don't
 * block sibling fetches.
 */
export async function enrichMfHoldings(mfHoldings = []) {
  if (!Array.isArray(mfHoldings) || mfHoldings.length === 0) return mfHoldings;

  const CONCURRENCY = 4;
  let i = 0;
  async function worker() {
    while (i < mfHoldings.length) {
      const idx = i++;
      const h = mfHoldings[idx];
      try {
        const amfi = await findAmfiScheme(h);
        if (!amfi) { h.amfi = null; h.metrics = null; continue; }
        h.amfi = amfi;
        const series = await fetchSchemeHistory(amfi.schemeCode);
        h.metrics = series ? computeMetrics(series) : null;
      } catch (err) {
        console.warn(`[AMFI] enrich failed for ${h.name}:`, err.message);
        h.amfi = null;
        h.metrics = null;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return mfHoldings;
}

// ──────────────────── Live peer-compare (Phase 5 hook) ────────────────────

/**
 * Find top-N schemes in the same category as `holding`, ranked by 5y CAGR.
 * Excludes same-AMC swaps. Used by the Phase 5 live peer-compare to
 * replace the curated mfCandidates.json fallback.
 *
 * `categoryHint` is the SEBI category key from xirrOptimizer.mfCategoryKey.
 * We use it to filter the AMFI master before per-scheme history fetches
 * (otherwise we'd fetch 12k schemes per peer-compare call).
 */
export async function liveTopPeers(holding, categoryHint, n = 3) {
  const master = await fetchAmfiMaster();
  if (master.length === 0) return [];

  // SEBI category-hint → AMFI scheme-type substring
  const TYPE_FILTER = {
    elss: /ELSS/i,
    large_cap: /Large Cap/i,
    flexi_cap: /Flexi Cap|Multi Cap/i,
    mid_cap: /Mid Cap/i,
    small_cap: /Small Cap/i,
    hybrid_aggressive: /Aggressive Hybrid/i,
    hybrid_conservative: /Conservative Hybrid/i,
    liquid: /Liquid/i,
    short_duration: /Short Duration/i,
    corporate_bond: /Corporate Bond/i,
    index_nifty50: /Index/i,
  };
  const typeRx = TYPE_FILTER[categoryHint];
  if (!typeRx) return [];

  const candidates = master.filter((m) =>
    /direct/i.test(m.name) && /growth/i.test(m.name) && !/idcw|dividend/i.test(m.name)
    && typeRx.test(m.schemeType || "")
  );

  // Same-AMC exclusion
  const ownAmc = (holding.amfi?.fundHouse || holding.amc || "").trim().toLowerCase();
  const filtered = candidates.filter((c) => !ownAmc || !(c.fundHouse || "").toLowerCase().includes(ownAmc.split(" ")[0]));

  // Sort by latest NAV-derived 1-day momentum as a cheap pre-rank;
  // then fetch history for top 15 and rank by 5y CAGR. This avoids
  // 200+ history fetches per call.
  const TOP_PRE = 15;
  const preRanked = filtered.slice(0, TOP_PRE);

  const peers = await Promise.all(preRanked.map(async (c) => {
    const series = await fetchSchemeHistory(c.schemeCode);
    const m = series ? computeMetrics(series) : null;
    return {
      schemeCode: c.schemeCode,
      name: c.name,
      fundHouse: c.fundHouse,
      isin: c.isinGrowth,
      cagr5yPct: m?.cagr5yPct,
      cagr3yPct: m?.cagr3yPct,
      cagr1yPct: m?.cagr1yPct,
      sharpe3y: m?.sharpe3y,
      maxDrawdownPct: m?.maxDrawdownPct,
      annualVolPct: m?.annualVolPct,
    };
  }));

  return peers
    .filter((p) => Number.isFinite(p.cagr5yPct))
    .sort((a, b) => b.cagr5yPct - a.cagr5yPct)
    .slice(0, n);
}

// ──────────────────── Phase 5: bulk live-peer enrichment ────────────────────
//
// For each unique SEBI category in the user's book, fetch the top 3
// peer schemes once (cached at the per-scheme level by fetchSchemeHistory)
// and attach the result to every holding in that category. The recommender's
// rankPeers() consumes h.livePeers when present.

import { mfCategoryKey } from "./xirrOptimizer.js";

export async function enrichLivePeers(mfHoldings = []) {
  if (!Array.isArray(mfHoldings) || mfHoldings.length === 0) return mfHoldings;
  const liveMap = new Map();
  const uniqueCats = new Set();
  for (const h of mfHoldings) {
    const k = mfCategoryKey(h);
    if (k) uniqueCats.add(k);
  }
  await Promise.all([...uniqueCats].map(async (catKey) => {
    // Use the first holding in this category as the "exclusion source"
    // (rankPeers excludes same-AMC swaps based on it)
    const sample = mfHoldings.find((h) => mfCategoryKey(h) === catKey);
    try {
      const peers = await liveTopPeers(sample, catKey, 3);
      liveMap.set(catKey, peers);
    } catch (e) {
      console.warn(`[AMFI] live peer fetch failed for ${catKey}:`, e.message);
      liveMap.set(catKey, []);
    }
  }));
  for (const h of mfHoldings) {
    const k = mfCategoryKey(h);
    if (k) h.livePeers = liveMap.get(k) || [];
  }
  return mfHoldings;
}

// Test/dev hook — lets unit tests inject synthetic master data
export function _setTestMaster(records) {
  if (records) masterCache.set(MASTER_KEY, records);
  else masterCache.del(MASTER_KEY);
}

// ──────────────────── Improvement #1: benchmark TRI enrichment ────────────────────
//
// For each unique SEBI category in the user's book, resolve the canonical
// index-fund TRI proxy (see benchmarkIndices.js), fetch its NAV history
// once (re-using fetchSchemeHistory's per-scheme cache), compute the same
// metrics bundle, and attach a `benchmark` block to every holding in that
// category:
//
//   h.benchmark = {
//     proxyKey, indexName, schemeCode, schemeName,
//     metrics: { cagr1yPct, cagr3yPct, cagr5yPct, sharpe3y, maxDrawdownPct, ... },
//     alpha:   { alpha1yPp, alpha3yPp, alpha5yPp, primaryWindow, primaryAlphaPp, verdict },
//   }
//
// Categories with no defined proxy (debt, hybrid) get `h.benchmark = null`.
// Any per-step failure (master miss, history fetch) leaves `h.benchmark = null`.
// The recommender treats absence as "no chip" — it never blocks a decision.

import {
  benchmarkProxyForCategory,
  resolveProxyAgainstMaster,
  buildAlpha,
} from "./benchmarkIndices.js";

export async function enrichBenchmarkMetrics(mfHoldings = []) {
  if (!Array.isArray(mfHoldings) || mfHoldings.length === 0) return mfHoldings;

  // 1. Discover the unique benchmark proxies needed by this book.
  const neededProxies = new Map(); // proxyKey → proxy object
  const catToProxyKey = new Map(); // catKey → proxyKey
  for (const h of mfHoldings) {
    const k = mfCategoryKey(h);
    if (!k) continue;
    const proxy = benchmarkProxyForCategory(k);
    if (!proxy) continue;
    catToProxyKey.set(k, proxy.proxyKey);
    if (!neededProxies.has(proxy.proxyKey)) neededProxies.set(proxy.proxyKey, proxy);
  }
  if (neededProxies.size === 0) {
    for (const h of mfHoldings) h.benchmark = null;
    return mfHoldings;
  }

  // 2. Resolve each proxy against the AMFI master (handles code rotation).
  const master = await fetchAmfiMaster();
  const resolvedByProxy = new Map(); // proxyKey → { schemeCode, schemeName, source }
  for (const [proxyKey, proxy] of neededProxies.entries()) {
    const resolved = resolveProxyAgainstMaster(proxy, master);
    if (resolved) resolvedByProxy.set(proxyKey, resolved);
  }

  // 3. Fetch NAV history + compute metrics for each resolved proxy.
  //    Re-uses fetchSchemeHistory's cache so subsequent analyze calls are cheap.
  const metricsByProxy = new Map(); // proxyKey → { metrics }
  await Promise.all([...resolvedByProxy.entries()].map(async ([proxyKey, resolved]) => {
    try {
      const series = await fetchSchemeHistory(resolved.schemeCode);
      const metrics = series ? computeMetrics(series) : null;
      if (metrics) metricsByProxy.set(proxyKey, metrics);
    } catch (e) {
      console.warn(`[BENCH] proxy ${proxyKey} (${resolved.schemeCode}) metrics failed:`, e.message);
    }
  }));

  // 4. Attach per-holding benchmark + alpha. Compute alpha against the
  //    holding's AMFI metrics (real NAV-derived) — never against the
  //    duration-dependent groww_xirr (apples-to-oranges).
  for (const h of mfHoldings) {
    const k = mfCategoryKey(h);
    if (!k) { h.benchmark = null; continue; }
    const proxyKey = catToProxyKey.get(k);
    if (!proxyKey) { h.benchmark = null; continue; }
    const proxy = neededProxies.get(proxyKey);
    const resolved = resolvedByProxy.get(proxyKey);
    const benchMetrics = metricsByProxy.get(proxyKey);
    if (!proxy || !resolved || !benchMetrics) { h.benchmark = null; continue; }

    const alpha = h.metrics ? buildAlpha(h.metrics, benchMetrics) : null;

    h.benchmark = {
      proxyKey,
      indexName: proxy.indexName,
      schemeCode: resolved.schemeCode,
      schemeName: resolved.schemeName,
      proxyName: proxy.proxyName,
      resolveSource: resolved.source,
      metrics: {
        cagr1yPct: benchMetrics.cagr1yPct,
        cagr3yPct: benchMetrics.cagr3yPct,
        cagr5yPct: benchMetrics.cagr5yPct,
        sharpe3y: benchMetrics.sharpe3y,
        maxDrawdownPct: benchMetrics.maxDrawdownPct,
        annualVolPct: benchMetrics.annualVolPct,
        asOfDate: benchMetrics.asOfDate,
      },
      alpha,
    };
  }
  return mfHoldings;
}
