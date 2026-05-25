// Korea + Taiwan Picks API contract + isolation from the US + India pipelines.
//
// The region read routes use requireAdminRead (OPEN when AUTH_ENABLED=false, the
// harness default) so the tabs are reachable in dev/e2e. This spec locks the
// route contract per region and proves the US + India picks routes are unchanged.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const picksPath = (code) => path.join(__dirname, "..", "..", "data", `sws-${code}`, "picks-latest.json");

const REGIONS = { kr: { region: "KR", currency: "KRW" }, tw: { region: "TW", currency: "TWD" } };

function expectFiniteReturnsPayload(body) {
  expect(body.returns_pct).toBeTruthy();
  expect(body.card?.returns_pct).toBeTruthy();
  for (const key of ["1D", "7D", "1M", "3M", "1Y"]) {
    expect(Number.isFinite(body.returns_pct[key]), `${key} top-level return`).toBe(true);
    expect(Number.isFinite(body.card.returns_pct[key]), `${key} card return`).toBe(true);
  }
}

for (const [code, cfg] of Object.entries(REGIONS)) {
  const HAS_FIXTURE = fs.existsSync(picksPath(code));

  test.describe(`${cfg.region} Picks API`, () => {
    test.skip(!HAS_FIXTURE, `no data/sws-${code}/picks-latest.json fixture present`);

    test(`GET /api/${code}-picks → 200 ${cfg.currency} sections, no avoid list`, async ({ request }) => {
      const r = await request.get(`/api/${code}-picks`);
      expect(r.status()).toBe(200);
      const b = await r.json();
      expect(b.region).toBe(cfg.region);
      expect(b.currency).toBe(cfg.currency);
      expect(Array.isArray(b.sections.top_ranked_30_v3)).toBe(true);
      expect(b.sections.avoid).toBeUndefined();
    });

    test(`GET /api/${code}-picks?limit=2&category=top_ranked_30_v3 paginates`, async ({ request }) => {
      const r = await request.get(`/api/${code}-picks?limit=2&category=top_ranked_30_v3`);
      expect(r.status()).toBe(200);
      const b = await r.json();
      expect(Object.keys(b.sections)).toEqual(["top_ranked_30_v3"]);
      expect(b.sections.top_ranked_30_v3.length).toBeLessThanOrEqual(2);
    });

    test(`GET /api/${code}-stock/:ticker → 200 dotted key + currency ${cfg.currency}`, async ({ request }) => {
      const picks = await (await request.get(`/api/${code}-picks`)).json();
      const ticker = picks.sections.top_ranked_30_v3[0]?.ticker;
      expect(ticker).toBeTruthy();
      expect(ticker).toMatch(/\.[A-Z]+$/); // dotted suffix carried end-to-end
      const s = await request.get(`/api/${code}-stock/${encodeURIComponent(ticker)}`);
      expect(s.status()).toBe(200);
      const sb = await s.json();
      expect(sb.ticker).toBe(ticker);
      expect(sb.currency).toBe(cfg.currency);
      expectFiniteReturnsPayload(sb);
      if (sb.fundamentals_fallback) {
        expect(sb.fundamentals_fallback).toMatchObject({
          source: "yahoo-finance2",
          yahoo_symbol: ticker,
          pe: expect.any(Number),
          forward_pe: expect.any(Number),
          pb: expect.any(Number),
          eps: expect.any(Number),
          roe_pct: expect.any(Number),
          roa_pct: expect.any(Number),
          debt_to_equity_pct: expect.any(Number),
          current_ratio: expect.any(Number),
          gross_margin_pct: expect.any(Number),
          operating_margin_pct: expect.any(Number),
          net_margin_pct: expect.any(Number),
          beta: expect.any(Number),
        });
      } else {
        expect(sb.fundamentals_fallback).toBeNull();
      }
    });

    test(`GET /api/${code}-stock/BAD!! → 400 invalid_ticker`, async ({ request }) => {
      const r = await request.get(`/api/${code}-stock/BAD!!`);
      expect(r.status()).toBe(400);
    });

    test(`GET /api/${code}-scan/status → 200 with 3 shards`, async ({ request }) => {
      const r = await request.get(`/api/${code}-scan/status`);
      expect(r.status()).toBe(200);
      const b = await r.json();
      expect(Array.isArray(b.shards)).toBe(true);
      expect(b.shards.length).toBe(3);
    });

    test("no leaderboard section holds a pure-numeric ticker", async ({ request }) => {
      const b = await (await request.get(`/api/${code}-picks`)).json();
      for (const [k, arr] of Object.entries(b.sections)) {
        if (!Array.isArray(arr)) continue;
        for (const c of arr) expect(c.ticker, `pure-numeric ${c.ticker} in ${k}`).not.toMatch(/^\d+$/);
      }
    });
  });
}

// Isolation: the region routes must not have disturbed the US or India contracts.
test.describe("Region picks ISOLATION", () => {
  test("US /api/us-picks shape unchanged (still USD, no KR/TW region marker)", async ({ request }) => {
    const r = await request.get("/api/us-picks");
    if (r.status() === 200) {
      const b = await r.json();
      expect(b.region).toBe("US");
      expect(b.currency).toBe("USD");
    } else {
      expect(r.status()).toBe(404);
    }
  });

  test("India /api/sws-picks shape unchanged (no region:US/KR/TW marker)", async ({ request }) => {
    const r = await request.get("/api/sws-picks");
    if (r.status() === 200) {
      const b = await r.json();
      expect(b.sections).toBeTruthy();
      expect(["KR", "TW", "US"]).not.toContain(b.region);
    } else {
      expect(r.status()).toBe(404);
    }
  });
});
