// E2E test — Author-holdings disclosure (P0.5, 2026-05-16).
//
// Verifies the GET /api/disclosures/holdings endpoint serves the JSON
// disclosure file and the SEBI footer links to it. SEBI RA Reg 24(2)
// requires research analysts to disclose positions in covered securities
// at the time of publication; this is the friends-and-family compliant
// surface for that requirement.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Author-holdings disclosure", () => {
  test("GET /api/disclosures/holdings returns the disclosure JSON", async ({ request }) => {
    const r = await request.get("/api/disclosures/holdings");
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.author_handle).toBe("starbhai");
    expect(j.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Array.isArray(j.third_party_data_providers)).toBe(true);
    expect(j.third_party_data_providers.length).toBeGreaterThan(0);
    expect(j.disclosure_statement).toMatch(/educational research platform/i);
    expect(j.grievance_contact).toBeTruthy();
  });

  test("third-party data providers section flags SWS, Yahoo, NSE", async ({ request }) => {
    const r = await request.get("/api/disclosures/holdings");
    const j = await r.json();
    const names = j.third_party_data_providers.map((p) => p.name);
    expect(names.some((n) => /simply wall/i.test(n))).toBe(true);
    expect(names.some((n) => /yahoo/i.test(n))).toBe(true);
    expect(names.some((n) => /NSE|national stock exchange/i.test(n))).toBe(true);
  });

  test("SEBI footer links to the disclosure endpoint", async ({ page }) => {
    await gotoApp(page);
    const link = page.locator('[data-testid="holdings-disclosure-link"] a[href="/api/disclosures/holdings"]');
    await expect(link).toBeVisible();
  });

  test("SEBI footer mentions grievance contact", async ({ page }) => {
    await gotoApp(page);
    const grievance = page.locator('[data-testid="holdings-disclosure-link"] a[href^="mailto:"]');
    await expect(grievance).toBeVisible();
  });
});
