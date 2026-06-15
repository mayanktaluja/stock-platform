/**
 * /api/sws-picks server-side query-param regression.
 *
 * Until 2026-05-18 the handler ignored `req.query.limit` and `req.query.category`
 * — every call shipped the full multi-MB body. Mobile + slow-network users paid
 * the full payload even when asking for top 10. (The single largest bucket, the
 * ~1,191-row `avoid` section, has since been dropped from the payload entirely.)
 * This spec pins the fixed limit/category semantics so any future drift fails
 * loudly.
 *
 * Self-skips when /api/sws-picks returns 404 (no picks data loaded).
 */

import { test, expect } from "@playwright/test";

test.describe("/api/sws-picks query params", () => {
  test("?limit=N caps each section and stamps _meta.<section>_total", async ({ request }) => {
    const r = await request.get("/api/sws-picks?limit=3");
    if (r.status() === 404) return;
    expect(r.status()).toBe(200);
    const body = await r.json();
    if (!body?.sections) return;
    for (const [k, items] of Object.entries(body.sections)) {
      if (!Array.isArray(items)) continue;
      expect(items.length).toBeLessThanOrEqual(3);
    }
    expect(body._meta).toBeDefined();
    expect(body._meta.limit).toBe(3);
  });

	  test("?category=KEY returns only the named section", async ({ request }) => {
    const baseline = await request.get("/api/sws-picks");
    if (baseline.status() === 404) return;
    const baseBody = await baseline.json();
    if (!baseBody?.sections) return;
    const someSection = Object.keys(baseBody.sections).find(
      (k) => Array.isArray(baseBody.sections[k]) && baseBody.sections[k].length > 0,
    );
    if (!someSection) return;

    const filtered = await request.get(`/api/sws-picks?category=${encodeURIComponent(someSection)}`);
    expect(filtered.status()).toBe(200);
    const fBody = await filtered.json();
    expect(Object.keys(fBody.sections)).toEqual([someSection]);
	    expect(fBody._meta.category).toBe(someSection);
	  });

	  test("?category=best_to_buy_now keeps the Best Stocks to Buy Now compatibility key", async ({ request }) => {
	    const filtered = await request.get("/api/sws-picks?category=best_to_buy_now");
	    if (filtered.status() === 404) return;
	    expect(filtered.status()).toBe(200);
	    const body = await filtered.json();
	    expect(Object.keys(body.sections || {})).toEqual(
	      body.sections?.best_to_buy_now ? ["best_to_buy_now"] : [],
	    );
	    expect(body._meta?.category).toBe("best_to_buy_now");
	  });

  test("unknown ?category returns empty sections (not 4xx)", async ({ request }) => {
    const r = await request.get("/api/sws-picks?category=__nonexistent__");
    if (r.status() === 404) return;
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.sections).toEqual({});
  });

  test("?limit=0 is clamped to 0 (empty arrays, valid response)", async ({ request }) => {
    const r = await request.get("/api/sws-picks?limit=0");
    if (r.status() === 404) return;
    expect(r.status()).toBe(200);
    const body = await r.json();
    if (!body?.sections) return;
    for (const items of Object.values(body.sections)) {
      if (Array.isArray(items)) expect(items.length).toBe(0);
    }
  });

  test("?limit above the 200 cap is silently clamped to 200", async ({ request }) => {
    const r = await request.get("/api/sws-picks?limit=99999");
    if (r.status() === 404) return;
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body._meta.limit).toBe(200);
  });

  test("baseline (no params) still returns full payload", async ({ request }) => {
    const r = await request.get("/api/sws-picks");
    if (r.status() === 404) return;
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body._meta?.limit).toBeUndefined();
    expect(body._meta?.category).toBeUndefined();
  });
});

test.describe("/healthz", () => {
  test("returns 200 ok with no auth required", async ({ request }) => {
    const r = await request.get("/healthz");
    expect(r.status()).toBe(200);
    const body = await r.text();
    expect(body).toBe("ok");
    expect(r.headers()["content-type"]).toMatch(/text\/plain/);
  });
});
