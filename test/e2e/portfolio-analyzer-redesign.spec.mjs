// D2: Portfolio Analyzer (V1 path) redesign guard.
//
// Contract-safe redesign: inline hex in the V1 render fns is migrated to
// var(--token) so the report themes; DOM handles are untouched.
//
// NAMING: "portfolio-analyzer-redesign" deliberately sorts AFTER
// portfolio-analyzer-dividends and portfolio-analyzer-fresh-banner (d < f < r,
// single worker, alphabetical). This spec uploads the shared fixture, which
// primes the server-side analyzer cache (~60s TTL) — running it BEFORE the
// fresh-banner spec would feed that spec a stale snapshot_at and break its
// `>= t0` assertion. Same hazard class the dividends spec documents.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");

// Legacy raw hexes migrated to tokens in D2 — must not reappear in the
// rendered V1 report. (HTML entities like &#9888; don't match these.)
const LEGACY_HEX = [
  "#fca5a5",
  "#86efac",
  "#93c5fd",
  "#fde047",
  "#1a2233",
  "#1a2238",
  "#2a3349",
  "#111827",
  "#0b1220",
  "#9ca3af",
];

async function uploadAndWaitForReport(page, fixturePath) {
  const expectedSourceFile = basename(fixturePath);
  await page.locator("#analyzerFileInput").setInputFiles(fixturePath);
  await page.waitForFunction(
    (sourceFile) => {
      const r = document.getElementById("analyzerReport");
      const cache = typeof _analyzerCache !== "undefined" ? _analyzerCache : null;
      return (
        r &&
        r.style.display !== "none" &&
        r.innerHTML.length > 0 &&
        cache?.sourceFile === sourceFile
      );
    },
    expectedSourceFile,
    { timeout: 30_000 },
  );
}

test.describe("D2 analyzer redesign", () => {
  test.skip(
    !existsSync(FIXTURE),
    "fixture missing — run `node test/e2e/helpers/build-fixture-xlsx.mjs`",
  );

  test("report is token-driven and re-themes", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("starbhaiTheme", "dark");
        localStorage.removeItem("theme");
      } catch {}
    });
    await gotoApp(page, { tab: "analyzer" });
    await uploadAndWaitForReport(page, FIXTURE);

    const report = page.locator("#analyzerReport");
    const html = await report.evaluate((el) => el.innerHTML);

    // Token-driven: the report references vars, not legacy hex.
    expect(html).toContain("var(--");
    for (const hex of LEGACY_HEX) {
      expect(html, `legacy ${hex} should be tokenized`).not.toContain(hex);
    }

    // Theme flip: a report panel's computed background must change.
    // (Re-upload after reload — the client cache dies with the page.)
    // Probe token RESOLUTION at the report node rather than any single
    // element's background — V1 panels use rgba() backgrounds, so a
    // background probe computes transparent in both themes. The resolved
    // value of a swept token proves the cascade theme-flips the surface.
    const panelBg = () =>
      report.evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--surface-navy").trim(),
      );
    const darkBg = await panelBg();
    await page.evaluate(() => {
      localStorage.setItem("starbhaiTheme", "light");
      localStorage.removeItem("theme");
    });
    await page.reload();
    await gotoApp(page, { tab: "analyzer" });
    await uploadAndWaitForReport(page, FIXTURE);
    const lightBg = await panelBg();
    expect(lightBg).not.toBe(darkBg);
  });
});
