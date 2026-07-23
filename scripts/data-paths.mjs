/**
 * Canonical definition of what counts as a DATA path for push scoping.
 *
 * The pre-push hook uses this to decide whether a push is pure-data (and so can
 * be gated by a fast integrity check) or contains code (and must run the full
 * `npm test` suite). See .githooks/pre-push and scripts/validate-data-push.mjs.
 *
 * SECURITY: classification is purely LEXICAL on the repo-relative path produced
 * by `git diff --name-only`. It never inspects file contents. That is what makes
 * the guarantee auditable — no code change can ride along on a "data" push,
 * because no code path is on the list. `test/dataPathAllowlist.test.mjs` asserts
 * that no code-extension file exists under the allow-listed prefixes, so the
 * property cannot rot silently if someone adds one later.
 *
 * DEPENDENCY-FREE by design: imports nothing beyond node builtins, so it still
 * resolves in a git worktree that has no node_modules.
 */

/** Directory prefixes whose entire subtree is data. */
export const PUSH_DATA_PREFIXES = ["data/"];

/** Root-level files that are generated data artifacts, not source. */
export const PUSH_DATA_FILES = [
  "fundamentals.json",
  "surveillance.json",
  "governance.json",
  "fundamentalsHistory.json",
];

/**
 * Paths that LOOK like data but must never take the fast path.
 *
 * A .gitignore under data/ is not itself data — editing one changes which files
 * FUTURE pushes carry, so it deserves the full suite.
 */
export const PUSH_DATA_DENY_SUFFIXES = [".gitignore"];

/**
 * The 9 paths scripts/sws-nightly.sh ships in its degraded "data-only" mode
 * (nightly_data_only_paths at :1142-1152, duplicated as DATA_FILES at :1287-1298).
 * Mirrored here so test/dataPathAllowlist.test.mjs can assert the bash arrays and
 * this module have not drifted apart.
 */
export const DATA_ONLY_SHIP_PATHS = [
  "data/catalysts/",
  "data/nse-fo/oi-deltas-latest.json",
  "data/macroCalendar.json",
  "data/sws/nightly-timings-latest.json",
  "data/nse-index-constituents.json",
  "fundamentals.json",
  "surveillance.json",
  "governance.json",
  "fundamentalsHistory.json",
];

/** Extensions that indicate executable code — must never appear under a data prefix. */
export const CODE_EXTENSIONS = [
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".sh", ".bash", ".zsh", ".py", ".rb",
  ".yml", ".yaml",
];

/** Binary/compressed payloads: integrity-checked by existence only, never scanned. */
export const BINARY_EXTENSIONS = [".gz", ".tgz", ".zip", ".pdf", ".png", ".jpg", ".jpeg", ".webp"];

/**
 * Is this repo-relative path a data artifact safe to ship without the full suite?
 *
 * Rejects absolute paths and any form of traversal outright — a path we cannot
 * reason about lexically is never classified as data.
 */
export function isDataPushPath(p) {
  if (typeof p !== "string") return false;
  const rel = p.trim();
  if (!rel) return false;
  if (rel.startsWith("/") || rel.startsWith("~")) return false;
  if (rel.split("/").some((seg) => seg === "..")) return false;
  if (PUSH_DATA_DENY_SUFFIXES.some((suf) => rel.endsWith(suf))) return false;
  if (CODE_EXTENSIONS.some((ext) => rel.toLowerCase().endsWith(ext))) return false;
  if (PUSH_DATA_FILES.includes(rel)) return true;
  return PUSH_DATA_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

export function isBinaryDataPath(p) {
  return BINARY_EXTENSIONS.some((ext) => String(p).toLowerCase().endsWith(ext));
}

// CLI: `node scripts/data-paths.mjs --list data-only`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const which = process.argv[process.argv.indexOf("--list") + 1];
  if (process.argv.includes("--list")) {
    const rows = which === "data-only" ? DATA_ONLY_SHIP_PATHS : [...PUSH_DATA_PREFIXES, ...PUSH_DATA_FILES];
    console.log(rows.join("\n"));
  }
}
