import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// gated/app.js is a plain browser script that inlines the PEG resolver from
// services/valuation/pegDisplay.js (it cannot import it). These assertions are a
// drift guard: if someone reverts the modal to render a raw negative peg as
// "Not meaningful" without the recompute, or drops the shared-module pointer,
// this fails loudly.
const ROOT = process.cwd();
const app = fs.readFileSync(path.join(ROOT, "gated/app.js"), "utf8");

test("app.js modal points at the shared PEG resolver module", () => {
  assert.match(app, /services\/valuation\/pegDisplay\.js/);
});

test("app.js no longer renders a non-positive peg straight to Not meaningful", () => {
  // The old one-liner: `pegVal > 0 ? pegVal.toFixed(2) : "Not meaningful"`.
  assert.doesNotMatch(app, /pegVal\s*>\s*0\s*\?\s*pegVal\.toFixed\(2\)\s*:\s*"Not meaningful"/);
});

test("app.js recomputes PEG = P/E / growth before declaring Not meaningful", () => {
  assert.match(app, /pegNetIncomeCagrPct/);
  assert.match(app, /PEG_DISPLAY_CAP\s*=\s*20/);
  assert.match(app, /peVal\s*\/\s*growth/);
  // The genuine NM branch still exists for flat/shrinking earnings.
  assert.match(app, /"Not meaningful"/);
});

test("app.js floors the recompute P/E to drop garbage-low-P/E rows", () => {
  assert.match(app, /PEG_MIN_PE\s*=\s*3/);
  assert.match(app, /peVal\s*>=\s*PEG_MIN_PE/);
});

test("app.js CAGR uses newest-first history with positive endpoints", () => {
  assert.match(app, /deep\?\.fiscal\?\.yearly_history/);
  assert.match(app, /newest\.ni\s*>\s*0/);
  assert.match(app, /oldest\.ni\s*>\s*0/);
});

test("app.js also consults the Groww yearly profit series as a growth fallback", () => {
  assert.match(app, /deep\?\.financials\?\.groww\?\.yearly\?\.profit/);
  assert.match(app, /pegGrowwProfitCagrPct/);
});
