import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT || 4011;
const BASE_URL = `http://localhost:${PORT}`;
const SWS_REPO_ROOT_OVERRIDE = process.env.SWS_REPO_ROOT_OVERRIDE || ".e2e/sws-root";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
    // A1: the app gained a light theme (resolves stored > OS > dark). Pin the
    // suite default to dark so the existing specs keep validating the dark
    // palette they were written against — Chromium's default emulation is
    // 'light', which would otherwise silently flip every spec to the new,
    // less-tested theme. Light is covered explicitly (theme-toggle.spec.mjs;
    // axe runs both themes in F1). Specs needing light override per-context.
    colorScheme: "dark",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run build && PORT=${PORT} node server.js`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      NODE_ENV: "test",
      STARBHAI_SESSION_SECRET: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      SWS_REPO_ROOT_OVERRIDE,
    },
  },
});
