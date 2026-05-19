// PR #11: <link rel="preload" as="font"> for the three font families
// used above the fold (Fraunces, Geist, JetBrains Mono). This trims
// the LCP delay caused by the @import-resolved stylesheet's font
// download being non-discoverable to the preload scanner.

import { test, expect } from "@playwright/test";

test.describe("PR #11 font preload tags", () => {
  test("/index.html declares preload tags for Fraunces, Geist, JetBrains Mono", async ({
    request,
  }) => {
    const r = await request.get("/index.html");
    const html = await r.text();
    const matches = html.match(
      /<link\s+rel="preload"\s+as="font"[^>]+>/g,
    );
    expect(matches, "must have ≥3 font preloads").toBeTruthy();
    expect(matches.length).toBeGreaterThanOrEqual(3);

    // Each preload must have crossorigin + type=font/woff2
    for (const tag of matches) {
      expect(tag, `crossorigin required: ${tag}`).toMatch(/crossorigin/);
      expect(tag, `type=font/woff2 required: ${tag}`).toMatch(
        /type="font\/woff2"/,
      );
    }

    // Each family covered: Fraunces, Geist, JetBrainsMono in URL
    expect(matches.some((t) => /fraunces/i.test(t))).toBe(true);
    expect(matches.some((t) => /geist/i.test(t))).toBe(true);
    expect(matches.some((t) => /jetbrains|jetbrainsmono/i.test(t))).toBe(
      true,
    );
  });

  test("/index.html modulepreloads keyboard.js", async ({ request }) => {
    const r = await request.get("/index.html");
    const html = await r.text();
    expect(html).toMatch(/<link[^>]+rel="modulepreload"[^>]+keyboard\.js/);
  });
});
