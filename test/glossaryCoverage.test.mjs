// Glossary coverage guard.
//
// infoIcon(termId) / infoBubble(termId) (gated/app.js, gated/riskLab.js) render
// NOTHING when termId is absent from window.GLOSSARY — a typo'd id ships as an
// invisible icon with no error. This test scans the tab render files for
// infoIcon('literal') / infoBubble('literal') calls and asserts every referenced
// id exists in gated/glossary.js, plus that the Sector Outlook + 5x Lab feature
// ids are both defined and actually wired into a render file.
//
// Hard-asserts only the files whose icon wiring this feature owns
// (sectorOutlook.js, multibaggerLab.js). app.js / riskLab.js are scanned for an
// informational drift report so a pre-existing dangling id can't fail the suite.

import { readFileSync } from "node:fs";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const CALL_RE = /\b(?:infoIcon|infoBubble)\(\s*['"]([A-Za-z0-9_]+)['"]/g;

function referencedIds(src) {
  return [...src.matchAll(CALL_RE)].map((m) => m[1]);
}

// ── 1. Extract top-level GLOSSARY keys ────────────────────────────────────
const glossarySrc = read("../gated/glossary.js");
const glossaryKeys = new Set(
  [...glossarySrc.matchAll(/^ {2}([A-Za-z0-9_]+):\s*\{/gm)].map((m) => m[1]),
);
assert("glossary has a healthy number of entries", glossaryKeys.size >= 140, glossaryKeys.size);

// ── 2. Hard scan: files whose icon wiring this feature owns ───────────────
const OWNED_FILES = ["../gated/sectorOutlook.js", "../gated/multibaggerLab.js"];
const ownedRefs = new Map(); // id -> [files]
for (const f of OWNED_FILES) {
  for (const id of referencedIds(read(f))) {
    if (!ownedRefs.has(id)) ownedRefs.set(id, []);
    ownedRefs.get(id).push(f);
  }
}
assert("found infoIcon references in the owned render files", ownedRefs.size > 0, ownedRefs.size);

const missing = [];
for (const [id, files] of ownedRefs) {
  if (!glossaryKeys.has(id)) missing.push(`${id} (in ${[...new Set(files)].join(", ")})`);
}
assert("every infoIcon id in sectorOutlook.js / multibaggerLab.js exists in GLOSSARY", missing.length === 0, missing);

// ── 3. The Sector Outlook + 5x Lab feature ids exist AND are wired ────────
const FEATURE_IDS = [
  "sector_trust_score", "sector_trust_factors",
  "sector_outlook_label", "sector_outlook_confidence", "sector_composite",
  "sector_bottom_up", "sector_top_down", "sector_breadth", "sector_news_90d",
  "sector_top_themes", "sector_tailwind", "sector_headwind", "sector_neutral",
  "mb_current_value", "mb_target_net", "mb_gross_required", "mb_universe_scored",
  "mb_score", "mb_verdict", "mb_bull_case", "mb_bear_case", "mb_target_multiple",
];
const missingFeature = FEATURE_IDS.filter((id) => !glossaryKeys.has(id));
assert("all Sector Outlook + 5x Lab feature ids exist in GLOSSARY", missingFeature.length === 0, missingFeature);

// sector_tailwind/headwind/neutral + macro_regime are wired via the dynamic
// infoIcon(t.termId) stat-card path, so they won't show up in the literal scan
// of step 2 — assert them against the stat-card termId table instead.
const sectorSrc = read("../gated/sectorOutlook.js");
const statCardIds = [...sectorSrc.matchAll(/termId:\s*['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]);
const wired = new Set([...ownedRefs.keys(), ...statCardIds]);
const unwired = FEATURE_IDS.filter((id) => !wired.has(id));
assert("all feature ids are actually referenced in a render file", unwired.length === 0, unwired);

// ── 4. Informational drift report for the wider surface (non-fatal) ───────
for (const f of ["../gated/app.js", "../gated/riskLab.js"]) {
  const dangling = [...new Set(referencedIds(read(f)))].filter((id) => !glossaryKeys.has(id));
  if (dangling.length) {
    console.log(`  NOTE: ${f} has literal ids not in GLOSSARY (pre-existing, not failing): ${dangling.join(", ")}`);
  }
}

if (_failed > 0) {
  console.log(`\nglossaryCoverage: ${_failed} failures`);
  process.exit(1);
}
console.log("\nglossaryCoverage: all tests passed");
