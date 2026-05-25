/**
 * Guards the Vercel serverless bundle against a recurring prod-only bug:
 * regional SWS deep briefs are served by lazy-extracting a committed
 * `deep-<code>.tar.gz` via execSync('tar …') (usPicksDal.js / regionPicksDal.js /
 * swsDal/jsonBackend.js). @vercel/nft cannot trace a file referenced inside a
 * shell string, so every such tarball MUST be named in vercel.json's
 * `functions[].includeFiles` glob or it is silently omitted from the prod
 * bundle — the modal then renders only card-sourced sections and everything
 * from the deep brief (price, FV, snowflake, rewards, news…) goes blank.
 *
 * This happened to US Picks: India listed `data/sws/*.tar.gz` but the US/KR/TW
 * namespaces were never added. The symptom is invisible locally (the tarball is
 * on disk and `tar` works in dev), so only a deploy surfaces it. This test makes
 * the gap fail at `npm test` time instead, and auto-covers any future region.
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
  assert.ok(entry && typeof entry.includeFiles === "string", "vercel.json functions['api/index.js'].includeFiles must be a string");
  return entry.includeFiles;
}

function loadFunctionConfig(pathname) {
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf-8"));
  return (vercel.functions || {})[pathname];
}

// Split the brace-list into individual patterns. None of the patterns contain a
// comma, so a plain split is safe; tolerate an un-braced single pattern too.
function loadIncludePatterns() {
  let glob = loadIncludeFilesRaw().trim();
  if (glob.startsWith("{") && glob.endsWith("}")) glob = glob.slice(1, -1);
  return glob.split(",").map((p) => p.trim()).filter(Boolean);
}

// The committed (git-tracked) artifacts the prod runtime must be able to read:
// every region's deep tarball + its picks-latest.json. Discovered from git so a
// new region is covered automatically the moment its files are committed.
function requiredBundledFiles() {
  const out = execSync("git ls-files 'data/sws*'", { cwd: REPO_ROOT, encoding: "utf-8" });
  const tracked = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return tracked.filter(
    (p) => /(^|\/)deep[^/]*\.tar\.gz$/.test(p) || /\/picks-latest\.json$/.test(p),
  );
}

console.log("\nvercel.json includeFiles — regional deep tarballs + picks must be bundled\n");

const patterns = loadIncludePatterns();
const regexes = patterns.map(globToRegExp);
const required = requiredBundledFiles();
const isCovered = (file) => regexes.some((re) => re.test(file));

check("includeFiles stays within Vercel's 256-char schema limit", () => {
  const raw = loadIncludeFilesRaw();
  assert.ok(
    raw.length <= 256,
    `includeFiles is ${raw.length} chars; Vercel's vercel.json schema rejects >256. ` +
      `Consolidate patterns (e.g. data/sws*/*.json + data/sws*/*.tar.gz instead of one pair per region).`,
  );
});

check("framework auto-detection stays disabled so Vercel builds only api/index.js", () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf-8"));
  assert.equal(vercel.framework, null);
  assert.equal(loadFunctionConfig("server.js"), undefined);
});

check("discovery sanity: found the India + US deep tarballs (else git/glob is broken)", () => {
  assert.ok(required.includes("data/sws/deep.tar.gz"), "India deep.tar.gz not discovered");
  assert.ok(required.includes("data/sws-us/deep-us.tar.gz"), "US deep-us.tar.gz not discovered");
  assert.ok(required.length >= 4, `expected ≥4 required artifacts (≥2 tarballs + ≥2 picks), found ${required.length}`);
});

check("the glob matcher discriminates (covers sws tarballs, rejects unrelated paths)", () => {
  // Sanity-check the matcher itself so a broken globToRegExp (e.g. one that
  // collapses to /.*/  ) can't silently mask a real coverage gap.
  assert.ok(isCovered("data/sws/deep.tar.gz"), "matcher failed on a pattern that IS present");
  // data/sws*/*.tar.gz deliberately covers ANY sws-* namespace, so future
  // regions are bundled the moment they exist — no vercel.json edit needed.
  assert.ok(isCovered("data/sws-zz/deep-zz.tar.gz"), "data/sws*/*.tar.gz should cover any sws-* namespace");
  // …but it must NOT match paths outside the include globs.
  assert.ok(!isCovered("data/nse-fo/history/RELIANCE.json"), "matcher must NOT match a deep, unrelated data path");
  assert.ok(!isCovered("package.json"), "matcher must NOT match an unlisted root file");
});

check("EVERY committed regional deep tarball + picks-latest.json is in includeFiles", () => {
  const missing = required.filter((f) => !isCovered(f));
  assert.deepEqual(
    missing,
    [],
    `Not bundled into the Vercel function (modal/leaderboard will be blank on prod):\n    ${missing.join("\n    ")}\n  Add the namespace to vercel.json includeFiles (e.g. data/<dir>/*.json,data/<dir>/*.tar.gz).`,
  );
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
