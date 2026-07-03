/**
 * Format an entry-timing state TRANSITION into a Telegram alert (ENTRY class —
 * Two-Key Entry PR-3, plan: ~/.claude/plans/entry-timing-final.md).
 *
 * Input is one row from the nightly scoring's pending-queue file
 * (`${ALERTS_LEDGER_DIR}/entry-transitions-pending.json`):
 *   { ticker, from: <state|null>, to: <state>, price_inr, state_nights,
 *     no_chase_inr?, invalidation_inr?, tranches?: [{pct, trigger_price_inr, label}] }
 *
 * Pure/deterministic — no network, no env, no I/O. The drain step in
 * scripts/refresh-news-alerts.mjs decides whether to send; this only renders.
 *
 * Alertable classes ONLY (everything else → null, dropped without retry):
 *   (a) any        → ENTRY_CONFIRMED   — "entry window opened", the money alert.
 *                                        breaking=true (bypasses quiet hours).
 *   (b) non-knife  → FALLING_KNIFE     — "knife — hold fire". Routine.
 *   (c) FALLING_KNIFE → STABILIZING    — "base forming". Routine.
 * →MACRO_DEFER, →NO_DATA and every other flip (incl. CONFIRMED→STABILIZING
 * micro-flips) are deliberately silent — badge-level noise, not phone-level.
 *
 * Disclaimer is covered by the site-wide footer (#sebiSiteFooter) — none inlined.
 */

import { escapeHtml } from "./telegramSender.js";
import { ledgerKey } from "./sentLedger.js";

const PROD_URL = "https://starbhai-stock-platform.vercel.app";

// entryTimingConfig.js states → human labels for the "(was …)" text.
const STATE_LABELS = {
  FALLING_KNIFE: "Knife falling",
  STABILIZING: "Stabilizing",
  ENTRY_CONFIRMED: "Entry confirmed",
  MACRO_DEFER: "Macro defer",
  NO_DATA: "No data",
};

export function stateLabel(state) {
  return STATE_LABELS[state] || String(state || "Unknown");
}

/** ₹ formatter — deterministic (no locale): whole rupees at ≥100, ≤2dp below. */
function fmtInr(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `₹${Math.abs(n) >= 100 ? Math.round(n) : Number(n.toFixed(2))}`;
}

/** Tranche pct arrives as a fraction (0.4) from tranchePlanBuilder; tolerate 40 too. */
function fmtPct(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n <= 1 ? n * 100 : n)}%`;
}

/** "T1 40% @ ₹495 · T2 35% @ ₹470 · T3 25% @ ₹446" — or null when unrenderable. */
function trancheLine(tranches) {
  if (!Array.isArray(tranches)) return null;
  const parts = [];
  for (const t of tranches) {
    const price = fmtInr(t?.trigger_price_inr);
    if (!price) continue; // a rung without a price is unactionable — skip it
    const pct = fmtPct(t?.pct);
    parts.push(`T${parts.length + 1}${pct ? ` ${pct}` : ""} @ ${price}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/** "No-chase above ₹643 · Invalidation ₹455" — whichever levels exist. */
function levelsLine(tr) {
  const parts = [];
  const noChase = fmtInr(tr.no_chase_inr);
  const invalidation = fmtInr(tr.invalidation_inr);
  if (noChase) parts.push(`No-chase above ${noChase}`);
  if (invalidation) parts.push(`Invalidation ${invalidation}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Build the alert. Returns { text, breaking, key, buttons } or null for
 * non-alertable transitions (caller drops those from the queue, no retry).
 */
export function formatEntryTransition(tr) {
  const ticker = String(tr?.ticker || "").trim();
  const to = tr?.to;
  if (!ticker || typeof to !== "string") return null;
  const from = tr.from ?? null;
  if (from === to) return null; // not a transition

  const name = `<b>${escapeHtml(ticker)}</b>`;
  const was = from ? ` (was ${escapeHtml(stateLabel(from))})` : "";
  let lines = null;
  let breaking = false;

  if (to === "ENTRY_CONFIRMED") {
    // (a) The money alert — actionable numbers, loud.
    breaking = true;
    const ladder = trancheLine(tr.tranches);
    // Degraded (no ladder): fall back to the flag price so the line stays actionable.
    const price = ladder ? null : fmtInr(tr.price_inr);
    lines = [`🟢 ${name} — entry window opened (base confirmed)${price ? ` · ${price}` : ""}`];
    if (ladder) lines.push(ladder);
    const levels = levelsLine(tr);
    if (levels) lines.push(levels);
  } else if (to === "FALLING_KNIFE" && from !== "FALLING_KNIFE") {
    // (b) Into the knife from any non-knife state (incl. first sighting, from=null).
    lines = [`🔴 ${name} — falling knife${was}. Hold fire; wait for the turn.`];
  } else if (to === "STABILIZING" && from === "FALLING_KNIFE") {
    // (c) Knife → base forming.
    lines = [`🟡 ${name} — base forming${was}. Staging window ahead.`];
  } else {
    return null; // →MACRO_DEFER, →NO_DATA, micro-flips — silent by design
  }

  return {
    text: lines.join("\n"),
    breaking,
    key: ledgerKey(["entry", ticker, to]),
    buttons: [{ text: "📊 Open platform", url: `${PROD_URL}/?t=${encodeURIComponent(ticker)}` }],
  };
}
