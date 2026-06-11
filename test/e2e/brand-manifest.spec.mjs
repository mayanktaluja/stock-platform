// PR #2: PWA manifest reachability + schema + linkage.
//
// /manifest.webmanifest must serve as application/manifest+json (or
// application/json — both browsers accept), validate as JSON, and carry the
// PWA-required fields: name, start_url, display, icons (≥ 192 + 512). Both
// the gated app shell and the signed-out login page must <link rel="manifest">
// it so a homescreen-install action works in both states.

import { test, expect } from "@playwright/test";

test.describe("PR #2 PWA manifest", () => {
  let cachedManifest;

  async function loadManifest(request) {
    if (cachedManifest) return cachedManifest;
    const r = await request.get("/manifest.webmanifest");
    expect(r.status()).toBe(200);
    cachedManifest = JSON.parse(await r.text());
    return cachedManifest;
  }

  test("/manifest.webmanifest serves with manifest content-type", async ({
    request,
  }) => {
    const r = await request.get("/manifest.webmanifest");
    expect(r.status()).toBe(200);
    const ct = r.headers()["content-type"] || "";
    // express.static via send@^0.18 maps .webmanifest →
    // application/manifest+json. Browsers also accept application/json.
    expect(ct, `unexpected content-type: ${ct}`).toMatch(
      /application\/(manifest\+)?json/,
    );
  });

  test("manifest validates as JSON with required PWA fields", async ({
    request,
  }) => {
    const manifest = await loadManifest(request);

    // PWA-required fields per W3C App Manifest spec
    expect(manifest.name, "name required").toBeTruthy();
    expect(manifest.short_name, "short_name required").toBeTruthy();
    expect(manifest.start_url, "start_url required").toBeTruthy();
    expect(manifest.display, "display required").toMatch(
      /^(standalone|fullscreen|minimal-ui|browser)$/,
    );

    // Install shell starts light; runtime theme is controlled by the Platform
    // menu and may update the page's meta theme-color after boot.
    expect(manifest.theme_color).toBe("#F7F8FB");
    expect(manifest.background_color).toBe("#F7F8FB");
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).toBe("/index.html");
    expect(manifest.lang).toBe("en-IN");

    // Must carry ≥ 192 + 512 px icons (Chrome PWA install prompt baseline)
    expect(manifest.icons).toBeInstanceOf(Array);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");

    // At least one maskable icon for Android adaptive icon support
    const purposes = manifest.icons.map((i) => i.purpose || "any");
    expect(purposes.some((p) => p.includes("maskable"))).toBe(true);
  });

  test("manifest is linked from gated/index.html", async ({ page }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    const href = await page.evaluate(
      () =>
        document.head
          .querySelector('link[rel="manifest"]')
          ?.getAttribute("href"),
    );
    expect(href).toBe("/manifest.webmanifest");
  });

  test("manifest is linked from public/login.html (signed-out)", async ({
    page,
  }) => {
    await page.goto("/login.html", { waitUntil: "domcontentloaded" });
    const href = await page.evaluate(
      () =>
        document.head
          .querySelector('link[rel="manifest"]')
          ?.getAttribute("href"),
    );
    expect(href).toBe("/manifest.webmanifest");
  });

  test("manifest theme matches the static app shell theme metadata", async ({
    request,
  }) => {
    const manifest = await loadManifest(request);
    const shell = await request.get("/index.html");
    expect(shell.status()).toBe(200);
    const html = await shell.text();
    const metaTheme = html.match(
      /<meta\s+name="theme-color"\s+content="([^"]+)"/,
    )?.[1];

    expect(metaTheme, "static /index.html theme-color").toBe(
      manifest.theme_color,
    );
  });

  test("manifest icon URLs all resolve 200", async ({ request }) => {
    const manifest = await loadManifest(request);
    for (const icon of manifest.icons) {
      const iconRes = await request.get(icon.src);
      expect(
        iconRes.status(),
        `icon ${icon.src} (${icon.sizes}, ${icon.purpose}) must resolve`,
      ).toBe(200);
      expect(iconRes.headers()["content-type"]).toMatch(/image\//);
    }
  });
});
