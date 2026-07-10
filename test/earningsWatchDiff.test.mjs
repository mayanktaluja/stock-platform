/**
 * Run with: node test/earningsWatchDiff.test.mjs
 */

import assert from "node:assert/strict";
import { buildEarningsWatchDelta } from "../services/earnings/earningsWatchDiff.js";

// Live-snapshot event (current side): verdict at event.prediction.verdict.
function event(symbol, daysUntil, verdict, date = "2026-07-20") {
  return {
    symbol,
    company: `${symbol} Ltd`,
    event_iso_date: date,
    days_until: daysUntil,
    fiscal_quarter: "Q1 FY27",
    prediction: { verdict, confidence_pct: verdict === "INSUFFICIENT_DATA" ? null : 65 },
  };
}
// Archive prediction (prior side): verdict at predicted_verdict.
function prior(symbol, verdict, date = "2026-07-20") {
  return { symbol, event_iso_date: date, predicted_verdict: verdict };
}

// First run (no prior) → suppress, never dump the whole calendar.
{
  const d = buildEarningsWatchDelta([event("A", 5, "BEAT")], []);
  assert.equal(d.suppressed_reason, "no_prior");
  assert.equal(d.added_total, 0);
}

// Added: a (symbol, date) key not in prior, within the near-term window.
{
  const d = buildEarningsWatchDelta(
    [event("NEWCO", 4, "MISS", "2026-07-14")],
    [prior("OLDCO", "BEAT", "2026-07-14")],
  );
  assert.equal(d.added_total, 1);
  assert.equal(d.added[0].symbol, "NEWCO");
  assert.equal(d.added[0].days_until_label, "in 4 days");
  assert.equal(d.suppressed_reason, null);
  assert.equal(d.verdict_changed.length, 0);
}

// Added window filter: a far-edge addition (> addedMaxDays) is dropped.
{
  const d = buildEarningsWatchDelta(
    [event("FAR", 45, "BEAT", "2026-08-30")],
    [prior("SEED", "MISS", "2026-01-01")],
    { addedMaxDays: 30 },
  );
  assert.equal(d.added_total, 0);
}

// days_until:0 renders "Today", never a blank cell (escapeHtml(0) trap).
{
  const d = buildEarningsWatchDelta(
    [event("TODAY", 0, "BEAT", "2026-07-10")],
    [prior("SEED", "MISS", "2026-01-01")],
  );
  assert.equal(d.added[0].days_until_label, "Today");
}

// Material flip BEAT<->MISS is surfaced; the existing key is NOT counted as added.
{
  const d = buildEarningsWatchDelta(
    [event("FLIP", 6, "MISS", "2026-07-16")],
    [prior("FLIP", "BEAT", "2026-07-16")],
  );
  assert.equal(d.added_total, 0);
  assert.equal(d.verdict_changed.length, 1);
  assert.equal(d.verdict_changed[0].prev_verdict, "BEAT");
  assert.equal(d.verdict_changed[0].verdict, "MISS");
}

// Adjacent drift (INLINE<->BEAT) is coin-flip noise → excluded.
{
  const d = buildEarningsWatchDelta(
    [event("ADJ", 6, "BEAT", "2026-07-16")],
    [prior("ADJ", "INLINE", "2026-07-16")],
  );
  assert.equal(d.verdict_changed.length, 0);
}

// INSUFFICIENT_DATA / null transitions are schema churn → excluded.
{
  const d = buildEarningsWatchDelta(
    [event("ID", 6, "INSUFFICIENT_DATA", "2026-07-16")],
    [prior("ID", "MISS", "2026-07-16")],
  );
  assert.equal(d.verdict_changed.length, 0);
}

// Symbol canonicalization: TCS.NS matches prior TCS → not "added", flip detected.
{
  const d = buildEarningsWatchDelta(
    [event("TCS.NS", 6, "MISS", "2026-07-16")],
    [prior("TCS", "BEAT", "2026-07-16")],
  );
  assert.equal(d.added_total, 0, "suffixed current symbol must match bare prior");
  assert.equal(d.verdict_changed.length, 1);
}

// verdict_changed is capped at maxRows (default 20).
{
  const cur = [];
  const pri = [];
  for (let i = 0; i < 25; i++) {
    const date = `2026-08-${String(i + 1).padStart(2, "0")}`;
    cur.push(event(`F${i}`, i, "MISS", date));
    pri.push(prior(`F${i}`, "BEAT", date));
  }
  const d = buildEarningsWatchDelta(cur, pri);
  assert.equal(d.verdict_changed.length, 20, "material flips capped at maxRows");
}

// added_total reflects the FULL count even though the renderer caps display.
{
  const cur = [];
  const pri = [prior("SEED", "MISS", "2026-01-01")];
  for (let i = 0; i < 30; i++) cur.push(event(`N${i}`, 3, "BEAT", `2026-07-${String((i % 28) + 1).padStart(2, "0")}-x${i}`.slice(0, 10) + ``));
  // distinct keys via distinct symbols; date reused is fine since symbol differs
  const d = buildEarningsWatchDelta(cur, pri, { addedMaxDays: 30 });
  assert.equal(d.added_total, 30);
  // sorted by days_until then symbol; all days_until===3 so symbol order
  assert.ok(d.added.length === 30);
}

console.log("earningsWatchDiff tests passed");
