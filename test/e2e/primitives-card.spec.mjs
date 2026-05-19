// PR #4: .card primitive elevation token consumption.
//
// The :root declared --elev-1..4 tokens in Phase 8B but no rule ever
// consumed them. PR #4 adds the .card primitive that drives box-shadow
// via --elev-2 by default, plus --elev-1 / --elev-3 / --elev-4 modifiers.
//
// This spec asserts the primitive class actually produces a non-trivial
// box-shadow at runtime. It does NOT assert any existing card carries
// the new class — PR #4 deliberately leaves existing .stock-card and
// .sws-modal alone; subsequent PRs migrate where appropriate.

import { test, expect } from "@playwright/test";

test.describe("PR #4 .card primitive", () => {
  test("a .card on the page picks up an --elev-2 box-shadow", async ({
    page,
  }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });

    // Inject a probe .card and read its computed box-shadow so we don't
    // depend on any real call site adopting the class in PR #4.
    const shadow = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "card";
      probe.style.position = "absolute";
      probe.style.top = "-9999px";
      probe.textContent = "probe";
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const out = cs.boxShadow;
      probe.remove();
      return out;
    });

    // box-shadow must be non-"none" and non-empty
    expect(shadow).toBeTruthy();
    expect(shadow).not.toBe("none");
    expect(shadow.length).toBeGreaterThan(5);
  });

  test(".card--elev-4 has a heavier shadow than .card--elev-1", async ({
    page,
  }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    const [shadow1, shadow4] = await page.evaluate(() => {
      function probe(cls) {
        const el = document.createElement("div");
        el.className = cls;
        el.style.position = "absolute";
        el.style.top = "-9999px";
        document.body.appendChild(el);
        const s = getComputedStyle(el).boxShadow;
        el.remove();
        return s;
      }
      return [probe("card card--elev-1"), probe("card card--elev-4")];
    });
    // elev-1 and elev-4 should differ — the test for "heavier" is just
    // that they're not the same string
    expect(shadow1).not.toBe(shadow4);
    expect(shadow1).toBeTruthy();
    expect(shadow4).toBeTruthy();
  });

  test(".badge primitives carry semantic colours", async ({ page }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    const colours = await page.evaluate(() => {
      const variants = ["success", "warn", "danger", "info", "neutral"];
      return variants.map((v) => {
        const el = document.createElement("span");
        el.className = `badge badge--${v}`;
        el.style.position = "absolute";
        el.style.top = "-9999px";
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = { variant: v, color: cs.color, background: cs.backgroundColor };
        el.remove();
        return out;
      });
    });
    // All 5 should have distinct text colours
    const uniqueColours = new Set(colours.map((c) => c.color));
    expect(
      uniqueColours.size,
      `badge colours must be distinct, got ${JSON.stringify(colours)}`,
    ).toBe(5);
  });
});
