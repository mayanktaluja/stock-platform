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
 * data/sws-us/deep/*.json stays out of the deployment, but each
 * committed regional deep tarball must be uploaded and included so
 * /api/us-stock can lazy-extract the deep brief on demand.
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
    entry && typeof entry.includeFiles === "string",
    "vercel.json functions['api/index.js'].includeFiles must be a single glob string",
  );
  return entry.includeFiles;
}

function loadFunctionConfig(pathname) {
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "vercel.json"), "utf-8"));
  return (vercel.functions || {})[pathname];
}

function loadExcludeFilesRaw() {
  const entry = loadFunctionConfig("api/index.js");
  assert.ok(
    entry && typeof entry.excludeFiles === "string",
    "vercel.json functions['api/index.js'].excludeFiles must be a single glob string",
  );
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
  if (Array.isArray(glob)) {
    return glob
      .map((p) => String(p).trim())
      .filter(Boolean)
      .flatMap(expandBraces);
  }
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

function readJsonFromTarball(tarball, member) {
  const raw = execSync(`tar -xOzf "${tarball}" "${member}"`, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

const REQUIRED_ROOT_FIXTURES = [
  "fundamentals.json",
  "fundamentalsHistory.json",
  "governance.json",
  "surveillance.json",
];

const REQUIRED_NESTED_RUNTIME_FILES = [
  "data/sws/chronos-forecast-latest.json",
  "data/sws/chronos-forecast-health.json",
  "data/sws/discovery-feed-latest.json",
  "data/sectorOutlook/outlook-latest.json",
  "data/nse-fo/oi-deltas-latest.json",
  "data/risk-lab/picks-adjusted-latest.json",
  "data/risk-lab/quality-flags-latest.json",
  "data/risk-lab/macro-thesis-latest.json",
  "data/risk-lab/_quality-keywords.json",
  "data/risk-lab/_sector-overlays.json",
  "data/strategy/multibagger-scores-latest.json",
  "data/strategy/catalyst-slate-latest.json",
  "data/strategy/multibagger-health-latest.json",
  "data/strategy/multibagger-portfolio.json",
  "data/disclosures/holdings.json",
  "data/sws/alerts/fundamental-changes-latest.json",
  "data/track-record/section-performance-latest.json",
];

const LOCAL_ONLY_GENERATED_WORKSETS = [
  "data/sws/deep/20MICRONS.json",
  "data/sws-us/deep/AAPL.json",
  "data/sws/chronos-ohlcv-cache/JSLL.NS.json",
  "data/sws/chronos-model-cache/model.bin",
  "data/sws/chronos-debug/JSLL.json",
  "data/sws/groww-stock-latest.json",
  "data/sectorOutlook/classified-news/RELIANCE.jsonl",
  "data/sectorOutlook/llm-theme-cache.json",
  "data/nse-fo/history/RELIANCE.json",
  "data/risk-lab/llm-disagreement-cache.json",
  "data/strategy/history/2026-06-01.json",
  "data/strategy/decisions.ndjson",
  "data/sws/alerts/input-signatures-latest.json",
  "data/sws/alerts/input-alert-confirmation-state.json",
  "data/catalysts/llm-signal-cache.json",
  "data/catalysts/earnings-history/2026-07-26.json",
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
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    assert.ok(
      String(entry).length <= 256,
      `excludeFiles entry is ${String(entry).length} chars; keep each Vercel glob/path compact.`,
    );
  }
  assert.ok(!isExcluded("data/sws/deep.tar.gz"), "India deep.tar.gz must stay bundled for lazy /tmp extraction");
  assert.ok(!isExcluded("data/sws-us/deep-us.tar.gz"), "US deep tarball must stay bundled for lazy /tmp extraction");
  assert.ok(isExcluded("data/sws/deep/20MICRONS.json"), "loose India deep files should be excluded from Lambda trace bloat");
  assert.ok(isExcluded("data/sws-us/deep/AAPL.json"), "loose US deep files should be excluded from Lambda trace bloat");
  assert.ok(isExcluded("data/sws/chronos-ohlcv-cache/JSLL.NS.json"), "Chronos OHLCV cache should be excluded from Lambda trace bloat");
  assert.ok(!isExcluded("data/sws/chronos-forecast-latest.json"), "Chronos forecast latest must stay bundled");
  assert.ok(!isExcluded("data/sws/chronos-forecast-health.json"), "Chronos forecast health must stay bundled");
  assert.ok(!isExcluded("data/sws-us/picks-latest.json"), "regional picks must stay bundled");
  assert.ok(isExcluded("test/e2e/stock-detail-modal.spec.mjs"), "tests should not be traced into the production Lambda");
});

check(".vercelignore excludes loose SWS deep artifacts but keeps packed deep tarballs", () => {
  for (const pattern of [
    "data/sws/deep/**",
    "data/sws-us/deep/**",
    "data/sws/chronos-ohlcv-cache/**",
    "data/sws/chronos-model-cache/**",
    "data/sws/chronos-debug/**",
    "**/__pycache__/**",
    "**/*.pyc",
    "data/sectorOutlook/classified-news/**",
    "data/nse-fo/history/**",
  ]) {
    assert.ok(ignoredPatterns.includes(pattern), `${pattern} must be excluded from Vercel source uploads`);
  }
  assert.ok(isIgnored("data/sws/deep/20MICRONS.json"), "loose India deep files must not be uploaded to Vercel");
  assert.ok(isIgnored("data/sws-us/deep/AAPL.json"), "loose US deep files must not be uploaded to Vercel");
  assert.ok(!isIgnored("data/sws/deep.tar.gz"), "India deep tarball must remain deployable");
  assert.ok(!isIgnored("data/sws/chronos-forecast-latest.json"), "Chronos forecast latest must remain deployable");
  assert.ok(isIgnored("data/sws/chronos-debug/JSLL.json"), "Chronos debug traces must not be uploaded");
  // input-signatures + input-alert-confirmation-state are the LOCAL input-diff
  // builder's working set (21.2 MB). Prod reads only the diff's output below.
  assert.ok(isIgnored("data/sws/alerts/input-signatures-latest.json"), "SWS input signatures are a local-only workset");
  assert.ok(isIgnored("data/sws/alerts/input-alert-confirmation-state.json"), "SWS confirmation state is a local-only workset");
  assert.ok(!isIgnored("data/sws/alerts/fundamental-changes-latest.json"), "SWS input changes must remain deployable");
  assert.ok(!isIgnored("data/sws-us/deep-us.tar.gz"), "US deep tarball must remain deployable");
  assert.ok(isIgnored("data/sectorOutlook/classified-news/RELIANCE.jsonl"), "classified-news cache must not be uploaded");
  assert.ok(isIgnored("data/nse-fo/history/RELIANCE.json"), "F&O rolling history cache must not be uploaded");
});

