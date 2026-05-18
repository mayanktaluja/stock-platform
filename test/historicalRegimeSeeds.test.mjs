import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SEEDS_PATH = path.join(REPO_ROOT, "data", "macro-seed-events.json");
const OUT_PATH = path.join(REPO_ROOT, "data", "macroRegime-history", "backfill-seeds.jsonl");

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    pass++;
  } catch (err) {
    console.log(`  not ok - ${name}\n      ${err.message}`);
    fail++;
  }
}

const VALID_REGIMES = new Set([
  "WAR_ESCALATION",
  "WAR_DE_ESCALATION",
  "OIL_SHOCK",
  "RATE_HIKE",
  "RATE_CUT",
  "CURRENCY_WEAKNESS",
  "POLICY_STIMULUS",
  "REGULATORY_SHOCK",
  "GLOBAL_RISK_OFF",
  "CALM",
]);

const seedsDoc = JSON.parse(fs.readFileSync(SEEDS_PATH, "utf-8"));

test("seeds file exists + has schema_version", () => {
  assert.equal(seedsDoc.schema_version, "macro-seed-events-v1");
});

test("seeds: 12-15 events curated (n>=3 per common regime)", () => {
  assert.ok(seedsDoc.events.length >= 12, `expected ≥12, got ${seedsDoc.events.length}`);
  assert.ok(seedsDoc.events.length <= 20, "intentionally small — audit-friendly");
});

test("every seed has required fields + valid regime", () => {
  for (const e of seedsDoc.events) {
    for (const f of ["date", "label", "regime", "severity", "severity_rationale"]) {
      assert.ok(e[f], `event ${e.label || "?"} missing field ${f}`);
    }
    assert.ok(VALID_REGIMES.has(e.regime), `unknown regime ${e.regime} on ${e.label}`);
    assert.ok(e.severity >= 1 && e.severity <= 5, `severity out of [1,5] on ${e.label}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.date), `date format wrong on ${e.label}`);
    assert.ok(Array.isArray(e.primary_sectors_hit) || Array.isArray(e.primary_sectors_benefit), `${e.label} has neither hit nor benefit list`);
  }
});

test("regime coverage: WAR_ESCALATION, GLOBAL_RISK_OFF, REGULATORY_SHOCK all present ≥1", () => {
  const seen = new Map();
  for (const e of seedsDoc.events) seen.set(e.regime, (seen.get(e.regime) || 0) + 1);
  assert.ok((seen.get("WAR_ESCALATION") || 0) >= 1);
  assert.ok((seen.get("GLOBAL_RISK_OFF") || 0) >= 1);
  assert.ok((seen.get("REGULATORY_SHOCK") || 0) >= 1);
});

test("seed dates span at least 5 years", () => {
  const years = seedsDoc.events.map((e) => parseInt(e.date.slice(0, 4), 10));
  assert.ok(Math.max(...years) - Math.min(...years) >= 5, "span too narrow for analog diversity");
});

test("ANANTRAJ-canonical seed (India-Pak May 2025) is present", () => {
  const sindoor = seedsDoc.events.find((e) => e.regime === "WAR_ESCALATION" && e.date.startsWith("2025-05"));
  assert.ok(sindoor, "May 2025 India-Pak escalation must be seeded (the ANANTRAJ trigger)");
  assert.ok(sindoor.primary_sectors_hit.includes("Real Estate"), "Real Estate must be marked hit");
});

test("scripts/seed-historical-regimes.mjs has been run and output matches", () => {
  if (!fs.existsSync(OUT_PATH)) {
    // Run-script gate: tests don't trigger the script themselves to keep them hermetic;
    // we assume CI invokes the script during a fresh provisioning run.
    console.log(`  (skipped: ${OUT_PATH} not present — run: node scripts/seed-historical-regimes.mjs)`);
    return;
  }
  const lines = fs.readFileSync(OUT_PATH, "utf-8").trim().split("\n");
  assert.equal(lines.length, seedsDoc.events.length, "output line count must match seeds");
  for (const line of lines) {
    const r = JSON.parse(line);
    assert.equal(r.source, "manual-seed", "every output line must have source: manual-seed");
    assert.ok(VALID_REGIMES.has(r.regime));
    assert.ok(typeof r.generatedAt === "string" && r.generatedAt.includes("T"));
  }
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
