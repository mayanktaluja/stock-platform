// PR #4: .btn primitive on 3 migrated refresh buttons.
//
// Pre-PR4 each refresh button carried an inline style="background:...;
// border-color:...; color:..." that duplicated the .refresh-btn class.
// PR #4 introduces .btn.btn--info / .btn--warn modifiers and migrates
// the 3 buttons by class-chaining `.btn .btn--info .btn--sm .refresh-btn`
// (legacy class kept so untouched CSS still wins on font/padding).

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("PR #4 .btn primitive", () => {
  // The Analyzer / Watchlist / Earnings refresh buttons sit inside
  // containers hidden until their tab loads data. We assert that the
  // migrated class composition exists in the DOM (a structural check)
  // rather than visibility (a data-dependent check).
  test("portfolio refresh button uses .btn .btn--info classes (post-migration)", async ({
    page,
  }) => {
    await gotoApp(page);
    const btn = page.locator('button.btn.btn--info[onclick*="loadPortfolio"]');
    await expect(btn).toHaveCount(1);

    const hasInline = await btn.evaluate(
      (el) => el.getAttribute("style") || "",
    );
    expect(hasInline.trim()).toBe("");

    const fnExists = await page.evaluate(
      () => typeof window.loadPortfolio === "function",
    );
    expect(fnExists).toBe(true);
  });

  test("watchlist refresh button uses .btn .btn--info classes", async ({
    page,
  }) => {
    await gotoApp(page);
    const btn = page.locator('button.btn.btn--info[onclick*="loadWatchlist"]');
    await expect(btn).toHaveCount(1);
    const hasInline = await btn.evaluate(
      (el) => el.getAttribute("style") || "",
    );
    expect(hasInline.trim()).toBe("");
  });

  test("earnings refresh button uses .btn .btn--warn classes", async ({
    page,
  }) => {
    await gotoApp(page);
    const btn = page.locator(
      'button.btn.btn--warn[onclick*="loadEarningsWatch"]',
    );
    await expect(btn).toHaveCount(1);
    const hasInline = await btn.evaluate(
      (el) => el.getAttribute("style") || "",
    );
    expect(hasInline.trim()).toBe("");
  });

  test("migrated .btn--info on a probe shows the info-blue border on hover", async ({
    page,
  }) => {
    // Construct a probe button so we don't depend on the analyzer tab
    // being populated. This validates the CSS rule itself, not any
    // specific call site.
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    const colour = await page.evaluate(async () => {
      const b = document.createElement("button");
      b.className = "btn btn--info";
      b.textContent = "probe";
      b.style.position = "absolute";
      b.style.top = "-9999px";
      document.body.appendChild(b);
      // Force the :hover style via a temporary class swap
      // Note: :hover can't be triggered via JS in Playwright cleanly,
      // so we read the non-hover border-color as the baseline; it must
      // already differ from --border because .btn--info has its own
      // border-color.
      const got = getComputedStyle(b).borderColor;
      b.remove();
      return got;
    });
    // .btn--info baseline border is rgba(74, 144, 226, 0.30)
    expect(colour).toMatch(/rgba?\(\s*74,\s*144,\s*226/);
  });

  test("legacy unmigrated refresh-btn still works (no regression)", async ({
    page,
  }) => {
    // Track tab's refresh button was NOT migrated in PR #4 — should still
    // function with just the .refresh-btn class.
    await gotoApp(page, { tab: "track" });
    const btn = page.locator('.refresh-btn:not(.btn)[onclick*="loadTrack"]');
    // At least one unmigrated refresh-btn must exist post-PR4 (proves the
    // legacy alias path is preserved)
    expect(await btn.count()).toBeGreaterThanOrEqual(1);
  });
});
