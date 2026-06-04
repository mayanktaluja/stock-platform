import { computeV4Score, verdictV4FromScore } from "./swsScoringV4.js";

const MIN_MCAP_INR = 5_000_000_000;
const MIN_PEER_CHECK_COUNT = 5;
const MIN_SCORE_DELTA = 6;
const MIN_SHADOW_SCORE = 47;
const MIN_AFFECTED_PILLARS = 2;
const MIN_IMPUTED_CHECKS = 3;
const MAX_PILLAR_UPLIFT = 4;
const SECTION_LIMIT = 500;

const V4_PILLAR_KEYS = {
  Health: ["financial_health", "health"],
  Future: ["future", "future_growth"],
  Value: ["valuation", "value"],
  Past: ["past", "past_performance"],
};

const PILLAR_LABEL_TO_SNOW = {
  Health: "financial_health",
  Future: "future",
  Value: "valuation",
  Past: "past",
};

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const round1 = (v) => isFiniteNumber(v) ? Math.round(v * 10) / 10 : null;
const round3 = (v) => isFiniteNumber(v) ? Math.round(v * 1000) / 1000 : null;

function canonicalTicker(stock) {
  return String(stock?.ticker || stock?.overview?.ticker || "").trim().toUpperCase();
}

export function classifySnowflakeGapMarketCap(mcapInr) {
  const mcap = Number(mcapInr);
  if (!Number.isFinite(mcap) || mcap <= 0) return null;
  if (mcap >= 5_000_000_000_000) return "mega";
  if (mcap >= 1_000_000_000_000) return "large";
  if (mcap >= 200_000_000_000) return "mid";
  if (mcap >= 50_000_000_000) return "small";
  if (mcap >= MIN_MCAP_INR) return "micro";
  return "sub_500cr";
}

function normaliseKeyPart(value) {
  const clean = value == null ? "" : String(value).trim();
  return clean || null;
}

export function snowflakeGapPeerKeys(stock) {
  const ov = stock?.overview || {};
  const audit = ov.pe_benchmark_audit || {};
  const cap = normaliseKeyPart(ov.market_cap_band) || classifySnowflakeGapMarketCap(ov.market_cap_inr);
  if (!cap) return [];
  const keys = [];
  const push = (scope, value, label) => {
    const clean = normaliseKeyPart(value);
    if (!clean) return;
    const key = `${scope}:${clean}|cap:${cap}`;
    if (!keys.some((k) => k.key === key)) keys.push({ key, scope, label: label || clean, market_cap_bucket: cap });
  };
  push("industry_code", audit.sws_industry_api?.industry_code, audit.internal_median?.industry_name || audit.sws_industry_api?.source?.name);
  push("industry_code", audit.internal_median?.industry_code, audit.internal_median?.industry_name);
  push("industry", stock?.industry || ov.industry || ov.primary_industry?.name || ov.pe_benchmark_source?.industry_name, stock?.industry || ov.industry || ov.primary_industry?.name || ov.pe_benchmark_source?.industry_name);
  push("sector", stock?.sector || ov.primary_industry?.name, stock?.sector || ov.primary_industry?.name);
  return keys;
}

function checksByPillar(matrix) {
  const out = {};
  for (const check of matrix?.checks || []) {
    if (!check || !V4_PILLAR_KEYS[check.pillar]) continue;
    if (!out[check.pillar]) out[check.pillar] = [];
    out[check.pillar].push(check);
  }
  return out;
}

function getSnowPillar(snow, pillar) {
  const keys = V4_PILLAR_KEYS[pillar] || [];
  for (const key of keys) {
    const value = snow?.[key];
    if (isFiniteNumber(value)) return value;
  }
  return 0;
}

function setSnowAliases(snow, pillar, value) {
  const rounded = round1(Math.max(0, Math.min(6, value)));
  if (pillar === "Health") {
    snow.financial_health = rounded;
    snow.health = rounded;
  } else if (pillar === "Future") {
    snow.future = rounded;
    snow.future_growth = rounded;
  } else if (pillar === "Value") {
    snow.valuation = rounded;
    snow.value = rounded;
  } else if (pillar === "Past") {
    snow.past = rounded;
    snow.past_performance = rounded;
  }
}

