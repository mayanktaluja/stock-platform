// PR T6 regression: /api/track/history?symbol= filter + per-stock track strip.
//
// Two layers:
//   1. Server — /api/track/history?symbol=X must respond 200 with a
//      symbol-filtered trades array (back-compat: no param = current path).
//   2. Frontend — opening the SWS modal must call the symbol filter and
//      either inject .stock-track-strip atop the body (when snapshots
//      exist for that ticker) or leave the modal unchanged.
//
// In a fresh test environment the local paperTradesStorage starts empty, so
// the visible-strip assertion auto-skips when no snapshots are present —
// we still validate the backend route signature.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("Per-stock track strip (PR T6)", () => {
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

  test("clicking a pick card injects track strip ONLY when snapshots exist for that ticker", async ({ page, request }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);
    await page.locator(".sws-pick-card").first().click();
    await page.locator("#swsModalTitle").waitFor({ state: "visible", timeout: 15_000 });

    const ticker = await page.locator("#swsModalTitle").first().innerText();
    const sym = ticker.trim().split(/\s+/)[0]; // strip the watchlist-btn glyph
    const resp = await request.get(`/api/track/history?symbol=${encodeURIComponent(sym)}`);
    const body = await resp.json();
    const hasTrades = Array.isArray(body.trades) && body.trades.length > 0;

    const strip = page.locator(".stock-track-strip");
    if (hasTrades) {
      await expect(strip).toBeVisible({ timeout: 5_000 });
      await expect(strip.locator(".stock-track-row").first()).toBeVisible();
    } else {
      // Silent absent path — modal still renders fine without the strip.
      await expect(strip).toHaveCount(0);
    }
  });
});
