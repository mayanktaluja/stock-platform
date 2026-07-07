// Theme-contrast smoke — the "no navy-on-paper" guard.
//
// The light-mode wash-out bug was dark-locked translucent fills
// (rgba(255,255,255,0.0x), navy rgba(15,20,34,*)) that render invisible or
// muddy on the cream surface. PR2 introduced semantic depth tokens; this spec
// pins their CONTRACT: every --surface-* token, composited over the resolved
// page background, must read LIGHT in light mode and DARK in dark mode.
//
// Why composite (not raw computed luminance): a translucent rgba computes
// verbatim in getComputedStyle — rgba(20,22,28,0.035) looks "dark" and
// rgba(0,0,0,0) looks black — so a naive luminance check is unsound. We alpha-
// composite the token over the opaque page background first, which is what the
// eye actually sees. Data-independent (injects its own probe element), so it
// runs even without a picks fixture.

import { test, expect } from "@playwright/test";

// Tokens whose composited surface must track the theme. Opaque anchors
// (--bg-card / --bg-primary) included as sanity — they must always read light
// in light and dark in dark with no compositing subtlety.
const SURFACE_TOKENS = [
  "--surface-raise",
  "--surface-raise-strong",
  "--surface-inset",
  "--surface-navy-glass-40",
  "--surface-navy-glass-60",
  "--bg-card",
  "--bg-primary",
];

// Composite each token over the page background in-page and return perceptual
// luminance (0..1). Alpha-composites up the ancestor chain is overkill here —
// the probe is a direct child of <body>, whose background is opaque.
async function tokenLuminances(page) {
  return page.evaluate((tokens) => {
    function parse(c) {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [255, 255, 255, 1];
      const p = m[1].split(",").map((s) => parseFloat(s.trim()));
      return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
    }
    function lum(r, g, b) {
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    const out = {};
    for (const t of tokens) {
      probe.style.background = `var(${t})`;
      const [r, g, b, a] = parse(getComputedStyle(probe).backgroundColor);
      // over the opaque page background
      const R = a * r + (1 - a) * bodyBg[0];
      const G = a * g + (1 - a) * bodyBg[1];
      const B = a * b + (1 - a) * bodyBg[2];
      out[t] = lum(R, G, B);
    }
    probe.remove();
    return out;
  }, SURFACE_TOKENS);
}

test.describe("theme-contrast smoke", () => {
  test("surface tokens composite LIGHT in light mode", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
    ).toBe("light");
    const lums = await tokenLuminances(page);
    for (const [tok, l] of Object.entries(lums)) {
      expect(
        l,
        `${tok} composited over the paper background must read light ` +
          `(luminance > 0.7); got ${l.toFixed(3)}. A dark/navy value here is ` +
          `the wash-out bug.`,
      ).toBeGreaterThan(0.7);
    }
    await ctx.close();
  });

  test("surface tokens composite DARK in dark mode", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try { localStorage.setItem("starbhaiTheme", "dark"); } catch (e) {}
    });
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
    ).toBe("dark");
    const lums = await tokenLuminances(page);
    for (const [tok, l] of Object.entries(lums)) {
      expect(
        l,
        `${tok} composited over the dark background must read dark ` +
          `(luminance < 0.35); got ${l.toFixed(3)}.`,
      ).toBeLessThan(0.35);
    }
    await ctx.close();
  });
});
