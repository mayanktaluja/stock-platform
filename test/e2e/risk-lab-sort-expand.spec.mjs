// Risk Lab — expandable list + click-to-sort columns.
//
// Covers the three interactions wired in gated/riskLab.js:
//   1. "Show all" footer button toggles between cap-at-100 and full list.
//   2. Column-header click cycles desc → asc → reset; aria-sort tracks state.
//   3. Lens switch resets both _sortState and _showAll.
//
// Self-skips when /api/risk-lab/picks-adjusted is unavailable (disabled / not
// generated) or when the filtered match count is ≤100 (Show-all button only
// renders past that threshold).

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

async function loadRiskLabAndCountFiltered(page, request) {
  const apiRes = await request.get("/api/risk-lab/picks-adjusted");
  if (apiRes.status() === 404 || apiRes.status() === 503) {
    test.skip(true, "Risk Lab disabled or picks-adjusted file not generated");
  }
  expect(apiRes.ok()).toBe(true);
  const body = await apiRes.json();
  // Quality lens is the default in riskLab.js — mirror the filter.
  const filtered = (body.stocks || []).filter(
    (s) => (s.quality_flags?.length || 0) > 0 || s.quality_veto?.vetoed,
  );
  if (filtered.length <= 100) {
    test.skip(true, `Quality lens has ${filtered.length} matches — Show-all button only renders past 100`);
  }
  await gotoApp(page, { tab: "riskLab" });
  await expect(page.locator("button:has-text('Quality Lens')")).toBeVisible({ timeout: 15_000 });
  return filtered.length;
}

test.describe("Risk Lab — sort & expand", () => {
  test("mobile layout contains fixed-grid rows without body horizontal overflow", async ({ page, request }) => {
    const apiRes = await request.get("/api/risk-lab/picks-adjusted");
    if (apiRes.status() === 404 || apiRes.status() === 503) {
      test.skip(true, "Risk Lab disabled or picks-adjusted file not generated");
    }
    const body = await apiRes.json();
    const filtered = (body.stocks || []).filter(
      (s) => (s.quality_flags?.length || 0) > 0 || s.quality_veto?.vetoed,
    );
    if (filtered.length === 0) test.skip(true, "Quality lens has no rows in current snapshot");

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoApp(page, { tab: "riskLab" });
    await expect(page.getByTestId("risk-lab-table-wrap")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("risk-lab-row").first()).toBeVisible();

    const metrics = await page.evaluate(() => ({
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wrapOverflow: (() => {
        const el = document.querySelector('[data-testid="risk-lab-table-wrap"]');
        return el ? el.scrollWidth > el.clientWidth : false;
      })(),
    }));
    expect(metrics.bodyOverflow).toBeLessThanOrEqual(1);
    expect(metrics.wrapOverflow).toBe(true);

    await page.getByTestId("risk-lab-row").first().press("Enter");
    await expect(page.locator("#swsModalBackdrop.open, #usModalBackdrop.open")).toBeVisible({ timeout: 10_000 });
  });

  test("Show-all button expands beyond the 100 cap and collapses back", async ({ page, request }) => {
    const total = await loadRiskLabAndCountFiltered(page, request);
    const btn = page.getByTestId("risk-lab-show-all-btn");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toHaveText(`Show all ${total} matches`);
    // Capped: exactly 100 rows.
    await expect(page.getByTestId("risk-lab-row")).toHaveCount(100);
    await btn.click();
    // Expanded: all rows render.
    await expect(page.getByTestId("risk-lab-row")).toHaveCount(total);
    await expect(btn).toHaveText(`Collapse to first 100 (of ${total})`);
    // Collapse back.
    await btn.click();
    await expect(page.getByTestId("risk-lab-row")).toHaveCount(100);
    await expect(btn).toHaveText(`Show all ${total} matches`);
  });

  test("Header click cycles desc → asc → reset; aria-sort reflects state", async ({ page, request }) => {
    await loadRiskLabAndCountFiltered(page, request);
    const header = page.getByTestId("risk-lab-header-origScore");
    await expect(header).toHaveAttribute("aria-sort", "none");
    await header.click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    await expect(header).toHaveText(/Orig Score ↓/);
    await header.click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await expect(header).toHaveText(/Orig Score ↑/);
    await header.click();
    await expect(header).toHaveAttribute("aria-sort", "none");
    // Header text after reset starts with "Orig Score" (no arrow). The
    // trailing "i" comes from the appended info bubble (.info-icon), which
    // is part of the header but not part of the sort indicator.
    const resetText = await header.textContent();
    expect(resetText).toMatch(/^Orig Score/);
    expect(resetText).not.toMatch(/[↓↑]/);
  });

  test("Descending Ticker sort orders Z→A (raw field, not display)", async ({ page, request }) => {
    await loadRiskLabAndCountFiltered(page, request);
    const header = page.getByTestId("risk-lab-header-ticker");
    await header.click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    // First three tickers in the rendered table should be in descending order.
    const tickers = await page.locator('[data-testid="risk-lab-row"] > div:first-child').allTextContents();
    expect(tickers.length).toBeGreaterThan(2);
    const firstThree = tickers.slice(0, 3);
    const sortedCopy = [...firstThree].sort((a, b) => b.localeCompare(a));
    expect(firstThree).toEqual(sortedCopy);
  });

  test("Switching lens resets show-all and sort state", async ({ page, request }) => {
    const total = await loadRiskLabAndCountFiltered(page, request);
    // Expand on default (Quality) lens.
    await page.getByTestId("risk-lab-show-all-btn").click();
    await expect(page.getByTestId("risk-lab-show-all-btn"))
      .toHaveText(`Collapse to first 100 (of ${total})`);
    // Activate a sort on Quality lens.
    await page.getByTestId("risk-lab-header-origScore").click();
    await expect(page.getByTestId("risk-lab-header-origScore"))
      .toHaveAttribute("aria-sort", "descending");
    // Switch to Combined view (Macro lens can be empty in current data —
    // empty-state branch hides headers and would break the reset assertions).
    await page.click("button:has-text('Combined view')");
    // Wait for re-render: the show-all button text reverts to "Show all …".
    await expect(page.getByTestId("risk-lab-show-all-btn"))
      .toHaveText(/^Show all \d+ matches$/, { timeout: 5_000 });
    // Sort state reset: aria-sort back to none on Orig Score.
    await expect(page.getByTestId("risk-lab-header-origScore"))
      .toHaveAttribute("aria-sort", "none");
  });
});
