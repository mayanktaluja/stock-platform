import { computeSizeMultiplier, resolveSizingTier } from "../riskLab/positionSizing.js";

/**
 * reactionPlaybook.js
 *
 * The 9-cell BEAT/INLINE/MISS × RAISE/MAINTAIN/CUT trading matrix.
 *
 * Two public entry points:
 *
 *   buildPreviewPlaybook(event)
 *     → Pre-result. Picks a primary cell from the predicted verdict
 *       (assuming guidance maintained — the modal case) and surfaces
 *       alternate-scenario branches the user should pre-arm for.
 *
 *   buildT1Playbook(event, actualResult, guidanceTone)
 *     → Post-result. Deterministic — given the actual outcome and
 *       guidance tone (RAISE/MAINTAIN/CUT), returns the cell's full
 *       trade plan.
 *
 * Output schema is intentionally identical for both — each plan is a
 * `{ stance, time_horizon, entry, stoploss, target, rationale,
 *    confidence, falsification }` shape — so the UI can render
 * either with the same component.
 *
 * The 9-cell matrix lives at the top of the file as a single
 * declarative table so a reviewer can audit all outputs in one screen.
 * Cell logic mirrors my SEBI-RA pattern matrix (see earnings strategy
 * note in /Users/.../plans/) — adjusting any cell here is a trading-
 * desk-level decision and should not be done casually.
 *
 * Hard rules:
 *   1. INSUFFICIENT_DATA inputs return a no-trade plan, never a guess.
 *   2. Confidence in the playbook is independent of predictor
 *      confidence. A BEAT_RAISE cell is HIGH confidence even when
 *      the predictor only reached 60% — once the result + guidance
 *      are KNOWN, the cell is what it is.
 *   3. No leverage suggestions. No options strategies. V1 is pure
 *      cash-equity stance recommendations. Margin/leverage is
 *      personal and SEBI-RA scope.
 */

export const PLAYBOOK_VERSION = "earnings-playbook-v1-2026-05";

// ────────── The matrix ──────────
//
// Each cell is keyed `${verdict}_${guidance}`:
//
//   verdict:  BEAT | INLINE | MISS
//   guidance: RAISE | MAINTAIN | CUT
//
// Cells encode my SEBI-RA pattern matrix. Each cell yields a single
// trading plan; the UI surfaces it as the post-result T+1 angle.
// Pre-result preview branches surface 1–3 most-likely cells.

