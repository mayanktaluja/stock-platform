import crypto from "node:crypto";

export const PIT_SNAPSHOT_SCHEMA_VERSION = "multibagger-pit-snapshot-v1";
export const PIT_ROW_SCHEMA_VERSION = "multibagger-pit-row-v1";
export const PIT_SELECTION = Object.freeze({
  TOP_N: 200,
  ALWAYS_INCLUDE_VERDICTS: Object.freeze(["5X_CANDIDATE", "HIGH_CONVICTION"]),
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value === undefined ? null : value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v === undefined || typeof v === "function") continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function finiteNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function tickerKey(row) {
  return stringOrNull(row?.ticker || row?.symbol)?.toUpperCase() || null;
}

function verdictRank(v) {
  if (v === "5X_CANDIDATE") return 3;
  if (v === "HIGH_CONVICTION") return 2;
  if (v === "WATCH") return 1;
  return 0;
}

function sortScoredCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const scoreDelta = (finiteNumberOrNull(b?.score_0_100) ?? -Infinity) - (finiteNumberOrNull(a?.score_0_100) ?? -Infinity);
    if (scoreDelta !== 0) return scoreDelta;
    const verdictDelta = verdictRank(b?.verdict) - verdictRank(a?.verdict);
    if (verdictDelta !== 0) return verdictDelta;
    return (tickerKey(a) || "").localeCompare(tickerKey(b) || "");
  });
}

function dedupeByTicker(sorted) {
  const seen = new Set();
  const rows = [];
  for (const row of sorted) {
    const ticker = tickerKey(row);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    rows.push(row);
  }
  return rows;
}

function sourceHashMap(sources) {
  const out = {};
  for (const [name, value] of Object.entries(sources || {})) {
    if (value === undefined) continue;
    out[name] = sha256Json(value);
  }
  return out;
}

function selectionReason({ rank, verdict }) {
  const reasons = [];
  if (rank <= PIT_SELECTION.TOP_N) reasons.push("top_200");
  if (PIT_SELECTION.ALWAYS_INCLUDE_VERDICTS.includes(verdict)) reasons.push("high_conviction_plus");
  return reasons;
}

function deepFreeze(obj) {
  if (!obj || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) deepFreeze(value);
  return obj;
}

export function buildPitSnapshotRows(scoredCandidates, {
  snapshot_iso,
  source_hashes = {},
  include_raw_candidate = false,
} = {}) {
  const sorted = dedupeByTicker(sortScoredCandidates(Array.isArray(scoredCandidates) ? scoredCandidates : []));
  const rows = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const candidate = sorted[i];
    const rank = i + 1;
    const verdict = stringOrNull(candidate?.verdict) || "UNKNOWN";
    const reasons = selectionReason({ rank, verdict });
    if (reasons.length === 0) continue;
    const ticker = tickerKey(candidate);
    const entryPrice = finiteNumberOrNull(
      candidate?.entry_price_inr ??
      candidate?.current_price_inr ??
      candidate?.overview?.current_price_inr ??
      candidate?.last_close_inr
    );
    const row = {
      schema_version: PIT_ROW_SCHEMA_VERSION,
      snapshot_iso: snapshot_iso || null,
      ticker,
      rank,
      selection_reasons: reasons,
      verdict,
      score_0_100: finiteNumberOrNull(candidate?.score_0_100),
      sector: stringOrNull(candidate?.sector),
      entry_price_inr: entryPrice,
      market_cap_inr: finiteNumberOrNull(candidate?.market_cap_inr ?? candidate?.overview?.market_cap_inr),
      source_hashes: { ...source_hashes },
      candidate_hash: sha256Json(candidate),
      frozen_candidate: include_raw_candidate ? canonicalize(candidate) : null,
    };
    rows.push(deepFreeze(row));
  }
  return deepFreeze(rows);
}

export function buildPitSnapshot(scoredCandidates, {
  snapshot_iso = new Date().toISOString(),
  generated_by = "multibagger-pit-snapshot",
  sources = {},
  include_raw_candidate = false,
} = {}) {
  const source_hashes = sourceHashMap(sources);
  const rows = buildPitSnapshotRows(scoredCandidates, {
    snapshot_iso,
    source_hashes,
    include_raw_candidate,
  });
  const snapshot = {
    schema_version: PIT_SNAPSHOT_SCHEMA_VERSION,
    snapshot_iso,
    snapshot_date_iso: String(snapshot_iso || "").slice(0, 10) || null,
    generated_by,
    selection_policy: {
      top_n: PIT_SELECTION.TOP_N,
      always_include_verdicts: [...PIT_SELECTION.ALWAYS_INCLUDE_VERDICTS],
    },
    source_hashes,
    universe_size: Array.isArray(scoredCandidates) ? scoredCandidates.length : 0,
    row_count: rows.length,
    rows,
    snapshot_hash: null,
  };
  snapshot.snapshot_hash = sha256Json({ ...snapshot, snapshot_hash: null });
  return deepFreeze(snapshot);
}
