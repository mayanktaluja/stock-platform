// Tier-2 technicals reader (Two-Key Entry PR-4). Loads the sidecar written by
// scripts/sws-enrich-technicals.mjs and exposes a per-ticker lookup with a
// freshness gate. FAILS OPEN at every layer: missing file / malformed JSON /
// absent ticker / stale entry all return null — the caller degrades that ticker
// to the Tier-1 returns-proxy, never poisons a plan with stale indicators.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, "..", "..", "data", "technicals", "indicators-latest.json");
const DEFAULT_MAX_AGE_HOURS = 96;

let _cache = null; // { filePath, indicators }

// Same normalization as portfolioDividendService: strip exchange suffix, uppercase.
export function normalizeTicker(ticker) {
  return String(ticker || "")
    .trim()
    .toUpperCase()
    .replace(/\.(NS|BO|BSE)$/i, "");
}

export function loadTechnicals({ filePath = DEFAULT_PATH } = {}) {
  if (_cache && _cache.filePath === filePath) return _cache.indicators;
  let indicators = null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (raw && typeof raw.indicators === "object") indicators = raw.indicators;
  } catch {
    indicators = null; // missing or malformed → fail open
  }
  _cache = { filePath, indicators };
  return indicators;
}

loadTechnicals.reset = () => {
  _cache = null;
};

export function getTechnicals(ticker, { filePath = DEFAULT_PATH, maxAgeHours = DEFAULT_MAX_AGE_HOURS, now = Date.now() } = {}) {
  const indicators = loadTechnicals({ filePath });
  if (!indicators) return null;
  const entry = indicators[normalizeTicker(ticker)];
  if (!entry || typeof entry !== "object") return null;
  const asOf = Date.parse(entry.as_of || "");
  if (!Number.isFinite(asOf) || now - asOf > maxAgeHours * 3600 * 1000) return null; // stale → Tier-1
  return entry;
}