check("discovery sanity: found the market deep tarballs + regional picks (else git/glob is broken)", () => {
  assert.ok(required.includes("data/sws/deep.tar.gz"), "India deep.tar.gz not discovered");
  assert.ok(required.includes("data/sws-us/deep-us.tar.gz"), "US deep-us.tar.gz not discovered");
  assert.ok(required.includes("data/sws-us/picks-latest.json"), "US picks-latest.json not discovered");
  assert.ok(required.length >= 4, `expected ≥4 required artifacts (market tarballs + picks), found ${required.length}`);
});

check("the glob matcher discriminates (covers sws tarballs, rejects unrelated paths)", () => {
  // Sanity-check the matcher itself so a broken globToRegExp (e.g. one that
  // collapses to /.*/  ) can't silently mask a real coverage gap.
  assert.ok(isCovered("data/sws/deep.tar.gz"), "matcher failed on a pattern that IS present");
  assert.ok(isCovered("data/sws-us/deep-us.tar.gz"), "US deep tarball must be bundled");
  // ...but broad runtime directories must still be trimmed by excludeFiles.
  assert.ok(
    isCovered("data/nse-fo/history/RELIANCE.json") && isExcluded("data/nse-fo/history/RELIANCE.json"),
    "F&O history can match a broad include glob only if excludeFiles trims it from the function bundle",
  );
  // And it must NOT match paths outside the include globs.
  assert.ok(!isCovered("package.json"), "matcher must NOT match an unlisted root file");
});

check("nested runtime snapshots served by API routes are in includeFiles", () => {
  const missing = REQUIRED_NESTED_RUNTIME_FILES.filter((f) => !isCovered(f) || isExcluded(f));
  assert.deepEqual(
    missing,
    [],
    `Runtime file(s) missing from the Vercel function bundle or excluded:\n    ${missing.join("\n    ")}`,
  );
});

check("local-only generated worksets are excluded from the function bundle", () => {
  const bundled = LOCAL_ONLY_GENERATED_WORKSETS.filter((f) => isCovered(f) && !isExcluded(f) && !isIgnored(f));
  assert.deepEqual(
    bundled,
    [],
    `Local cache file(s) still bundled or uploaded into prod:\n    ${bundled.join("\n    ")}`,
  );
});

check("EVERY committed deep tarball + regional picks-latest.json is in includeFiles", () => {
  const missing = required.filter((f) => !isCovered(f));
  assert.deepEqual(
    missing,
    [],
    `Not bundled into the Vercel function (India modal/leaderboards will be blank on prod):\n    ${missing.join("\n    ")}\n  Add the artifact to vercel.json includeFiles.`,
  );
});

check("India deep tarball preserves Snowflake insufficient-data metadata canary", () => {
  const canary = readJsonFromTarball("data/sws/deep.tar.gz", "deep/UMESLTD.json");
  const dq = canary?.overview?.snowflake_data_quality;
  assert.equal(dq?.insufficient, true, "UMESLTD must preserve compact insufficient-data metadata");
  assert.equal(dq.insufficient_count, 10, "UMESLTD insufficient-data count drifted");
  assert.equal(dq.checked_count, 30, "UMESLTD checked-count contract drifted");
  assert.deepEqual(dq.affected_pillars, ["Value", "Future", "Dividends"]);
  const matrix = canary?.overview?.snowflake_check_matrix;
  assert.ok(Array.isArray(matrix?.checks), "UMESLTD must preserve the deployable Snowflake check matrix");
  assert.equal(matrix.checks.length, 30, "UMESLTD Snowflake matrix must include the 30 visible checks");
  assert.ok(
    matrix.checks.some((check) => check?.title === "PEG Ratio" && check.insufficient === true),
    "UMESLTD matrix must retain missing PEG Ratio evidence",
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
