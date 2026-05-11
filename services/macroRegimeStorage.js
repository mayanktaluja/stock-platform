/**
 * Macro Regime Storage Adapter
 *
 * Vercel KV (prod) → file (dev) — same pattern as watchlistStorage.js.
 *
 * Why this exists: Vercel runs N serverless instances each with its own
 * NodeCache. Without a shared store, every cold-started instance independently
 * tries to classify on first request, all hit Groq's TPD quota, and the user
 * sees a degraded banner from whichever instance won the race. KV gives every
 * instance a single shared view of the last good classification.
 *
 * Store shape: a single JSON-encoded regime object under the key `macro:regime`.
 *
 * File location: data/macroRegime.json — committed to git so Vercel cold starts
 * read the last good classification even when KV is unset (same pattern as
 * data/catalysts/*.json for NSE data that can't be fetched from Vercel IPs).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH = path.join(__dirname, "..", "data", "macroRegime.json");
const KV_KEY = "macro:regime";

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
  constructor() { this.name = "file"; }

  async read() {
    if (!existsSync(FILE_PATH)) return null;
    try {
      const parsed = JSON.parse(readFileSync(FILE_PATH, "utf-8"));
      return isUsableRegime(parsed) ? parsed : null;
    } catch { return null; }
  }

  async write(regime) {
    try {
      mkdirSync(path.dirname(FILE_PATH), { recursive: true });
      const tmp = `${FILE_PATH}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(regime), "utf-8");
      await import("node:fs").then((fs) => fs.renameSync(tmp, FILE_PATH));
    } catch (err) {
      console.warn("[MACRO:FILE] write failed:", err.message);
    }
  }
}

class KVMacroRegimeStorage {
  constructor() { this.name = "vercel-kv"; this._kv = null; }

  async _getKV() {
    if (this._kv) return this._kv;
    const mod = await import("@vercel/kv");
    this._kv = mod.kv;
    return this._kv;
  }

  async read() {
    try {
      const kv = await this._getKV();
      const raw = await kv.get(KV_KEY);
      if (!raw) return null;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return isUsableRegime(parsed) ? parsed : null;
    } catch (err) {
      console.warn("[MACRO:KV] read failed:", err.message);
      return null;
    }
  }

  async write(regime) {
    try {
      const kv = await this._getKV();
      await kv.set(KV_KEY, JSON.stringify(regime));
    } catch (err) {
      console.warn("[MACRO:KV] write failed:", err.message);
    }
  }
}

let _storage = null;

export function getMacroRegimeStorage() {
  if (_storage) return _storage;
  const hasKV = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
  _storage = hasKV ? new KVMacroRegimeStorage() : new FileMacroRegimeStorage();
  console.log(`[MACRO] Using ${_storage.name} storage`);
  return _storage;
}
