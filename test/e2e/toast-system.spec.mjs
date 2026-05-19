// PR #5: toast() helper. Asserts:
//   1. window.toast() exists and renders chips into #toastStack.
//   2. Stack caps at 3 visible + a "+N more" chip when more queue up.
//   3. Auto-dismiss removes the chip after its durationMs.
//   4. #toastStack carries role=status + aria-live=polite for a11y.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #5 toast() system", () => {
  test("#toastStack is rendered at body level with the right ARIA", async ({
    page,
  }) => {
    await gotoApp(page);
    const attrs = await page.evaluate(() => {
      const el = document.getElementById("toastStack");
      return el && {
        parent: el.parentElement?.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        ariaLive: el.getAttribute("aria-live"),
        ariaAtomic: el.getAttribute("aria-atomic"),
      };
    });
    expect(attrs).not.toBeNull();
    expect(attrs.parent).toBe("body");
    expect(attrs.role).toBe("status");
    expect(attrs.ariaLive).toBe("polite");
    expect(attrs.ariaAtomic).toBe("false");
  });

  test("toast() renders a chip with the right kind", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.toast({ kind: "error", msg: "Test error", durationMs: 60000 });
    });
    const chip = page.locator('#toastStack [data-testid="toast"]');
    await expect(chip).toBeVisible({ timeout: 2000 });
    await expect(chip).toHaveAttribute("data-kind", "error");
    await expect(chip).toHaveText(/Test error/);
  });

  test("toast stack caps at 3 with overflow chip when 5 fire fast", async ({
    page,
  }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) {
        window.toast({ kind: "error", msg: `Err ${i}`, durationMs: 60000 });
      }
    });
    const visible = page.locator('#toastStack [data-testid="toast"]');
    const overflow = page.locator('#toastStack [data-testid="toast-overflow"]');
    await expect(visible).toHaveCount(3);
    await expect(overflow).toBeVisible();
    await expect(overflow).toHaveText(/\+2 more/);
  });

  test("toast auto-dismisses after durationMs", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.toast({ kind: "info", msg: "Quick toast", durationMs: 500 });
    });
    const chip = page.locator('#toastStack [data-testid="toast"]');
    await expect(chip).toBeVisible();
    // After ~600ms it should be gone
    await page.waitForTimeout(900);
    await expect(chip).toHaveCount(0);
  });

  test("toast respects --z-toast token (sits above modal backdrop)", async ({
    page,
  }) => {
    await gotoApp(page);
    const z = await page.evaluate(() => {
      const stack = document.getElementById("toastStack");
      return getComputedStyle(stack).zIndex;
    });
    // --z-toast = 1700, --z-modal-backdrop = 1300
    expect(parseInt(z, 10)).toBeGreaterThanOrEqual(1700);
  });
});
