/**
 * Regression: the SWS rewards/risks coverage canary in the sanity gate.
 *
 * Companion to bug3-sws-rewards-risks.regression.mjs. That test runs the parser
 * against frozen fixtures — it proves the extraction *logic* is correct but
 * cannot detect SWS changing their live API, which is exactly how the original
 * bug #3 hid (every stock's overview.rewards/overview.risks silently went empty
 * while the frozen-fixture unit test kept passing).
 *
 * The fix added a live canary: the nightly refresh counts deep files with
 * non-empty rewards/risks into last-refresh.json, and scripts/sws-sanity-gate.mjs
 * L1 BLOCKs the auto-PR when rewards_populated_count collapses below
 * MIN_REWARDS_POPULATED.
 *
 * This test drives the gate directly (via the SWS_SANITY_ROOT env seam) against
 * a synthetic last-refresh.json and asserts the canary fires on a collapse and
 * stays quiet on a healthy count.
 *
 * Run via: npm run test:regression  (pure — spawns the gate, no server)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REAL_LAST_REFRESH = path.join(REPO_ROOT, "data", "sws", "last-refresh.json");

let pass = 0;
let fail = 0;
let skipped = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

console.log("Bug #3b — SWS rewards/risks coverage canary");

// Self-skip when the data precondition is missing — consistent with the suite.
if (!existsSync(REAL_LAST_REFRESH)) {
  skipped++;
  console.log("  ⊘ canary fires/clears  (skipped — data/sws/last-refresh.json absent)");
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(REAL_LAST_REFRESH, "utf8"));

// Run the gate against an isolated fixture dir holding only a synthetic
// last-refresh.json. SWS_SANITY_ROOT redirects every gate read/write — the
// gate writes its report under <root>/_sanity/, which in the real tree is
// git-tracked. Other layers (L2/L3/L6) record their own failures against the
// sparse dir; that's fine — we assert only on the L1 rewards finding.
function runGate(rewardsCount) {
  const dir = mkdtempSync(path.join(tmpdir(), "sws-canary-"));
  try {
    const lr = { ...base, rewards_populated_count: rewardsCount, risks_populated_count: rewardsCount };
    writeFileSync(path.join(dir, "last-refresh.json"), JSON.stringify(lr));
    spawnSync("node", ["scripts/sws-sanity-gate.mjs"], {
      cwd: REPO_ROOT,
      env: { ...process.env, SWS_SANITY_ROOT: dir },
      encoding: "utf8",
    });
    const report = JSON.parse(readFileSync(path.join(dir, "_sanity", "_latest.json"), "utf8"));
    const checks = report?.layers?.L1_run_integrity?.checks || [];
    return checks.find((c) => c.name === "rewards_populated_threshold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Case A: universe-wide collapse (the bug #3 signature) → BLOCK, ok:false ──
const collapse = runGate(0);
assert("collapse (rewards=0): rewards_populated_threshold finding exists", !!collapse, collapse);
assert("collapse (rewards=0): severity is BLOCK", collapse?.severity === "BLOCK", collapse?.severity);
assert("collapse (rewards=0): ok is false — canary fires", collapse?.ok === false, collapse?.ok);

// ── Case B: healthy coverage → ok:true (no false-positive on a normal run) ──
const healthy = runGate(5000);
assert("healthy (rewards=5000): ok is true — no false-positive", healthy?.ok === true, healthy?.ok);
assert(
  "healthy (rewards=5000): still records the BLOCK-severity check",
  healthy?.severity === "BLOCK",
  healthy?.severity,
);

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
