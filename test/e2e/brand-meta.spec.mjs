// PR #1: brand metadata assertions across every HTML surface.
//
// Pre-PR: zero og:* / twitter:* / theme-color / apple-touch-icon across the
// 5 HTML pages → every shared link on Slack/WhatsApp/Twitter rendered as a
// generic blob. This spec is the regression guard that locks in the brand
// presence north-star (BR-1 in the rollout plan).
//
// We assert per-page because each page has its own og:title + og:url +
// og:description. The shared assertions (og:image, theme-color, etc.) are
// hoisted into a small helper to avoid copy-paste drift.

import { test, expect } from "@playwright/test";

const SHARED_OG = {
  "og:type": /^(website|article)$/,
  "og:site_name": "Starbhai",
  "og:image": "https://starbhai-stock-platform.vercel.app/og-image.jpg",
  "og:image:width": "1200",
  "og:image:height": "630",
  "og:image:type": "image/jpeg",
};

const SHARED_TWITTER = {
  "twitter:card": "summary_large_image",
  "twitter:image": "https://starbhai-stock-platform.vercel.app/og-image.jpg",
};

const SHARED_THEME = {
  "theme-color": "#FBFAF7",
  "apple-mobile-web-app-capable": "yes",
  "apple-mobile-web-app-status-bar-style": "default",
  "apple-mobile-web-app-title": "Starbhai",
};

const PAGES = [
  {
    name: "main app shell",
    url: "/index.html",
    expectOgUrl: "https://starbhai-stock-platform.vercel.app/",
    expectOgTitle: /Starbhai/,
    expectThemeColor: "#FBFAF7",
    expectStatusBar: "default",
  },
  {
    name: "login (signed-out)",
    url: "/login.html",
    expectOgUrl: "https://starbhai-stock-platform.vercel.app/login.html",
    expectOgTitle: /Starbhai/,
    expectThemeColor: "#FBFAF7",
    expectStatusBar: "default",
  },
  {
    name: "methodology",
    url: "/methodology",
    expectOgUrl: "https://starbhai-stock-platform.vercel.app/methodology.html",
    expectOgTitle: /Methodology/,
    expectThemeColor: "#0B0C10",
    expectStatusBar: "black-translucent",
  },
  {
    name: "charter",
    url: "/legal/charter",
    expectOgUrl: "https://starbhai-stock-platform.vercel.app/legal/charter",
    expectOgTitle: /Charter/,
    expectThemeColor: "#0B0C10",
    expectStatusBar: "black-translucent",
  },
  {
    name: "grievance",
    url: "/legal/grievance",
    expectOgUrl: "https://starbhai-stock-platform.vercel.app/legal/grievance",
    expectOgTitle: /Grievance/,
    expectThemeColor: "#0B0C10",
    expectStatusBar: "black-translucent",
  },
];

async function getMeta(page, kind, key) {
  // kind: "property" (og:*) or "name" (twitter:*, theme-color, apple-*)
  return page.evaluate(
    ({ kind, key }) => {
      const el = document.head.querySelector(`meta[${kind}="${key}"]`);
      return el ? el.getAttribute("content") : null;
    },
    { kind, key },
  );
}

test.describe("PR #1 brand metadata", () => {
  for (const p of PAGES) {
    test(`${p.name} (${p.url}) carries og + twitter + theme metadata`, async ({
      page,
      request,
    }) => {
      // Self-skip if the page 404s — mirrors analyzer-reflow.spec.mjs:23.
      const head = await request.get(p.url);
      test.skip(head.status() === 404, `${p.url} not served in this env`);

      await page.goto(p.url, { waitUntil: "domcontentloaded" });

      // Per-page assertions
      expect(await getMeta(page, "property", "og:url")).toBe(p.expectOgUrl);
      expect(await getMeta(page, "property", "og:title")).toMatch(
        p.expectOgTitle,
      );
      // og:description is page-specific but must be present and non-empty
      const desc = await getMeta(page, "property", "og:description");
      expect(desc, "og:description must be present").toBeTruthy();
      expect(desc.length, "og:description must be substantive").toBeGreaterThan(
        20,
      );

      // Shared OG assertions
      for (const [key, expected] of Object.entries(SHARED_OG)) {
        const got = await getMeta(page, "property", key);
        if (expected instanceof RegExp) {
          expect(got, `${key} must match ${expected}`).toMatch(expected);
        } else {
          expect(got, `${key} must equal ${expected}`).toBe(expected);
        }
      }

      // Shared Twitter assertions
      for (const [key, expected] of Object.entries(SHARED_TWITTER)) {
        expect(await getMeta(page, "name", key), `${key}`).toBe(expected);
      }

      // Shared theme / Apple assertions. The app shell and login are the
      // light-default product surfaces; static docs/legal pages retain their
      // dark metadata until their own redesign.
      for (const [key, expected] of Object.entries(SHARED_THEME)) {
        const resolved = key === "theme-color"
          ? p.expectThemeColor
          : (key === "apple-mobile-web-app-status-bar-style" ? p.expectStatusBar : expected);
        expect(await getMeta(page, "name", key), `${key}`).toBe(resolved);
      }
    });
  }
});
