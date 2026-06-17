// E2E test — Users-tab avatars: CSP allowance + renderer onerror fallback.
//
// The Users tab (gated/app.js:2279 _renderUsersTable) renders a Google
// profile picture per row via <img src="https://lh3.googleusercontent.com/...">.
// Two regression hazards exist:
//
//   1. CSP omits Google's user-content CDN → every <img> is silently
//      blocked by the browser before the request leaves, and every row
//      falls back to a broken-image glyph. This is the bug this spec was
//      written to lock out — production CSP omitted `*.googleusercontent
//      .com` and the entire Users tab was a wall of broken icons.
//   2. The renderer drops the onerror fallback → a single broken URL
//      (URL rotation, deleted Google picture, transient 4xx) leaks the
//      browser's broken-image icon into the UI instead of degrading to
//      the placeholder div.
//
// The Users tab itself is admin-gated and the Playwright harness runs
// with AUTH_ENABLED=false, so we can't drive the real tab. Instead:
//   - assert the CSP header on the served root (the contract is global,
//     so any served page exposes it),
//   - assert the renderer source in gated/app.js still emits the
//     wrapper-div + onerror pattern (a string-level lock that doesn't
//     need a live admin session),
//   - exercise the runtime behaviour of the pattern via page.setContent.

import { test, expect } from "@playwright/test";

test.describe("Users-tab avatars — CSP + renderer regression", () => {
  test("CSP img-src allows Google profile-picture CDN", async ({ request }) => {
    // Helmet attaches the CSP to every response — any served route exposes
    // it. The login page is universally reachable in AUTH_ENABLED=false
    // mode (gated/* requires auth, /login.html doesn't).
    const r = await request.get("/login.html", { maxRedirects: 0 });
    const csp = r.headers()["content-security-policy"] || "";
    expect(csp, "no CSP header on /login.html").not.toBe("");

    // Isolate the img-src directive and verify the Google CDN allowance.
    // The wildcard form is what the helmet config emits; we don't accept
    // the literal `lh3.googleusercontent.com` pin because future Google
    // CDN rotation to lh4/lh5/lh6 would silently break avatars again.
    const imgSrcMatch = csp.match(/img-src\s+([^;]+)/i);
    expect(imgSrcMatch, `img-src directive missing from CSP: ${csp}`).not.toBeNull();
    const imgSrc = imgSrcMatch[1];
    expect(imgSrc, `img-src does not allow Google avatar CDN: "${imgSrc}"`)
      .toMatch(/https:\/\/\*\.googleusercontent\.com/);

    // Defence: the previously-allowed sources must still be there. A future
    // CSP audit that "tightens" img-src must not strip these and break the
    // favicon / chart sprites / inline data URIs.
    expect(imgSrc).toMatch(/'self'/);
    expect(imgSrc).toMatch(/\bdata:/);
    expect(imgSrc).toMatch(/\bblob:/);
  });

  test("renderer emits wrapper-div + onerror fallback for the avatar", async ({ request }) => {
    // String-level lock on gated/app.js so a future refactor that drops the
    // onerror handler (or unwraps the placeholder div) gets caught in CI.
    // The runtime check below proves the pattern works; this check proves
    // the pattern is still being emitted.
    // express.static mounts the gated/ dir at the URL root (server.js:867),
    // so the source bundle lands at /app.js, not /gated/app.js.
    const r = await request.get("/app.js");
    expect(r.status()).toBe(200);
    const src = await r.text();

    // The renderer must wrap the <img> in a div with the placeholder
    // background (so a failed image reveals the placeholder, not whitespace).
    expect(src).toMatch(/background:var\(--bg-graphite\);overflow:hidden;display:inline-block/);

    // The <img> must carry the onerror hide so broken URLs degrade
    // gracefully. Without this, the browser's broken-image glyph shows.
    expect(src).toMatch(/onerror="this\.style\.display='none'"/);

    // referrerpolicy must remain in place — some Google CDN responses
    // blacklist random-origin referers.
    expect(src).toMatch(/referrerpolicy="no-referrer"/);
  });

  test("avatar pattern: valid src loads, broken src hits onerror → display:none", async ({ page }) => {
    // The actual _renderUsersTable function is module-scoped and the Users
    // tab requires admin auth (unavailable here), so we exercise the same
    // HTML pattern via setContent. about:blank has no CSP, so the only
    // failure mode for the broken <img> is its bogus src — exactly what
    // we want to assert onerror handles.
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="good-wrap" style="width:32px;height:32px;border-radius:50%;background:#1a2233;overflow:hidden;display:inline-block;">
          <img id="good"
               src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="
               alt=""
               style="width:100%;height:100%;object-fit:cover;display:block;"
               referrerpolicy="no-referrer"
               onerror="this.style.display='none'">
        </div>
        <div id="bad-wrap" style="width:32px;height:32px;border-radius:50%;background:#1a2233;overflow:hidden;display:inline-block;">
          <img id="bad"
               src="data:image/png;base64,not-valid-base64-this-should-fail-to-decode"
               alt=""
               style="width:100%;height:100%;object-fit:cover;display:block;"
               referrerpolicy="no-referrer"
               onerror="this.style.display='none'">
        </div>
      </body></html>
    `);

    // Wait until both <img> elements have settled (loaded or errored).
    // img.complete flips true on both success and failure paths.
    await page.waitForFunction(() => {
      const good = document.getElementById("good");
      const bad = document.getElementById("bad");
      return good && bad && good.complete && bad.complete;
    }, { timeout: 5000 });

    // Good path: 1×1 GIF loads → naturalWidth > 0, not display:none.
    const goodState = await page.locator("#good").evaluate((img) => ({
      naturalWidth: img.naturalWidth,
      display: img.style.display,
    }));
    expect(goodState.naturalWidth, "valid avatar should load").toBeGreaterThan(0);
    expect(goodState.display, "valid avatar should not be hidden").not.toBe("none");

    // Bad path: invalid data URI fails to decode → onerror fires → display:none.
    const badState = await page.locator("#bad").evaluate((img) => ({
      naturalWidth: img.naturalWidth,
      display: img.style.display,
    }));
    expect(badState.naturalWidth, "broken avatar must not register as loaded").toBe(0);
    expect(badState.display, "onerror must hide the broken <img>").toBe("none");

    // The wrapper div should still be visible in both cases — the dark
    // circle placeholder is what the user actually sees when the image
    // is hidden.
    const badWrapVisible = await page.locator("#bad-wrap").isVisible();
    expect(badWrapVisible).toBe(true);
  });
});
