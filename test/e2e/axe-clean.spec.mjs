// PR #12: axe-core a11y scan per non-admin tab. Asserts zero CRITICAL
// WCAG 2.1 AA violations on each tab's first render. Serious + moderate
// + minor are LOGGED but don't fail — the pre-PR platform has multiple
// long-standing serious violations (scrollable-region-focusable on the
// dashboard scrollers, etc.) that aren't regressions introduced by this
// uplift. A future a11y-sweep PR can ratchet the gate down to serious
// once the existing violations are addressed.

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const TABS = ["picks", "news", "track", "analyzer", "watchlist"];

test.describe("PR #12 axe-core a11y scan (critical only)", () => {
  for (const tab of TABS) {
    test(`${tab} tab has no CRITICAL WCAG 2.1 AA violations`, async ({
      page,
    }) => {
      await gotoApp(page);
      if (tab !== "picks") await switchTab(page, tab);
      await page.waitForTimeout(500);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      const critical = results.violations.filter((v) => v.impact === "critical");
      const serious = results.violations.filter((v) => v.impact === "serious");
      if (serious.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[a11y-backlog] ${tab} tab — ${serious.length} serious violations (not gating):`,
          serious.map((v) => `${v.id} (${v.nodes.length} nodes)`).join(", "),
        );
      }
      expect(
        critical,
        `${tab} tab has ${critical.length} CRITICAL WCAG violations: ` +
          critical.map((v) => `${v.id}`).join(", "),
      ).toEqual([]);
    });
  }
});
