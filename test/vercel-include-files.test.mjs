/**
 * Guards the Vercel serverless bundle against two recurring prod-only bugs:
 * India SWS deep briefs are served by lazy-extracting the committed
 * `data/sws/deep.tar.gz` via execSync('tar …') (swsDal/jsonBackend.js).
 * @vercel/nft cannot trace a file referenced inside a shell string, so that
 * tarball MUST be named in vercel.json's `functions[].includeFiles` glob or the
 * India modal renders only card-sourced sections and everything from the deep
 * brief (price, FV, snowflake, rewards, news…) goes blank.
 *
 * Regional market modals use the same packed-deep contract now: loose
 * data/sws-{us,kr,tw}/deep/*.json stays out of the deployment, but each
 * committed regional deep tarball must be uploaded and included so
 * /api/{us,kr,tw}-stock can lazy-extract the deep brief on demand.
 *
 * The symptom is invisible locally (the tarballs are on disk and `tar` works in
 * dev), so only a deploy surfaces it. This test makes the contract fail at
 * `npm test` time instead.
 *
 * Run with: node test/vercel-include-files.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

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
// `*` matches within a path segment, `**` matches across segments.
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

// Read the raw includeFiles glob string from vercel.json.
function loadIncludeFilesRaw() {
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf-8"));
  const entry = (vercel.functions || {})["api/index.js"];
  assert.ok(
    entry && (typeof entry.includeFiles === "string" || Array.isArray(entry.includeFiles)),
    "vercel.json functions['api/index.js'].includeFiles must be a string or array",
  );
  return entry.includeFiles;
}

function loadFunctionConfig(pathname) {
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf-8"));
  return (vercel.functions || {})[pathname];
}

function loadExcludeFilesRaw() {
  const entry = loadFunctionConfig("api/index.js");
  assert.ok(entry && typeof entry.excludeFiles === "string", "vercel.json functions['api/index.js'].excludeFiles must be a string");
  return entry.excludeFiles;
}

function loadVercelIgnorePatterns() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, ".vercelignore"), "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
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

// Split the outer brace-list into individual patterns, then expand compact
// nested brace groups used to keep vercel.json under the 256-char schema limit.
function splitBraceGlob(glob) {
  if (Array.isArray(glob)) return glob.map((p) => String(p).trim()).filter(Boolean);
  glob = String(glob || "").trim();
  if (glob.startsWith("{") && glob.endsWith("}")) glob = glob.slice(1, -1);
  return splitTopLevelComma(glob).flatMap(expandBraces).filter(Boolean);
}

function loadIncludePatterns() {
  return splitBraceGlob(loadIncludeFilesRaw()).map((p) => p.replace(/^\.\.\//, ""));
}

function loadExcludePatterns() {
  return splitBraceGlob(loadExcludeFilesRaw()).map((p) => p.replace(/^\.\.\//, ""));
}

// The committed (git-tracked) artifacts the prod runtime must be able to read:
// every market's picks-latest.json plus every packed deep tarball. Discovered
// from git so a new region is covered automatically the moment its files are
// committed.
function requiredBundledFiles() {
  const out = execSync("git ls-files 'data/sws*'", { cwd: REPO_ROOT, encoding: "utf-8" });
  const tracked = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return tracked.filter(
    (p) => /\/deep(?:-[a-z]+)?\.tar\.gz$/.test(p) || /\/picks-latest\.json$/.test(p),
  );
}

const REQUIRED_ROOT_FIXTURES = [
  "fundamentals.json",
  "fundamentalsHistory.json",
  "governance.json",
  "surveillance.json",
];

console.log("\nvercel.json includeFiles — market deep tarballs + regional picks must be bundled\n");

const patterns = loadIncludePatterns();
const regexes = patterns.map(globToRegExp);
const excludePatterns = loadExcludePatterns();
const excludeRegexes = excludePatterns.map(globToRegExp);
const required = requiredBundledFiles();
const isCovered = (file) => regexes.some((re) => re.test(file));
const isExcluded = (file) => excludeRegexes.some((re) => re.test(file));
const ignoredPatterns = loadVercelIgnorePatterns();
const ignoredRegexes = ignoredPatterns.map(globToRegExp);
const isIgnored = (file) => ignoredRegexes.some((re) => re.test(file));

check("includeFiles stays within Vercel's 256-char schema limit", () => {
  const raw = loadIncludeFilesRaw();
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    assert.ok(
      String(entry).length <= 256,
      `includeFiles entry is ${String(entry).length} chars; keep each Vercel glob/path compact.`,
    );
  }
});

check("framework auto-detection stays disabled so Vercel builds only api/index.js", () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf-8"));
  assert.equal(vercel.framework, null);
  assert.equal(loadFunctionConfig("server.js"), undefined);
});

check("excludeFiles trims non-runtime trace bloat without hiding packed deep briefs", () => {
  const raw = loadExcludeFilesRaw();
  assert.ok(
    raw.length <= 256,
    `excludeFiles is ${raw.length} chars; keep the brace-list compact enough for Vercel's schema.`,
  );
  assert.ok(!isExcluded("data/sws/deep.tar.gz"), "India deep.tar.gz must stay bundled for lazy /tmp extraction");
  assert.ok(!isExcluded("data/sws-us/deep-us.tar.gz"), "US deep tarball must stay bundled for lazy /tmp extraction");
  assert.ok(!isExcluded("data/sws-kr/deep-kr.tar.gz"), "KR deep tarball must stay bundled for lazy /tmp extraction");
  assert.ok(!isExcluded("data/sws-tw/deep-tw.tar.gz"), "TW deep tarball must stay bundled for lazy /tmp extraction");
  assert.ok(isExcluded("data/sws/deep/20MICRONS.json"), "loose India deep files should be excluded from Lambda trace bloat");
  assert.ok(isExcluded("data/sws-us/deep/AAPL.json"), "loose US deep files should be excluded from Lambda trace bloat");
  assert.ok(!isExcluded("data/sws-us/picks-latest.json"), "regional picks must stay bundled");
  assert.ok(isExcluded("test/e2e/stock-detail-modal.spec.mjs"), "tests should not be traced into the production Lambda");
});

check(".vercelignore excludes loose SWS deep artifacts but keeps packed deep tarballs", () => {
  for (const pattern of [
    "data/sws/deep/**",
    "data/sws-us/deep/**",
    "data/sws-kr/deep/**",
    "data/sws-tw/deep/**",
  ]) {
    assert.ok(ignoredPatterns.includes(pattern), `${pattern} must be excluded from Vercel source uploads`);
  }
  assert.ok(isIgnored("data/sws/deep/20MICRONS.json"), "loose India deep files must not be uploaded to Vercel");
  assert.ok(isIgnored("data/sws-us/deep/AAPL.json"), "loose US deep files must not be uploaded to Vercel");
  assert.ok(!isIgnored("data/sws/deep.tar.gz"), "India deep tarball must remain deployable");
  assert.ok(!isIgnored("data/sws-us/deep-us.tar.gz"), "US deep tarball must remain deployable");
  assert.ok(!isIgnored("data/sws-kr/deep-kr.tar.gz"), "KR deep tarball must remain deployable");
  assert.ok(!isIgnored("data/sws-tw/deep-tw.tar.gz"), "TW deep tarball must remain deployable");
});

check("discovery sanity: found the market deep tarballs + regional picks (else git/glob is broken)", () => {
  assert.ok(required.includes("data/sws/deep.tar.gz"), "India deep.tar.gz not discovered");
  assert.ok(required.includes("data/sws-us/deep-us.tar.gz"), "US deep-us.tar.gz not discovered");
  assert.ok(required.includes("data/sws-kr/deep-kr.tar.gz"), "KR deep-kr.tar.gz not discovered");
  assert.ok(required.includes("data/sws-tw/deep-tw.tar.gz"), "TW deep-tw.tar.gz not discovered");
  assert.ok(required.includes("data/sws-us/picks-latest.json"), "US picks-latest.json not discovered");
  assert.ok(required.length >= 8, `expected ≥8 required artifacts (market tarballs + ≥4 picks), found ${required.length}`);
});

check("the glob matcher discriminates (covers sws tarballs, rejects unrelated paths)", () => {
  // Sanity-check the matcher itself so a broken globToRegExp (e.g. one that
  // collapses to /.*/  ) can't silently mask a real coverage gap.
  assert.ok(isCovered("data/sws/deep.tar.gz"), "matcher failed on a pattern that IS present");
  assert.ok(isCovered("data/sws-us/deep-us.tar.gz"), "US deep tarball must be bundled");
  assert.ok(isCovered("data/sws-kr/deep-kr.tar.gz"), "KR deep tarball must be bundled");
  assert.ok(isCovered("data/sws-tw/deep-tw.tar.gz"), "TW deep tarball must be bundled");
  // …but it must NOT match paths outside the include globs.
  assert.ok(!isCovered("data/nse-fo/history/RELIANCE.json"), "matcher must NOT match a deep, unrelated data path");
  assert.ok(!isCovered("package.json"), "matcher must NOT match an unlisted root file");
});

check("EVERY committed deep tarball + regional picks-latest.json is in includeFiles", () => {
  const missing = required.filter((f) => !isCovered(f));
  assert.deepEqual(
    missing,
    [],
    `Not bundled into the Vercel function (India modal/leaderboards will be blank on prod):\n    ${missing.join("\n    ")}\n  Add the artifact to vercel.json includeFiles.`,
  );
});

check("root runtime fixtures used by health/scoring are in includeFiles", () => {
  const missing = REQUIRED_ROOT_FIXTURES.filter((f) => !isCovered(f));
  assert.deepEqual(
    missing,
    [],
    `Root runtime fixture(s) missing from the Vercel function bundle:\n    ${missing.join("\n    ")}`,
  );
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