const PLAYBOOK_MATRIX = {
  // ── BEAT row ──
  BEAT_RAISE: {
    label: "Beat + Raise (strongest)",
    stance: "Follow the break — primary swing setup",
    time_horizon: "swing_5d",
    entry: "Buy on T+1 close after concall, OR on first pullback to opening 30-min low if it holds",
    stoploss: "Below T+1 opening 30-min low (~1.5–2.5% below entry)",
    target: "+5–8% over T+2 to T+5; partial out at +4% if 1-day momentum stalls",
    rationale: "Beat + guidance raise = analyst PT upgrades T+1–T+3, sustained drift. Strongest cell in the matrix.",
    confidence: "HIGH",
    falsification: [
      "Sector rolls over the same week",
      "Macro shock (FOMC/RBI/geopolitical) within T+5",
      "Block-deal flow reveals a large institutional seller post-print",
    ],
    leans: "long",
  },
  BEAT_MAINTAIN: {
    label: "Beat + Maintain (often a fade)",
    stance: "Conditional — fade gap-up if pre-runup was sharp; otherwise small follow",
    time_horizon: "intraday_or_swing_2d",
    entry:
      "If pre-runup >5% in 5d AND gap-up >3%: SHORT/skip-long the open, fade to VWAP. " +
      "Else: small long on opening 30-min consolidation breakout, exit T+2 close.",
    stoploss: "Long: 1.5% below entry. Fade: above gap-up high.",
    target: "Long: fill of any gap-up, no chase. Fade: pre-result close.",
    rationale: "Most common 'sell on news' setup. Beat is fully priced if smart money already ran the stock; maintained guidance gives no fresh catalyst.",
    confidence: "MEDIUM",
    falsification: [
      "Concall flags an unscheduled positive catalyst (large order, capex announcement)",
      "Sector beats broadly the same day → tide lifts even fade setups",
    ],
    leans: "fade_or_neutral",
  },
  BEAT_CUT: {
    label: "Beat + Cut (the trap)",
    stance: "Fade — short the open or sit out longs",
    time_horizon: "intraday",
    entry: "Short the gap-up open; if no gap, short the rejection at any opening rally",
    stoploss: "Above gap-up high; 2% above entry as a backstop",
    target: "VWAP first, then pre-result close if momentum shifts",
    rationale: "Headline beat looks good but cut guidance flips the forward narrative. Stock fades hard once the concall lands. The 'beat' alone is a trap for retail.",
    confidence: "HIGH",
    falsification: [
      "Cut is one-time / FX-related and management calls out a quick recovery on the call",
      "Sector is rallying hard — single-stock fade gets crushed by the tide",
    ],
    leans: "short_or_skip",
  },

  // ── INLINE row ──
  INLINE_RAISE: {
    label: "Inline + Raise (underrated bullish)",
    stance: "Buy — best 2–3 day swing in the matrix",
    time_horizon: "swing_3d",
    entry: "Buy at T+1 close OR on T+1 morning pullback to opening 30-min low",
    stoploss: "Below T+1 opening 30-min low",
    target: "+3–5% over T+2 to T+3; analysts re-rate on the forward bump",
    rationale: "Market underreacts because the headline is 'inline' — boring. Forward guidance bump is the real signal; analyst PTs follow. Cleanest cell for a 2–3 day hold.",
    confidence: "HIGH",
    falsification: [
      "Guidance bump is one-time / FY-restatement, not organic",
      "Sector reverses",
    ],
    leans: "long",
  },
  INLINE_MAINTAIN: {
    label: "Inline + Maintain (skip)",
    stance: "Skip — no edge; chop likely",
    time_horizon: "none",
    entry: "Stand aside",
    stoploss: "n/a",
    target: "n/a",
    rationale: "No catalyst either way. Stock often drifts down because the 'inline' result resolves uncertainty without new positive news. Not worth the screen time.",
    confidence: "MEDIUM",
    falsification: [
      "Surprise sector tailwind in the days following",
      "Block-deal flow reveals an institutional buyer post-print",
    ],
    leans: "skip",
  },
  INLINE_CUT: {
    label: "Inline + Cut (strong negative drift)",
    stance: "Short or stay flat — 5–10 day downside drift",
    time_horizon: "swing_5d",
    entry: "Short on T+1 bounce to VWAP, OR enter on T+2 if T+1 closes red",
    stoploss: "Above T+1 high; 2.5% above entry as backstop",
    target: "-4–6% over T+2 to T+5",
    rationale: "Forward downgrade is the real signal; the 'inline' headline buys the stock 24–48h before the analyst-PT cuts hit. This is the post-earnings drift in negative form.",
    confidence: "HIGH",
    falsification: [
      "Macro tailwind (rate cut, oil crash) shifts the sector",
      "Activist or strategic announcement during the drift window",
    ],
    leans: "short_or_skip",
  },

  // ── MISS row ──
  MISS_RAISE: {
    label: "Miss + Raise (mixed)",
    stance: "Conditional — light long after stabilisation if forward look is credible",
    time_horizon: "swing_3d",
    entry: "After T+1 closes, if forward bump is articulated clearly on the concall: small long T+2 open, sized half a normal trade.",
    stoploss: "Below T+1 low",
    target: "Recovery to pre-print level over T+3 to T+5; partial at +3%",
    rationale: "Headline miss + raised guidance is rare. Often miss is one-time (FX, deferral, base effect). If management is credibly bullish on forward, the dip can be a buy. Treat as an edge case.",
    confidence: "MEDIUM",
    falsification: [
      "Forward bump is vague or qualified",
      "Multiple analyst downgrades land during T+1 — momentum is too negative to fight",
    ],
    leans: "small_long",
  },
  MISS_MAINTAIN: {
    label: "Miss + Maintain (strong negative)",
    stance: "Short the bounce or sit out longs",
    time_horizon: "swing_3d",
    entry: "Short on T+1 bounce to VWAP, OR enter on T+2 if T+1 holds red",
    stoploss: "Above T+1 high",
    target: "-3–5% over T+2 to T+3",
    rationale: "Miss with no forward apology = capitulation hasn't started. Continuation move down is the typical pattern. Don't try to catch the knife on T+1 open.",
    confidence: "HIGH",
    falsification: [
      "Sector rally swallows single-stock weakness",
      "Surprise positive catalyst (M&A, large order) hits the tape",
    ],
    leans: "short_or_skip",
  },
  MISS_CUT: {
    label: "Miss + Cut (worst — multi-week down)",
    stance: "Strong short — multi-week downtrend; do not catch the knife",
    time_horizon: "swing_10d",
    entry: "Short on any bounce to VWAP through T+5; scale in over multiple sessions",
    stoploss: "Above the post-result high; 4% above entry as backstop",
    target: "-8–15% over T+5 to T+15; partial at first major support",
    rationale: "Worst cell. Both backward AND forward narratives confirm decay. Analyst downgrades cluster T+1–T+5. The drift is reliable. The only risk is sector or macro reversal — sector rotation can save even bad single-stock setups.",
    confidence: "HIGH",
    falsification: [
      "Macro tailwind shifts capital toward beaten-down names",
      "Surprise activist / takeover bid",
      "Sector rallies 5%+ in the drift window",
    ],
    leans: "short",
  },
};

