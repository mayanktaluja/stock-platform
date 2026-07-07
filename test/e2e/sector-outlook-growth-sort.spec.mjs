// Sector Outlook tab — growth-sort behaviour (default rank, Trust toggle,
// per-horizon persistence, click-to-sort headers). Companion to
// sector-outlook.spec.mjs; same 503 / empty-sectors self-skip harness so it
// stays green on a clean checkout where the orchestrator hasn't been run —
// see scripts/refresh-sector-outlook.mjs.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

// ── expected-order helpers (mirror gated/sectorOutlook.js exactly) ──────────
// Kept in-file so the spec computes the same rank the frontend renders and can
// assert equality rather than eyeballing DOM cell text.

function growthKey(h) {
  if (!h || typeof h !== "object") return -Infinity;
  if (Number.isFinite(Number(h.growth_rank_score))) return Number(h.growth_rank_score);
  const raw = h.top_down?.status === "UNCORROBORATED" ? Number(h.bottom_up?.score) : Number(h.composite);
  return Number.isFinite(raw) ? raw : -Infinity;
}

// Default sort: signed growth key desc → trust → breadth → name (stable).
function growthSortedSectors(body, horizon) {
  return [...(body.sectors || [])].sort((a, b) => {
    const ah = a.horizons?.[horizon] || {};
    const bh = b.horizons?.[horizon] || {};
    const ga = growthKey(ah), gb = growthKey(bh);
    if (ga !== gb) return gb > ga ? 1 : -1;
    const tr = (Number(bh.trust_score) || 0) - (Number(ah.trust_score) || 0);
    if (tr) return tr;
    const br = (Number(bh.bottom_up?.breadth_pct) || 0) - (Number(ah.bottom_up?.breadth_pct) || 0);
    if (br) return br;
    return String(a.sector || "").localeCompare(String(b.sector || ""));
  }).map((s) => s.sector);
}

// Legacy trust-first sort: confidence desc → trust_score desc → abs(composite)
// desc → direction rank desc, then stable (preserves body.sectors order).
function trustSortedSectors(body, horizon) {
  const confidenceRank = { HIGH: 3, MED: 2, LOW: 1 };
  const directionRank = { STRONG_TAILWIND: 5, STRONG_HEADWIND: 4, TAILWIND: 3, HEADWIND: 2, NEUTRAL: 1 };
  return [...(body.sectors || [])].sort((a, b) => {
    const ah = a.horizons?.[horizon] || {};
    const bh = b.horizons?.[horizon] || {};
    const cr = (confidenceRank[bh.confidence] || 0) - (confidenceRank[ah.confidence] || 0);
    if (cr) return cr;
    const tr = (Number(bh.trust_score) || 0) - (Number(ah.trust_score) || 0);
    if (tr) return tr;
    const ar = Math.abs(Number(bh.composite) || 0) - Math.abs(Number(ah.composite) || 0);
    if (ar) return ar;
    return (directionRank[bh.outlook_label] || 0) - (directionRank[ah.outlook_label] || 0);
  }).map((s) => s.sector);
}

// News(90d) sort key — matches the COLUMN_ACCESSORS.news accessor in the
// frontend (numeric n_news, non-finite sinks to -Infinity).
function newsKey(h) {
  const n = Number(h?.bottom_up?.n_news);
  return Number.isFinite(n) ? n : -Infinity;
}

// Sector → horizon-object map for a given horizon, for re-deriving cell values
// from the API in rendered DOM order.
function horizonMap(body, horizon) {
  const m = new Map();
  for (const s of body.sectors || []) m.set(s.sector, s.horizons?.[horizon] || {});
  return m;
}

// ── DOM readers ─────────────────────────────────────────────────────────────

async function renderedSectors(page) {
  return page.locator("#sectorOutlookTab tr[data-sector]").evaluateAll((rows) =>
    rows.map((r) => r.getAttribute("data-sector")),
  );
}

async function renderedGrowthScores(page) {
  return page.locator("#sectorOutlookTab tr[data-sector]").evaluateAll((rows) =>
    rows.map((r) => r.getAttribute("data-growth-score")),
  );
}

// Parse a raw data-growth-score list to finite numbers, dropping "" / null /
// non-finite entries (those rank to the bottom, so the finite prefix is what
// carries the ordering claim).
function finiteScores(raw) {
  return raw
    .filter((v) => v != null && v !== "" && Number.isFinite(Number(v)))
    .map((v) => Number(v));
}

// Assert a numeric sequence is monotonic. Tiny epsilon absorbs float rounding
// (values are emitted at 4dp); -Infinity comparisons stay well-defined.
function assertMonotonic(values, direction, epsilon = 1e-6) {
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (direction === "desc") {
      expect(prev + epsilon >= cur, `expected non-increasing at index ${i}: ${prev} then ${cur}`).toBe(true);
    } else {
      expect(prev - epsilon <= cur, `expected non-decreasing at index ${i}: ${prev} then ${cur}`).toBe(true);
    }
  }
}

