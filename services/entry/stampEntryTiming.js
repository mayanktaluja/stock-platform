// Nightly post-pass: stamp entry_timing (Two-Key Entry Key 2) + entry_plan (staged-buy
// ladder) onto every curated-section pick row, carrying prevState (hysteresis) and the
// ladder anchor forward from the previous night's picks-latest.json.
//
// Called by scripts/sws-scoring.mjs runFullScoring() AFTER buildLeaderboard and BEFORE
// the picks-latest write. Pure w.r.t. I/O — the caller reads the previous file and
// passes it in. Never throws: a per-row failure stamps nothing for that row (fail-open,
// the card renders exactly as before). Plan: ~/.claude/plans/entry-timing-final.md §2-§3.

import { computeEntryTiming } from "./swsEntryTiming.js";
import { buildTranchePlan } from "./tranchePlanBuilder.js";
import { ALERT_DWELL_NIGHTS } from "./entryTimingConfig.js";

// Sections that carry full pickCardFields rows (the slim universe projection is
// deliberately NOT stamped — ~0.5MB/commit saved, no badge renders there).
function isRowArray(items) {
  return Array.isArray(items) && items.length > 0 && typeof items[0] === "object";
}

// Index the previous night's sections by ticker → {state, plan} for hysteresis + anchor carry.
export function indexPrevEntryState(prevSections) {
  const map = new Map();
  if (!prevSections || typeof prevSections !== "object") return map;
  for (const items of Object.values(prevSections)) {
    if (!isRowArray(items)) continue;
    for (const row of items) {
      if (!row?.ticker || map.has(row.ticker)) continue;
      if (row.entry_timing || row.entry_plan) {
        map.set(row.ticker, {
          state: row.entry_timing?.state || null,
          anchor_price_inr: row.entry_plan?.anchor_price_inr ?? null,
          anchored_at: row.entry_plan?.anchored_at ?? null,
          state_nights: row.entry_timing?.state_nights ?? 1,
          // state before the current streak began — the "from" of the eventual alert
          streak_from: row.entry_timing?.streak_from ?? null,
        });
      }
    }
  }
  return map;
}

export function stampEntryTimingOnSections({ sections, universeR3m, macroRegime, prevSections, scannedAt, getTechnicals }) {
  if (!sections || typeof sections !== "object") return { stamped: 0, eligibleRows: 0 };
  const prev = indexPrevEntryState(prevSections);
  const macro = macroRegime
    ? { severity: macroRegime.severity, sectorImpacts: macroRegime.sectorImpacts || [] }
    : null;
  let stamped = 0;
  let eligibleRows = 0;
  const transitions = []; // dwell-passed state changes for the alert queue (PR-3)
  // Alert scope (v1): best_to_buy_now tickers only — the whole 2k-row universe
  // gets STAMPED, but queueing every universe transition would flood Telegram.
  // Watchlist/holdings scope is the planned follow-up.
  const alertScope = new Set(
    (Array.isArray(sections.best_to_buy_now) ? sections.best_to_buy_now : [])
      .map((r) => r?.ticker)
      .filter(Boolean),
  );
  // Sections do NOT share row object references (buildLeaderboard emits per-section
  // copies), so every occurrence must be stamped. Compute once per ticker, assign to
  // each copy — states/plans stay identical across sections by construction.
  const cache = new Map(); // ticker → { timing, plan }

  for (const [key, items] of Object.entries(sections)) {
    if (key.startsWith("__") || !isRowArray(items)) continue;
    for (const row of items) {
      if (!row?.ticker) continue;
      const hit = cache.get(row.ticker);
      if (hit) {
        row.entry_timing = hit.timing;
        if (hit.plan && row.entry_band?.fresh_buy_eligible === true) row.entry_plan = hit.plan;
        continue;
      }
      try {
        const prevEntry = prev.get(row.ticker) || null;
        // Tier-2 technicals: per-ticker fail-open lookup (null → Tier-1 path).
        const technicals = typeof getTechnicals === "function" ? getTechnicals(row.ticker) || null : null;
        const timing = computeEntryTiming({
          returnsPct: row.returns_pct || null,
          fiftyTwoWeek: row.fifty_two_week || null,
          currentPriceInr: row.current_price_inr,
          universeR3m: universeR3m || null,
          macro,
          sector: row.sector || null,
          prevState: prevEntry?.state || null,
          asOf: scannedAt || null,
          technicals,
        });
        // Consecutive-night dwell counter for the alert layer (ALERT_DWELL_NIGHTS).
        const sameState = prevEntry && prevEntry.state === timing.state;
        timing.state_nights = sameState ? (prevEntry.state_nights || 1) + 1 : 1;
        // "from" of the eventual alert: set on the change night, carried through the streak.
        timing.streak_from = sameState ? (prevEntry.streak_from ?? null) : (prevEntry?.state ?? null);
        row.entry_timing = timing;
        stamped++;

        // Staged-buy ladder — only for rows the value key already lets through.
        const eligible = row.entry_band?.fresh_buy_eligible === true && timing.state !== "NO_DATA";
        if (eligible) {
          eligibleRows++;
          // Anchor: persist while the state is unchanged; re-anchor on any state change.
          const carry = prevEntry && prevEntry.state === timing.state && Number.isFinite(prevEntry.anchor_price_inr);
          const anchorPriceInr = carry ? prevEntry.anchor_price_inr : row.current_price_inr;
          const anchoredAt = carry ? prevEntry.anchored_at : scannedAt || null;
          const plan = buildTranchePlan({
            anchorPriceInr,
            anchoredAt,
            fairValueInr: row.fair_value_inr,
            noBuyAboveInr: row.entry_band?.no_buy_above_inr,
            fiftyTwoWeekLow: row.fifty_two_week?.low,
            atr14: technicals?.atr14, // Tier-2 (PR-4); absent → Tier-1 basis
            medianMaePct: undefined, // config seed until PR-1 output is wired as provenance
          });
          if (plan) row.entry_plan = plan;
        }
        // Alert transition fires the night the streak reaches the dwell threshold —
        // one emission per streak; the queue drain dedups again via sentLedger.
        // Runs AFTER the plan block so →CONFIRMED alerts carry the ladder numbers.
        if (
          timing.state_nights === ALERT_DWELL_NIGHTS &&
          timing.streak_from !== null &&
          timing.streak_from !== timing.state &&
          alertScope.has(row.ticker)
        ) {
          transitions.push({
            ticker: row.ticker,
            from: timing.streak_from,
            to: timing.state,
            price_inr: row.current_price_inr ?? null,
            state_nights: timing.state_nights,
            no_chase_inr: row.entry_plan?.no_chase_inr ?? null,
            invalidation_inr: row.entry_plan?.invalidation_inr ?? null,
            tranches: row.entry_plan?.eligible ? row.entry_plan.tranches : undefined,
          });
        }
        cache.set(row.ticker, { timing, plan: row.entry_plan || null });
      } catch {
        // fail-open: row ships without entry_timing/entry_plan, card renders as today
      }
    }
  }
  return { stamped, eligibleRows, transitions };
}
