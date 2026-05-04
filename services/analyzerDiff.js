// Analyzer diff mode — compare the current run's per-holding state to
// the user's previously persisted snapshot and return a "what changed"
// summary. Lets the second-and-subsequent runs lead with the delta
// rather than re-rendering the full report cold.
//
// Matches the diff-mode contract documented for the portfolio-review-sws
// skill: actionChanges, scoreChanges, newHoldings, exitedHoldings,
// surveillanceChanges. Each entry is shaped to be directly renderable
// in the analyzer report banner without further joins.
//
// Pure function. No I/O, no LLM. Snapshot shape (lightweight — we don't
// serialise the full SWS payload):
//
//   { ticker, action, v3Score, surveillance, currentValue, snowflakeTotal }
//
// A snapshot is an array of these row objects + a top-level
// { generatedAt, holdingsCount, totalValue }.

/**
 * Build a lightweight snapshot from the current SWS report's holdings.
 * Strips everything except the per-row fields the diff cares about so
 * persisted snapshots stay small (~100 bytes per row).
 */
export function buildSnapshot(scoredHoldings, meta = {}) {
  const rows = (scoredHoldings || []).map((h) => ({
    ticker: h.sws?.ticker || h.symbol || h.ticker || null,
    action: h.action || null,
    v3Score: h.sws?.v3_score ?? null,
    surveillance: h.sws?.surveillance ? { list: h.sws.surveillance.list, stage: h.sws.surveillance.stage ?? null } : null,
    currentValue: h.currentValue ?? null,
    snowflakeTotal: h.sws?.snowflake_total ?? null,
  }));
  return {
    generatedAt: new Date().toISOString(),
    holdingsCount: rows.length,
    totalValue: rows.reduce((s, r) => s + (Number(r.currentValue) || 0), 0),
    rows,
  };
}

// Score change threshold — only flag movements ≥ this value to avoid
// noise from tiny v3 jitters between runs. v3 sits on a 0-100 scale;
// a 5-point change is a real category shift in the band distribution.
const SCORE_CHANGE_THRESHOLD = 5;

/**
 * Compare two snapshots and return a structured diff.
 *
 * @param {object} prev - previous snapshot (from buildSnapshot)
 * @param {object} current - current snapshot
 * @returns {{
 *   hasChanges: boolean,
 *   prevAt: string|null,
 *   currentAt: string|null,
 *   actionChanges: Array<{ ticker, prevAction, currentAction }>,
 *   scoreChanges: Array<{ ticker, prevScore, currentScore, delta }>,
 *   newHoldings: Array<{ ticker, action, v3Score }>,
 *   exitedHoldings: Array<{ ticker, prevAction, prevValue }>,
 *   surveillanceChanges: Array<{ ticker, prev, current }>,
 *   summary: string,
 * }}
 */
export function diffSnapshots(prev, current) {
  // First-run path — no prior snapshot to diff against.
  if (!prev || !Array.isArray(prev.rows)) {
    return {
      hasChanges: false,
      prevAt: null,
      currentAt: current?.generatedAt || null,
      actionChanges: [],
      scoreChanges: [],
      newHoldings: [],
      exitedHoldings: [],
      surveillanceChanges: [],
      summary: "First run — no prior snapshot to diff against.",
    };
  }

  const prevByTicker = new Map();
  for (const r of prev.rows) {
    if (r?.ticker) prevByTicker.set(r.ticker, r);
  }
  const currentByTicker = new Map();
  for (const r of (current?.rows || [])) {
    if (r?.ticker) currentByTicker.set(r.ticker, r);
  }

  const actionChanges = [];
  const scoreChanges = [];
  const newHoldings = [];
  const exitedHoldings = [];
  const surveillanceChanges = [];

  // Newly added + action / score / surveillance changes.
  for (const [ticker, cur] of currentByTicker) {
    const old = prevByTicker.get(ticker);
    if (!old) {
      newHoldings.push({
        ticker,
        action: cur.action,
        v3Score: cur.v3Score,
      });
      continue;
    }
    if (old.action !== cur.action) {
      actionChanges.push({
        ticker,
        prevAction: old.action,
        currentAction: cur.action,
      });
    }
    const dPrev = Number.isFinite(old.v3Score) ? old.v3Score : null;
    const dCur = Number.isFinite(cur.v3Score) ? cur.v3Score : null;
    if (dPrev != null && dCur != null) {
      const delta = +(dCur - dPrev).toFixed(1);
      if (Math.abs(delta) >= SCORE_CHANGE_THRESHOLD) {
        scoreChanges.push({
          ticker,
          prevScore: dPrev,
          currentScore: dCur,
          delta,
        });
      }
    }
    const survPrev = old.surveillance || null;
    const survCur = cur.surveillance || null;
    const sPrevKey = survPrev ? `${survPrev.list}-${survPrev.stage ?? ""}` : null;
    const sCurKey = survCur ? `${survCur.list}-${survCur.stage ?? ""}` : null;
    if (sPrevKey !== sCurKey) {
      surveillanceChanges.push({
        ticker,
        prev: survPrev,
        current: survCur,
      });
    }
  }

  // Exited holdings — present in prev, missing in current.
  for (const [ticker, old] of prevByTicker) {
    if (!currentByTicker.has(ticker)) {
      exitedHoldings.push({
        ticker,
        prevAction: old.action,
        prevValue: old.currentValue,
      });
    }
  }

  // Sort each list deterministically — alphabetic by ticker keeps the
  // banner stable across runs even when iteration order changes.
  actionChanges.sort((a, b) => a.ticker.localeCompare(b.ticker));
  scoreChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  newHoldings.sort((a, b) => a.ticker.localeCompare(b.ticker));
  exitedHoldings.sort((a, b) => a.ticker.localeCompare(b.ticker));
  surveillanceChanges.sort((a, b) => a.ticker.localeCompare(b.ticker));

  const totalChanges = actionChanges.length + scoreChanges.length + newHoldings.length + exitedHoldings.length + surveillanceChanges.length;
  const hasChanges = totalChanges > 0;

  // Plain-English summary. Used as the diff-banner title text.
  const parts = [];
  if (newHoldings.length > 0) parts.push(`${newHoldings.length} new holding${newHoldings.length > 1 ? "s" : ""}`);
  if (exitedHoldings.length > 0) parts.push(`${exitedHoldings.length} exited`);
  if (actionChanges.length > 0) parts.push(`${actionChanges.length} action change${actionChanges.length > 1 ? "s" : ""}`);
  if (scoreChanges.length > 0) parts.push(`${scoreChanges.length} score shift${scoreChanges.length > 1 ? "s" : ""}`);
  if (surveillanceChanges.length > 0) parts.push(`${surveillanceChanges.length} surveillance change${surveillanceChanges.length > 1 ? "s" : ""}`);
  const summary = hasChanges
    ? `Since last review: ${parts.join(", ")}.`
    : "No material changes since last review — the action grid below is identical.";

  return {
    hasChanges,
    prevAt: prev.generatedAt || null,
    currentAt: current?.generatedAt || null,
    actionChanges,
    scoreChanges,
    newHoldings,
    exitedHoldings,
    surveillanceChanges,
    summary,
  };
}
