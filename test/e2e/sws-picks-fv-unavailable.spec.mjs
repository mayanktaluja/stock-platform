// Regression: cards whose `fair_value_inr` was nulled by the leaderboard
// sanitiser (FV/Price ratio out of [0.2, 5] or upside out of [-90%, +400%])
// must render an explicit "unavailable" chip with a hover tooltip, not a
// bare em-dash. A bare em-dash reads as "data failed to load" — the chip
// signals "the source FV was junk, this card stays in the section based on
// Snowflake pillars only".
//
// The check is data-driven: we ask /api/sws-picks for the first card with
// `fair_value_inr === null` and only then assert against the DOM. If today's
// picks-latest.json has zero null-FV cards (clean SWS scrape), the spec
// self-skips rather than failing — matches the project's "self-skip on
// missing data preconditions" pattern.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("SWS Picks — FV-unavailable chip", () => {
  test("cards with null fair_value_inr render an explanatory chip, not a bare em-dash", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Find the first null-FV card via the API. The picks endpoint returns
    // sections keyed by category — flatten and look for the sentinel.
    const nullFvTicker = await page.evaluate(async () => {
      const res = await fetch("/api/sws-picks");
      if (!res.ok) return null;
      const body = await res.json();
      const sections = body?.cards || body?.sections || body;
      const buckets = Object.values(sections || {}).filter(Array.isArray);
      for (const bucket of buckets) {
        for (const card of bucket) {
          if (card && card.fair_value_inr == null && card.ticker) return card.ticker;
        }
      }
      return null;
    });

    test.skip(!nullFvTicker, "no null-FV card in today's picks-latest.json — nothing to assert");

    // Each section caps the inline render at PICKS_INLINE_CAP / DEFAULT_CAP,
    // so a null-FV stock might not be in the default top-N slice. Search
    // forces every matching card visible (forceExpand = !!picksSearchQuery
    // in renderPicks), which is also the exact UX flow the user reported.
    await page.fill("#picksSearchInput", nullFvTicker);
    await page.waitForFunction(
      (t) => {
        const cards = document.querySelectorAll(`.sws-pick-card[data-ticker="${t}"]`);
        return cards.length > 0;
      },
      nullFvTicker,
      { timeout: 5_000 }
    );

    // Card markup is `data-ticker="<TICKER>"`. The ticker may appear in
    // multiple sections (e.g. PTC in deep_value AND upcoming_earnings) —
    // assert against ALL matching cards, since the chip is a card-level
    // contract, not a section-level one.
    const cards = page.locator(`.sws-pick-card[data-ticker="${nullFvTicker}"]`);
    const count = await cards.count();
    expect(count, `expected at least one card for ${nullFvTicker}`).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const chip = card.locator(".sws-pick-fv-unavailable");
      await expect(chip, `${nullFvTicker} card #${i} must show the unavailable chip`).toBeVisible();
      await expect(chip).toHaveText(/unavailable/i);

      // Tooltip on the chip explains WHY — verifies the title attribute is
      // present and carries the user-facing rationale, not just a bare
      // "unavailable" with no hover affordance.
      const title = await chip.getAttribute("title");
      expect(title, "chip must carry a title tooltip").toBeTruthy();
      expect(title.length).toBeGreaterThan(40);
      expect(title.toLowerCase()).toContain("snowflake");

      // The bare em-dash must NOT appear inside the FV stat cell. The FV
      // stat is the cell whose label starts with "FV" (excludes Px / Snow).
      // We scope to the cell to avoid false positives from neighbouring cells.
      const fvCellText = await card.locator(".sws-pick-stat", { hasText: "FV" }).first().innerText();
      expect(fvCellText).not.toMatch(/^FV\s*[—–-]\s*$/);
    }
  });

  test("cards with a real fair_value_inr keep the rupee-formatted value (no chip)", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Pick a card the API says has a non-null FV, then assert the chip is
    // absent — guards against the conditional being too broad.
    const goodFvTicker = await page.evaluate(async () => {
      const res = await fetch("/api/sws-picks");
      if (!res.ok) return null;
      const body = await res.json();
      const sections = body?.cards || body?.sections || body;
      const buckets = Object.values(sections || {}).filter(Array.isArray);
      for (const bucket of buckets) {
        for (const card of bucket) {
          if (card && card.fair_value_inr != null && card.fair_value_inr > 0 && card.ticker) return card.ticker;
        }
      }
      return null;
    });

    test.skip(!goodFvTicker, "no non-null-FV card in today's picks-latest.json");

    const card = page.locator(`.sws-pick-card[data-ticker="${goodFvTicker}"]`).first();
    await expect(card).toBeVisible();
    await expect(card.locator(".sws-pick-fv-unavailable")).toHaveCount(0);
    // FV cell shows a ₹ amount.
    const fvCellText = await card.locator(".sws-pick-stat", { hasText: "FV" }).first().innerText();
    expect(fvCellText).toMatch(/₹/);
  });
});