// ────────── Helpers ──────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Resolve verdict + guidance tone to a matrix-cell key.
 * Returns null when either input is missing/unknown.
 */
export function resolveCellKey(verdict, guidance) {
  const v = String(verdict || "").toUpperCase();
  const g = String(guidance || "").toUpperCase();
  if (!["BEAT", "INLINE", "MISS"].includes(v)) return null;
  if (!["RAISE", "MAINTAIN", "CUT"].includes(g)) return null;
  const key = `${v}_${g}`;
  return PLAYBOOK_MATRIX[key] ? key : null;
}

/**
 * Get a cell directly by key, returning a deep-copied plan so callers
 * can mutate it (e.g. attach symbol-specific notes) without polluting
 * the matrix.
 */
export function getCell(key) {
  const cell = PLAYBOOK_MATRIX[key];
  if (!cell) return null;
  return JSON.parse(JSON.stringify({ key, ...cell }));
}

// ────────── Pre-result preview ──────────

/**
 * Pre-result, we don't know guidance yet. Give the user:
 *   primary  — most-likely cell assuming MAINTAIN guidance (statistical
 *              base case)
 *   branches — alternate cells for RAISE / CUT scenarios so the user
 *              can pre-arm a flip plan
 *
 * The pre-result preview is intentionally not a single recommendation
 * but a decision tree: "if guidance is raised, follow plan A; if
 * maintained, B; if cut, C." This is the SEBI-RA-correct framing
 * because earnings are binary events and the playbook hinges on data
 * we don't have until concall.
 */
