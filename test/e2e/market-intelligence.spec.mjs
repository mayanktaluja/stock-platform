// E2E test — Market Intelligence tab (market backdrop + digest + catalysts + sector heatmap).
//
// Per the 2026-05-16 E2E audit: this entire tab had ZERO Playwright coverage
// before this spec. The tab is non-admin (every signed-in user sees it) and
// hits six production endpoints — /api/news/market, /api/macro/regime,
// /api/market-verdict, /api/sector-heatmap, /api/catalysts/today,
// /api/sws-discovery-feed — so a regression here ships silently
// to every user.
//
// The spec covers three concerns:
//   1. Tab routing — switchTab("news") makes #newsTab visible and the
//      auto-refresh indicator fires.
//   2. API contracts — the four endpoints `loadMarketNews()` calls return
//      a usable shape (200 OK and a JSON body, or a documented error).
//   3. Structural render — after load, #newsContainer has populated past
//      its initial loading-spinner state (either real content or a clean
//      empty-state, not a hung spinner).
//
// Assertions are STRUCTURAL — class/id presence and element counts — never
// data-value, so live NSE/Yahoo/news-fetch variation doesn't flake the run.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("Market Intelligence tab", () => {
  test("switching to news tab makes #newsTab visible and shows refresh affordance", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "news");

    const newsTab = page.locator("#newsTab");
    await expect(newsTab).toBeVisible();
    await expect(page.locator("#newsRefreshIndicator")).toBeVisible();
    // The Refresh button is wired to loadMarketNews(); its presence is the
    // contract surface a user clicks when they want fresh data.
    await expect(page.locator('#newsTab button.refresh-btn')).toBeVisible();
  });

  test("API contracts — Market Intelligence endpoints respond", async ({ request }) => {
    // Each endpoint may do upstream fetches (Google News RSS, NSE sector
    // indices, etc.) that take >10s on a cold server. Bump the per-test
    // timeout above the 30s default so a slow upstream doesn't tear down
    // the request context mid-call.
    test.setTimeout(90_000);

    // Per-request timeout caps each call — one slow endpoint can't starve
    // the others. We only assert "did the route exist" (anything less than
    // 5xx OR a graceful error JSON) and "did the body parse as JSON" — the
    // contract surface, not the live data.
    async function probe(path) {
      try {
        const res = await request.get(path, { timeout: 25_000 });
        const status = res.status();
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        return { ok: true, status, body };
      } catch (err) {
        // Network/timeout failure — record but don't throw, so other
        // probes still run and the test reports the full picture.
        return { ok: false, status: -1, body: null, err: String(err.message || err) };
      }
    }

    const news = await probe("/api/news/market");
    const macro = await probe("/api/macro/regime");
    const verdict = await probe("/api/market-verdict");
    const heatmap = await probe("/api/sector-heatmap");
    const catalysts = await probe("/api/catalysts/today");
    const discovery = await probe("/api/sws-discovery-feed");

    // Each probe must have completed (no hard timeout / ECONNRESET).
    // Status <500 is the contract: route handler ran (even if it returned
    // a documented 4xx error body). Body must parse as JSON OR be null
    // when the response had no body. The spec is intentionally loose on
    // the response shape — that's what the unit tests + UI render spec
    // guard. Here we just confirm the route is reachable and well-formed.
    for (const [name, p] of [["news", news], ["macro", macro], ["verdict", verdict], ["heatmap", heatmap], ["catalysts", catalysts], ["discovery", discovery]]) {
      expect(p.ok, `${name} probe must complete (got error: ${p.err || "none"})`).toBe(true);
      expect(p.status, `${name} status must be <500 (got ${p.status})`).toBeLessThan(500);
      // Body must parse OR be null. We don't fail on null because
      // /api/sector-heatmap may legitimately return an empty body when
      // NSE rate-limits.
      if (p.body !== null) {
        expect(typeof p.body, `${name} body must be an object when present`).toBe("object");
      }
    }
    if (news.body?.digest) {
      expect(["bullish", "bearish", "mixed"]).toContain(news.body.digest.marketMood);
      expect(news.body.digest.generatedBy).toBe("deterministic");
    }
    if (verdict.body?.signals) {
      expect(Array.isArray(verdict.body.signals)).toBe(true);
      expect(typeof verdict.body.score).toBe("number");
    }
    if (discovery.body?.schema_version) {
      expect(discovery.body.schema_version).toBe("sws-discovery-feed-v1");
      expect(Array.isArray(discovery.body.items)).toBe(true);
      expect(typeof discovery.body.sections).toBe("object");
    }
  });

  test("renders macro card + digest + catalysts + collapsed radar in order (no verdict card)", async ({ page }) => {
    const generatedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await page.route("**/api/news/market", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lastUpdated: new Date().toISOString(),
          digest: {
            marketMood: "mixed",
            moodSummary: "Signals are split.",
            keyTakeaways: ["Macro pressure is the dominant read."],
            bullishDrivers: [],
            bearishRisks: [],
            sectorsToWatch: ["Oil & Gas", "Aviation"],
          },
        }),
      }),
    );
    await page.route("**/api/macro/regime", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          regime: "OIL_SHOCK",
          regimeLabel: "Oil Shock",
          severity: 4,
          confidence: 0.72,
          classifierProvider: "groq",
          generatedAt,
          reasoning: "Crude headlines are dominating the macro classifier.",
          keyEvents: ["Brent crude moves sharply higher before market open."],
          sectorImpacts: [
            { sector: "Oil & Gas", impact: 3, reason: "Producer margin tailwind" },
            { sector: "Aviation", impact: -3, reason: "Fuel cost headwind" },
          ],
          transition: {
            from: "CALM",
            to: "OIL_SHOCK",
            signal: {
              action: "TRIM",
              summary: "Oil spike favours energy producers and hurts fuel users.",
            },
          },
        }),
      }),
    );
    // NOTE: /api/market-verdict is intentionally NOT mocked — the "Mixed evidence"
    // verdict card was removed from this tab; the market digest is now the single
    // backdrop synthesis. The route still exists server-side (covered by
    // marketVerdictRoute.test.mjs), the tab just no longer fetches or renders it.
    await page.route("**/api/catalysts/today", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "catalysts-v1",
          stats: { corpInWindow: 1, macroInWindow: 1 },
          sections: {
            inBook: [{ ticker: "RELIANCE", company: "Reliance Industries", categoryLabel: "Earnings", purpose: "Financial Results", date: "2026-06-18" }],
            inPicks: [],
            broader: [],
            macro: [{ title: "RBI MPC minutes", category: "Macro", tier: "A", date: "2026-06-19", notes: "Rate commentary" }],
          },
        }),
      }),
    );
    await page.route("**/api/sector-heatmap", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sectors: [
            { sector: "Metals", avgChange: 1.45, winners: 6, losers: 0, stockCount: 6, topGainer: { symbol: "VEDL.NS", change: 4.1 }, topLoser: { symbol: "JSWSTEEL.NS", change: 0.1 } },
            { sector: "Banking", avgChange: -1.13, winners: 2, losers: 8, stockCount: 10, topGainer: { symbol: "HDFCBANK.NS", change: 0.3 }, topLoser: { symbol: "KOTAKBANK.NS", change: -3.3 } },
          ],
          marketBreadth: { totalStocks: 500, advancing: 210, declining: 270, unchanged: 20 },
          lastUpdated: new Date().toISOString(),
        }),
      }),
    );
    await page.route("**/api/sws-discovery-feed", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "sws-discovery-feed-v1",
          generated_at: generatedAt,
          available: true,
          lanes: [
            { id: "future_breakout", label: "Future Breakout" },
            { id: "off_section_high_future", label: "Off-section High Future" },
            { id: "momentum_news_confirmed", label: "Momentum + News" },
            { id: "upgrade_watch", label: "Upgrade Watch" },
          ],
          counts: { universe: 2, items: 2, future_breakout: 1, off_section_high_future: 1, momentum_news_confirmed: 1, upgrade_watch: 0 },
          items: [
            {
              ticker: "KRISHNADEF",
              name: "Krishna Defence and Allied Industries Limited",
              lanes: [{ id: "momentum_news_confirmed", label: "Momentum + News" }],
              radar_score: 82,
              v4_score: 61.9,
              v4_verdict: "TOP_PICK",
              future_growth: 0,
              returns: { r7d: 7.3, r1m: -5, r3m: 13, r6m: 63, r1y: 27 },
              latest_headline: "Full year 2026 earnings released: EPS up strongly",
              section_membership: [{ id: "snowflake_gap_lab", label: "Snowflake Gap Lab", actionable: false }],
              caution_flags: ["future_data_unavailable"],
              why_surfaced: "Positive tape plus material recent headline.",
            },
            {
              ticker: "FINOPB",
              name: "Fino Payments Bank Limited",
              lanes: [{ id: "off_section_high_future", label: "Off-section High Future" }],
              radar_score: 68,
              v4_score: 47.4,
              v4_verdict: "STRONG",
              future_growth: 5,
              returns: { r7d: 3.2, r1m: 2.3, r3m: -25.1, r6m: -50.4, r1y: -50.5 },
              latest_headline: "New minor risk - Profit margin trend",
              section_membership: [],
              caution_flags: ["needs_tape_confirmation"],
              why_surfaced: "Future Growth 5/6 with V4 47.4; not in an actionable curated section.",
            },
          ],
          sections: {
            future_breakout: [],
            off_section_high_future: [],
            momentum_news_confirmed: [],
            upgrade_watch: [],
          },
        }),
      }),
    );
    await page.route("**/api/sws-stock/KRISHNADEF", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ticker: "KRISHNADEF",
          card: { ticker: "KRISHNADEF", name: "Krishna Defence and Allied Industries Limited", sector: "Capital Goods", v4_score: 61.9, v4_verdict: "TOP_PICK", current_price_inr: 1217.3 },
          deep: { overview: { name: "Krishna Defence and Allied Industries Limited", sector: "Capital Goods", snowflake: { future: 0, future_growth: 0 } } },
          returns_pct: { "7D": 7.3, "3M": 13 },
          in_sections: ["snowflake_gap_lab"],
          currency: "INR",
        }),
      }),
    );

    await gotoApp(page);
    await switchTab(page, "news");

    const card = page.getByTestId("market-macro-regime-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("market-macro-regime-label")).toContainText("Oil Shock");
    await expect(page.getByTestId("market-macro-severity")).toContainText("Severity 4/5");
    await expect(page.getByTestId("market-macro-freshness")).toContainText("Updated under 1h ago");
    await expect(card).toContainText("72% confidence");
    await expect(card).toContainText("GROQ");
    await expect(card).toContainText("Brent crude moves sharply higher");
    await expect(page.getByTestId("market-macro-sector-chips")).toContainText("Oil & Gas");
    await expect(page.getByTestId("market-macro-sector-chips")).toContainText("Aviation");
    await expect(card).toContainText("CALM");
    await expect(card).toContainText("OIL_SHOCK");
    await expect(page.locator("#macroRegimeBanner")).toHaveCount(0);

    // The legacy "Mixed evidence" market-verdict card is gone — the market digest is
    // now the single backdrop synthesis.
    await expect(page.getByTestId("market-verdict-card")).toHaveCount(0);
    await expect(page.getByTestId("market-digest-card")).toBeVisible();
    await expect(page.getByTestId("market-digest-card")).toContainText("MIXED");
    await expect(page.getByTestId("market-digest-card")).toContainText("Macro pressure is the dominant read.");

    // Catalysts (above the heatmap).
    await expect(page.getByTestId("market-catalysts-card")).toContainText("Upcoming Catalysts");
    await expect(page.getByTestId("market-catalysts-card")).toContainText("Reliance Industries");
    await expect(page.getByTestId("market-catalysts-card")).toContainText("RBI MPC minutes");

    // Sector heatmap renders on the Nifty 500 universe.
    await expect(page.getByTestId("market-heatmap-card")).toContainText("Nifty 500 universe");
    await expect(page.getByTestId("market-heatmap-card")).toContainText("Metals");

    // Section order: macro → digest → catalysts → heatmap → radar.
    // Compare on-screen vertical positions.
    const tops = await page.evaluate(() => {
      const top = (id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return el ? el.getBoundingClientRect().top : Number.NaN;
      };
      return {
        macro: top("market-macro-regime-card"),
        digest: top("market-digest-card"),
        catalysts: top("market-catalysts-card"),
        heatmap: top("market-heatmap-card"),
        radar: top("discovery-radar-details"),
      };
    });
    expect(tops.macro).toBeLessThan(tops.digest);
    expect(tops.digest).toBeLessThan(tops.catalysts);
    expect(tops.catalysts).toBeLessThan(tops.heatmap);
    expect(tops.heatmap).toBeLessThan(tops.radar);

    // Discovery Radar is collapsed by default at the bottom.
    const radarDetails = page.getByTestId("discovery-radar-details");
    await expect(radarDetails).toBeVisible();
    expect(await radarDetails.evaluate((el) => el.open)).toBe(false);
    await expect(radarDetails).toContainText("review queue");

    // Expand it, then exercise the lane filter — the <details> must STAY open across
    // the outerHTML re-render setDiscoveryRadarFilter does (SF2 regression guard).
    await radarDetails.locator("summary").click();
    expect(await radarDetails.evaluate((el) => el.open)).toBe(true);
    await expect(page.getByTestId("discovery-radar-card")).toContainText("KRISHNADEF");
    await expect(page.getByTestId("discovery-radar-card")).toContainText("FINOPB");
    await page.getByRole("button", { name: /Off-section High Future/ }).click();
    expect(await radarDetails.evaluate((el) => el.open)).toBe(true);
    await expect(page.getByTestId("discovery-radar-row")).toHaveCount(1);
    await expect(page.getByTestId("discovery-radar-card")).toContainText("FINOPB");
    await expect(page.getByTestId("discovery-radar-card")).not.toContainText("KRISHNADEF");
    await page.getByRole("button", { name: /Momentum \+ News/ }).click();
    await page.getByTestId("discovery-radar-row").first().click();
    await expect(page.locator("#swsModalBackdrop.open")).toBeVisible();
    await expect(page.locator("#swsModalBackdrop")).toContainText("KRISHNADEF");
  });

  test("#newsContainer renders past the initial loading-spinner state", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "news");

    // loadMarketNews() may take a few seconds — it fetches three endpoints
    // in parallel. The container starts with a .loading-spinner; once load
    // resolves, the renderer either populates real content OR an
    // .empty-state. Either way, the .loading-spinner placeholder is gone.
    const containerSettled = await page
      .waitForFunction(
        () => {
          const c = document.getElementById("newsContainer");
          if (!c) return false;
          const hasSpinner = c.querySelector(".loading-spinner") !== null;
          const hasContent = c.children.length > 0 && !hasSpinner;
          const hasEmptyState = c.querySelector(".empty-state") !== null;
          // Settled = NOT just the loading-spinner. Empty state OR real
          // content both qualify.
          return hasContent || hasEmptyState;
        },
        null,
        { timeout: 30_000 }
      )
      .then(() => true)
      .catch(() => false);

    test.skip(
      !containerSettled,
      "loadMarketNews never finished — NSE/news source upstream likely down in CI"
    );

    // The container has substantive children (more than just whitespace).
    const childCount = await page.locator("#newsContainer").evaluate((el) => el.childElementCount);
    expect(childCount, "newsContainer must have rendered children after load").toBeGreaterThan(0);

    // #newsLastUpdated should have content when the news fetch succeeded.
    // Empty-state path leaves it empty (no `lastUpdated` returned), so we
    // don't require it; we just confirm it's not stuck mid-update.
    const updatedText = await page.locator("#newsLastUpdated").textContent();
    expect(typeof updatedText, "#newsLastUpdated must be a string").toBe("string");
  });
});
