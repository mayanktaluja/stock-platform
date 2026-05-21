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
  kr: { label: "Korea", symbol: "₩", forbidden: ["₹", "$"], universeLabels: ["KOSPI 200", "KOSDAQ 150", "KRX 300"], enabledIndex: "kospi200" },
  tw: { label: "Taiwan", symbol: "NT$", forbidden: ["₹", "₩"], universeLabels: ["Taiwan 50", "Taiwan Mid-Cap 100", "TPEx 50"], enabledIndex: null },
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
      await expect(container.locator('.sws-pick-section[data-section-key="top_ranked_30_v3"]')).toBeVisible();
    });

    test("open to all signed-in users: tab renders without the admin flag", async ({ page }) => {
      await gotoApp(page);
      await page.evaluate(() => { window.__starbhai_isAdmin = false; window.__starbhai_isPersonal = false; });
      await page.evaluate((c) => window.switchTab(`${c}Picks`), code);
      await expect(page.locator(`#${dom}Tab`)).toBeVisible({ timeout: 10_000 });
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

    test("collapsible sections: chip-nav + Expand/Collapse-all toggle the accordion", async ({ page }) => {
      await openRegionTab(page);
      await expect(page.locator(`#${dom}Container .sws-pick-chipnav`)).toBeVisible();
      const hero = page.locator(`#${dom}Container .sws-pick-section[data-section-key="top_ranked_30_v3"]`);
      await expect(hero).not.toHaveClass(/collapsed/); // hero open by default
      await page.locator(`#${dom}Container .sws-pick-chip-action`, { hasText: "Collapse all" }).click();
      await expect(hero).toHaveClass(/collapsed/);
      await page.locator(`#${dom}Container .sws-pick-chip-action`, { hasText: "Expand all" }).click();
      await expect(hero).not.toHaveClass(/collapsed/);
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

    test("universe dropdown renders the region's index options", async ({ page }) => {
      await openRegionTab(page);
      const sel = page.locator(`#${dom}UniverseFilter`);
      await expect(sel).toBeVisible();
      const txt = await sel.innerText();
      expect(txt).toMatch(/All scored/);
      for (const lbl of cfg.universeLabels) expect(txt).toContain(lbl);
    });

    test("each index option is enabled iff the server reports its constituents loaded", async ({ page }) => {
      await openRegionTab(page);
      const state = await page.evaluate((c) => {
        const d = regionPicksState[c] && regionPicksState[c].data;
        const avail = (d && d.universeFilters && d.universeFilters.available) || [];
        const sel = document.getElementById(`${c}PicksUniverseFilter`);
        const opts = [...sel.options].filter((o) => o.value !== "all").map((o) => ({ value: o.value, disabled: o.disabled }));
        return { avail, opts };
      }, code);
      expect(state.opts.length).toBeGreaterThan(0);
      // Graceful degradation: a named option is disabled exactly when its index
      // list isn't loaded (KR ships KOSPI 200; TW ships none until a feed is wired).
      for (const o of state.opts) {
        expect(o.disabled, `${code} option ${o.value} disabled should equal !available`).toBe(!state.avail.includes(o.value));
      }
    });

    test("selecting an available index narrows to members, then restores", async ({ page }) => {
      test.skip(!cfg.enabledIndex, `${cfg.label} has no sourced index constituents yet`);
      await openRegionTab(page);
      const before = await page.locator(`#${dom}Container .sws-pick-card`).count();
      await page.selectOption(`#${dom}UniverseFilter`, cfg.enabledIndex);
      await page.waitForTimeout(300);
      const res = await page.evaluate(({ c, idx }) => {
        const d = regionPicksState[c].data;
        const mem = new Set();
        for (const items of Object.values(d.sections)) {
          if (Array.isArray(items)) for (const it of items) if (it && it[idx]) mem.add(it.ticker);
        }
        const tickers = [...document.querySelectorAll(`#${c}PicksContainer .sws-pick-card`)].map((x) => x.getAttribute("data-ticker"));
        return { ok: tickers.every((t) => mem.has(t)), members: mem.size };
      }, { c: code, idx: cfg.enabledIndex });
      expect(res.members).toBeGreaterThan(0); // fixture carries real KOSPI 200 names
      expect(res.ok).toBe(true);              // every visible card is an index member
      expect(await page.locator(`#${dom}Container .sws-pick-card`).count()).toBeLessThanOrEqual(before);
      await page.selectOption(`#${dom}UniverseFilter`, "all");
      await page.waitForTimeout(300);
      expect(await page.locator(`#${dom}Container .sws-pick-card`).count()).toBe(before);
    });
  });
}