export function buildPreviewPlaybook(event) {
  const pred = event?.prediction;
  const signals = event?.signals;

  if (!pred || pred.verdict === "INSUFFICIENT_DATA") {
    return {
      mode: "preview",
      tradable: false,
      primary: null,
      branches: [],
      headline: "Insufficient data — no playbook.",
      version: PLAYBOOK_VERSION,
    };
  }

  // Pull the predicted verdict; the three branches are MAINTAIN
  // (primary base case), RAISE, and CUT.
  const verdict = pred.verdict;
  const primaryKey = resolveCellKey(verdict, "MAINTAIN");
  const raiseKey = resolveCellKey(verdict, "RAISE");
  const cutKey = resolveCellKey(verdict, "CUT");

  const primary = getCell(primaryKey);
  const raise = getCell(raiseKey);
  const cut = getCell(cutKey);

  // ── Skew the recommended branch based on pre-runup signal ──
  // A spike-runup tilts the user toward the CUT branch (the fade
  // setup); a lagging stock tilts toward the RAISE branch (the
  // surprise long). This adds a "highlight which branch to watch
  // most closely" hint without committing to a cell.
  const runup = signals?.momentum?.pre_runup_signal;
  let highlight_branch = "MAINTAIN";
  if (runup === "spike") highlight_branch = "CUT";
  else if (runup === "lagging") highlight_branch = "RAISE";
  else if (runup === "smooth") highlight_branch = "RAISE"; // smooth = informed flow → guidance bump probable

  // Headline is the user-facing TL;DR. One sentence; no jargon.
  const headline = (() => {
    if (verdict === "BEAT" && highlight_branch === "RAISE") {
      return `If guidance is raised, BEAT_RAISE plan applies — strongest cell. Watch concall guidance closely.`;
    }
    if (verdict === "BEAT" && highlight_branch === "CUT") {
      return `Pre-runup spike — if guidance disappoints, BEAT_CUT trap fires. Stand aside until concall.`;
    }
    if (verdict === "INLINE" && highlight_branch === "RAISE") {
      return `Lagging into INLINE result — INLINE_RAISE is the highest-edge cell if guidance bumps.`;
    }
    if (verdict === "MISS" && highlight_branch === "CUT") {
      return `Predicted MISS into a spiked stock — MISS_CUT is the worst cell. Sit out longs.`;
    }
    return `Predicted ${verdict}. Three guidance scenarios mapped — pick the branch after concall.`;
  })();

  // PR A2 — Confidence-calibrated position-size multiplier. Reads the
  // PRODUCTION predictor confidence here (the playbook is baked before
  // the lab runs). At request time in server.js we additionally overlay
  // the lab-calibrated multiplier when the Risk Lab has a tighter
  // confidence estimate (event.lab_view.quality_adjusted_confidence).
  const sizingMultiplier = computeSizeMultiplier(pred.confidence_pct);
  const sizingTier = resolveSizingTier(pred.confidence_pct);

  return {
    mode: "preview",
    tradable: true,
    predicted_verdict: verdict,
    highlight_branch,
    pre_runup_signal: runup || "neutral",
    primary, // MAINTAIN scenario plan
    branches: [
      { guidance: "RAISE", plan: raise, is_highlighted: highlight_branch === "RAISE" },
      { guidance: "MAINTAIN", plan: primary, is_highlighted: highlight_branch === "MAINTAIN" },
      { guidance: "CUT", plan: cut, is_highlighted: highlight_branch === "CUT" },
    ],
    headline,
    position_size_multiplier: sizingMultiplier,
    position_size_tier: sizingTier ? { label: sizingTier.label, min_confidence: sizingTier.min } : null,
    version: PLAYBOOK_VERSION,
  };
}

// ────────── Post-result T+1 ──────────

/**
 * Once the result + guidance are known, return the single matrix cell.
 *
 * Inputs:
 *   actualResult: "BEAT" | "INLINE" | "MISS"
 *   guidanceTone: "RAISE" | "MAINTAIN" | "CUT"
 *   gapPct:       optional — actual T+1 open gap pct vs T-1 close.
 *                 When provided we attach a one-line tactical note
 *                 (fade-the-gap vs follow-the-break).
 *
 * The returned plan is the matrix cell deep-copied + a per-event
 * `tactical_note` synthesised from the gap.
 */
