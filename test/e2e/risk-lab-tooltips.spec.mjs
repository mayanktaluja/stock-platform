// Risk Lab — hover tooltips for every term.
//
// Verifies the wiring of the platform-canonical tooltip system
// (#starbhaiTooltip + .info-icon + data-term-id) across the Risk Lab tab:
//
//   1. Visible ⓘ icons render next to column headers, banner stat labels,
//      and lens-tab buttons.
//   2. Hovering an ⓘ surfaces the glossary tooltip with the right term.
//   3. Flag chips and verdict cells are invisible-trigger tooltips —
//      hovering the chip itself fires the tooltip without a separate icon.
//   4. Escape closes the tooltip.
//   5. Switching to Macro Thesis renders ⓘ icons on thesis field labels.
//
// Self-skips when /api/risk-lab/picks-adjusted is unavailable.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const HOVER_SETTLE_MS = 250; // tooltip show animation is 0.18s; pad a bit for CI

async function loadRiskLab(page, request) {
  const apiRes = await request.get("/api/risk-lab/picks-adjusted");
  if (apiRes.status() === 404 || apiRes.status() === 503) {
    test.skip(true, "Risk Lab disabled or picks-adjusted file not generated");
  }
  expect(apiRes.ok()).toBe(true);
  await gotoApp(page, { tab: "riskLab" });
  await expect(page.locator("button:has-text('Quality Lens')")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="risk-lab-search-input"]')).toBeVisible({ timeout: 10_000 });
}

test.describe("Risk Lab — tooltips", () => {
  test("Column headers render visible ⓘ icons", async ({ page, request }) => {
    await loadRiskLab(page, request);
    for (const key of ["origScore", "delta", "adjusted"]) {
      const icon = page.locator(`[data-testid="risk-lab-header-${key}"] .info-icon`);
      await expect(icon).toBeVisible();
    }
  });

  test("Lens-tab buttons render visible ⓘ icons", async ({ page, request }) => {
    await loadRiskLab(page, request);
    // Each of the 4 lens buttons should host an .info-icon child.
    const lensIconCount = await page.locator(".risk-lab-lens-btn .info-icon").count();
    expect(lensIconCount).toBeGreaterThanOrEqual(4);
  });

  test("Hovering a column-header ⓘ shows the tooltip with the right term", async ({ page, request }) => {
    await loadRiskLab(page, request);
    const tooltip = page.locator("#starbhaiTooltip");
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");
    const icon = page.locator('[data-testid="risk-lab-header-origScore"] .info-icon');
    await icon.hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(tooltip).toHaveAttribute("aria-hidden", "false");
    await expect(tooltip).toContainText(/Original Score/i);
  });

  test("Hovering a verdict cell fires a tooltip via invisible data-term-id", async ({ page, request }) => {
    await loadRiskLab(page, request);
    // Find any row whose adjusted-verdict cell carries a glossary mapping.
    const verdictCell = page.locator('[data-testid="risk-lab-row"] .glossary-term').first();
    const hasVerdict = (await verdictCell.count()) > 0;
    if (!hasVerdict) test.skip(true, "no verdict cells with glossary mappings in current data");
    await verdictCell.hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "false");
  });

  test("Hovering a flag chip fires a tooltip", async ({ page, request }) => {
    await loadRiskLab(page, request);
    // Find any chip with a glossary mapping. flag_* / macro_veto / quality_veto / quality_*.
    const chip = page.locator('[data-testid="risk-lab-row"] [data-term-id^="flag_"], [data-testid="risk-lab-row"] [data-term-id="macro_veto"], [data-testid="risk-lab-row"] [data-term-id="quality_veto"]').first();
    const hasChip = (await chip.count()) > 0;
    if (!hasChip) test.skip(true, "no glossary-mapped chips in current data");
    await chip.hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "false");
  });

  test("Escape closes an open tooltip", async ({ page, request }) => {
    await loadRiskLab(page, request);
    const icon = page.locator('[data-testid="risk-lab-header-origScore"] .info-icon');
    await icon.hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "true");
  });

  test("Macro Thesis sub-view renders ⓘ icons on field labels", async ({ page, request }) => {
    const thesisRes = await request.get("/api/risk-lab/macro-thesis");
    if (thesisRes.status() === 404 || thesisRes.status() === 503) {
      test.skip(true, "Macro Thesis data not yet generated");
    }
    await loadRiskLab(page, request);
    await page.click("button:has-text('Macro Thesis')");
    await expect(page.locator('[data-testid="macro-thesis-root"]')).toBeVisible({ timeout: 10_000 });
    // At minimum: severity, days-in-state (if shown), regime confidence
    // labels each carry an .info-icon. We assert count is at least 2 since
    // optional fields may not render for every regime.
    const thesisIconCount = await page.locator('[data-testid="macro-thesis-root"] .info-icon').count();
    expect(thesisIconCount).toBeGreaterThanOrEqual(2);
  });

  test("Lens switch does not break tooltip wiring", async ({ page, request }) => {
    await loadRiskLab(page, request);
    await page.click("button:has-text('Combined view')");
    await expect(page.locator('[data-testid="risk-lab-header-ticker"]')).toBeVisible({ timeout: 10_000 });
    const icon = page.locator('[data-testid="risk-lab-header-origScore"] .info-icon');
    await expect(icon).toBeVisible();
    await icon.hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "false");
  });
});