export function buildSnowflakeGapPeerAverages(stocks, opts = {}) {
  const minPeerCheckCount = opts.minPeerCheckCount ?? MIN_PEER_CHECK_COUNT;
  const buckets = new Map();
  for (const stock of stocks || []) {
    const ticker = canonicalTicker(stock);
    const matrix = stock?.overview?.snowflake_check_matrix;
    if (!Array.isArray(matrix?.checks)) continue;
    for (const peerKey of snowflakeGapPeerKeys(stock)) {
      if (!buckets.has(peerKey.key)) {
        buckets.set(peerKey.key, {
          ...peerKey,
          min_peer_check_count: minPeerCheckCount,
          checks: new Map(),
        });
      }
      const bucket = buckets.get(peerKey.key);
      for (const check of matrix.checks) {
        if (!check || !V4_PILLAR_KEYS[check.pillar] || check.available !== true) continue;
        const result = check.result === "pass" ? 1 : check.result === "fail" ? 0 : null;
        if (result == null) continue;
        const checkKey = `${matrix.health_check_set || "Health"}|${check.pillar}|${check.name}`;
        if (!bucket.checks.has(checkKey)) {
          bucket.checks.set(checkKey, {
            pillar: check.pillar,
            name: check.name,
            title: check.title || check.name,
            pass_sum: 0,
            count: 0,
            tickers: new Set(),
          });
        }
        const entry = bucket.checks.get(checkKey);
        entry.pass_sum += result;
        entry.count += 1;
        if (ticker) entry.tickers.add(ticker);
      }
    }
  }

  const out = { min_peer_check_count: minPeerCheckCount, by_key: {} };
  for (const [key, bucket] of buckets.entries()) {
    const checks = {};
    for (const [checkKey, entry] of bucket.checks.entries()) {
      if (entry.count < minPeerCheckCount) continue;
      checks[checkKey] = {
        pillar: entry.pillar,
        name: entry.name,
        title: entry.title,
        pass_rate: round3(entry.pass_sum / entry.count),
        count: entry.count,
        tickers: [...entry.tickers],
      };
    }
    if (Object.keys(checks).length === 0) continue;
    out.by_key[key] = {
      scope: bucket.scope,
      label: bucket.label,
      market_cap_bucket: bucket.market_cap_bucket,
      checks,
    };
  }
  return out;
}

function findPeerBucket(stock, averages, missingChecks, selfTicker) {
  const buckets = averages?.by_key || {};
  const healthSet = stock?.overview?.snowflake_check_matrix?.health_check_set || "Health";
  for (const peerKey of snowflakeGapPeerKeys(stock)) {
    const bucket = buckets[peerKey.key];
    if (!bucket) continue;
    const resolved = [];
    let ok = true;
    for (const check of missingChecks) {
      const checkKey = `${healthSet}|${check.pillar}|${check.name}`;
      const avg = bucket.checks?.[checkKey];
      if (!avg || !isFiniteNumber(avg.pass_rate) || avg.count < averages.min_peer_check_count) {
        ok = false;
        break;
      }
      const selfIncluded = selfTicker && Array.isArray(avg.tickers) && avg.tickers.includes(selfTicker);
      const effectiveCount = avg.count - (selfIncluded ? 1 : 0);
      if (effectiveCount < averages.min_peer_check_count) {
        ok = false;
        break;
      }
      resolved.push({
        pillar: check.pillar,
        name: check.name,
        title: check.title || check.name,
        peer_pass_rate: avg.pass_rate,
        peer_count: effectiveCount,
      });
    }
    if (ok) return { ...bucket, key: peerKey.key, resolved_checks: resolved };
  }
  return null;
}

