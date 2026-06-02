// Regression: Indian stock modals must not show the per-stock Track Record strip.
//
// Two layers:
//   1. Server — /api/track/history?symbol=X must respond 200 with a
//      symbol-filtered trades array (back-compat: no param = current path).
//   2. Frontend — opening the SWS modal must not call the symbol-filtered
//      track-history endpoint and must not inject .stock-track-strip.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("Indian stock modal track strip removal", () => {
  test("/api/track/history?symbol=X is symbol-filtered + back-compat", async ({ request }) => {
    const all = await request.get("/api/track/history");
    expect(all.ok()).toBe(true);
    const allBody = await all.json();
    expect(allBody).toHaveProperty("trades");

    // Pick any symbol the harness might have and verify the filter response
    // shape. If no trades exist locally the trades array is just empty.
    const filtered = await request.get("/api/track/history?symbol=HDFCBANK");
    expect(filtered.ok()).toBe(true);
    const fb = await filtered.json();
    expect(Array.isArray(fb.trades)).toBe(true);
    // Either an empty array (no snapshots yet) OR every entry matches HDFCBANK.
    for (const t of fb.trades) {
      const norm = String(t.symbol || "").toUpperCase().replace(/\.(NS|BO)$/, "");
      expect(norm).toBe("HDFCBANK");
    }
  });

  test("clicking a pick card does not fetch or render the per-stock Track Record strip", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    let forbiddenTrackHistoryUrl = null;
    page.waitForRequest((req) => {
      const url = new URL(req.url());
      return url.pathname === "/api/track/history" && url.searchParams.has("symbol");
    }, { timeout: 15_000 }).then((req) => {
      forbiddenTrackHistoryUrl = req.url();
    }).catch(() => {});

    await page.locator(".sws-pick-card").first().click();

    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(100);
    await expect(page.locator(".stock-track-strip")).toHaveCount(0);
    await expect(page.locator(".stock-track-row")).toHaveCount(0);
    expect(forbiddenTrackHistoryUrl).toBeNull();
  });
});
