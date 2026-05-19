// PR #3: raw-hex regression guard.
//
// Pre-PR3 there were 134 raw hex sites in gated/index.html OUTSIDE the
// :root token block. Post-PR3 the count is ≤ 40 — mostly token gradient
// definitions and a handful of one-offs (yellow alerts, gray slate) that
// don't have a clean token home yet. This spec caps the count so future
// PRs cannot silently re-introduce raw hex.
//
// The cap (40) is a moving target — every subsequent PR that consolidates
// more hex should LOWER this number, never raise it. If a PR needs to add
// a hex literal it should ALSO add a token; the count stays flat.

import { test, expect } from "@playwright/test";

// Lines that are allowed to contain raw hex:
//   • `:root { --token: #HEX }` — token declarations
//   • HTML <meta> attribute values (theme-color etc.)
//   • Inline SVG paths in data: URIs (favicons)
//   • <linearGradient> stops INSIDE :root token values
function countRawHex(html) {
  // Strip the :root{} block so token declarations don't count
  const withoutRoot = html.replace(
    /:root\s*\{[\s\S]*?\n\s*\}\s*\n/,
    "/*ROOT_STRIPPED*/",
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

    // Cap: 40. Pre-PR3 was 134 (raw count). This number must ratchet down
    // PR by PR. To raise it: don't — token-ize first.
    expect(
      count,
      `Raw hex outside :root must be ≤40 (PR #3 post-sweep ceiling). Got ${count}. ` +
        `To pass, either replace the new hex with a token or include a ` +
        `documented justification in the PR body.`,
    ).toBeLessThanOrEqual(40);
  });
});
