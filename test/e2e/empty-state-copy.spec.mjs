// Honest empty states — no CLI leaks for normal users; admin keeps the hint.
//
// Several empty/error states used to tell the END USER to "Run the SWS refresh
// pipeline from the CLI" / "run scripts/…", which reads as an unfinished
// internal tool. PR6 rewrites the copy to plain language and moves the pipeline
// command behind an admin-only detail line (window.__starbhai_isAdmin). This
// spec asserts the rendered DOM text — not the source — so it ignores fetch
// URLs and comments and only checks what a user actually sees.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

// Force the India picks empty state by 404-ing the summary endpoint.
async function routeEmptyPicks(page) {
  await page.route("**/api/sws-picks-summary", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no scan" }) }),
  );
}

const LEAK_PATTERNS = [/scripts\//i, /\/sws-refresh/i, /\bCLI\b/i, /\.mjs\b/i, /snapshot-track-record/i];

test.describe("empty-state copy", () => {
  test("a normal signed-in user sees no CLI/script leaks in the picks empty state", async ({ page }) => {
    await routeEmptyPicks(page);
    await gotoApp(page, { tab: "picks" });

    const empty = page.locator("#picksContainer .empty-state");
    await expect(empty).toBeVisible({ timeout: 10_000 });
    const text = (await empty.innerText()).trim();

    expect(text.length).toBeGreaterThan(0);
    for (const pat of LEAK_PATTERNS) {
      expect(text, `user-facing empty state must not leak "${pat}"`).not.toMatch(pat);
    }
    // No admin detail for a non-admin (isAdmin is undefined in the e2e harness).
    await expect(empty.locator('[data-testid="state-detail"]')).toHaveCount(0);
  });

  test("the owner (admin) still gets the operational hint", async ({ page }) => {
    // Auth-init early-returns under AUTH_ENABLED=false, so __starbhai_isAdmin is
    // never set by the app in e2e — seed it before any script runs.
    await page.addInitScript(() => { window.__starbhai_isAdmin = true; });
    await routeEmptyPicks(page);
    await gotoApp(page, { tab: "picks" });

    const detail = page.locator("#picksContainer .empty-state .state-detail");
    await expect(detail).toBeVisible({ timeout: 10_000 });
    await expect(detail).toContainText(/sws-refresh-api/);
  });
});
