// Position sizer — the Conviction Pyramid + Kelly-fractional overlay.
// Maps a sorted list of scored candidates onto a 6-position Pillar 1
// (1 Anchor + 2 High + 3 Conviction) + 5 Catalyst + 3 Sector tilt.
//
// Per-portfolio caps (hard, non-negotiable):
//   - per_symbol_pct ≤ 14 (the High tier; Anchor sits at 12)
//   - per_sector_pct ≤ 35
//   - per_promoter_group_pct ≤ 20
//   - per_mcap_band_pct ≤ 70
//
// Kelly is advisory only — clamped to 25% fraction and used as a
// SHRINK signal (Kelly says "I'm not confident this can pay 4×, take a
// smaller bite") — never as a permission to scale beyond tier_pct.

export const PILLAR_ALLOC = Object.freeze({
  anchor_pct: 12,
  high_pct: 14,
  high_max: 2,
  conviction_pct: 8,
  conviction_max: 3,
  catalyst_pct: 4,
  catalyst_max: 5,
  sector_pct: 3.6,
  sector_max: 3,
  cash_pct: 5,
});

export const HARD_CAPS = Object.freeze({
  per_symbol_pct: 14,
  per_sector_pct: 35,
  per_promoter_group_pct: 20,
  per_mcap_band_pct: 70,
  kelly_max_fraction: 0.25,
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Kelly fraction from win-rate + payoff: f = (W·p - (1-p)·L) / W, clamped.
// Returns 0 when inputs are weak — caller will fall back to tier_pct.
export function kellyFraction({ win_rate, avg_win_mult, avg_loss_mult }) {
  if (!isFiniteNumber(win_rate) || win_rate <= 0 || win_rate >= 1) return 0;
  if (!isFiniteNumber(avg_win_mult) || avg_win_mult <= 0) return 0;
  if (!isFiniteNumber(avg_loss_mult) || avg_loss_mult <= 0) return 0;
  const f = (avg_win_mult * win_rate - (1 - win_rate) * avg_loss_mult) / avg_win_mult;
  return Math.max(0, Math.min(HARD_CAPS.kelly_max_fraction, f));
}

// Sizes a single position. tier_pct is the rated tier ceiling (e.g. 14 for
// High). Kelly tightens but never loosens.
export function sizePosition({ portfolio_value_inr, tier_pct, kelly_inputs = null } = {}) {
  if (!isFiniteNumber(portfolio_value_inr) || portfolio_value_inr <= 0) return 0;
  if (!isFiniteNumber(tier_pct) || tier_pct <= 0) return 0;
  const tier_inr = Number((portfolio_value_inr * (tier_pct / 100)).toFixed(2));
  if (!kelly_inputs) return tier_inr;
  const k = kellyFraction(kelly_inputs);
  if (k <= 0) return tier_inr;
  const kelly_inr = Number((portfolio_value_inr * k).toFixed(2));
  return Math.min(tier_inr, kelly_inr);
}

function bucketByKey(positions, keyFn) {
  const map = new Map();
  for (const p of positions) {
    const key = keyFn(p);
    if (!key) continue;
    const cur = map.get(key) || { count: 0, value_inr: 0 };
    cur.count += 1;
    cur.value_inr += p.value_inr || 0;
    map.set(key, cur);
  }
  return map;
}

function pctOf(value, total) {
  if (!isFiniteNumber(total) || total <= 0) return 0;
  return Number(((value / total) * 100).toFixed(2));
}

// Checks whether adding `candidate` to the portfolio would breach any
// hard cap. Returns { allowed, reason, projected_exposure }.
export function evaluateAddCandidate({ candidate, current_positions, portfolio_value_inr } = {}) {
  if (!candidate || !isFiniteNumber(candidate.value_inr) || candidate.value_inr <= 0) {
    return { allowed: false, reason: "invalid_candidate_size" };
  }
  if (!isFiniteNumber(portfolio_value_inr) || portfolio_value_inr <= 0) {
    return { allowed: false, reason: "invalid_portfolio_value" };
  }

  const positions = Array.isArray(current_positions) ? current_positions : [];

  // Per-symbol — duplicate entry blocked (size up via re-evaluation, not stacking).
  if (positions.some((p) => p.ticker === candidate.ticker)) {
    return { allowed: false, reason: "symbol_already_held" };
  }

  // Per-symbol pct
  const candidate_pct = pctOf(candidate.value_inr, portfolio_value_inr);
  if (candidate_pct > HARD_CAPS.per_symbol_pct) {
    return { allowed: false, reason: `per_symbol_${candidate_pct}pct_>_${HARD_CAPS.per_symbol_pct}pct` };
  }

  // Per-sector pct
  const sectorMap = bucketByKey([...positions, { ...candidate }], (p) => p.sector);
  const sectorAgg = sectorMap.get(candidate.sector) || { value_inr: 0 };
  const sector_pct = pctOf(sectorAgg.value_inr, portfolio_value_inr);
  if (sector_pct > HARD_CAPS.per_sector_pct) {
    return { allowed: false, reason: `sector_${sector_pct}pct_>_${HARD_CAPS.per_sector_pct}pct` };
  }

  // Per-promoter-group pct (only checked when candidate.promoter_group set)
  if (candidate.promoter_group) {
    const groupMap = bucketByKey([...positions, { ...candidate }], (p) => p.promoter_group);
    const groupAgg = groupMap.get(candidate.promoter_group) || { value_inr: 0 };
    const group_pct = pctOf(groupAgg.value_inr, portfolio_value_inr);
    if (group_pct > HARD_CAPS.per_promoter_group_pct) {
      return { allowed: false, reason: `promoter_group_${group_pct}pct_>_${HARD_CAPS.per_promoter_group_pct}pct` };
    }
  }

  // Per-mcap-band pct
  if (candidate.mcap_band) {
    const mcapMap = bucketByKey([...positions, { ...candidate }], (p) => p.mcap_band);
    const mcapAgg = mcapMap.get(candidate.mcap_band) || { value_inr: 0 };
    const mcap_pct = pctOf(mcapAgg.value_inr, portfolio_value_inr);
    if (mcap_pct > HARD_CAPS.per_mcap_band_pct) {
      return { allowed: false, reason: `mcap_band_${mcap_pct}pct_>_${HARD_CAPS.per_mcap_band_pct}pct` };
    }
  }

  return {
    allowed: true,
    reason: "ok",
    projected_exposure: {
      per_symbol_pct: candidate_pct,
      per_sector_pct: sector_pct,
    },
  };
}

// Builds the full target portfolio from a sorted candidate list. The list
// must come from multibaggerScorer + filtered to non-HARD_REJECT verdicts,
// sorted descending by score_0_100. Returns an array of { tier, ticker,
// value_inr, blocked_reasons[] }.
export function buildTargetPortfolio({ candidates, portfolio_value_inr, kelly_inputs = null } = {}) {
  if (!isFiniteNumber(portfolio_value_inr) || portfolio_value_inr <= 0) return [];
  if (!Array.isArray(candidates)) return [];

  const accepted = [];
  const tiers = [
    { tier: "anchor", pct: PILLAR_ALLOC.anchor_pct, max: 1 },
    { tier: "high", pct: PILLAR_ALLOC.high_pct, max: PILLAR_ALLOC.high_max },
    { tier: "conviction", pct: PILLAR_ALLOC.conviction_pct, max: PILLAR_ALLOC.conviction_max },
  ];

  for (const t of tiers) {
    let taken = 0;
    while (taken < t.max) {
      const next = candidates.find((c) => !accepted.some((a) => a.ticker === c.ticker));
      if (!next) break;
      const size_inr = sizePosition({ portfolio_value_inr, tier_pct: t.pct, kelly_inputs });
      const candidate = {
        ticker: next.ticker,
        sector: next.sector,
        mcap_band: next.mcap_band || null,
        promoter_group: next.promoter_group || null,
        value_inr: size_inr,
        tier: t.tier,
      };
      const verdict = evaluateAddCandidate({
        candidate,
        current_positions: accepted,
        portfolio_value_inr,
      });
      if (verdict.allowed) {
        accepted.push(candidate);
        taken += 1;
      } else {
        // Skip and continue to next candidate at the same tier
        const idx = candidates.indexOf(next);
        if (idx >= 0) candidates.splice(idx, 1);
        // (we mutate the input list — caller should clone if reuse needed)
        if (candidates.length === 0) break;
      }
    }
  }

  return accepted;
}
