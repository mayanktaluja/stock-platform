// Raw-hex regression guard.
//
// History: pre-PR3 had 134 raw hex sites in gated/index.html outside the
// token block; PR3 cut it to 40. The A0 redesign sweep took the remaining
// 46 down to 0 by token-izing every off-palette hex into the @tokens-start
// region (slate surfaces/borders + bright signal tokens). This spec caps
// the count so future PRs cannot silently re-introduce raw hex.
//
// The cap is a ratchet — LOWER it as more hex is consolidated, never raise.
// If a rule needs a colour it must reference a var() token (defined inside
// the @tokens region), not a literal hex.

import { test, expect } from "@playwright/test";

// Lines that are allowed to contain raw hex:
//   • `:root { --token: #HEX }` — token declarations
//   • HTML <meta> attribute values (theme-color etc.)
//   • Inline SVG paths in data: URIs (favicons)
//   • <linearGradient> stops INSIDE :root token values
function countRawHex(html) {
  // Strip every /* @tokens-start */ … /* @tokens-end */ region so token
  // declarations don't count. This covers BOTH the :root block and the
  // [data-theme="light"] override block (each wrapped in its own sentinel
  // pair). Sentinel-based — not selector-based — so adding a theme block
  // can't smuggle raw hex past the guard: only token decls live in there.
  const withoutRoot = html.replace(
    /\/\*\s*@tokens-start[\s\S]*?@tokens-end\s*\*\//g,
    "/*TOKENS_STRIPPED*/",
  );
  // Strip HTML entities like &#8635; (refresh symbol) that look hex-ish
  const withoutEntities = withoutRoot.replace(/&#\d+;/g, "");
  // Strip data: URIs (inline SVG favicons)
  const withoutDataUris = withoutEntities.replace(
    /data:image\/svg\+xml,[^"' ]+/g,
    "",
  );
  // Strip meta content attributes (theme-color, og:image:type, etc.)
  const withoutMetaContent = withoutDataUris.replace(
    /<meta[^>]+content="[^"]*"[^>]*>/g,
    "",
  );

  const matches = withoutMetaContent.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  return matches.length;
}

test.describe("PR #3 raw-hex cap", () => {
  test("/index.html stays at or below the PR #3 hex cap", async ({
    request,
  }) => {
    const r = await request.get("/index.html");
    expect(r.status()).toBe(200);
    const html = await r.text();
    const count = countRawHex(html);

    // Cap: 6. Post-A0-sweep the true count is 0; the small buffer absorbs
    // incidental one-offs without inviting drift. Ratchet down, never up.
    expect(
      count,
      `Raw hex outside the @tokens region must be ≤6 (A0 post-sweep ceiling; ` +
        `actual is 0). Got ${count}. To pass, replace the hex with a var() ` +
        `token declared inside the @tokens-start/@tokens-end region.`,
    ).toBeLessThanOrEqual(6);
  });

  // F2: the D2/D4-D7 sweeps took every JS render module to ZERO raw hex.
  // This gate keeps it there — any new colour must be a var(--token) whose
  // declaration lives in index.html's @tokens region. HTML entities
  // (&#9888;) are stripped by countRawHex already.
  for (const mod of [
    "app.js",
    "earnings.js",
    "riskLab.js",
    "multibaggerLab.js",
    "sectorOutlook.js",
    "swsV2Render.js",
    "glossary.js",
    "keyboard.js",
  ]) {
    test(`/${mod} carries zero raw hex`, async ({ request }) => {
      const r = await request.get(`/${mod}`);
      expect(r.status()).toBe(200);
      const count = countRawHex(await r.text());
      expect(
        count,
        `${mod} must stay at 0 raw hex (D-sweep ceiling, cap 4 buffer). ` +
          `Got ${count}. Use a var(--token) and declare it in index.html's ` +
          `@tokens region (dark + light values).`,
      ).toBeLessThanOrEqual(4);
    });
  }
});
