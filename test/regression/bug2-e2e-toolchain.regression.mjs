/**
 * Regression: the e2e toolchain must be self-sufficient on a clean clone.
 *
 * Bug #2 — `npm run test:e2e` failed out of the box because:
 *   1. `@playwright/test` was missing from devDependencies → ERR_MODULE_NOT_FOUND
 *      (playwright.config.mjs and every spec import it).
 *   2. Playwright browser binaries were never installed → "Executable doesn't
 *      exist" on first run; 13/19 specs failed.
 *
 * This locks both: @playwright/test is a declared devDependency, and the
 * test:e2e script installs browsers before running playwright. Pure check —
 * reads package.json, no server needed.
 *
 * Run with: node test/regression/bug2-e2e-toolchain.regression.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf-8"),
);

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

console.log("Bug #2 — e2e toolchain self-sufficiency");

assert(
  "@playwright/test is a declared devDependency",
  !!pkg.devDependencies?.["@playwright/test"],
  pkg.devDependencies?.["@playwright/test"],
);

const e2eScript = pkg.scripts?.["test:e2e"] || "";
assert(
  "test:e2e installs Playwright browsers before running",
  /playwright\s+install/.test(e2eScript),
  e2eScript,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
