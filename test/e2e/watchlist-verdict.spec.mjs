// PR W3 regression: Watchlist verdict pill + chevron details.
//
// Star a known-curated ticker on the SWS Picks tab → switch to Watchlist →
// the row's Verdict column must render a pill (TOP_PICK/STRONG/etc) rather
// than a muted "—". Then click the chevron and confirm the inline details
// row toggles open.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("Watchlist verdict pill (PR W3)", () => {
  test("starred curated ticker renders verdict pill + chevron toggles inline details", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Star the first pick card via its modal — handles the canonical path
    // until P9 surfaces inline ★ on the card itself.
    await page.locator(".sws-pick-card").first().click();
    await page.locator("#swsModalTitle").waitFor({ state: "visible", timeout: 15_000 });
    const star = page.locator("#swsModalTitle .watchlist-btn").first();
    const wasPressed = (await star.getAttribute("aria-pressed")) === "true";
    if (!wasPressed) {
      await star.click();
      await expect.poll(async () => star.getAttribute("aria-pressed")).toBe("true");
    }
    const sym = await star.getAttribute("data-watchlist-symbol");
    expect(sym).toBeTruthy();
    await page.keyboard.press("Escape");

    await switchTab(page, "watchlist");
    const watchlistTab = page.locator("#watchlistTab");
    await expect(watchlistTab).toBeVisible();
    await expect
      .poll(async () => watchlistTab.locator(`[data-watchlist-symbol="${sym}"]`).count(), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    // PR W3 — verdict pill must render. SWS picks symbols use bare tickers
    // (no .NS); we strip the suffix for the lookup so the modal-starred
    // symbol "JSLL.NS" still resolves to picks-latest's "JSLL" entry.
    const verdictCell = watchlistTab.locator("td.wl-col-verdict").first();
    await expect(verdictCell).toBeVisible({ timeout: 10_000 });
    const verdictText = (await verdictCell.innerText()).trim();
    expect(
      verdictText.length,
      "verdict cell must render either a pill label or muted '—'"
    ).toBeGreaterThan(0);
    // For a known-curated SWS pick we expect a real verdict, not "—".
    expect(
      ["TOP_PICK", "STRONG", "ACCEPTABLE", "FAIR_VALUE", "DEEP_VALUE", "QUALITY_GROWTH", "WATCH", "FULLY_VALUED", "AVOID", "OVERVALUED"]
        .some((v) => verdictText.includes(v.replace(/_/g, " "))),
      `expected a verdict label, got "${verdictText}"`
    ).toBe(true);

    // Chevron toggles the sibling details row.
    const chevron = watchlistTab.locator("button.wl-chevron").first();
    await expect(chevron).toBeVisible();
    const detailsRow = watchlistTab.locator("tr.wl-details-row").first();
    await expect(detailsRow).toBeHidden();
    await chevron.click();
    await expect(detailsRow).toBeVisible({ timeout: 2_000 });
    await chevron.click();
    await expect(detailsRow).toBeHidden({ timeout: 2_000 });
  });
});
