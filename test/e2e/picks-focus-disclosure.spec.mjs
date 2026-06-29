// India homepage · PR2 declutter — "More screens" disclosure.
//
// The curated core screens (Top 30, Quality Growth, Deep Value, Sector Value,
// Core Compounders) render directly; everything else (momentum, income, niche,
// experimental Gap Lab) is folded into a collapsed <details class="sws-pick-more-
// screens"> to cut choice overload. Verifies the split, the closed-by-default
// state, and that opening the summary reveals the tail screens.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

function row(ticker, upside) {
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: "Industrials",
    current_price_inr: 100,
    fair_value_inr: 100 + upside,
    upside_pct: upside,
    valuation_band: "DISCOUNT",
    fair_value_confidence: "HIGH",
    v4_score_100: 60,
    v4_verdict: "STRONG",
    score: 60,
    snowflake_total: 20,
    one_line: "Synthetic row",
    data_freshness_at: "2026-06-15T06:00:00.000Z",
  };
}

test.describe("India Picks · More-screens disclosure", () => {
  test("core screens render directly; non-core fold into a collapsed disclosure", async ({ page }) => {
    await page.route("**/api/sws-picks**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (!pathname.endsWith("/api/sws-picks") && !pathname.endsWith("/api/sws-picks-summary")) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "picks-latest-v4",
          scoring_version: "test",
          scanned_at: "2026-06-15T06:00:00.000Z",
          indexConstituentsAvailable: false,
          sections: {
            // core
            top_ranked_30_v4: [row("TOP", 30)],
            quality_growth: [row("QG", 25)],
            deep_value: [row("DV", 22)],
            best_fundamentals: [row("CC", 18)],
            // non-core (fold into "More screens")
            midterm: [row("MT", 16)],
            dividend_aristocrats: [row("DIV", 5)],
            snowflake_gap_lab: [{ ...row("GAP", 35), snowflake_gap_lab: { shadow_v4_score_100: 65, score_delta: 10 } }],
          },
        }),
      });
    });

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const more = page.locator("details.sws-pick-more-screens");
    await expect(more).toHaveCount(1);
    // Closed by default (gotoApp clears storage → loadPicksMoreOpen() === false).
    await expect(more).not.toHaveAttribute("open", /.*/);
    await expect(more.locator(".sws-pick-more-summary")).toContainText(/More screens/);

    // Core screens render OUTSIDE the disclosure.
    for (const key of ["top_ranked_30_v4", "quality_growth", "deep_value", "best_fundamentals"]) {
      await expect(more.locator(`.sws-pick-section[data-section-key="${key}"]`)).toHaveCount(0);
      await expect(page.locator(`#picksContainer > .sws-pick-section[data-section-key="${key}"], #picksContainer .sws-pick-section[data-section-key="${key}"]`).first()).toBeAttached();
    }

    // Non-core screens (incl. experimental Gap Lab) live INSIDE the disclosure.
    for (const key of ["midterm", "dividend_aristocrats", "snowflake_gap_lab"]) {
      await expect(more.locator(`.sws-pick-section[data-section-key="${key}"]`)).toHaveCount(1);
    }

    // Opening the summary expands the disclosure.
    await more.locator(".sws-pick-more-summary").click();
    await expect(more).toHaveAttribute("open", /.*/);
  });
});
