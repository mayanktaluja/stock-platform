/**
 * Regression: lock the /api/earnings/:symbol probe contract.
 *
 * Bug #10 in the E2E review flagged /api/earnings/INFY.NS returning 404 as
 * "missing earnings data for large caps". On inspection it's working as
 * designed: the endpoint is a window-scoped probe over the upcoming-results
 * snapshot, and its only caller — injectEarningsPreviewIntoModal in
 * gated/earnings.js — explicitly treats a non-200 as "no upcoming earnings,
 * skip the preview panel". INFY/TCS 404 simply because they already reported
 * and aren't in the forward window.
 *
 * No code change. This test pins the contract so a future "fix" can't turn
 * the silent no-op into a 500 or otherwise break the probe:
 *   - an in-window symbol → 200 with an `event` object
 *   - an unknown / out-of-window symbol → 404 with { error: "not_found" }
 *
 * Run via: npm run test:regression  (needs the suite's live server)
 */
const BASE = process.env.REGRESSION_BASE_URL || "http://localhost:4022";

let pass = 0;
let fail = 0;
let skipped = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

console.log("Bug #10 — /api/earnings/:symbol probe contract");

// ── Negative path: an unknown symbol must 404 with not_found — never 500. ──
const unknown = await getJson("/api/earnings/ZZZZ_NOTREAL");
assert("unknown symbol → 404", unknown.status === 404, unknown.status);
assert(
  "unknown symbol → { error: 'not_found' }",
  unknown.body?.error === "not_found",
  unknown.body,
);

// ── Positive path: an in-window symbol → 200 with an event. Self-skip when
// the snapshot has no events (genuine data precondition, not a failure). ──
const upcoming = await getJson("/api/earnings/upcoming");
const firstSymbol = upcoming.body?.events?.[0]?.symbol;
if (!firstSymbol) {
  skipped++;
  console.log("  ⊘ in-window symbol → 200  (skipped — earnings snapshot has 0 events)");
} else {
  const inWindow = await getJson(`/api/earnings/${encodeURIComponent(firstSymbol)}`);
  assert(`in-window symbol ${firstSymbol} → 200`, inWindow.status === 200, inWindow.status);
  assert(
    `in-window symbol ${firstSymbol} → response carries the event`,
    inWindow.body?.event?.symbol === firstSymbol,
    inWindow.body?.event?.symbol,
  );
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
