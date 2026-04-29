// Layer-5 peer-substitute discovery for the SWS holding engine.
//
// For every covered holding, scan picks-latest.json for same-sector peers
// that are NOT in the user's current portfolio, score-better-than the
// holding (v3 higher), and within a comparable market-cap band so the
// substitution makes sense from a portfolio-construction view.
//
// Used in two places:
//   1. PR 3 conviction engine doesn't read this directly — peer is a
//      portfolio-context surface, not a per-holding decision input.
//   2. swsPortfolioAggregate basket builder + UI surface peer chips
//      next to Reduction calls ("trim ANGELONE → rotate to BSE").

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { num } from "./swsScoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKS_LATEST = path.resolve(__dirname, "..", "data", "sws", "picks-latest.json");

let _picksCache = null;
function _loadPicks() {
  let stat;
  try { stat = fs.statSync(PICKS_LATEST); } catch { return null; }
  if (_picksCache && _picksCache.mtimeMs === stat.mtimeMs) return _picksCache.data;
  try {
    const raw = JSON.parse(fs.readFileSync(PICKS_LATEST, "utf-8"));
    _picksCache = { mtimeMs: stat.mtimeMs, data: raw };
    return raw;
  } catch { return null; }
}

// Build a flat candidate pool from all sections of picks-latest. We
// dedupe on ticker and prefer the highest v3 record when the same name
// shows up in multiple sections (e.g. top_ranked_30 + quality_growth).
function _buildCandidatePool() {
  const picks = _loadPicks();
  if (!picks?.sections) return [];
  const byTicker = new Map();
  for (const sectionRows of Object.values(picks.sections)) {
    if (!Array.isArray(sectionRows)) continue;
    for (const r of sectionRows) {
      if (!r?.ticker) continue;
      const existing = byTicker.get(r.ticker);
      const v3 = num(r.v3_score_100 ?? r.v3_score, 0);
      if (!existing || v3 > num(existing.v3_score_100 ?? existing.v3_score, 0)) {
        byTicker.set(r.ticker, r);
      }
    }
  }
  return [...byTicker.values()];
}

function _mcapBandMatch(candidateMcap, anchorMcap) {
  if (!anchorMcap || !candidateMcap) return true; // can't filter, allow
  const ratio = candidateMcap / anchorMcap;
  return ratio >= 0.3 && ratio <= 3.0;
}

function _peerWhy(p, anchorV3) {
  const v3 = num(p.v3_score_100 ?? p.v3_score, 0);
  const verdict = p.v3_verdict || p.verdict || "—";
  const upside = num(p.upside_pct, null);
  const bits = [`v3 ${v3.toFixed(0)} vs your ${num(anchorV3, 0).toFixed(0)}`, verdict];
  if (upside != null) bits.push(`${upside >= 0 ? "+" : ""}${upside.toFixed(0)}% to FV`);
  return bits.join(" · ");
}

// Per-holding peer-substitute discovery. Inputs:
//   ticker          — anchor holding ticker (e.g. "ANGELONE")
//   sector          — anchor sector (matched against pick.sector,
//                                    case-insensitive)
//   sws_v3          — anchor v3 score
//   market_cap_inr  — anchor market cap (for size-band filter)
//   heldTickers     — Set of all currently-held tickers (excluded from
//                     candidate pool)
//
// Returns { available, peers: [{ticker, name, sector, v3_score,
// market_cap_inr, why }], top_peer } or { available: false, ... }.
export function findPeerSubstitutes({ ticker, sector, sws_v3, market_cap_inr, heldTickers }) {
  if (!sector || sws_v3 == null) {
    return { available: false, reason: "missing sector or score", peers: [], top_peer: null };
  }
  const pool = _buildCandidatePool();
  if (pool.length === 0) {
    return { available: false, reason: "picks-latest unavailable", peers: [], top_peer: null };
  }
  const sectorLower = String(sector).toLowerCase().trim();
  const heldSet = heldTickers instanceof Set ? heldTickers : new Set(heldTickers || []);
  const candidates = pool
    .filter((p) => p.ticker !== ticker && !heldSet.has(p.ticker))
    .filter((p) => String(p.sector || "").toLowerCase().trim() === sectorLower)
    .filter((p) => num(p.v3_score_100 ?? p.v3_score, 0) > num(sws_v3, 0))
    .filter((p) => _mcapBandMatch(num(p.market_cap_inr, null), num(market_cap_inr, null)))
    .sort((a, b) => num(b.v3_score_100 ?? b.v3_score, 0) - num(a.v3_score_100 ?? a.v3_score, 0))
    .slice(0, 3);

  const peers = candidates.map((p) => ({
    ticker: p.ticker,
    name: p.name || p.ticker,
    sector: p.sector,
    v3_score: num(p.v3_score_100 ?? p.v3_score, 0),
    market_cap_inr: p.market_cap_inr ?? null,
    snowflake_total: p.snowflake_total ?? null,
    sws_url: p.sws_url ?? null,
    why: _peerWhy(p, sws_v3),
  }));

  return {
    available: true,
    peers,
    top_peer: peers[0] || null,
    candidate_pool_size: pool.length,
  };
}

// Sector-removal guardrail used by the basket builder. Given a list of
// holdings the user is being told to Reduction/EXIT, flag any sector that
// would be left at zero exposure.
export function detectSectorWipeout({ scoredHoldings, reductionTickers }) {
  const reductionSet = reductionTickers instanceof Set ? reductionTickers : new Set(reductionTickers || []);
  const bySector = new Map();
  for (const h of scoredHoldings) {
    const sec = h.sector || "Unclassified";
    if (!bySector.has(sec)) bySector.set(sec, { sector: sec, total: 0, reducing: 0, holdings: [] });
    const row = bySector.get(sec);
    row.total += 1;
    row.holdings.push(h.sws?.ticker || h.symbol);
    if (reductionSet.has(h.sws?.ticker || h.symbol)) row.reducing += 1;
  }
  const wipeouts = [];
  for (const row of bySector.values()) {
    if (row.total > 0 && row.reducing === row.total) {
      wipeouts.push({
        sector: row.sector,
        affected_count: row.total,
        affected_tickers: row.holdings,
        warning: `Trimming all ${row.total} ${row.sector} holdings leaves portfolio with zero exposure to this sector.`,
      });
    }
  }
  return wipeouts;
}
