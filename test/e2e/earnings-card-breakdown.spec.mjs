// PR 6 — the "How this prediction was built" expander on each earnings card.
//
// Surfaces the top-3 component impacts, the SWS V3 breakdown bars, the
// LLM qualitative read (in a SEPARATELY-LABELLED block — never woven
// into the deterministic rationale), and the version audit trail.
//
// Test 1 exercises the renderer directly via the window.__earnings
// debug export — it runs in CI without needing the (auth-gated)
// Earnings tab to be reachable. Test 2 is the live-tab structural
// check; it self-skips when the tab is gated, per project convention.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const SAMPLE_EVENT = {
  symbol: "TESTCO",
  fiscal_quarter: "Q4 FY26",
  event_iso_date: "2026-05-20",
  prediction: {
    verdict: "BEAT",
    confidence_pct: 58,
    score_100: 71,
    predictor_version: "earnings-predict-v2-2026-05",
    components_by_impact: [
      { name: "v3_future_past", pts: 14, why: "V3 future 18/20 · past 11/12 (TOP_PICK)" },
      { name: "trajectory", pts: 9, why: "EPS YoY +22%" },
      { name: "runup", pts: -6, why: "pre-runup spike (priced-in risk)" },
    ],
  },
  rationale: { headline: "x", version: "earnings-narrate-v1-2026-05" },
  playbook: { version: "earnings-playbook-v1-2026-05" },
  signals: {
    v3: {
      v3_score_100: 72,
      v3_verdict: "TOP_PICK",
      source: "computed",
      breakdown: { pts_future: 18, pts_past: 11, pts_fv_upside: 9, pts_overlay: -3 },
    },
    llm_signal: {
      bias: "lean_beat",
      confidence_delta_pct: 3,
      top_reason: "management flagged record order book",
      top_risk: "margin guidance still soft",
      classifier_provider: "groq",
      model_id: "llama-3.3-70b-versatile",
    },
  },
};

test.describe("Earnings card — prediction build expander (PR 6)", () => {
  test("renderPredictionBuildExpander emits the V3 bars, AI block, and audit trail", async ({ page }) => {
    await gotoApp(page);
    // earnings.js loads after app.js; wait for its debug export.
    await page.waitForFunction(
      () => window.__earnings && typeof window.__earnings.renderPredictionBuildExpander === "function",
      null,
      { timeout: 10_000 },
    );
    const html = await page.evaluate(
      (ev) => window.__earnings.renderPredictionBuildExpander(ev),
      SAMPLE_EVENT,
    );

    // The expander wrapper + summary.
    expect(html).toContain("earnings-build-expander");
    expect(html).toContain("How this prediction was built");
    expect(html).toContain('onclick="event.stopPropagation()"'); // doesn't open the modal
    // Top drivers — component labels mapped to friendly names.
    expect(html).toContain("V3 future + past");
    expect(html).toContain("EPS YoY trajectory");
    // V3 breakdown bars — labelled, ARIA progressbar roles.
    expect(html).toContain("SWS V3 breakdown");
    expect(html).toContain("Future");
    expect(html).toContain("Past");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow');
    // AI qualitative read — SEPARATELY labelled, non-deterministic.
    expect(html).toContain("AI qualitative read");
    expect(html).toContain("non-deterministic");
    expect(html).toContain("groq");
    expect(html).toContain("management flagged record order book");
    // Audit trail — versions.
    expect(html).toContain("Audit trail");
    expect(html).toContain("earnings-predict-v2-2026-05");
  });

  test("INSUFFICIENT_DATA events render no expander", async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(
      () => window.__earnings && typeof window.__earnings.renderPredictionBuildExpander === "function",
      null,
      { timeout: 10_000 },
    );
    const html = await page.evaluate(
      () => window.__earnings.renderPredictionBuildExpander({ symbol: "X", prediction: { verdict: "INSUFFICIENT_DATA" } }),
    );
    expect(html).toBe("");
  });

  test("live Earnings tab: expanding the panel does not open the stock modal", async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(() => window.__starbhai_isAdmin !== undefined, null, { timeout: 3_000 }).catch(() => {});
    const reachable = await page.evaluate(() => !!window.__starbhai_isAdmin);
    test.skip(!reachable, "Earnings tab not reachable in this run (AUTH_ENABLED=false)");

    await switchTab(page, "earnings");
    const expander = page.locator(".earnings-build-expander").first();
    await expander.waitFor({ state: "visible", timeout: 10_000 });
    await expander.locator("summary").click();
    // The expander content is visible…
    await expect(expander.locator("text=SWS V3 breakdown").first()).toBeVisible();
    // …and the stock-detail modal did NOT open. #swsModalBackdrop is a
    // static element that's always in the DOM — assert it stayed hidden
    // (stopPropagation kept the click off the card's open-modal handler).
    const backdrop = page.locator("#swsModalBackdrop");
    if (await backdrop.count()) {
      await expect(backdrop).toBeHidden();
    }
  });
});
