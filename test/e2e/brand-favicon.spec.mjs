// PR #1: PNG favicon + apple-touch-icon + og-image asset reachability.
//
// All four binaries live under public/ and are served by express.static at
// server.js:876. This spec asserts they actually resolve 200 with the right
// content-type — a missing icon makes the apple-touch-icon meta tag useless
// and the og-image shared-link card go blank.

import { test, expect } from "@playwright/test";

const ASSETS = [
  { url: "/favicon-32.png", contentType: /image\/png/, maxBytes: 5_000 },
  { url: "/favicon-180.png", contentType: /image\/png/, maxBytes: 20_000 },
  { url: "/icon-192.png", contentType: /image\/png/, maxBytes: 20_000 },
  { url: "/icon-512.png", contentType: /image\/png/, maxBytes: 50_000 },
  {
    url: "/icon-maskable-512.png",
    contentType: /image\/png/,
    maxBytes: 50_000,
  },
  {
    url: "/og-image.jpg",
    contentType: /image\/jpeg/,
    maxBytes: 200_000, // OG cards should stay slim
  },
];

test.describe("PR #1 brand asset reachability", () => {
  for (const a of ASSETS) {
    test(`${a.url} serves with correct content-type and size`, async ({
      request,
    }) => {
      const r = await request.get(a.url);
      expect(r.status(), `${a.url} status`).toBe(200);
      expect(r.headers()["content-type"], `${a.url} content-type`).toMatch(
        a.contentType,
      );
      const buf = await r.body();
      expect(buf.byteLength, `${a.url} non-empty`).toBeGreaterThan(0);
      expect(buf.byteLength, `${a.url} under ${a.maxBytes} bytes`).toBeLessThan(
        a.maxBytes,
      );
    });
  }

  test("apple-touch-icon link in /index.html points at /favicon-180.png", async ({
    page,
  }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    const href = await page.evaluate(
      () =>
        document.head
          .querySelector('link[rel="apple-touch-icon"]')
          ?.getAttribute("href"),
    );
    expect(href).toBe("/favicon-180.png");
  });

  test("PNG icon link in /index.html points at /favicon-32.png", async ({
    page,
  }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    const href = await page.evaluate(
      () =>
        document.head
          .querySelector('link[rel="icon"][type="image/png"]')
          ?.getAttribute("href"),
    );
    expect(href).toBe("/favicon-32.png");
  });

  test("SVG icon link in /index.html survives the PNG additions", async ({
    page,
  }) => {
    // Regression guard: the inline SVG data-URI favicon was the only icon
    // pre-PR. PR #1 keeps it for high-DPI browsers and just adds the PNG
    // fallbacks. If a future PR strips the SVG link this test fails loudly.
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    const href = await page.evaluate(
      () =>
        document.head
          .querySelector('link[rel="icon"][type="image/svg+xml"]')
          ?.getAttribute("href"),
    );
    expect(href).toBeTruthy();
    expect(href).toMatch(/^data:image\/svg\+xml,/);
  });
});
