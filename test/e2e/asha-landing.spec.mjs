import { test, expect } from "@playwright/test";

const PRIMARY_WHATSAPP = "919718213716";
const DIRECTIONS_QUERY =
  "Jyoti Park, Main Road, near Ashirwad Marriage Lawn, Sector 7 Ext., Gurugram, Haryana";

function decodedWhatsAppMessage(href) {
  const url = new URL(href);
  expect(url.hostname).toBe("wa.me");
  expect(url.pathname).toBe(`/${PRIMARY_WHATSAPP}`);
  return url.searchParams.get("text");
}

test.describe("Asha public landing page", () => {
  test("/asha routes serve the public page without login redirects", async ({ request }) => {
    for (const path of ["/asha", "/asha/"]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} status`).toBe(200);
      expect(response.headers().location || "").not.toContain("/login.html");
      const html = await response.text();
      expect(html).toContain("Asha - A Style Hub Area");
      expect(html).toContain("Serving Gurugram since 1996");
    }
  });

  test("390px first screen communicates trust and shows WhatsApp CTA", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/asha", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Asha - A Style Hub Area" })).toBeVisible();
    await expect(page.getByText("Formerly Asha Boutique & Collections")).toBeVisible();
    await expect(page.getByText("Serving Gurugram since 1996")).toBeVisible();
    await expect(page.getByText(/women's custom stitching and trusted fitting/i)).toBeVisible();
    await expect(page.getByTestId("hero-whatsapp")).toBeVisible();
    await expect(page.getByRole("link", { name: "Get Directions" }).first()).toBeVisible();
    await expect(page.getByTestId("sticky-cta")).toBeVisible();

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test("service selection updates sticky label and WhatsApp message", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/asha", { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: "Bridal Stitching" }).click();
    await expect(page.locator("[data-selected-service]")).toHaveText("Bridal Stitching");
    let href = await page.getByTestId("sticky-whatsapp").getAttribute("href");
    expect(decodedWhatsAppMessage(href)).toBe(
      "Namaste Asha, I want to ask about bridal outfit stitching. Please share details and timing.",
    );

    await page.getByRole("button", { name: "Ready-made Wear" }).click();
    await expect(page.locator("[data-selected-service]")).toHaveText("Ready-made Wear");
    href = await page.getByTestId("sticky-whatsapp").getAttribute("href");
    expect(decodedWhatsAppMessage(href)).toBe(
      "Namaste Asha, I saw your ready-made collection online. Please share options in my size.",
    );
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

    const instagramHref = await page.getByRole("link", { name: /@asha\.stylehub|View Instagram/ }).first().getAttribute("href");
    expect(instagramHref).toBe("https://www.instagram.com/asha.stylehub/");
  });

  test("LocalBusiness schema describes Asha accurately", async ({ page }) => {
    await page.goto("/asha", { waitUntil: "domcontentloaded" });

    const schema = await page.evaluate(() =>
      JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent),
    );

    expect(schema["@type"]).toBe("ClothingStore");
    expect(schema.name).toBe("Asha - A Style Hub Area");
    expect(schema.alternateName).toBe("Asha Boutique & Collections");
    expect(schema.foundingDate).toBe("1996");
    expect(schema.telephone).toEqual(["+919718213716", "+918118837701"]);
    expect(schema.sameAs).toContain("https://www.instagram.com/asha.stylehub/");
    expect(schema.address.addressLocality).toBe("Gurugram");
    expect(schema.address.streetAddress).toContain("Jyoti Park");
  });

  test("copy guardrails avoid launch, ecommerce, and fake-review claims", async ({ page }) => {
    await page.goto("/asha", { waitUntil: "domcontentloaded" });
    const text = await page.locator("body").innerText();

    expect(text).not.toMatch(/Grand Launch/i);
    expect(text).not.toMatch(/22 June/i);
    expect(text).not.toMatch(/best boutique/i);
    expect(text).not.toMatch(/\bcart\b|\bcheckout\b|\bpayment\b/i);
    expect(text).not.toMatch(/5\s*star|five\s*star|\breviews?\b|\brated\b/i);
  });
});
