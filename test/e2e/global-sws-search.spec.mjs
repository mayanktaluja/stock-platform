// Header global search — SWS markets route to the right modal.
//
// The e2e harness builds US/KR/TW fixture universes under .e2e/sws-root.
// Region lowercase fixture checks self-skip when the synthetic universe does
// not include a mixed-case ticker; unit tests still lock the canonical resolver.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.setTimeout(60_000);

async function searchHeader(page, query) {
  const input = page.locator("#searchInput");
  await input.click();
  await input.fill(query);
  await expect(page.locator("#searchResults")).toHaveClass(/active/, { timeout: 5_000 });
  await expect(page.locator(".search-result-item").first()).toBeVisible({ timeout: 10_000 });
}

async function apiSearch(page, query) {
  return page.evaluate(async (q) => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    return res.json();
  }, query);
}

test.describe("Header global SWS search", () => {
  test("India result opens the India SWS modal", async ({ page }) => {
    await gotoApp(page);
    await searchHeader(page, "CHENNPETRO");
    const row = page.locator('.search-result-item[data-market="india"]').first();
    test.skip((await row.count()) === 0, "no India result for CHENNPETRO in this fixture");
    await row.click();
    await expect(page.locator("#swsModalBackdrop")).toHaveClass(/open/, { timeout: 10_000 });
    await expect(page.locator("#swsModalBody")).toContainText(/CHENNPETRO|Chennai Petroleum/i, { timeout: 10_000 });
  });

  test("US result opens the US market modal", async ({ page }) => {
    await gotoApp(page);
    const payload = await apiSearch(page, "AAPL");
    test.skip(!payload.results?.some((r) => r.market === "us" && r.ticker === "AAPL"), "no AAPL US fixture available");
    await searchHeader(page, "AAPL");
    const row = page.locator('.search-result-item[data-market="us"][data-ticker="AAPL"]').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(page.locator("#usModalBackdrop")).toHaveClass(/open/, { timeout: 10_000 });
    await expect(page.locator("#usModalBody")).toContainText(/AAPL|Apple/i, { timeout: 10_000 });
  });

  test("mixed-case KR/TW result opens the region modal when fixture exists", async ({ page }) => {
    await gotoApp(page);
    const probes = [
      { q: "Q500036", market: "kr", modal: "#krModalBackdrop", body: "#krModalBody" },
      { q: "01001T", market: "tw", modal: "#twModalBackdrop", body: "#twModalBody" },
      { q: "8349A", market: "tw", modal: "#twModalBackdrop", body: "#twModalBody" },
    ];
    let chosen = null;
    for (const probe of probes) {
      const payload = await apiSearch(page, probe.q);
      const hit = payload.results?.find((r) => r.market === probe.market && /[a-z]/.test(r.ticker || ""));
      if (hit) {
        chosen = { ...probe, ticker: hit.ticker };
        break;
      }
    }
    test.skip(!chosen, "no mixed-case KR/TW fixture available");
    await searchHeader(page, chosen.q);
    const row = page.locator(`.search-result-item[data-market="${chosen.market}"][data-ticker="${chosen.ticker}"]`).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(page.locator(chosen.modal)).toHaveClass(/open/, { timeout: 10_000 });
    await expect(page.locator(chosen.body)).toContainText(chosen.ticker, { timeout: 10_000 });
  });
});
