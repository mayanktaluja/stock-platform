// E2E — Top-up badge cap (topup-cap-v1).
//
// Regression targets:
//  1. The action-mix bar's Top-up segment never exceeds the k cap (≤5) —
//     the whole point of the within-book conviction ranking.
//  2. When the cap demoted candidates, the cap note renders and demoted
//     rows surface as "Top-up (if funded)" — eligibility stays visible.
//
// Self-skips when the analyzer report doesn't render (live-price timeout)
// or when the SWS data snapshot produces no Top-up candidates at all
// (e.g. a stale-data window blocks every add via the freshness gate).

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "portfolio-sample.csv");

async function uploadAndWait(page) {
  await gotoApp(page, { tab: "analyzer" });
  await page.locator("#analyzerFileInput").setInputFiles(FIXTURE);
  return page
    .waitForFunction(
      () => {
        const r = document.getElementById("analyzerReport");
        return r && r.style.display !== "none";
      },
      null,
      { timeout: 45_000 }
    )
    .then(() => true)
    .catch(() => false);
}

test.describe("Top-up badge cap", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("action-mix Top-up segment count never exceeds the k cap of 5", async ({ page }) => {
    const reportReady = await uploadAndWait(page);
    test.skip(!reportReady, "analyzer report did not render in time — likely live-price dependency");

    const segment = page.locator(".analyzer-actionmix-segment", { hasText: "Top-up" }).first();
    if ((await segment.count()) === 0) return; // zero top-ups is trivially ≤ 5
    const countText = await segment.locator(".tx-num").innerText();
    const n = Number(countText.trim());
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeLessThanOrEqual(5);
  });

  test("cap note + 'Top-up (if funded)' badges render when the cap demoted candidates", async ({ page }) => {
    const reportReady = await uploadAndWait(page);
    test.skip(!reportReady, "analyzer report did not render in time — likely live-price dependency");

    const note = page.locator('[data-testid="analyzer-topup-cap-note"]');
    const noteCount = await note.count();
    test.skip(
      noteCount === 0,
      "no cap demotions on this data snapshot (stale SWS data blocks adds, or fewer candidates than k)"
    );

    await expect(note).toContainText("within-book conviction rank");
    // Demoted rows keep their eligibility visible via the muted badge label.
    const ifFundedBadge = page.locator("text=Top-up (if funded)").first();
    await expect(ifFundedBadge).toBeVisible();

    // The If-funded bar segment's count matches its modal row count.
    const seg = page.locator(".analyzer-actionmix-segment", { hasText: "If funded" }).first();
    if ((await seg.count()) > 0) {
      const segN = Number((await seg.locator(".tx-num").innerText()).trim());
      await seg.click();
      const backdrop = page.locator("#actionListModalBackdrop");
      await expect(backdrop).toHaveClass(/open/, { timeout: 5_000 });
      const rows = page.locator("#actionListModalBody [data-ticker], #actionListModalBody tbody tr");
      const rowCount = await rows.count();
      if (rowCount > 0) expect(rowCount).toBe(segN);
    }
  });
});
