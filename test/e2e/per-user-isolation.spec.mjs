// Two-user data-isolation proof (auth iter 2, the acceptance gate).
//
// AUTH_ENABLED=false in the test harness collapses every request to the
// single "_local_dev" user, so the OAuth flow can't establish two distinct
// signed-in users headlessly. Instead we drive identity through the
// NODE_ENV==='test'-gated `X-Test-Sub` header (services/userIdentity.js): two
// browser contexts, each pinned to a different sub via extraHTTPHeaders. The
// header rides every request the context makes — page navigations AND
// context.request API calls — so the server namespaces each context's writes
// under a different sub.
//
// This spec proves the WATCHLIST is isolated (a clean surface with no shared
// server-side cache). The portfolio-isolation assertion is added in PR3, once
// the portfolio response cache is sub-keyed. The security counterpart — that
// the header is INERT outside test mode — is covered by the pure unit test
// test/userIdentity.test.mjs.

import { test, expect } from "@playwright/test";

const SUB_A = "e2e_user_A";
const SUB_B = "e2e_user_B";
const SYM = "TCS";          // mega-cap, reliably in the tracked universe
const CANON = "TCS.NS";     // findBySymbol canonicalises bare TCS → TCS.NS

function ctxOpts(sub) {
  return { extraHTTPHeaders: { "X-Test-Sub": sub } };
}

async function getWatchlistSymbols(request) {
  const r = await request.get("/api/watchlist");
  if (!r.ok()) return null;
  const body = await r.json();
  return (body.stocks || []).map((s) => s.symbol);
}

test.describe("Per-user data isolation (auth iter 2)", () => {
  test("a 2nd signed-in user does NOT see the 1st user's watchlist", async ({ browser }) => {
    const ctxA = await browser.newContext(ctxOpts(SUB_A));
    const ctxB = await browser.newContext(ctxOpts(SUB_B));
    try {
      const reqA = ctxA.request;
      const reqB = ctxB.request;

      // Idempotent cleanup so a re-run starts from a known state.
      await reqA.post("/api/watchlist/remove", { data: { symbol: SYM } }).catch(() => {});
      await reqB.post("/api/watchlist/remove", { data: { symbol: SYM } }).catch(() => {});

      // User A adds a symbol.
      const add = await reqA.post("/api/watchlist/add", { data: { symbol: SYM } });
      // Self-skip guard: if this build's universe rejects the symbol (or the
      // add surface isn't present), skip rather than false-fail. A 401 here
      // would mean the test header isn't wired — that IS a regression, so we
      // do NOT skip on 401.
      test.skip(add.status() === 400, `watchlist add rejected ${SYM} (universe mismatch) — cannot run isolation proof`);
      expect(add.ok(), `add should succeed for ${SYM}`).toBeTruthy();

      // Precondition: A's own add round-trips (proves add+read+header work).
      const aSyms = await getWatchlistSymbols(reqA);
      expect(aSyms, "user A GET /api/watchlist should be readable").not.toBeNull();
      expect(aSyms).toContain(CANON);

      // THE isolation assertion: user B must NOT see user A's symbol. If the
      // X-Test-Sub gate weren't honored, both contexts would resolve to the
      // same namespace and B would see TCS — this fails loudly on that leak.
      const bSyms = await getWatchlistSymbols(reqB);
      expect(bSyms, "user B GET /api/watchlist should be readable").not.toBeNull();
      expect(bSyms, "user B must not see user A's watchlist item").not.toContain(CANON);

      // Symmetry: B adds a different symbol; A must not see it.
      const SYM_B = "INFY";
      const CANON_B = "INFY.NS";
      const addB = await reqB.post("/api/watchlist/add", { data: { symbol: SYM_B } });
      if (addB.ok()) {
        const bSyms2 = await getWatchlistSymbols(reqB);
        expect(bSyms2).toContain(CANON_B);
        const aSyms2 = await getWatchlistSymbols(reqA);
        expect(aSyms2, "user A must not see user B's watchlist item").not.toContain(CANON_B);
      }

      // UI-visible confirmation for user A: the Watchlist tab shows the row.
      const pageA = await ctxA.newPage();
      await pageA.goto("/index.html", { waitUntil: "domcontentloaded" });
      await pageA.waitForFunction(() => typeof window.switchTab === "function", null, { timeout: 10_000 });
      await pageA.evaluate(() => window.switchTab("watchlist"));
      await expect(pageA.locator("#watchlistTab")).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(() => pageA.locator(`#watchlistTab [data-watchlist-symbol="${CANON}"]`).count(), { timeout: 10_000 })
        .toBeGreaterThan(0);

      // UI-visible confirmation for user B: A's symbol is absent from B's tab.
      const pageB = await ctxB.newPage();
      await pageB.goto("/index.html", { waitUntil: "domcontentloaded" });
      await pageB.waitForFunction(() => typeof window.switchTab === "function", null, { timeout: 10_000 });
      await pageB.evaluate(() => window.switchTab("watchlist"));
      await expect(pageB.locator("#watchlistTab")).toBeVisible({ timeout: 10_000 });
      expect(await pageB.locator(`#watchlistTab [data-watchlist-symbol="${CANON}"]`).count()).toBe(0);
    } finally {
      // Best-effort cleanup of both namespaces.
      await ctxA.request.post("/api/watchlist/remove", { data: { symbol: SYM } }).catch(() => {});
      await ctxB.request.post("/api/watchlist/remove", { data: { symbol: "INFY" } }).catch(() => {});
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("a 2nd signed-in user does NOT see the 1st user's portfolio", async ({ browser }) => {
    const ctxA = await browser.newContext(ctxOpts(SUB_A));
    const ctxB = await browser.newContext(ctxOpts(SUB_B));
    try {
      const reqA = ctxA.request;
      const reqB = ctxB.request;

      // Reset both namespaces to a known-empty state.
      await reqA.post("/api/portfolio", { data: { stocks: [], mutualFunds: [] } }).catch(() => {});
      await reqB.post("/api/portfolio", { data: { stocks: [], mutualFunds: [] } }).catch(() => {});

      // User A saves a portfolio with a distinctive holding.
      const save = await reqA.post("/api/portfolio", {
        data: { stocks: [{ symbol: SYM, quantity: 10, avgPrice: 100 }], mutualFunds: [] },
      });
      test.skip(!save.ok(), `portfolio save failed (${save.status()}) — cannot run isolation proof`);

      // Precondition: A reads back its own holding (also exercises the
      // now-sub-keyed response cache — a stale global key would misfire here).
      const aResp = await reqA.get("/api/portfolio");
      expect(aResp.ok()).toBeTruthy();
      const aStocks = (await aResp.json()).stocks || [];
      expect(aStocks.some((s) => (s.symbol || "").startsWith("TCS"))).toBeTruthy();

      // THE isolation assertion: user B's portfolio must not contain A's holding.
      const bResp = await reqB.get("/api/portfolio");
      expect(bResp.ok()).toBeTruthy();
      const bStocks = (await bResp.json()).stocks || [];
      expect(
        bStocks.some((s) => (s.symbol || "").startsWith("TCS")),
        "user B must not see user A's portfolio holding (cache-key + storage isolation)",
      ).toBeFalsy();
    } finally {
      await ctxA.request.post("/api/portfolio", { data: { stocks: [], mutualFunds: [] } }).catch(() => {});
      await ctxA.close();
      await ctxB.close();
    }
  });
});
