// Privileged "More" menu — the 6 admin-only tabs (Users + the former personal
// sleeves + the 2 experimental tabs) are pulled out of the congested #mainTabs
// bar for admins and reached via a header dropdown instead.
//
// In test mode AUTH_ENABLED=false, so /api/auth/me returns 401 and the SPA
// never sets the privileged flags. We intercept that endpoint to drive the REAL
// auth.init() → bootstrap → buildLabsMenu() path (rather than poking globals),
// so the test exercises exactly what an allowlisted owner would trigger.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const PRIVILEGED_ME = {
  userId: "e2e-owner",
  email: "owner@example.com",
  name: "Owner",
  picture: "",
  isAdmin: true,
};

// Register before navigation so the SPA's /api/auth/me fetch is intercepted.
async function mockPrivileged(page, me = PRIVILEGED_ME) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(me),
    }),
  );
}

const MIGRATED_BTNS = [
  "usersTabBtn",
  "compounderTabBtn",
  "earningsEdgeTabBtn",
  "multibaggerLabTabBtn",
  "riskLabTabBtn",
  "sectorOutlookTabBtn",
];

test.describe("Privileged 'More' menu", () => {
  test("admin: trigger shows, 6 tabs leave the bar, dropdown lists the gated set", async ({ page }) => {
    await mockPrivileged(page);
    await gotoApp(page);

    // Trigger revealed by the real auth.init bootstrap.
    await expect(page.locator("#labsMenuBtn")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#labsMenuBtn")).toHaveAttribute("aria-haspopup", "true");
    await expect(page.locator("#labsMenuBtn")).toHaveAttribute("aria-expanded", "false");

    // All 6 privileged tabs are pulled out of the bar.
    for (const id of MIGRATED_BTNS) {
      await expect(page.locator(`#${id}`)).toBeHidden();
    }

    // Open the menu → dropdown visible, aria-expanded flips. An admin sees 9
    // items: Users + US/Korea/Taiwan Picks (open to all, surfaced here too) +
    // Compounder/Earnings Edge/5x Lab + Risk Lab + Sector Outlook (gotoApp
    // clears storage, so the two opt-out tabs are present).
    await page.locator("#labsMenuBtn").click();
    await expect(page.locator("#labsMenuDropdown")).toBeVisible();
    await expect(page.locator("#labsMenuDropdown")).toHaveAttribute("role", "menu");
    await expect(page.locator("#labsMenuBtn")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".labs-menu-item")).toHaveCount(9);
    await expect(page.locator('.labs-menu-item[role="menuitem"]')).toHaveCount(9);
  });

  test("clicking a dropdown tab activates it + lights the trigger; bar clears; switching back resets", async ({ page }) => {
    await mockPrivileged(page);
    await gotoApp(page);
    await expect(page.locator("#labsMenuBtn")).toBeVisible({ timeout: 10_000 });

    await page.locator("#labsMenuBtn").click();
    await page.locator("#labsItem_riskLab").click();

    await expect(page.locator("#riskLabTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#labsMenuBtn")).toHaveClass(/is-active/);
    await expect(page.locator("#labsItem_riskLab")).toHaveAttribute("aria-current", "true");
    // No BAR tab is active while a dropdown tab is open.
    await expect(page.locator("#mainTabs .tab.active")).toHaveCount(0);
    // Menu auto-closes on selection.
    await expect(page.locator("#labsMenuDropdown")).toBeHidden();

    // Switch back to a bar tab → trigger reverts to neutral, bar tab lights up.
    await page.evaluate(() => window.switchTab("picks"));
    await expect(page.locator("#picksTab")).toBeVisible();
    await expect(page.locator("#labsMenuBtn")).not.toHaveClass(/is-active/);
    await expect(page.locator("#picksTabBtn")).toHaveClass(/active/);
  });

  test("exact-match: switchTab('earnings') does not bleed into Earnings Edge", async ({ page }) => {
    await mockPrivileged(page);
    await gotoApp(page);
    await expect(page.locator("#labsMenuBtn")).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => window.switchTab("earnings"));
    await expect(page.locator("#earningsTab")).toBeVisible({ timeout: 10_000 });
    // Earnings Watch stays a normal bar tab and is the active one.
    await expect(page.locator("#earningsTabBtn")).toHaveClass(/active/);
    // The Earnings Edge dropdown item is NOT marked active (the old substring
    // match — onclick.includes('earnings') — would have marked it).
    await expect(page.locator("#labsItem_earningsEdge")).toHaveAttribute("aria-current", "false");
    await expect(page.locator("#labsMenuBtn")).not.toHaveClass(/is-active/);
  });

  test("normal user: no trigger; Risk Lab + Sector Outlook are hidden", async ({ page }) => {
    // No /api/auth/me mock → 401 in test mode → not admin.
    await gotoApp(page);
    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#labsMenu")).toBeHidden();
    // Two-tier model: the experimental tabs are admin-only now, so their bar
    // buttons are hidden for non-admins (reached only via the admin dropdown).
    await expect(page.locator("#riskLabTabBtn")).toBeHidden();
    await expect(page.locator("#sectorOutlookTabBtn")).toBeHidden();
  });
});
