import { test, expect } from "@playwright/test";

const PRIMARY_WHATSAPP = "919718213716";
const PRODUCTION_URL = "https://asha-stylehub.vercel.app/";
const DIRECTIONS_QUERY =
  "Jyoti Park, Main Road, near Ashirwad Marriage Lawn, Sector 7 Ext., Gurugram, Haryana";

const SERVICE_MESSAGES = {
  "Custom Stitching": "Namaste Asha, I need help with custom stitching and fitting. Please guide me.",
  "Blouse & Saree Fitting":
    "Namaste Asha, I need blouse or saree fitting support. Please share details and timing.",
  "Bridal & Occasion Wear":
    "Namaste Asha, I need bridal or occasion wear fitting/stitching support. Please guide me.",
  Alterations: "Namaste Asha, I need alteration/fitting support. Please share timing.",
  "Ready-Made Ethnic Wear":
    "Namaste Asha, I am looking for ready-made ethnic wear. Please share available options.",
};

function decodedWhatsAppMessage(href) {
  const url = new URL(href);
  expect(url.hostname).toBe("wa.me");
  expect(url.pathname).toBe(`/${PRIMARY_WHATSAPP}`);
  return url.searchParams.get("text");
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(Math.max(overflow.scrollWidth, overflow.bodyWidth)).toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
}

async function stickyState(page) {
  return page.getByTestId("sticky-cta").evaluate((node) => ({
    hidden: node.getAttribute("aria-hidden"),
    hasVisibleClass: node.classList.contains("is-visible"),
    opacity: getComputedStyle(node).opacity,
    pointerEvents: getComputedStyle(node).pointerEvents,
  }));
}

test.describe("Asha public landing page", () => {
  test("/asha routes serve the public page without login redirects", async ({ request }) => {
    for (const path of ["/asha", "/asha/"]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} status`).toBe(200);
      expect(response.headers().location || "").not.toContain("/login.html");
      const html = await response.text();
      expect(html).toContain("Asha - A Style Hub Area");
      expect(html).toContain("Custom stitching &amp; fitting in Gurugram");
    }
  });

  test("mobile widths have no horizontal overflow", async ({ page }) => {
    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/asha", { waitUntil: "domcontentloaded" });
      await expectNoHorizontalOverflow(page);
    }
  });

  test("390px first screen communicates local trust and conversion actions", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/asha", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("Asha").first()).toBeVisible();
    await expect(page.getByText("Since 1996", { exact: true })).toBeVisible();
    await expect(page.getByText("Jyoti Park, Sector 7 Ext., Gurugram")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Custom stitching & fitting in Gurugram" })).toBeVisible();
    await expect(page.getByText(/women's custom stitching/i)).toBeVisible();
    await expect(page.getByTestId("hero-whatsapp")).toBeVisible();
    await expect(page.getByTestId("hero-call")).toBeVisible();
    await expect(page.getByRole("link", { name: /Get directions near Ashirwad Marriage Lawn/i })).toBeVisible();

    const sticky = await stickyState(page);
    expect(sticky.hidden).toBe("true");
    expect(sticky.hasVisibleClass).toBe(false);
    await expectNoHorizontalOverflow(page);
  });

  test("sticky CTA appears after hero and does not cover final contact actions", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/asha", { waitUntil: "domcontentloaded" });

    await page.evaluate(() => window.scrollTo(0, document.querySelector("[data-hero]").offsetHeight + 120));
    await expect.poll(() => stickyState(page)).toMatchObject({
      hidden: "false",
      hasVisibleClass: true,
      pointerEvents: "auto",
    });

    await page.getByTestId("sticky-call").click({ trial: true });

    await page.locator("[data-contact-section]").scrollIntoViewIfNeeded();
    await expect.poll(() => stickyState(page)).toMatchObject({
      hidden: "true",
      hasVisibleClass: false,
      pointerEvents: "none",
    });

    await page.getByRole("link", { name: "Call Now" }).click({ trial: true });
    await page.getByRole("link", { name: "Get Directions", exact: true }).click({ trial: true });
  });

  test("service selection updates WhatsApp message for all five services", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/asha", { waitUntil: "domcontentloaded" });

    for (const [service, message] of Object.entries(SERVICE_MESSAGES)) {
      const selector = service === "Ready-Made Ethnic Wear"
        ? page.getByRole("button", { name: "Check Ready-Made Options" })
        : page.getByRole("button", { name: `Select ${service}` });
      await selector.click();
      const href = await page.getByTestId("sticky-whatsapp").getAttribute("href");
      expect(decodedWhatsAppMessage(href)).toBe(message);
    }
  });

  test("contact actions point at WhatsApp, phone, maps, and Instagram", async ({ page }) => {
    await page.goto("/asha", { waitUntil: "domcontentloaded" });

    const whatsappHref = await page.getByTestId("visit-whatsapp").getAttribute("href");
    expect(decodedWhatsAppMessage(whatsappHref)).toContain("custom stitching and fitting");

    await expect(page.locator('a[href="tel:+919718213716"]').first()).toBeVisible();
    await expect(page.locator('a[href="tel:+918118837701"]').first()).toBeVisible();

    const directionsHref = await page.locator("[data-directions-link]").first().getAttribute("href");
    const directionsUrl = new URL(directionsHref);
    expect(directionsUrl.hostname).toBe("www.google.com");
    expect(directionsUrl.searchParams.get("query")).toBe(DIRECTIONS_QUERY);

    const instagramHref = await page
      .getByRole("link", { name: /@asha\.stylehub|View Instagram/ })
      .first()
      .getAttribute("href");
    expect(instagramHref).toBe("https://www.instagram.com/asha.stylehub/");
  });

  test("production metadata and LocalBusiness schema describe Asha accurately", async ({ page }) => {
    await page.goto("/asha", { waitUntil: "domcontentloaded" });

    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", PRODUCTION_URL);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", PRODUCTION_URL);

    const schema = await page.evaluate(() =>
      JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent),
    );

    expect(schema["@type"]).toEqual(["ClothingStore", "LocalBusiness"]);
    expect(schema.name).toBe("Asha - A Style Hub Area");
    expect(schema.alternateName).toBe("Asha Boutique & Collections");
    expect(schema.foundingDate).toBe("1996");
    expect(schema.telephone).toEqual(["+919718213716", "+918118837701"]);
    expect(schema.url).toBe(PRODUCTION_URL);
    expect(schema.sameAs).toContain("https://www.instagram.com/asha.stylehub/");
    expect(schema.address.addressLocality).toBe("Gurugram");
    expect(schema.address.streetAddress).toContain("Jyoti Park");
  });

  test("copy guardrails avoid launch, ecommerce, fake-review, and unfinished-photo claims", async ({ page }) => {
    await page.goto("/asha", { waitUntil: "domcontentloaded" });
    const text = await page.locator("body").innerText();

    expect(text).not.toMatch(/Grand Launch/i);
    expect(text).not.toMatch(/22 June/i);
    expect(text).not.toMatch(/best boutique|No\.\s*1/i);
    expect(text).not.toMatch(/\bcart\b|\bcheckout\b|\bpayment\b/i);
    expect(text).not.toMatch(/5\s*star|five\s*star|\breviews?\b|\brated\b/i);
    expect(text).not.toMatch(/future photos?|future collections?|placeholder|lookbook ready/i);
    expect(text).not.toMatch(/perfect fit guaranteed/i);
  });
});
