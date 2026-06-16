// Rationale narrator — turns a scored candidate's breakdown + diagnostics
// into plain-English reasoning: why it was picked (bull drivers), the
// specific bear case for THIS stock, and the modeled target multiple.
//
// Plus buildStrategyExplainer(): the top-level "how picks + sectors are
// chosen" methodology and a LIVE pre-mortem grounded in the current
// portfolio state. Pure functions — no I/O, no hype. The honest framing
// (can't guarantee 5x, base rate <10%) is intentional and load-bearing.

function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

// Map a component key + its value (+ diagnostics) to a bull-case phrase.
function bullPhrase(key, val, c) {
  const d = c.diagnostics || {};
  switch (key) {
    case "inflection": {
      const infl = d.inflection || {};
      if (infl.loss_to_profit) return "Swung from losses to profit this year — the single strongest multibagger signal.";
      if (isNum(infl.latest_growth_pct) && infl.latest_growth_pct > 0) {
        const cagr = isNum(infl.three_year_cagr_pct) ? `, ${infl.three_year_cagr_pct}% 3-yr CAGR` : "";
        return `Profit grew ${infl.latest_growth_pct}% YoY${cagr} — earnings inflecting up.`;
      }
      return "Earnings momentum building.";
    }
    case "v3_future": return `Strong SWS future-growth pillar (${val}/12).`;
    case "v3_valuation": return `Cheap on valuation vs peers (${val}/10).`;
    case "fv_upside": {
      const tier = val >= 10 ? "Deep (≥50%)" : val >= 8 ? "Sizeable (≥30%)" : val >= 5 ? "Moderate (≥15%)" : "Some";
      return `${tier} upside to analyst fair value.`;
    }
    case "mcap": return val >= 10
      ? "Micro-cap (<₹500Cr) — maximum room to compound."
      : val >= 8 ? "Small-cap (₹500Cr–₹5kCr) — room to multi-bag."
      : "Mid-cap — moderate headroom.";
    case "sector_tailwind": {
      const t = d.tailwind || {};
      return `${c.sector || "Sector"} carries a regime-aligned tailwind (${val} pts).`;
    }
    case "momentum": return "Positive, real price momentum (not imputed).";
    case "liquidity_bonus": return "Liquid enough to enter and exit cleanly.";
    case "health": return "Healthy balance sheet underpinning the story.";
    case "forward_growth": return "Analysts forecast continued double-digit growth.";
    case "story_bonus": {
      const tags = (d.story && d.story.tags) || [];
      return tags.length ? `Thematic story: ${tags.join(", ").toLowerCase()}.` : "Carries a policy/thematic tailwind.";
    }
    default: return null;
  }
}