async function waitForMatrix(page) {
  await expect(page.locator("h2:has-text('Sector Outlook')")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#sectorOutlookTab tr[data-sector]").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("Sector Outlook — growth sort", () => {
  test("default sort is growth-descending (tailwinds above headwinds)", async ({ page, request }) => {
    const res = await request.get("/api/sector-outlook/latest");
    if (res.status() === 503) test.skip(true, "outlook-latest.json not yet generated");
    const body = await res.json();
    if (!body.sectors || body.sectors.length === 0) test.skip(true, "no sectors classified yet");

    await gotoApp(page, { tab: "sectorOutlook" });
    await waitForMatrix(page);

    // Core assertion: signed growth-rank keys descend down the table.
    const scores = finiteScores(await renderedGrowthScores(page));
    expect(scores.length).toBeGreaterThan(0);
    assertMonotonic(scores, "desc");

    // The Growth sort mode is the default (aria-pressed=true) and Trust is off.
    const growthBtn = page.locator("button.sector-outlook-sort-btn[data-sort-mode='growth']");
    const trustBtn = page.locator("button.sector-outlook-sort-btn[data-sort-mode='trustLegacy']");
    await expect(growthBtn).toHaveAttribute("aria-pressed", "true");
    await expect(trustBtn).toHaveAttribute("aria-pressed", "false");

    // Thin-evidence pills are optional on this dataset — assert only that the
    // selector is well-formed (count is a non-negative integer).
    const thinCount = await page.locator("#sectorOutlookTab span[data-testid='thin-evidence']").count();
    expect(thinCount).toBeGreaterThanOrEqual(0);
  });

  test("toggling to Trust re-sorts the table and flips aria-pressed", async ({ page, request }) => {
    const res = await request.get("/api/sector-outlook/latest");
    if (res.status() === 503) test.skip(true, "outlook-latest.json not yet generated");
    const body = await res.json();
    if (!body.sectors || body.sectors.length === 0) test.skip(true, "no sectors classified yet");

    await gotoApp(page, { tab: "sectorOutlook" });
    await waitForMatrix(page);

    const growthOrder = growthSortedSectors(body, "3_12m");
    const trustOrder = trustSortedSectors(body, "3_12m");

    // Default rendered order matches the computed growth order.
    const before = await renderedSectors(page);
    expect(before).toEqual(growthOrder);

    // Click Trust — aria-pressed flips on both buttons.
    const growthBtn = page.locator("button.sector-outlook-sort-btn[data-sort-mode='growth']");
    const trustBtn = page.locator("button.sector-outlook-sort-btn[data-sort-mode='trustLegacy']");
    await trustBtn.click();
    await expect(trustBtn).toHaveAttribute("aria-pressed", "true");
    await expect(growthBtn).toHaveAttribute("aria-pressed", "false");

    // Rendered order now equals the computed trust order (robust equality).
    const after = await renderedSectors(page);
    expect(after).toEqual(trustOrder);

    // ...and it genuinely differs from the growth order UNLESS the two rank
    // functions legitimately produce the same sequence on this dataset.
    if (JSON.stringify(growthOrder) !== JSON.stringify(trustOrder)) {
      expect(after).not.toEqual(before);
    }
  });

  test("growth sort holds after switching to the 12–24m horizon", async ({ page, request }) => {
    const res = await request.get("/api/sector-outlook/latest");
    if (res.status() === 503) test.skip(true, "outlook-latest.json not yet generated");
    const body = await res.json();
    if (!body.sectors || body.sectors.length === 0) test.skip(true, "no sectors classified yet");

    await gotoApp(page, { tab: "sectorOutlook" });
    await waitForMatrix(page);

    // 3–12m default is already growth-descending.
    assertMonotonic(finiteScores(await renderedGrowthScores(page)), "desc");

    // Switch to the 12–24m horizon; the growth sort persists across the switch.
    const tab1224 = page.locator(".sector-outlook-horizon-tab[data-horizon='12_24m']");
    await tab1224.click();
    await expect(tab1224).toHaveAttribute("aria-selected", "true");

    const scores1224 = finiteScores(await renderedGrowthScores(page));
    expect(scores1224.length).toBeGreaterThan(0);
    assertMonotonic(scores1224, "desc");
  });

  test("clicking the News column header sorts by that column, toggling direction", async ({ page, request }) => {
    const res = await request.get("/api/sector-outlook/latest");
    if (res.status() === 503) test.skip(true, "outlook-latest.json not yet generated");
    const body = await res.json();
    if (!body.sectors || body.sectors.length === 0) test.skip(true, "no sectors classified yet");

    await gotoApp(page, { tab: "sectorOutlook" });
    await waitForMatrix(page);

    const byHorizon = horizonMap(body, "3_12m");
    const newsTh = page.locator("th.sector-outlook-sortable-th[data-sort-key='news']");

    // First click → descending.
    await newsTh.click();
    await expect(newsTh).toHaveAttribute("aria-sort", "descending");
    const descNews = (await renderedSectors(page)).map((s) => newsKey(byHorizon.get(s) || {}));
    expect(descNews.length).toBeGreaterThan(0);
    assertMonotonic(descNews, "desc");

    // Second click → ascending.
    await newsTh.click();
    await expect(newsTh).toHaveAttribute("aria-sort", "ascending");
    const ascNews = (await renderedSectors(page)).map((s) => newsKey(byHorizon.get(s) || {}));
    expect(ascNews.length).toBeGreaterThan(0);
    assertMonotonic(ascNews, "asc");
  });
});