export function computeSnowflakeGapLabForStock(stock, universe, opts = {}) {
  const minScoreDelta = opts.minScoreDelta ?? MIN_SCORE_DELTA;
  const minShadowScore = opts.minShadowScore ?? MIN_SHADOW_SCORE;
  const minAffectedPillars = opts.minAffectedPillars ?? MIN_AFFECTED_PILLARS;
  const minImputedChecks = opts.minImputedChecks ?? MIN_IMPUTED_CHECKS;
  const maxPillarUplift = opts.maxPillarUplift ?? MAX_PILLAR_UPLIFT;
  const matrix = stock?.overview?.snowflake_check_matrix;
  if (!Array.isArray(matrix?.checks)) return null;

  const byPillar = checksByPillar(matrix);
  const missingChecks = Object.entries(byPillar)
    .flatMap(([pillar, checks]) => checks.filter((check) => check.insufficient === true && check.result === "no_data").map((check) => ({ ...check, pillar })));
  if (missingChecks.length < minImputedChecks) return null;

  const affectedPillars = [...new Set(missingChecks.map((check) => check.pillar))];
  if (affectedPillars.length < minAffectedPillars && missingChecks.length < minImputedChecks) return null;

  const selfTicker = canonicalTicker(stock);
  const peerBucket = findPeerBucket(stock, universe?.snowflakeGapPeerAverages, missingChecks, selfTicker);
  if (!peerBucket) return null;

  const baseSnow = stock?.overview?.snowflake || {};
  const shadowSnow = { ...baseSnow };
  const pillarUplifts = {};
  for (const pillar of affectedPillars) {
    const peerLift = peerBucket.resolved_checks
      .filter((check) => check.pillar === pillar)
      .reduce((sum, check) => sum + check.peer_pass_rate, 0);
    const uplift = Math.min(maxPillarUplift, peerLift);
    const base = getSnowPillar(baseSnow, pillar);
    const next = Math.min(6, base + uplift);
    if (next > base) {
      setSnowAliases(shadowSnow, pillar, next);
      pillarUplifts[PILLAR_LABEL_TO_SNOW[pillar]] = round1(next - base);
    }
  }
  if (Object.keys(pillarUplifts).length === 0) return null;

  const shadowStock = {
    ...stock,
    overview: {
      ...(stock.overview || {}),
      snowflake: shadowSnow,
    },
  };
  const scored = computeV4Score(shadowStock, {
    universe,
    surveillanceFlag: stock?.v4_breakdown?.surveillance || false,
  });
  const shadowScore = scored.v4_score_100;
  const canonicalScore = stock?.v4_score_100;
  if (!isFiniteNumber(shadowScore) || !isFiniteNumber(canonicalScore)) return null;
  const scoreDelta = round1(shadowScore - canonicalScore);
  if (scoreDelta < minScoreDelta || shadowScore < minShadowScore) return null;
  const shadowVerdict = verdictV4FromScore(shadowScore);

  return {
    label: "Experimental shadow V4",
    caveat: "For review, not a recommendation. Canonical V4 remains the source of record.",
    canonical_v4_score_100: round1(canonicalScore),
    canonical_v4_verdict: stock.v4_verdict || null,
    shadow_v4_score_100: round1(shadowScore),
    shadow_v4_verdict: shadowVerdict,
    score_delta: scoreDelta,
    shadow_snowflake: shadowSnow,
    shadow_v4_breakdown: scored.v4_breakdown,
    affected_pillars: affectedPillars.map((p) => PILLAR_LABEL_TO_SNOW[p]).filter(Boolean),
    imputed_checks_count: missingChecks.length,
    peer_scope: peerBucket.scope,
    peer_key: peerBucket.key,
    peer_label: peerBucket.label || null,
    market_cap_bucket: peerBucket.market_cap_bucket || null,
    confidence: missingChecks.length >= 6 ? "MEDIUM" : "LOW",
    pillar_uplifts: pillarUplifts,
    imputed_checks: peerBucket.resolved_checks.map((check) => ({
      pillar: PILLAR_LABEL_TO_SNOW[check.pillar] || check.pillar,
      name: check.name,
      title: check.title,
      peer_pass_rate: check.peer_pass_rate,
      peer_count: check.peer_count,
    })),
  };
}

export function buildSnowflakeGapLabSection(scoredStocks, opts = {}) {
  const pickCardFields = opts.pickCardFields;
  if (typeof pickCardFields !== "function") {
    throw new Error("buildSnowflakeGapLabSection requires pickCardFields");
  }
  const universe = opts.universe || {};
  const averages = universe.snowflakeGapPeerAverages || buildSnowflakeGapPeerAverages(scoredStocks, opts);
  const labUniverse = { ...universe, snowflakeGapPeerAverages: averages };
  const audit = {
    experimental: true,
    available: true,
    caveat: "Experimental screen for SWS data gaps. Canonical V4 remains the source of record.",
    peer_scope: "industry_or_sector_plus_market_cap_bucket",
    min_peer_check_count: averages.min_peer_check_count,
    min_score_delta: opts.minScoreDelta ?? MIN_SCORE_DELTA,
    min_shadow_score: opts.minShadowScore ?? MIN_SHADOW_SCORE,
    candidates_scanned: Array.isArray(scoredStocks) ? scoredStocks.length : 0,
    rejected: {},
  };

  const isPureBseCode = (ticker) => typeof ticker === "string" && /^\d+$/.test(ticker);
  const candidates = [];
  for (const stock of scoredStocks || []) {
    const ticker = canonicalTicker(stock);
    const mcap = Number(stock?.overview?.market_cap_inr);
    const surveillance = stock?.v4_breakdown?.surveillance || stock?.v2_breakdown?.surveillance || null;
    const reject = (reason) => {
      audit.rejected[reason] = (audit.rejected[reason] || 0) + 1;
    };
    if (!ticker || isPureBseCode(ticker)) { reject("ticker_hygiene"); continue; }
    if (!Number.isFinite(mcap) || mcap < MIN_MCAP_INR) { reject("mcap_floor"); continue; }
    if (surveillance?.list === "GSM") { reject("gsm"); continue; }
    const lab = computeSnowflakeGapLabForStock(stock, labUniverse, opts);
    if (!lab) { reject("lab_gate"); continue; }
    const card = pickCardFields(stock);
    card.snowflake_gap_lab = lab;
    candidates.push(card);
  }

  candidates.sort((a, b) => {
    const da = a.snowflake_gap_lab?.score_delta || 0;
    const db = b.snowflake_gap_lab?.score_delta || 0;
    if (db !== da) return db - da;
    return (b.snowflake_gap_lab?.shadow_v4_score_100 || 0) - (a.snowflake_gap_lab?.shadow_v4_score_100 || 0);
  });
  const items = candidates.slice(0, opts.limit ?? SECTION_LIMIT);
  audit.candidates_selected = items.length;
  audit.candidates_total = candidates.length;
  return { items, audit, averages };
}
