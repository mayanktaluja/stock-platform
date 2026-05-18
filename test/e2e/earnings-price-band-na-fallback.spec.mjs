// P2-12 — INSUFFICIENT_DATA price_band fallback.
//
// services/earnings/priceBandBuilder.js deliberately sets bull/base/bear
// to null for events with verdict === "INSUFFICIENT_DATA" (basis:
// "insufficient_data"). The old renderer bailed out completely on any
// null cell — the bull/base/bear strip just disappeared, which looked
// like a render bug on the 9 affected cards (BCPL, JBFIND, RUSHABEAR,
// INDUSFILA, ANZEN, …).
//
// The new renderer keeps the strip present and surfaces each null cell
// as `<span class="band-na" title="insufficient data — no projected
// upper or lower bound">n/a</span>` — visually muted + italic so it
// reads as "we don't have a number here" rather than "this loaded
// wrong".
//
// Test 1 hits the renderer directly via window.__earnings — runs in CI
// without needing the (auth-gated) Earnings tab to be reachable.
// Test 2 is the live-tab structural check; self-skips when the tab is
// gated OR when the snapshot has zero INSUFFICIENT_DATA cards, per
// project convention.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const INSUFFICIENT_BAND = {
  anchored: false,
  basis: "insufficient_data",
  bull: null,
  base: null,
  bear: null,
  version: "earnings-bands-v1-2026-05",
};

test.describe("Earnings card — INSUFFICIENT_DATA price band n/a fallback (P2-12)", () => {
  test("renderPriceBand emits .band-na for each null cell + keeps the strip present", async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(
      () => window.__earnings && typeof window.__earnings.renderPriceBand === "function",
      null,
      { timeout: 10_000 },
    );
    const html = await page.evaluate(
      (band) => window.__earnings.renderPriceBand(band),
      INSUFFICIENT_BAND,
    );

    // Strip is NOT empty — the old renderer returned "" for any null cell,
    // which dropped the whole bull/base/bear block.
    expect(html).not.toBe("");
    // All three cells render the muted fallback.
    const naMatches = html.match(/class="band-na"/g) || [];
    expect(naMatches.length).toBe(3);
    expect(html).toContain(">n/a<");
    // Tooltip explains the semantic — "no upside conviction".
    expect(html).toContain("insufficient data");
    // Labels still render so the user can tell what each cell would be.
    expect(html).toContain("Bear");
    expect(html).toContain("Base");
    expect(html).toContain("Bull");
  });

  test("renderPriceBand still formats real numeric bands unchanged", async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(
      () => window.__earnings && typeof window.__earnings.renderPriceBand === "function",
      null,
      { timeout: 10_000 },
    );
    const band = {
      anchored: true,
      basis: "anchored ₹1000 · vol≈4% · conf×0.8",
      current_price_inr: 1000,
      bull: { pct: 4.2, price_inr: 1042 },
      base: { pct: 1.1, price_inr: 1011 },
      bear: { pct: -2.0, price_inr: 980 },
      version: "earnings-bands-v1-2026-05",
    };
    const html = await page.evaluate(
      (b) => window.__earnings.renderPriceBand(b),
      band,
    );
    expect(html).toContain("₹1,042");
    expect(html).toContain("₹980");
    // No fallback markers when data is real.
    expect(html).not.toContain("band-na");
    expect(html).not.toContain(">n/a<");
  });

  test("live Earnings tab: INSUFFICIENT_DATA cards render the n/a fallback", async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(() => window.__starbhai_isAdmin !== undefined, null, { timeout: 3_000 }).catch(() => {});
    const reachable = await page.evaluate(() => !!window.__starbhai_isAdmin);
    test.skip(!reachable, "Earnings tab not reachable in this run (AUTH_ENABLED=false)");

    await switchTab(page, "earnings");
    // Wait for at least one card to render so the snapshot is loaded.
    await page.locator(".earnings-card").first().waitFor({ state: "visible", timeout: 10_000 });

    const insufficientCards = page.locator('.earnings-card[data-verdict="INSUFFICIENT_DATA"]');
    const count = await insufficientCards.count();
    test.skip(count === 0, "No INSUFFICIENT_DATA cards in the current snapshot");

    // Every INSUFFICIENT_DATA card carries .band-na markers (one per cell).
    const firstCard = insufficientCards.first();
    const naCells = firstCard.locator(".band-na");
    await expect(naCells.first()).toBeVisible();
    // Bear/Base/Bull → three null cells → three .band-na spans on the card.
    expect(await naCells.count()).toBeGreaterThanOrEqual(3);
  });
});
