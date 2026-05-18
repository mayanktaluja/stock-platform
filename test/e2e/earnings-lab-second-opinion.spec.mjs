// PR A1 (Phase 2) — Risk Lab "second opinion" surface on the Earnings Watch tab.
//
// Verifies that:
//   1. /api/earnings/upcoming attaches a `lab_view` per event AND surfaces
//      lab_enabled + lab_regime at the response root (when lab data exists)
//   2. Each event's `lab_view` (when non-null) matches the agreed schema and
//      the `disagrees_with_prediction` heuristic only fires for BEAT calls
//   3. The Earnings Watch card renders the lab strip
//      (`[data-testid="lab-second-opinion"]`) for at least one event when
//      the snapshot has a disagreement case to surface.
//
// All assertions self-skip cleanly when the underlying data isn't present
// (fresh checkout, RISK_LAB_ENABLED=false, missing data/risk-lab files) so
// CI passes without forcing a full pipeline refresh.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("Earnings Watch — Risk Lab 2nd-opinion column (PR A1)", () => {
  test("/api/earnings/upcoming response surfaces lab_view + lab_enabled", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming?days=30");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    if (body.missing === true) {
      test.skip(true, "no earnings snapshot — fresh checkout, skip");
    }
    expect(body).toHaveProperty("lab_enabled");
    expect(typeof body.lab_enabled).toBe("boolean");
    test.skip(body.lab_enabled !== true, "Risk Lab disabled or data missing — skip");

    expect(Array.isArray(body.events)).toBe(true);
    // At least one event should have lab_view attached (could be null per
    // event if the ticker isn't in the lab map — but the FIELD should exist).
    const withLab = body.events.filter((e) => e.lab_view != null);
    test.skip(withLab.length === 0, "no events matched lab tickers — universe mismatch, skip");

    // Spot-check schema on first matched event
    const v = withLab[0].lab_view;
    expect(v).toHaveProperty("disagrees_with_prediction");
    expect(typeof v.disagrees_with_prediction).toBe("boolean");
    expect(v).toHaveProperty("has_macro_overlay");
    expect(v).toHaveProperty("has_quality_overlay");
    expect(Array.isArray(v.quality_flags)).toBe(true);
    expect(Array.isArray(v.top_reasons)).toBe(true);
    expect(v.top_reasons.length).toBeLessThanOrEqual(3);
  });

  test("disagrees_with_prediction only fires for BEAT-predicted events", async ({ request }) => {
    const body = await (await request.get("/api/earnings/upcoming?days=60")).json();
    test.skip(body.missing === true || body.lab_enabled !== true, "preconditions missing — skip");
    const events = Array.isArray(body.events) ? body.events : [];
    for (const e of events) {
      if (!e.lab_view) continue;
      if (e.lab_view.disagrees_with_prediction === true) {
        // The disagree heuristic is gated on BEAT — anything else means the
        // service-layer heuristic regressed.
        expect(e.prediction?.verdict).toBe("BEAT");
      }
    }
  });

  test("Earnings Watch card renders the lab strip for ≥1 disagreement (when present)", async ({
    page,
    request,
  }) => {
    const body = await (await request.get("/api/earnings/upcoming?days=60")).json();
    test.skip(body.missing === true || body.lab_enabled !== true, "preconditions missing — skip");
    const disagreements = (body.events || []).filter(
      (e) => e.lab_view?.disagrees_with_prediction === true,
    );
    test.skip(disagreements.length === 0, "no disagreement cases in current snapshot — skip render check");

    await gotoApp(page, { tab: "earnings" });
    // Wait for at least one earnings card to render
    await expect(page.locator(".earnings-card").first()).toBeVisible({ timeout: 15_000 });

    // At least one lab-second-opinion strip should be in the DOM (one per
    // disagreement; UI may render more if hasQuality/hasMacro are set without
    // disagreement but at minimum we should see one).
    const stripCount = await page.locator('[data-testid="lab-second-opinion"]').count();
    expect(stripCount).toBeGreaterThan(0);

    // At least one strip should be flagged as a disagreement
    const disagreeingStrips = await page
      .locator('[data-testid="lab-second-opinion"][data-disagrees="true"]')
      .count();
    expect(disagreeingStrips).toBeGreaterThan(0);
  });
});