// Pick the top N positive drivers, in descending contribution order.
function topDrivers(breakdown, n = 4) {
  return Object.entries(breakdown || {})
    .filter(([k, v]) => isNum(v) && v > 0 && !k.startsWith("penalty_"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

export function narrateCandidate(c, { validated = false } = {}) {
  if (!c || typeof c !== "object") return null;
  const b = c.breakdown || {};
  const d = c.diagnostics || {};

  // Bull case — top drivers as phrases.
  const why_picked = topDrivers(b, 4)
    .map(([k, v]) => bullPhrase(k, v, c))
    .filter(Boolean);

  // Bear case — specific to this stock's weak spots.
  const bear = [];
  if (c.gate_blocked && Array.isArray(c.gate_reasons) && c.gate_reasons.length) {
    bear.push(`Hard-gated: ${c.gate_reasons.join("; ")}.`);
  }
  if (d.tailwind && d.tailwind.cohort_exhausted) {
    bear.push("Its sector is already up >80% over the past year — you may be buying late into a re-rated cohort.");
  }
  // Inflection-dominant concentration risk.
  const drivers = topDrivers(b, 1);
  if (drivers.length && drivers[0][0] === "inflection") {
    bear.push("The thesis leans heavily on the earnings turnaround holding — a one-off item or a single soft quarter would re-rate it down fast.");
  }
  if (isNum(b.momentum) && b.momentum <= 3) {
    bear.push("Thin/short trading history — momentum is unproven, which makes sizing and clean exits harder.");
  }
  if (isNum(b.health) && b.health < 2.5) {
    bear.push("Weaker balance-sheet health — fragile if growth stalls.");
  }
  if (isNum(b.fv_upside) && b.fv_upside <= 3) {
    bear.push("Already near analyst fair value — limited margin of safety on entry.");
  }
  if (d.inflection && d.inflection.one_off_flagged) {
    bear.push("Recent earnings may include a one-off item — the inflection score was capped accordingly.");
  }
  // Always-true baseline for a concentrated small-cap bet.
  bear.push("Concentrated small-cap position — expect 40%+ drawdowns en route; the stop policy is what protects the book.");

  const target = c.verdict === "5X_CANDIDATE"
    ? (validated
      ? "Validated top-tier asymmetric candidate; still requires entry, liquidity, and stop checks."
      : "Model-implied top-tier asymmetric candidate; not empirically validated as a 5x forecast.")
    : c.verdict === "HIGH_CONVICTION"
    ? (validated
      ? "Validated high-conviction asymmetric candidate; entry quality still decides sizing."
      : "Model-implied high-conviction candidate; treat as research until validation and entry checks pass.")
    : c.verdict === "WATCH"
    ? "Watchlist — needs a stronger catalyst or a better entry before sizing up."
    : "Below the entry bar.";

  return {
    why_picked,
    bear_case: bear,
    target_multiple_rationale: target,
    one_line: why_picked[0] || "Composite score across 12 factors.",
  };
}

// Compute which component is most often the #1 driver across the top picks.
function dominantDriver(candidates) {
  const counts = {};
  let total = 0;
  for (const c of candidates || []) {
    const d = topDrivers(c.breakdown, 1);
    if (!d.length) continue;
    counts[d[0][0]] = (counts[d[0][0]] || 0) + 1;
    total += 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top || !total) return null;
  return { key: top[0], count: top[1], total };
}

const COMPONENT_LABELS = {
  inflection: "earnings inflection (turnaround / >50% profit growth)",
  v3_future: "SWS future-growth pillar",
  v3_valuation: "valuation discount",
  fv_upside: "fair-value upside",
  mcap: "small-cap headroom",
  sector_tailwind: "sector tailwind",
  momentum: "price momentum",
};

export function buildStrategyExplainer({ scores, validated = false } = {}) {
  const regime = scores?.macro_regime || "unknown";
  const fiveX = scores?.five_x_count ?? 0;
  const hc = scores?.high_conviction_count ?? 0;
  const universe = scores?.universe_size ?? 0;
  const top = scores?.top_50 || [];
  const dom = dominantDriver(top);

  const domLine = dom
    ? `Today the ranking is concentrated on ${COMPONENT_LABELS[dom.key] || dom.key}: it's the #1 driver for ${dom.count}/${dom.total} of the top picks. That's a coherent thesis (turnarounds are where multibaggers come from) but it means the picks are correlated — if that signal mean-reverts, several wobble together.`
    : "No candidates ranked yet.";

  return {
    schema_version: "multibagger-strategy-explainer-v1",
    headline: validated
      ? `Evidence gate passed. ${fiveX} of ${universe} stocks cleared the top asymmetric bar today; ${hc} more are high-conviction.`
      : `Unvalidated research screen. ${fiveX} of ${universe} stocks cleared the model-implied top asymmetric bar today; ${hc} more are high-conviction.`,
    how_stocks_are_picked: [
      "Every stock gets a 0–100 score summing 12 factors: earnings inflection (17), SWS future-growth (12) + valuation (10) pillars, fair-value upside (10), market-cap headroom (10), sector tailwind (17), momentum (10), liquidity, balance-sheet health, forecast growth, and a thematic-story bonus.",
      domLine,
    ],
    how_sectors_are_picked: [
      `Sector weight = base affinity × macro-regime multiplier × cohort-freshness. Current regime: ${regime}.`,
      "Cohort-freshness zeroes out any sector already up >80% over the trailing year — the model refuses to buy the top of a re-rated cohort (e.g. the defense-PSU 2023 trap).",
    ],
    what_gets_removed: [
      "Promoter pledge ≥25% or +10pp in 90 days",
      "Illiquid: 30-day traded value < 5× the intended position (can't exit)",
      "GSM surveillance listing",
      "Going-concern / audit-qualified flags in recent news",
      "Data completeness < 40%",
    ],
    the_5x_mechanism: [
      "₹1L is split 64% multibagger core / 20% catalyst trades / 11% sector tilt / 5% cash.",
      "The core is 6 concentrated bets (Anchor 12% + 2×14% + 3×8%). The arithmetic: 6 positions need sum-of-multiples ≥ 30 to 5x the book — e.g. 2 stocks at 10x + 1 at 5x + 1 at 3x + 2 flat. You need 2–3 genuine multibaggers out of 6, not all six.",
    ],
    pre_mortem: [
      `Most likely miss — the regime never turned: small-caps stayed flat/fell. The regime gate should have parked capital in cash + NIFTYBEES, so the realistic bad case is "protected capital, made ~15%," not ruin.`,
      "The inflection signal was a head-fake: turnaround picks had one-off earnings or a soft quarter; correlated picks → correlated disappointment.",
      "Concentration blew up: a pledge/fraud event on the 12% Anchor is −10.8% in a day. Gates reduce but don't eliminate this.",
      "We were right but got shaken out: the median 10-bagger has a ~56% drawdown en route; a gap-down through a stop still cuts a future winner.",
      "The base rate simply held: portfolio-level 5x is a top 2–8% outcome even with everything right. Honest expected case is ~1.5–2.5x in a favorable year, with a ~5–10% tail chance of 5x — and a real chance of a flat/negative year.",
    ],
    honest_note: "This cannot guarantee 5x, and any system that claims to is lying. What it does: maximize the probability of 5x conditional on a favorable regime, and bound the downside (regime gate + −40% NIFTYBEES failsafe). The pre-mortem is the feature, not a disclaimer.",
  };
}