export function buildT1Playbook(event, actualResult, guidanceTone, gapPct = null) {
  const key = resolveCellKey(actualResult, guidanceTone);
  if (!key) {
    return {
      mode: "t1",
      tradable: false,
      cell_key: null,
      plan: null,
      tactical_note: "Cannot resolve playbook cell — invalid actual result or guidance tone.",
      version: PLAYBOOK_VERSION,
    };
  }

  const plan = getCell(key);
  const gap = num(gapPct);

  // ── Tactical note based on gap magnitude vs the cell's lean ──
  // A BEAT_RAISE plan with a gap-up >5% is a great follow setup; a
  // BEAT_RAISE that opens FLAT is unusual and worth flagging.
  let tactical_note = null;
  if (gap != null) {
    if (plan.leans === "long") {
      if (gap > 5) tactical_note = `Gap-up ${gap.toFixed(1)}% — wait for opening 30-min consolidation; do not chase the open.`;
      else if (gap >= 1) tactical_note = `Gap-up ${gap.toFixed(1)}% — modest gap aligns with cell; standard entry plan applies.`;
      else if (gap < 0) tactical_note = `Gap-down ${gap.toFixed(1)}% despite ${plan.label} cell — sector or macro overhang; downgrade size by half until 30-min close confirms.`;
      else tactical_note = `Flat open — reduces follow conviction; consider tighter SL.`;
    } else if (plan.leans === "short" || plan.leans === "short_or_skip") {
      if (gap < -5) tactical_note = `Gap-down ${gap.toFixed(1)}% — wait for VWAP bounce to short; do not chase the open.`;
      else if (gap > 1) tactical_note = `Gap-up ${gap.toFixed(1)}% despite ${plan.label} — consider stand-aside; let day-trader fade do the work.`;
      else tactical_note = `Mild down or flat — short-the-bounce setup intact.`;
    } else if (plan.leans === "fade_or_neutral") {
      if (Math.abs(gap) > 4) tactical_note = `Gap of ${gap.toFixed(1)}% — fade setup confirmed; enter on first reversal candle.`;
      else tactical_note = `Modest gap ${gap.toFixed(1)}% — fade conviction lower; size down.`;
    }
  }

  // PR A2 — position-size multiplier derived from the prediction the user
  // would have acted on PRE-result. Post-result the multiplier is mostly
  // informational (the trade is already on), but it explains "I sized 0.6x
  // because confidence was 48%" in the audit trail and helps backtests
  // model the realised P&L correctly.
  const prePredConfidence = event?.prediction?.confidence_pct;
  const sizingMultiplier = computeSizeMultiplier(prePredConfidence);
  const sizingTier = resolveSizingTier(prePredConfidence);

  return {
    mode: "t1",
    tradable: true,
    cell_key: key,
    actual_verdict: String(actualResult || "").toUpperCase(),
    guidance_tone: String(guidanceTone || "").toUpperCase(),
    gap_pct: gap,
    plan,
    tactical_note: tactical_note || `Apply the ${plan.label} plan as written.`,
    position_size_multiplier: sizingMultiplier,
    position_size_tier: sizingTier ? { label: sizingTier.label, min_confidence: sizingTier.min } : null,
    version: PLAYBOOK_VERSION,
  };
}

// ────────── Calendar-wide application ──────────

/**
 * Attach preview playbooks to every event in the calendar.
 * Idempotent: events that already have a `playbook` field are skipped
 * (lets a future T+1 commit not get clobbered by the next refresh).
 */
export function attachPlaybooksToCalendar(events) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => {
    if (e.playbook && e.playbook.mode === "t1") return e; // preserve resolved T+1 plans
    return { ...e, playbook: buildPreviewPlaybook(e) };
  });
}

/**
 * Roll-up stats — count how many events are in each highlighted-branch
 * bucket, so the tab header chip can show "of 86 BEATs, 32 should be
 * watched for RAISE, 14 for CUT".
 */
export function summarisePlaybooks(events) {
  const byBranch = { RAISE: 0, MAINTAIN: 0, CUT: 0, none: 0 };
  let tradable = 0;
  for (const e of events || []) {
    const pb = e.playbook;
    if (!pb || !pb.tradable) {
      byBranch.none += 1;
      continue;
    }
    tradable += 1;
    if (byBranch[pb.highlight_branch] != null) byBranch[pb.highlight_branch] += 1;
    else byBranch.none += 1;
  }
  return {
    tradable_count: tradable,
    by_highlighted_branch: byBranch,
    playbook_version: PLAYBOOK_VERSION,
  };
}
