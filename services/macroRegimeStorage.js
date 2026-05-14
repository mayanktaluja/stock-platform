/**
 * Macro Regime Storage Adapter
 *
 * File-only: prod and dev both read data/macroRegime.json. The Vercel KV
 * branch that used to live here was structurally dead — same situation
 * fundamentals.js hit in PR #195 ("rip out dead Vercel KV path so prod
 * reads fresh disk"). KV had no callers that actually persist in prod:
 *
 *   - Vercel cron's /api/cron/warm-caches wrote to KV but Vercel's
 *     filesystem is read-only outside /tmp, so the disk write was a no-op
 *     and KV was the only sink — but KV_REST_API_URL was unset in prod,
 *     so the KV write itself was a no-op too.
 *   - In-process refreshMacroRegime() ran inside server.js's setInterval,
 *     but that interval only fires when app.listen() is reached (i.e. local
 *     dev). On Vercel, each function invocation is a fresh process — the
 *     interval has never executed a single tick in production.
 *
 * The canonical refresh path is now: scripts/refresh-macro-regime.mjs runs
 * locally via launchd (bundled into scripts/sws-nightly.sh at 02:00 and
 * 16:30 IST), writes data/macroRegime.json atomically, then sws-nightly
 * commits + opens a PR + auto-merges. Vercel reads fresh disk on the
 * next deploy. Same pattern as fundamentals + SWS picks.
 *
 * File location: data/macroRegime.json — bundled into the Vercel build via
 * vercel.json `includeFiles`, so cold starts read it directly.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = path.join(__dirname, "..", "data", "macroRegime.json");

// Reject regimes whose reasoning contains raw error text — these are
// poisoned by a prior bug (#106/#109) that wrote `Refresh failed: 429...`
// into the cache. Treat them as if no cache existed so we don't surface
// the error message to users.
const POISON_REASONING = /classifier error|refresh failed|rate limit reached/i;

function isUsableRegime(parsed) {
  if (!parsed || typeof parsed.regime !== "string" || !parsed.generatedAt) return false;
  if (POISON_REASONING.test(parsed.reasoning || "")) return false;
  return true;
}

class FileMacroRegimeStorage {
  constructor() { this.name = "file"; this._loggedMissing = false; }

  async read() {
    if (!existsSync(FILE_PATH)) {
      // Log once per process so prod logs reveal whether the committed
      // data/macroRegime.json made it into the Vercel bundle. Repeating
      // every read() call would flood logs.
      if (!this._loggedMissing) {
        console.warn(`[MACRO:FILE] cache file not found at ${FILE_PATH} — banner will rely on live classification or remain hidden`);
        this._loggedMissing = true;
      }
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(FILE_PATH, "utf-8"));
      if (!isUsableRegime(parsed)) {
        console.warn(`[MACRO:FILE] cache file at ${FILE_PATH} parsed but rejected as unusable (regime=${parsed?.regime}, generatedAt=${parsed?.generatedAt})`);
        return null;
      }
      return parsed;
    } catch (err) {
      console.warn(`[MACRO:FILE] read failed at ${FILE_PATH}: ${err.message}`);
      return null;
    }
  }

  async write(regime) {
    // Best-effort: this only succeeds in local dev (Vercel filesystem is
    // read-only outside /tmp). The canonical write path is the standalone
    // script + commit, not this in-process write.
    //
    // No-op under NODE_ENV=test. The Playwright e2e harness boots a real
    // server, and any in-process refresh during a suite — notably the
    // cold-cache background refreshMacroRegime() in the portfolio endpoint
    // (server.js) — would otherwise rewrite the tracked data/macroRegime.json
    // mid-run and leave the working tree dirty. This is the single chokepoint
    // every in-process write funnels through, so guarding it here covers all
    // call sites. The canonical refresh (scripts/refresh-macro-regime.mjs)
    // writes via its own writeAtomic(), not this adapter, so it is unaffected.
    if (process.env.NODE_ENV === "test") return;
    try {
      mkdirSync(path.dirname(FILE_PATH), { recursive: true });
      const tmp = `${FILE_PATH}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(regime), "utf-8");
      renameSync(tmp, FILE_PATH);
    } catch (err) {
      console.warn("[MACRO:FILE] write failed:", err.message);
    }
  }
}

let _storage = null;

export function getMacroRegimeStorage() {
  if (_storage) return _storage;
  _storage = new FileMacroRegimeStorage();
  console.log(`[MACRO] Using ${_storage.name} storage`);
  return _storage;
}
