/**
 * Caps the size of the Vercel `api/index` function bundle.
 *
 * On 2026-07-25 the nightly data push crossed Vercel's 250 MB uncompressed
 * function limit and EVERY production and preview deploy failed for two days.
 * The build itself succeeded — the rejection happens in the deploy step, after
 * the build log says "Build Completed" — so nothing in the repo noticed. Prod
 * silently kept serving a two-day-old deployment.
 *
 * Nothing had "broken": the archive under data/catalysts/earnings-history/ grows
 * ~5 MB every night, so the bundle ratcheted 212 MB → 265 MB over ten days and
 * then fell off a cliff. This is the guard that turns that cliff into a test
 * failure weeks ahead of time.
 *
 * The budget is deliberately well under Vercel's hard 250 MB so a red build here
 * is an early warning with room to act, not an outage. When it fires, do not
 * just raise the number — find what grew and pack, prune, or .vercelignore it.
 *
 * Sizing method: git-tracked paths (the deploy uploads the committed tree), each
 * measured on disk, filtered through .vercelignore → includeFiles → excludeFiles.
 * On the failing deploy this reproduced Vercel's reported 264.95 MB to within
 * 0.08 MB (0.03%), so it needs no Vercel build to be accurate.
 *
 * Run with: node test/vercel-bundle-size.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Vercel's hard limit. Exceeding it fails the DEPLOY, not the build.
const VERCEL_HARD_LIMIT_BYTES = 250_000_000;
// Our ratchet. Leaves ~50 MB of runway so this goes red with weeks of warning.
const BUNDLE_BUDGET_BYTES = 200_000_000;

let pass = 0,
  fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "→", e.message);
  }
}

// Minimal glob→RegExp faithful to minimatch path semantics (what Vercel uses):
// `*` matches within a path segment, `**` matches across segments. Mirrors
// test/vercel-include-files.test.mjs so both gates agree on what ships.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\/".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function splitTopLevelComma(s, { keepEmpty = false } = {}) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (const ch of String(s || "")) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (keepEmpty || cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (keepEmpty || cur.trim()) out.push(cur.trim());
  return out;
}

function expandBraces(pattern) {
  const s = String(pattern || "");
  const start = s.indexOf("{");
  if (start < 0) return [s];
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    if (s[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [s];
  const before = s.slice(0, start);
  const after = s.slice(end + 1);
  return splitTopLevelComma(s.slice(start + 1, end), { keepEmpty: true })
    .flatMap((part) => expandBraces(before + part + after));
}

function splitBraceGlob(glob) {
  if (Array.isArray(glob)) {
    return glob.map((p) => String(p).trim()).filter(Boolean).flatMap(expandBraces);
  }
  glob = String(glob || "").trim();
  if (glob.startsWith("{") && glob.endsWith("}")) glob = glob.slice(1, -1);
  return splitTopLevelComma(glob).flatMap(expandBraces).filter(Boolean);
}

function functionConfig() {
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf-8"));
  const entry = (vercel.functions || {})["api/index.js"];
  assert.ok(entry, "vercel.json functions['api/index.js'] must exist");
  return entry;
}

function vercelIgnoreMatchers() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, ".vercelignore"), "utf-8");
  const patterns = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  // A bare directory path in .vercelignore excludes everything beneath it, so
  // match both the literal path and its subtree.
  return patterns.flatMap((p) => [globToRegExp(p), globToRegExp(p.replace(/\/\*\*$/, "") + "/**")]);
}

/** Every git-tracked file that the deploy would upload into the function. */
function bundledFiles() {
  const cfg = functionConfig();
  const includeRes = splitBraceGlob(cfg.includeFiles).map((p) => globToRegExp(p.replace(/^\.\.\//, "")));
  const excludeRes = splitBraceGlob(cfg.excludeFiles).map((p) => globToRegExp(p.replace(/^\.\.\//, "")));
  const ignoreRes = vercelIgnoreMatchers();

  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 1 << 28 })
    .toString()
    .split("\0")
    .filter(Boolean);

  const out = [];
  for (const rel of tracked) {
    if (ignoreRes.some((re) => re.test(rel))) continue;
    if (!includeRes.some((re) => re.test(rel))) continue;
    if (excludeRes.some((re) => re.test(rel))) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(REPO_ROOT, rel)).size;
    } catch {
      continue; // staged deletion — not uploaded
    }
    out.push({ rel, size });
  }
  return out;
}

const mb = (bytes) => (bytes / 1e6).toFixed(2);

console.log("\nvercel.json — api/index function bundle must stay under budget\n");

const files = bundledFiles();
const total = files.reduce((a, f) => a + f.size, 0);

// Group by the first three path segments so the report points at a directory to
// fix rather than at one arbitrary large file.
const groups = new Map();
for (const f of files) {
  const key = f.rel.split("/").slice(0, 3).join("/");
  groups.set(key, (groups.get(key) || 0) + f.size);
}
const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
const topReport = top.map(([k, v]) => `      ${mb(v).padStart(8)} MB  ${k}`).join("\n");

console.log(`  bundle: ${mb(total)} MB across ${files.length} files`);
console.log(`  budget: ${mb(BUNDLE_BUDGET_BYTES)} MB    Vercel hard limit: ${mb(VERCEL_HARD_LIMIT_BYTES)} MB`);
console.log("  largest groups:");
console.log(topReport);
console.log("");

check("the sizing model found a plausible bundle (else git/glob is broken)", () => {
  assert.ok(
    files.length >= 50,
    `expected ≥50 bundled files, found ${files.length} — the include globs or git listing broke`,
  );
  assert.ok(
    total > 10_000_000,
    `bundle computed as only ${mb(total)} MB — the matcher is almost certainly broken, not the bundle`,
  );
});

check("api/index stays under Vercel's hard 250 MB uncompressed limit", () => {
  assert.ok(
    total <= VERCEL_HARD_LIMIT_BYTES,
    `Bundle is ${mb(total)} MB — OVER Vercel's ${mb(VERCEL_HARD_LIMIT_BYTES)} MB limit. ` +
      `EVERY deploy will fail at the deploy step (the build still says "Completed"). Largest groups:\n${topReport}`,
  );
});

check(`api/index stays under the ${mb(BUNDLE_BUDGET_BYTES)} MB budget`, () => {
  assert.ok(
    total <= BUNDLE_BUDGET_BYTES,
    `Bundle is ${mb(total)} MB, over the ${mb(BUNDLE_BUDGET_BYTES)} MB budget ` +
      `(${mb(VERCEL_HARD_LIMIT_BYTES - total)} MB left before deploys start failing).\n${topReport}\n` +
      `  Pack a growing directory into a tarball (see scripts/pack-earnings-history.sh) or\n` +
      `  .vercelignore a local-only cache. Raising this number is the last resort, not the first.`,
  );
});

check("the growing earnings-history archive ships packed, not loose", () => {
  // The specific regression that caused the 2026-07-25 outage. The loose
  // directory grows ~5 MB/day; only the tarball may ship.
  const loose = files.filter((f) => f.rel.startsWith("data/catalysts/earnings-history/"));
  assert.deepEqual(
    loose.map((f) => f.rel).slice(0, 5),
    [],
    `Loose earnings-history snapshots are back in the bundle (${loose.length} files, ` +
      `${mb(loose.reduce((a, f) => a + f.size, 0))} MB). They must stay .vercelignore'd and ship ` +
      `via data/catalysts/earnings-history.tar.gz.`,
  );
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, "data/catalysts/earnings-history.tar.gz")),
    "data/catalysts/earnings-history.tar.gz is missing — run: bash scripts/pack-earnings-history.sh",
  );
  assert.ok(
    files.some((f) => f.rel === "data/catalysts/earnings-history.tar.gz"),
    "earnings-history.tar.gz exists but is not bundled — prod would serve an empty archive",
  );
});

