// PR #12: axe-core a11y scan per non-admin tab. Asserts zero CRITICAL
// WCAG 2.1 AA violations on each tab's first render. Serious + moderate
// + minor are LOGGED but don't fail — the pre-PR platform has multiple
// long-standing serious violations (scrollable-region-focusable on the
// dashboard scrollers, etc.) that aren't regressions introduced by this
// uplift. A future a11y-sweep PR can ratchet the gate down to serious
// once the existing violations are addressed.
//
// F1 update: parametrized over BOTH themes — the light palette (A1) must be
// as critical-clean as dark. Per-test timeout is 90s because the track tab's
// /api/track/history takes ~13s on a cold cache in the test env; the old 30s
// budget expired mid-axe-scan and masqueraded as an a11y failure.

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const TABS = ["picks", "news", "track", "analyzer", "watchlist"];
const THEMES = ["dark", "light"];

test.describe("PR #12 axe-core a11y scan (critical only)", () => {
  for (const theme of THEMES) {
    for (const tab of TABS) {
      test(`${tab} tab (${theme}) has no CRITICAL WCAG 2.1 AA violations`, async ({
        page,
      }) => {
        test.setTimeout(90_000);
        await gotoApp(page);
        // Set theme AFTER gotoApp (its first-nav storage-clear would wipe it),
        // then reload so the boot script re-resolves from localStorage.
        await page.evaluate((t) => localStorage.setItem("theme", t), theme);
        await page.reload();
        await page.waitForFunction(
          (t) => document.documentElement.getAttribute("data-theme") === t,
          theme,
        );
        if (tab !== "picks") await switchTab(page, tab);
        await page.waitForTimeout(500);
        // Let slow tabs (track: ~13s cold /api/track/history) settle so axe
        // doesn't race a mid-render DOM.
        await page
          .waitForLoadState("networkidle", { timeout: 30_000 })
          .catch(() => {});
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        const critical = results.violations.filter(
          (v) => v.impact === "critical",
        );
        const serious = results.violations.filter(
          (v) => v.impact === "serious",
        );
        if (serious.length > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[a11y-backlog] ${tab}/${theme} — ${serious.length} serious violations (not gating):`,
            serious.map((v) => `${v.id} (${v.nodes.length} nodes)`).join(", "),
          );
        }
        expect(
          critical,
          `${tab} tab (${theme}) has ${critical.length} CRITICAL WCAG violations: ` +
            critical.map((v) => `${v.id}`).join(", "),
        ).toEqual([]);
      });
    }
  }
});
