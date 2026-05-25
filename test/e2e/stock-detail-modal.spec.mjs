// E2E test 0.5 — Stock detail modal opens AND renders real ticker data.
//
// Pre-2026-05-16: this spec only asserted that the modal backdrop got the
// `.open` class and that #swsModalTitle had non-empty text. A modal that
// opened with the title-bar populated but a silently-empty body (e.g.
// renderSwsModal returning early because the SWS payload was malformed,
// or the .sws-modal-score / .sws-modal-section blocks failing to render)
// would pass that gate. The 2026-05-16 audit flagged this as a High-tier
// silent-failure risk: the stock-detail modal is the most-used interactive
// surface in the SPA, opened from 15+ entry points.
//
// This hardened spec adds two structural assertions on top of the original
// open/close lifecycle test:
//   - .sws-modal-hero must render (the SWS payload reached the renderer)
//   - At least one .sws-modal-section must render (the body is populated,
//     not just the hero stub)
// The .sws-modal-score check is best-effort — score is hidden for
// limited-data live-only fallbacks (renderSwsModal v2 path) so its
// absence is not a regression.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("Stock detail modal (SWS)", () => {
  test("clicking a pick card opens, populates body sections, and Escape closes", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const firstCard = page.locator(".sws-pick-card").first();
    await firstCard.click();

    const backdrop = page.locator("#swsModalBackdrop");
    await expect(backdrop).toHaveClass(/open/, { timeout: 5_000 });

    // Title appears once the per-stock fetch resolves and renderSwsModal
    // has stamped the hero. Original guard.
    const title = page.locator("#swsModalTitle");
    await expect(title).toBeVisible({ timeout: 15_000 });
    const titleText = (await title.innerText()).trim();
    expect(titleText.length, "#swsModalTitle must render ticker text").toBeGreaterThan(0);

    // Hero section structural anchor — present whether the renderer took
    // the rich SWS path or the limited-data live-only fallback.
    const hero = page.locator("#swsModalBody .sws-modal-hero");
    await expect(hero, "#swsModalBody must contain .sws-modal-hero").toBeVisible({ timeout: 5_000 });

    // Body must have at least one .sws-modal-section. The rich-data render
    // produces 5+ sections (snowflake, rewards, risks, news, valuation);
    // the limited-data fallback still emits at least the live-quote
    // section. A modal with hero-only and no body sections is a silent
    // render bug — exactly what this hardening guards against.
    const sectionCount = await page.locator("#swsModalBody .sws-modal-section").count();
    expect(
      sectionCount,
      "#swsModalBody must render at least one .sws-modal-section (zero = silent renderer failure)"
    ).toBeGreaterThan(0);

    // Escape closes — original guard.
    await page.keyboard.press("Escape");
    await expect(backdrop).not.toHaveClass(/open/, { timeout: 5_000 });
  });

  test("cached quick stats render ownership metrics when available", async ({ page, request }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const tickers = await page.locator(".sws-pick-card").evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-ticker")).filter(Boolean).slice(0, 40)
    );
    let target = null;
    let sourceDate = null;
    for (const ticker of tickers) {
      const res = await request.get(`/api/sws-stock/${encodeURIComponent(ticker)}`);
      if (!res.ok()) continue;
      const data = await res.json();
      if (data?.deep?.groww_source && data?.deep?.overview?.source_map?.current_price_inr) {
        target = ticker;
        sourceDate = String(data.deep.groww_source.fetched_at || "").slice(0, 10);
        break;
      }
    }
    test.skip(!target, "No Groww-backed SWS pick fixture available in the current data snapshot.");

    await page.locator(`.sws-pick-card[data-ticker="${target}"]`).first().click();
    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body).toContainText(/Quick stats\s+SWS/, { timeout: 5_000 });
    if (sourceDate) {
      await expect(body).toContainText(sourceDate, { timeout: 5_000 });
    }
    await expect(body).toContainText("Promoter %", { timeout: 5_000 });
  });
});
