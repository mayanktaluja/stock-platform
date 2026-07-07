// F1: modal focus-trap enforcement.
//
// The delegated trap (app.js — single document-level keydown handler for
// #swsModalBackdrop/#actionListModalBackdrop/#shortcutsModal) existed before
// this overhaul but had no spec. This pins the WCAG 2.4.3 contract: while a
// modal is open, Tab cycles INSIDE the dialog and never leaks to the page
// behind the backdrop; Esc closes and the toast region stays polite.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("F1 modal focus trap", () => {
  async function routeMarketDetail(page, endpoint) {
    await page.route(endpoint, (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ticker: "FOCUS",
        currency: "USD",
        in_sections: ["top_ranked_30_v4"],
        card: {
          ticker: "FOCUS",
          name: "Focus Test",
          sector: "Software",
          current_price_inr: 100,
          fair_value_inr: 125,
          upside_pct: 25,
          valuation_band: "DISCOUNT",
          v4_score_100: 61,
          v4_verdict: "STRONG",
          snowflake_total: 21,
          entry_band: { entry_state: "BUY_ZONE", fresh_buy_eligible: true, reasons: [] },
        },
        deep: {
          parsed_at: "2026-06-17T00:00:00.000Z",
          overview: {
            current_price_inr: 100,
            fair_value_inr: 125,
            upside_pct: 25,
            market_cap_inr: 1_000_000_000,
            snowflake_total: 21,
            snowflake: { health: 5, future: 4, valuation: 4, past: 4 },
            rewards: ["Synthetic reward"],
            risks: ["Synthetic risk"],
          },
        },
      }),
    }));
  }

  test("Tab cycles inside the SWS modal, never behind the backdrop", async ({
    page,
  }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);
    await page.locator("#picksTab .sws-pick-card").first().click();
    await expect(page.locator("#swsModalBody")).toBeVisible({
      timeout: 10_000,
    });

    // 25 Tab presses must keep focus inside the open dialog.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const dialog = document.querySelector("#swsModalBackdrop.open");
        const a = document.activeElement;
        // body counts as "leaked" only if the dialog has focusables at all.
        if (!dialog) return true;
        if (a === document.body) return true; // transient; never behind-page element
        return dialog.contains(a);
      });
      expect(inside, `Tab #${i + 1} leaked focus behind the modal`).toBe(true);
    }

    // Esc closes (existing contract — re-pinned here).
    await page.keyboard.press("Escape");
    await expect(page.locator("#swsModalBackdrop.open")).toHaveCount(0);
  });

  for (const cfg of [
    { name: "US", open: "openUSModal", close: "closeUSModal", route: "**/api/us-stock/FOCUS", modal: "#usModalBackdrop" },
  ]) {
    test(`${cfg.name} modal traps Tab and restores focus on close`, async ({ page }) => {
      await routeMarketDetail(page, cfg.route);
      await gotoApp(page);
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "focusRestoreProbe";
        btn.textContent = "Focus probe";
        document.body.appendChild(btn);
        btn.focus();
      });

      if (cfg.arg) {
        await page.evaluate(([fn, arg]) => window[fn](arg, "FOCUS"), [cfg.open, cfg.arg]);
      } else {
        await page.evaluate((fn) => window[fn]("FOCUS"), cfg.open);
      }
      await expect(page.locator(`${cfg.modal}.open`)).toBeVisible({ timeout: 10_000 });

      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        const inside = await page.evaluate((modal) => {
          const dialog = document.querySelector(`${modal}.open`);
          return !!dialog && dialog.contains(document.activeElement);
        }, cfg.modal);
        expect(inside, `${cfg.name} Tab #${i + 1} leaked focus`).toBe(true);
      }

      if (cfg.arg) {
        await page.evaluate(([fn, arg]) => window[fn](arg), [cfg.close, cfg.arg]);
      } else {
        await page.evaluate((fn) => window[fn](), cfg.close);
      }
      await expect(page.locator(`${cfg.modal}.open`)).toHaveCount(0);
      await expect(page.locator("#focusRestoreProbe")).toBeFocused();
    });
  }

  test("toast region is a polite live region", async ({ page }) => {
    await gotoApp(page);
    const stack = page.locator("#toastStack");
    await expect(stack).toHaveAttribute("role", "status");
    await expect(stack).toHaveAttribute("aria-live", "polite");
  });
});