check("the packed archive matches the loose snapshots byte-for-byte", () => {
  // Packing is a separate step from archiving, so the tarball can lag the
  // directory. Prod reads ONLY the tarball — a stale one silently serves
  // yesterday's predictions and pre-resolution verdicts with no other symptom.
  //
  // Comparing only the newest filename is NOT enough: resolve-earnings-actuals
  // rewrites `actual_verdict` inside OLD snapshots in place (and --re-resolve
  // re-checks up to 90 days back), so a manual resolver run committed without a
  // repack changes no filename at all. Equal-length verdicts like BEAT→MISS
  // don't even change the file size, so this hashes content.
  const looseDir = path.join(REPO_ROOT, "data/catalysts/earnings-history");
  const tarball = path.join(REPO_ROOT, "data/catalysts/earnings-history.tar.gz");
  if (!fs.existsSync(looseDir) || !fs.existsSync(tarball)) return;

  const digest = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

  const looseManifest = fs
    .readdirSync(looseDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => `${f} ${digest(fs.readFileSync(path.join(looseDir, f)))}`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eh-verify-"));
  let packedManifest;
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", scratch], { stdio: ["ignore", "ignore", "pipe"] });
    const packedDir = path.join(scratch, "earnings-history");
    packedManifest = fs
      .readdirSync(packedDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .map((f) => `${f} ${digest(fs.readFileSync(path.join(packedDir, f)))}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const looseSet = new Set(looseManifest);
  const packedSet = new Set(packedManifest);
  const missing = looseManifest.filter((e) => !packedSet.has(e));
  const extra = packedManifest.filter((e) => !looseSet.has(e));

  assert.ok(
    missing.length === 0 && extra.length === 0,
    `earnings-history.tar.gz is out of sync with the loose snapshots. Prod reads the tarball only.\n` +
      (missing.length ? `      stale or absent in the tarball: ${missing.slice(0, 5).join(", ")}\n` : "") +
      (extra.length ? `      in the tarball but not on disk: ${extra.slice(0, 5).join(", ")}\n` : "") +
      `      Re-pack: bash scripts/pack-earnings-history.sh`,
  );
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
