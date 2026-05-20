// Chunked progressive render for large SWS Picks sections.
//
// Any expanded section above PICKS_EXPANDED_THRESHOLD (100) used to build all
// N cards in one synchronous innerHTML assignment, blocking the main thread
// for 2–5 s and visibly freezing the UI. This spec is the regression gate for
// the fix: render only the first PICKS_EXPANDED_CHUNK_SIZE (100) cards inline
// + an IntersectionObserver sentinel, then stream the rest in as the user
// scrolls. Exercised against the largest curated bucket (Upcoming Earnings,
// ~640 stocks) — the old Avoid bucket that originally motivated this fix has
// since been removed from the tab, but the chunked path it guards is unchanged.
//
// Race-immune by construction — modelled on sws-picks-inline-star.spec.mjs:
// install a requestAnimationFrame tick counter on window BEFORE the click,
// then read it back AFTER the click + flush. If the page froze, the counter
// stays at ~0; if the chunked render works, the main thread keeps yielding
// and the counter climbs at ~60 fps.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

const FREEZE_WINDOW_MS = 600;
const MIN_TICKS_FOR_LIVE_MAINTHREAD = 20; // ~33 fps over 600ms — anything less = visible freeze
const CHUNK_SIZE = 100; // mirrors PICKS_EXPANDED_CHUNK_SIZE in gated/app.js
const SKIP_BELOW = 200; // chunked path only triggers above PICKS_EXPANDED_THRESHOLD (100)
const SECTION_KEY = "upcoming_earnings"; // largest curated bucket post-Avoid-removal

test.describe("SWS Picks · chunked progressive render", () => {
  test("clicking 'Show all (N)' on a large section does not freeze the main thread", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Read the section count from the chip-nav. Self-skip if the bucket is
    // small enough that the chunked path wouldn't engage — per the project
    // pattern, specs skip when their preconditions aren't met rather than
    // fail noisily.
    const sectionCountText = await page
      .locator(`.sws-pick-chip[data-section-key="${SECTION_KEY}"] .sws-pick-chip-count`)
      .textContent({ timeout: 10_000 });
    const sectionCount = parseInt((sectionCountText || "").trim(), 10);
    test.skip(
      !Number.isFinite(sectionCount) || sectionCount < SKIP_BELOW,
      `Section count (${sectionCount}) below ${SKIP_BELOW} — chunked render path not exercised in this snapshot`
    );

    // Make sure the section is visible on screen so the "Show all" button is
    // clickable. The chip click expands + scrolls.
    await page.evaluate((key) => window.jumpToPicksSection(key), SECTION_KEY);
    const showAllBtn = page
      .locator(`.sws-pick-section[data-section-key="${SECTION_KEY}"] .sws-pick-overflow-btn`)
      .first();
    await expect(showAllBtn).toBeVisible({ timeout: 5_000 });
    await expect(showAllBtn).toHaveText(/Show all/, { timeout: 5_000 });

    // Install the rAF tick counter BEFORE the click. The ticker runs for
    // FREEZE_WINDOW_MS ms regardless of what the renderer does; if the
    // main thread is blocked, rAF callbacks queue but don't fire, so the
    // counter stays at ~0.
    await page.evaluate((windowMs) => {
      window.__chunkedRenderTicks = 0;
      window.__chunkedRenderDone = false;
      const start = performance.now();
      const tick = () => {
        window.__chunkedRenderTicks += 1;
        if (performance.now() - start >= windowMs) {
          window.__chunkedRenderDone = true;
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, FREEZE_WINDOW_MS);

    await showAllBtn.click();

    // Wait the full freeze window, then read the counter back.
    await page.waitForFunction(() => window.__chunkedRenderDone === true, null, {
      timeout: FREEZE_WINDOW_MS + 2_000,
    });
    const ticks = await page.evaluate(() => window.__chunkedRenderTicks);
    expect(
      ticks,
      `main thread froze after 'Show all' — only ${ticks} rAF ticks in ${FREEZE_WINDOW_MS}ms`
    ).toBeGreaterThanOrEqual(MIN_TICKS_FOR_LIVE_MAINTHREAD);

    // Positive evidence the chunked path took effect: the first chunk is in
    // the DOM and the sentinel exists waiting for scroll.
    const cardsAfterClick = await page
      .locator(`.sws-pick-section[data-section-key="${SECTION_KEY}"] .sws-pick-card`)
      .count();
    expect(cardsAfterClick).toBeGreaterThanOrEqual(CHUNK_SIZE);
    expect(cardsAfterClick).toBeLessThan(sectionCount);
    await expect(
      page.locator(`.sws-pick-chunk-sentinel[data-section-key="${SECTION_KEY}"]`)
    ).toHaveCount(1, { timeout: 2_000 });

    // Drive scroll until the sentinel is consumed. Each iteration scrolls
    // to the bottom and waits long enough for the IntersectionObserver
    // callback + insertAdjacentHTML to land. Bounded loop so a stuck
    // sentinel fails fast rather than hanging the suite.
    const maxIterations = Math.ceil(sectionCount / CHUNK_SIZE) + 3;
    for (let i = 0; i < maxIterations; i++) {
      const sentinelStillThere = await page
        .locator(`.sws-pick-chunk-sentinel[data-section-key="${SECTION_KEY}"]`)
        .count();
      if (sentinelStillThere === 0) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(400);
    }
    await expect(
      page.locator(`.sws-pick-chunk-sentinel[data-section-key="${SECTION_KEY}"]`)
    ).toHaveCount(0, { timeout: 5_000 });

    // Final card count in the section should equal the chip count.
    const finalCards = await page
      .locator(`.sws-pick-section[data-section-key="${SECTION_KEY}"] .sws-pick-card`)
      .count();
    expect(finalCards).toBe(sectionCount);
  });
});
