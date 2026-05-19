// Action generator — rules engine that converts portfolio state +
// candidate pipeline + risk verdicts into a tight 1-3 action list for
// the "Today's Action Card" surface. Pure function.
//
// Priority order (only the highest-priority blocking action surfaces if
// any is critical):
//   1. EXIT actions from risk manager (stops, failsafe)
//   2. TRIM actions from trailing-band ratchets
//   3. BUY actions from candidate pipeline + open slots
//   4. NO_ACTION with next-event hint when nothing to do
//
// Caller must supply:
//   - mtm: output of multibaggerPortfolioService.markToMarket()
//   - risk_verdicts: per-position evaluatePosition output, keyed by ticker
//   - portfolio_risk: evaluatePortfolioRisk output (state + actions)
//   - regime_open: pillarsOpen() result — block BUYs when shut
//   - candidates: sorted scored candidates (multibaggerScorer output)
//   - catalyst_slate: buildCatalystSlate result
//   - next_event_hint: optional { date_iso, label } for empty-state copy

const MAX_ACTIONS = 3;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function tierOpenSlots(positions) {
  const counts = { anchor: 0, high: 0, conviction: 0 };
  for (const p of positions || []) {
    if (p.tier in counts) counts[p.tier] += 1;
  }
  return {
    anchor: 1 - counts.anchor,
    high: 2 - counts.high,
    conviction: 3 - counts.conviction,
  };
}

export function generateActions({
  mtm,
  risk_verdicts = {},
  portfolio_risk = null,
  regime_open = null,
  candidates = [],
  catalyst_slate = null,
  next_event_hint = null,
} = {}) {
  const actions = [];

  // Priority 1: portfolio-level failsafe / amber state
  if (portfolio_risk?.state === "RED") {
    actions.push({
      priority: "critical",
      type: "FAILSAFE",
      headline: "Portfolio drawdown ≥40% — liquidate to NIFTYBEES + cash",
      detail: portfolio_risk.actions.join("; "),
    });
    return { actions, regime_blocked: false, max: MAX_ACTIONS };
  }
  if (portfolio_risk?.state === "AMBER") {
    actions.push({
      priority: "critical",
      type: "DEFEND",
      headline: "Portfolio drawdown ≥35% — liquidate Catalyst + Sector tilt; concentrate to Anchor + High",
      detail: portfolio_risk.actions.join("; "),
    });
  }

  // Priority 2: per-position stops + trims
  if (mtm?.positions) {
    for (const pos of mtm.positions) {
      const verdict = risk_verdicts[pos.ticker];
      if (!verdict) continue;
      if (verdict.breached && actions.length < MAX_ACTIONS) {
        actions.push({
          priority: "critical",
          type: "EXIT_STOP",
          ticker: pos.ticker,
          headline: `Stop hit ${pos.ticker} — exit at ₹${pos.current_price_inr}`,
          detail: `Entry ₹${pos.avg_entry_price_inr} · gain ${verdict.gain_pct}% · band ${verdict.band_label}`,
        });
      } else if (verdict.recommended_trim_pct > 0 && actions.length < MAX_ACTIONS) {
        actions.push({
          priority: "high",
          type: "TRIM",
          ticker: pos.ticker,
          trim_pct: verdict.recommended_trim_pct,
          headline: `Trim ${pos.ticker} ${Math.round(verdict.recommended_trim_pct * 100)}% — gain ${verdict.gain_pct}%`,
          detail: `Trailing band ${verdict.band_label} · stop ₹${verdict.stop_price_inr}`,
        });
      }
    }
  }

  // Priority 3: BUY recommendations from candidate pipeline + open slots
  const regimeBlocked = regime_open ? !regime_open.pillar1_anchor?.open && !regime_open.pillar1_high?.open : false;
  if (!regimeBlocked && actions.length < MAX_ACTIONS) {
    const slots = tierOpenSlots(mtm?.positions);
    const heldTickers = new Set((mtm?.positions || []).map((p) => p.ticker));
    const queue = candidates.filter((c) => !heldTickers.has(c.ticker) && c.verdict !== "HARD_REJECT");
    for (const c of queue) {
      if (actions.length >= MAX_ACTIONS) break;
      let tier = null;
      if (slots.anchor > 0 && c.verdict === "5X_CANDIDATE") tier = "anchor";
      else if (slots.high > 0 && (c.verdict === "5X_CANDIDATE" || c.verdict === "HIGH_CONVICTION")) tier = "high";
      else if (slots.conviction > 0 && ["5X_CANDIDATE", "HIGH_CONVICTION", "WATCH"].includes(c.verdict)) tier = "conviction";
      if (!tier) continue;
      slots[tier] -= 1;
      actions.push({
        priority: "normal",
        type: "BUY",
        ticker: c.ticker,
        tier,
        headline: `Buy ${c.ticker} (${tier}, score ${c.score_0_100})`,
        detail: c.breakdown ? Object.entries(c.breakdown).filter(([_, v]) => v > 0).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(" · ") : "",
      });
    }
  }

  // Empty state
  if (actions.length === 0) {
    actions.push({
      priority: "info",
      type: "NO_ACTION",
      headline: "No actions today.",
      detail: regimeBlocked
        ? `Pillar 1 entries are regime-blocked (${regime_open?.pillar1_anchor?.reasons?.join(", ") || "see regime gate"}).`
        : next_event_hint
          ? `Next catalyst: ${next_event_hint.label} on ${next_event_hint.date_iso}.`
          : "Pipeline is quiet. Review weekly.",
    });
  }

  return { actions: actions.slice(0, MAX_ACTIONS), regime_blocked: regimeBlocked, max: MAX_ACTIONS };
}

export const ACTION_GENERATOR_CONFIG = Object.freeze({ MAX_ACTIONS });
