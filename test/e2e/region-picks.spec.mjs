// Korea + Taiwan Picks tabs — render, currency (₩ / NT$, never ₹/$), modal,
// filters, admin-gating. One parametrized spec over both regions.
//
// Self-skips a region when its data/sws-<code>/picks-latest.json fixture is
// absent. The test:e2e npm script builds both fixtures (via
// build-region-picks-fixture.mjs) before Playwright runs, so CI always has data.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoApp } from "./helpers/app.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const picksPath = (code) => path.join(__dirname, "..", "..", "data", `sws-${code}`, "picks-latest.json");

// Per region: the symbol that MUST appear and the symbols that MUST NOT (a USD/INR
// leak). KRW has no "$"; TWD is "NT$" so we forbid ₹ + ₩ (not a bare "$").
const REGIONS = {
  kr: { label: "Korea", symbol: "₩", forbidden: ["₹", "$"] },
  tw: { label: "Taiwan", symbol: "NT$", forbidden: ["₹", "₩"] },
};

for (const [code, cfg] of Object.entries(REGIONS)) {
  const dom = `${code}Picks`;
  const HAS_FIXTURE = fs.existsSync(picksPath(code));

  // gotoApp boots into the India picks tab; the region tabs are admin-gated on
  // window.__starbhai_isAdmin, so we set it (as any admin-tab e2e does) first.
  async function openRegionTab(page) {
    await gotoApp(page);
    await page.evaluate(() => { window.__starbhai_isAdmin = true; });
    await page.evaluate((c) => window.switchTab(`${c}Picks`), code);
    await expect(page.locator(`#${dom}Tab`)).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(
      (d) => document.querySelectorAll(`#${d}Container .sws-pick-card`).length > 0,
      dom,
      { timeout: 15_000 },
    );
  }

  test.describe(`${cfg.label} Picks tab`, () => {
    test.skip(!HAS_FIXTURE, `no data/sws-${code}/picks-latest.json fixture present`);

    test(`renders cards in ${cfg.symbol}, never ${cfg.forbidden.join("/")}`, async ({ page }) => {
      await openRegionTab(page);
      const container = page.locator(`#${dom}Container`);
      expect(await container.locator(".sws-pick-card").count()).toBeGreaterThan(0);
      const text = await container.innerText();
      expect(text).toContain(cfg.symbol);
      for (const bad of cfg.forbidden) expect(text).not.toContain(bad);
      await expect(container.locator('[data-section-key="top_ranked_30_v3"]')).toBeVisible();
    });

    test("admin-gated: tab stays hidden without the admin flag", async ({ page }) => {
      await gotoApp(page);
      await page.evaluate(() => { window.__starbhai_isAdmin = false; window.__starbhai_isPersonal = false; });
      await page.evaluate((c) => window.switchTab(`${c}Picks`), code);
      await expect(page.locator(`#${dom}Tab`)).toBeHidden();
    });

    test(`modal opens with the full rich detail (score breakdown + returns) in ${cfg.symbol}`, async ({ page }) => {
      await openRegionTab(page);
      const firstTicker = await page.locator(`#${dom}Container .sws-pick-card`).first().getAttribute("data-ticker");
      await page.evaluate(({ c, t }) => window.openRegionModal(c, t), { c: code, t: firstTicker });
      const modal = page.locator(`#${code}ModalBackdrop`);
      await expect(modal).toHaveClass(/open/, { timeout: 10_000 });
      const txt = await page.locator(`#${code}ModalBody`).innerText();
      expect(txt).toContain(cfg.symbol);
      for (const bad of cfg.forbidden) expect(txt).not.toContain(bad);
      // Headers are uppercased by CSS text-transform → match case-insensitively.
      // (Rewards/Risks are data-dependent — the top-scored fixture name may have
      // none — so the rich-modal proof rests on the always-present sections below.)
      expect(txt).toMatch(/Health/i);
      // PR2 parity: rich sections absent from the old simplified region modal —
      // proves KR/TW now render via the shared renderSwsModalCore.
      expect(txt).toMatch(/Snowflake/i);
      expect(txt).toMatch(/Score breakdown/i);
      expect(txt).toMatch(/Total returns/i);
      await page.evaluate((c) => window.closeRegionModal(c), code);
      await expect(modal).not.toHaveClass(/open/);
    });

    test("search filter narrows then restores cards", async ({ page }) => {
      await openRegionTab(page);
      const before = await page.locator(`#${dom}Container .sws-pick-card`).count();
      await page.fill(`#${dom}SearchInput`, "zzzznomatch_xyz");
      await expect(page.locator(`#${dom}Container`)).toContainText(/No stocks match/i);
      await page.click(`#${dom}SearchClear`);
      expect(await page.locator(`#${dom}Container .sws-pick-card`).count()).toBe(before);
    });

    test("sector filter present; no India Nifty universe filter", async ({ page }) => {
      await openRegionTab(page);
      await expect(page.locator(`#${dom}SectorFilter`)).toBeVisible();
      expect(await page.locator(`#${dom}SectorFilter option`).count()).toBeGreaterThan(1);
      await expect(page.locator(`#${dom}Tab #picksUniverseFilter`)).toHaveCount(0);
      expect(await page.locator(`#${dom}SectorFilter`).innerText()).not.toMatch(/Nifty/i);
    });
  });
}
