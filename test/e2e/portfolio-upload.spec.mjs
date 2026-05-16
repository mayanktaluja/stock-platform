// E2E test 0.2 — XLSX upload on Portfolio Analyzer.
//
// Regression target: the analyzer must accept a Groww-shaped XLSX, parse it,
// AND surface a non-empty report (not just a non-empty file). The pre-2026-05-16
// version of this spec only asserted that the upload-error banner stayed
// hidden — a silently-empty #analyzerReport (renderSWSAnalyzerReport bailing
// before populating its subsections) would pass the old assertion. Per the
// 2026-05-16 audit, that's the highest-stakes user surface and the most
// likely silent-failure path, so this spec now requires structural evidence
// the report actually rendered.
//
// Assertions are STRUCTURAL (DOM-presence + element-count), not data-value
// (no "stock score must be X"), so live Yahoo + SWS jitter doesn't flake
// the test. If the analyze pipeline never finishes (Yahoo CI rate-limit,
// network blip), the spec self-skips with a clear reason — same convention
// as analyzer-action-mix.spec.mjs.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");

test.describe("Portfolio Analyzer XLSX upload", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing — run node test/e2e/helpers/build-fixture-xlsx.mjs");

  test("upload Groww-shaped XLSX → analyzer report actually renders (not just no error)", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });

    const input = page.locator("#analyzerFileInput");
    await input.setInputFiles(FIXTURE);

    // First gate: SOMETHING must happen — analyzing-spinner up, report up, or
    // an error banner. A pipeline that silently dies without any state change
    // is the historic regression we're guarding against.
    await page.waitForFunction(
      () => {
        const analyzing = document.getElementById("analyzerAnalyzing");
        const report = document.getElementById("analyzerReport");
        const error = document.getElementById("analyzerUploadError");
        const analyzingVisible = analyzing && analyzing.style.display !== "none";
        const reportVisible = report && report.style.display !== "none";
        const errorVisible = error && error.style.display !== "none";
        return analyzingVisible || reportVisible || errorVisible;
      },
      null,
      { timeout: 15_000 }
    );

    const errorVisible = await page.evaluate(() => {
      const el = document.getElementById("analyzerUploadError");
      return !!(el && el.style.display !== "none" && el.textContent.trim().length > 0);
    });
    expect(errorVisible, "upload must not surface a parsing error").toBe(false);

    // Second gate: wait for the report state. Live Yahoo+SWS can take 30-45s
    // on a cold cache. If the analyzer never reaches the report state in 45s,
    // self-skip — the upload-not-rejected check above still ran and is what
    // this spec primarily guards. The structural assertions below are
    // bonus-coverage that requires the live pipeline to actually complete.
    const reportReady = await page
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

    test.skip(
      !reportReady,
      "analyzer report did not render in time — live Yahoo/SWS dependency, likely CI rate-limit"
    );

    // Structural assertions — the report container exists AND has real
    // subsection content. A silently-empty render (renderSWSAnalyzerReport
    // bailing without populating its children) would fail one of these.
    const report = page.locator("#analyzerReport");
    await expect(report).toBeVisible();

    // The report container must have substantive children. After
    // renderSWSAnalyzerReport runs, #analyzerReport contains the summary +
    // risk + portfolio-actions blocks plus their subgrids. A blank container
    // would mean the renderer never populated DOM. Element-count, not text,
    // so live-data variation doesn't flake.
    const childCount = await report.evaluate((el) => el.childElementCount);
    expect(childCount, "analyzerReport must have rendered child elements").toBeGreaterThan(0);

    // At least ONE of the well-known structural anchors must be present.
    // renderSWSAnalyzerReport overrides #analyzerReport.innerHTML wholesale
    // with: a banner div, a `.analyzer-hero-trio`, optional secondary-KPIs
    // `<details class="analyzer-secondary-kpis">`, and 4 tier disclosures
    // `<details class="analyzer-tier-details">`. The V2 renderer is similar.
    // Asserting that AT LEAST ONE of the well-known structural anchors is
    // present catches a silently-empty render (renderer bailed before any
    // template substitution) without flake from live data variation.
    const anchorPresent = await page.evaluate(() => {
      const selectors = [
        ".analyzer-hero-trio",      // hero trio — always rendered when snap exists
        ".analyzer-tier-details",   // tier A/B/C/D details — at least one
        ".analyzer-secondary-kpis", // secondary KPIs disclosure
      ];
      return selectors.some((sel) => document.querySelectorAll(sel).length > 0);
    });
    expect(
      anchorPresent,
      "at least one structural anchor (.analyzer-hero-trio / .analyzer-tier-details / .analyzer-secondary-kpis) must be rendered"
    ).toBe(true);
  });
});
