// Raw-rgba() ratchet guard — the light-mode companion to
// design-tokens-no-raw-hex.spec.mjs.
//
// The no-raw-hex gate only catches `#hex`; it never saw the ~750 literal
// rgba() fills the render layer hardcoded. Those are dark-locked by
// construction (rgba(255,255,255,0.0x) fills, navy rgba(15,20,34,*) panels)
// and wash out or turn muddy on the light "paper" surface. PR2 introduced
// semantic depth tokens (--surface-raise / --surface-raise-strong /
// --surface-inset / --surface-navy-glass-*) and swept the app.js + index.html
// dark-locked families onto them.
//
// This spec caps the remaining raw rgba() per module so the count can only go
// DOWN. Satellite sweeps (PR5) lower their own caps; nothing may raise one.
// Caps are the post-PR2 actuals (no buffer — a ratchet, not a budget).
//
// Legitimate rgba() that SHOULD stay raw and still counts toward the cap:
//   • box-shadow / text-shadow (dark in both themes by design)
//   • overlay scrims (rgba(0,0,0,0.6+) modal backdrops)
//   • gradient stops that read acceptably in both themes
// These are why the caps are not zero. Tighten opportunistically; never raise.

import { test, expect } from "@playwright/test";

// index.html: strip the @tokens-start/@tokens-end regions first — token
// DEFINITIONS legitimately use rgba (--border, --surface-*, --bg-frost).
function countRgbaOutsideTokens(html) {
  const stripped = html.replace(
    /\/\*\s*@tokens-start[\s\S]*?@tokens-end\s*\*\//g,
    "",
  );
  return (stripped.match(/rgba\(/g) || []).length;
}
function countRgba(text) {
  return (text.match(/rgba\(/g) || []).length;
}

// Post-PR2 actuals. LOWER as sweeps land; never raise.
const MODULE_CAPS = {
  "app.js": 486,           // PR2 swept 70 fills (574→504); PR4 tonePill/freshnessChip + dead VERDICT_PALETTE (504→486)
  "earnings.js": 108,      // PR5a target ~40
  "riskLab.js": 38,        // PR5b target ~10
  "sectorOutlook.js": 25,  // PR5c target ~8
  "multibaggerLab.js": 8,
  "swsV2Render.js": 2,
  "glossary.js": 0,
  "keyboard.js": 0,
};
const INDEX_CAP = 189; // rgba outside the @tokens regions (was ~219 pre-sweep)

test.describe("raw-rgba ratchet", () => {
  test("/index.html stays at or below the rgba cap (outside @tokens)", async ({
    request,
  }) => {
    const r = await request.get("/index.html");
    expect(r.status()).toBe(200);
    const count = countRgbaOutsideTokens(await r.text());
    expect(
      count,
      `Raw rgba() outside the @tokens region must be ≤${INDEX_CAP} (post-PR2 ` +
        `actual). Got ${count}. Use a --surface-* / --border* token (declared ` +
        `inside @tokens-start/@tokens-end with dark AND light values) instead ` +
        `of a literal rgba fill/border. Shadows and scrims may stay raw.`,
    ).toBeLessThanOrEqual(INDEX_CAP);
  });

  for (const [mod, cap] of Object.entries(MODULE_CAPS)) {
    test(`/${mod} stays at or below its rgba cap (${cap})`, async ({
      request,
    }) => {
      const r = await request.get(`/${mod}`);
      expect(r.status()).toBe(200);
      const count = countRgba(await r.text());
      expect(
        count,
        `${mod} raw rgba() must be ≤${cap} (ratchet — lower as swept, never ` +
          `raise). Got ${count}. Background/border fills → var(--surface-*) / ` +
          `var(--border*); shadows and overlay scrims may stay raw.`,
      ).toBeLessThanOrEqual(cap);
    });
  }
});
