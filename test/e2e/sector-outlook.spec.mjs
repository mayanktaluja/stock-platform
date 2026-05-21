// Sector Outlook tab — v1 (bottom-up SWS news theme aggregation × current
// macro regime). Self-skips if the orchestrator hasn't been run locally —
// see scripts/refresh-sector-news-themes.mjs + scripts/refresh-sector-outlook.mjs.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Sector Outlook tab (v1)", () => {
  test("/api/sector-outlook/latest returns the sector-outlook-v1 schema", async ({ request }) => {
    const res = await request.get("/api/sector-outlook/latest");
    if (res.status() === 503) {
      test.skip(true, "outlook-latest.json not yet generated");
    }
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.schema_version).toBe("sector-outlook-v1");
    expect(body).toHaveProperty("generated_at");
    expect(body).toHaveProperty("regime_at_generation");
    expect(body).toHaveProperty("sectors");
    expect(Array.isArray(body.sectors)).toBe(true);
    expect(body).toHaveProperty("gate_met");
    // v1 deliberately ships with gate_met=false (no backtest)
    expect(body.gate_met).toBe(false);
    expect(body).toHaveProperty("caveats");
    expect(Array.isArray(body.caveats)).toBe(true);
    expect(body.caveats.length).toBeGreaterThan(0);
  });

  test("each sector exposes both horizons + outlook_label + confidence", async ({ request }) => {
    const res = await request.get("/api/sector-outlook/latest");
    if (res.status() === 503) test.skip(true, "outlook-latest.json not yet generated");
    const body = await res.json();
    if (body.sectors.length === 0) test.skip(true, "no sectors classified yet");
    const validLabels = ["STRONG_TAILWIND", "TAILWIND", "NEUTRAL", "HEADWIND", "STRONG_HEADWIND"];
    const validConfidence = ["HIGH", "MED", "LOW"];
    for (const s of body.sectors) {
      expect(typeof s.sector).toBe("string");
      expect(s.horizons).toBeTruthy();
      for (const h of ["3_12m", "12_24m"]) {
        expect(s.horizons[h], `sector=${s.sector} horizon=${h}`).toBeTruthy();
        expect(validLabels).toContain(s.horizons[h].outlook_label);
        expect(validConfidence).toContain(s.horizons[h].confidence);
        expect(typeof s.horizons[h].composite).toBe("number");
        expect(s.horizons[h].bottom_up).toBeTruthy();
        expect(typeof s.horizons[h].bottom_up.score).toBe("number");
      }
    }
  });

  test("/api/sector-outlook/healthz reports schema-correct payload", async ({ request }) => {
    const res = await request.get("/api/sector-outlook/healthz");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("exists");
    expect(body).toHaveProperty("stale");
    expect(typeof body.exists).toBe("boolean");
    expect(typeof body.stale).toBe("boolean");
  });

  test("tab button is visible to signed-in users (no admin gate)", async ({ page }) => {
    await gotoApp(page);
    const btn = page.locator("#sectorOutlookTabBtn");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    // Tab button has EXPERIMENTAL pill
    await expect(btn.locator("text=EXPERIMENTAL")).toBeVisible();
  });

  test("clicking the tab renders sector matrix + methodology section", async ({ page, request }) => {
    const apiRes = await request.get("/api/sector-outlook/latest");
    if (apiRes.status() === 503) test.skip(true, "outlook-latest.json not generated");
    await gotoApp(page, { tab: "sectorOutlook" });
    // Heading
    await expect(page.locator("h2:has-text('Sector Outlook')")).toBeVisible({ timeout: 15_000 });
    // Scope summary lookups to this tab — the Track Record tab ships its own
    // SEBI "Methodology — how these numbers are computed" <summary> that lives
    // in the DOM regardless of the active tab, so a page-global
    // summary:has-text('Methodology') resolves to 2 elements (strict-mode fail).
    const tab = page.locator("#sectorOutlookTab");
    // Methodology section is always rendered
    await expect(tab.locator("summary:has-text('Methodology')")).toBeVisible();
    // Backtest panel — explicit EXPERIMENTAL status
    await expect(tab.locator("summary:has-text('Backtest status')")).toBeVisible();
  });

  test("horizon tabs switch matrix between 3-12m and 12-24m", async ({ page, request }) => {
    const apiRes = await request.get("/api/sector-outlook/latest");
    if (apiRes.status() === 503) test.skip(true, "outlook-latest.json not generated");
    const body = await apiRes.json();
    if (body.sectors.length === 0) test.skip(true, "no sectors classified");

    await gotoApp(page, { tab: "sectorOutlook" });
    await expect(page.locator("h2:has-text('Sector Outlook')")).toBeVisible({ timeout: 15_000 });

    // Initial state — 3-12m tab is active
    const tab312 = page.locator(".sector-outlook-horizon-tab[data-horizon='3_12m']");
    const tab1224 = page.locator(".sector-outlook-horizon-tab[data-horizon='12_24m']");
    await expect(tab312).toHaveAttribute("aria-selected", "true");
    await expect(tab1224).toHaveAttribute("aria-selected", "false");

    // Click the 12-24m tab — aria-selected flips
    await tab1224.click();
    await expect(tab1224).toHaveAttribute("aria-selected", "true");
    await expect(tab312).toHaveAttribute("aria-selected", "false");
  });

  test("SEBI-conservative language audit — no 'predict' / 'guarantee' / 'will outperform'", async ({ page, request }) => {
    const apiRes = await request.get("/api/sector-outlook/latest");
    if (apiRes.status() === 503) test.skip(true, "outlook-latest.json not generated");
    await gotoApp(page, { tab: "sectorOutlook" });
    await expect(page.locator("h2:has-text('Sector Outlook')")).toBeVisible({ timeout: 15_000 });
    // Search the visible tab content (not the whole page — site footer might
    // legitimately contain regulatory phrasing). Scoping to #sectorOutlookTab
    // also disambiguates the methodology toggle from the Track Record tab's own
    // "Methodology — how these numbers are computed" <summary> in the DOM.
    const tab = page.locator("#sectorOutlookTab");
    // Open the methodology section so its body is in the DOM tree
    await tab.locator("summary:has-text('Methodology')").click();
    const text = (await tab.textContent()) || "";
    expect(text.toLowerCase()).not.toContain("guarantee");
    expect(text.toLowerCase()).not.toContain("will outperform");
    // 'predict' may appear in disclaimer text "do not interpret as a prediction"
    // — that's the disclaimer itself, so allow it ONLY when prefixed with "not"
    // or "do not". The regex below catches naked predictive claims.
    expect(text).not.toMatch(/\bwe\s+predict\b/i);
    expect(text).not.toMatch(/\bsector\s+will\s+(grow|outperform|rally)\b/i);
    // Required conservative-language anchor — at least one of these phrases
    // must be present so future refactors don't accidentally drop the framing.
    const conservativePhrases = ["indicative", "observed", "no formal backtest", "experimental"];
    const hasConservative = conservativePhrases.some((p) =>
      text.toLowerCase().includes(p),
    );
    expect(hasConservative).toBe(true);
  });

  test("drill-down expands inline evidence on row click", async ({ page, request }) => {
    const apiRes = await request.get("/api/sector-outlook/latest");
    if (apiRes.status() === 503) test.skip(true, "outlook-latest.json not generated");
    const body = await apiRes.json();
    if (body.sectors.length === 0) test.skip(true, "no sectors classified");

    await gotoApp(page, { tab: "sectorOutlook" });
    await expect(page.locator("h2:has-text('Sector Outlook')")).toBeVisible({ timeout: 15_000 });

    const firstSector = body.sectors[0].sector;
    const row = page.locator(`tr[data-sector="${firstSector}"]`);
    await expect(row).toBeVisible();

    const drillRow = page.locator(`tr[data-drilldown-for="${firstSector}"]`);
    // Drill-down starts hidden
    await expect(drillRow).toBeHidden();
    await row.click();
    // After click, drill-down expands
    await expect(drillRow).toBeVisible();
    // Has methodology-style labels inside
    await expect(drillRow.locator("text=Bottom-up signal")).toBeVisible();
    await expect(drillRow.locator("text=Top-down macro")).toBeVisible();
  });

  test("localStorage opt-out hides the tab", async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem("sectorOutlookEnabled_v1", "false"); } catch {}
    });
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.switchTab === "function", null, { timeout: 10_000 });
    // Even with the opt-out, the tab button is rendered in HTML — the GUARD
    // only stops switchTab from opening it. Confirm switchTab refuses.
    await page.evaluate(() => window.switchTab("sectorOutlook"));
    // Should NOT have switched — the tab content remains hidden.
    await expect(page.locator("#sectorOutlookTab")).toBeHidden();
  });
});
