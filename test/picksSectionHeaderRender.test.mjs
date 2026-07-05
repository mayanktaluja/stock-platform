import assert from "node:assert/strict";
import { formatSectionPill, withSectionPills } from "../services/trackRecord/picksSectionBacktest.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\npicksSectionHeaderRender");

const measured = {
  n_resolved: 42,
  thin: false,
  hit_rate_pct: 74.2,
  median_alpha_pct: 2.1,
  median_alpha_ci_pct: { lo: 1.7, hi: 2.6 },
  median_days_held: 1,
};
const thin = { n_resolved: 18, thin: true, median_alpha_pct: null, median_alpha_ci_pct: null };
const empty = { n_resolved: 0, thin: true, median_alpha_pct: null };

it("measured section → α + CI + n + hold, no 'measuring'", () => {
  const html = formatSectionPill(measured);
  assert.match(html, /α \+2\.1%/);
  assert.match(html, /95% CI \+1\.7…\+2\.6/);
  assert.match(html, /n=42/);
  assert.match(html, /~1d hold/);
  assert.match(html, /sws-pick-section-alpha pos/);
  assert.doesNotMatch(html, /measuring/);
});

it("negative alpha → neg modifier class + signed value", () => {
  const html = formatSectionPill({ ...measured, median_alpha_pct: -0.8, median_alpha_ci_pct: { lo: -1.9, hi: 0.3 } });
  assert.match(html, /sws-pick-section-alpha neg/);
  assert.match(html, /α -0\.8%/);
});

it("thin section → muted 'n=X · measuring', NO alpha", () => {
  const html = formatSectionPill(thin);
  assert.match(html, /n=18 · measuring/);
  assert.match(html, /sws-pick-section-measuring/);
  assert.doesNotMatch(html, /α/);
  assert.doesNotMatch(html, /CI/);
});

it("empty section (n=0) → muted measuring, no alpha", () => {
  const html = formatSectionPill(empty);
  assert.match(html, /n=0 · measuring/);
  assert.doesNotMatch(html, /α/);
});

it("no entry / null → empty string (render nothing)", () => {
  assert.equal(formatSectionPill(null), "");
  assert.equal(formatSectionPill(undefined), "");
  assert.equal(formatSectionPill({ n_resolved: null }), "");
});

it("withSectionPills stamps pill_html on every section, metrics untouched", () => {
  const payload = { thin_n: 30, sections: { midterm: measured, quality_growth: thin } };
  const out = withSectionPills(payload);
  assert.match(out.sections.midterm.pill_html, /α \+2\.1%/);
  assert.match(out.sections.quality_growth.pill_html, /measuring/);
  assert.equal(out.sections.midterm.n_resolved, 42); // untouched
});

it("measured pill has no unescaped double-quote breakage (attrs well-formed)", () => {
  const html = formatSectionPill(measured);
  // exactly two double-quoted attributes: class + title
  assert.equal((html.match(/="/g) || []).length, 2);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
