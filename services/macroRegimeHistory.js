/**
 * Macro Regime History — append-only NDJSON snapshot writer.
 *
 * Foundation for the Risk Lab backtest: the live data/macroRegime.json is a
 * single snapshot that gets overwritten every 2h by the cron. To A/B compare
 * the lab's overlay against the original predictor on resolved earnings, we
 * need historical regimes joinable to past event dates.
 *
 * Design choices:
 *   - **Single-writer.** Only scripts/refresh-macro-regime.mjs calls this
 *     module. The macroRegimeStorage adapter's in-process write() does NOT
 *     append history — that path is best-effort and re-runs the same regime
 *     many times per process, which would bloat the history with duplicates.
 *   - **Dedup by content hash.** Only TRANSITIONS land. A regime that stays
 *     OIL_SHOCK sev3 across 12 refreshes writes one line, not twelve.
 *   - **Yearly rotation.** data/macroRegime-history-YYYY.jsonl. At ~10
 *     transitions/day worst case × 365 = 3650 lines/yr × ~500 bytes = ~1.8MB.
 *     Yearly rotation keeps any single file under 5MB even at peaks.
 *   - **Append-only NDJSON.** One JSON object per line, atomic append via fs
 *     positional write semantics. No daily files (the adversarial review
 *     flagged 8 snapshots/day × 365 × multiple years as repo bloat).
 *
 * Reads: the backtest joins (event_date → nearest-prior regime snapshot ≤
 * event_date 09:00 IST). Forward-only history; no retro-fills.
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HISTORY_DIR = path.join(__dirname, "..", "data", "macroRegime-history");

/**
 * Stable signature for a regime. Two regimes are "the same" (no transition)
 * iff their signatures match. Includes the fields a backtest would care
 * about — regime label, severity, the sectorImpacts array (order-independent),
 * and the LLM reasoning text (catches a classifier swap that emits the same
 * label but with different rationale).
 *
 * Excludes: generatedAt (always changes), sourceHealth + tierCoverage +
 * fallbacksUsed (operational noise), headlineCount (noisy).
 */
export function regimeContentHash(regime) {
  if (!regime || typeof regime.regime !== "string") return null;
  const sectorImpacts = Array.isArray(regime.sectorImpacts)
    ? [...regime.sectorImpacts]
        .map((s) => ({ sector: String(s.sector || ""), impact: Number(s.impact || 0) }))
        .sort((a, b) => a.sector.localeCompare(b.sector))
    : [];
  const stable = JSON.stringify({
    regime: regime.regime,
    severity: Number(regime.severity || 0),
    confidence: Math.round(Number(regime.confidence || 0) * 100) / 100,
    sectorImpacts,
    reasoning: String(regime.reasoning || "").slice(0, 300),
    classifierProvider: regime.classifierProvider || null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * Path to the NDJSON file for a given regime's year. Uses generatedAt if set;
 * falls back to today.
 */
export function historyFilePath(regime, historyDir = DEFAULT_HISTORY_DIR) {
  const date = regime?.generatedAt ? new Date(regime.generatedAt) : new Date();
  const year = isNaN(date.getTime()) ? new Date().getUTCFullYear() : date.getUTCFullYear();
  return path.join(historyDir, `${year}.jsonl`);
}

/**
 * Read the last NDJSON line from a file. Returns null if the file is missing
 * or empty.
 *
 * For files growing slowly (the worst case is ~10 lines/day = ~5KB/year if
 * lines were 500 bytes, but realistically far less because transitions are
 * rare), a full readFileSync + split is fine. We avoid the complexity of
 * seek-and-scan since the file will never grow beyond a few MB.
 */
export function readLastLine(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, "utf-8");
    const lines = text.trim().split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Append `regime` to its yearly history file IF the content hash differs
 * from the last appended entry. Returns:
 *   { appended: true, hash, path }   — wrote a new transition
 *   { appended: false, reason }      — no-op (same as last, missing, error)
 */
export function appendRegimeIfChanged(regime, opts = {}) {
  const historyDir = opts.historyDir || DEFAULT_HISTORY_DIR;
  if (!regime || typeof regime.regime !== "string") {
    return { appended: false, reason: "no_regime" };
  }
  const hash = regimeContentHash(regime);
  if (!hash) {
    return { appended: false, reason: "hash_failed" };
  }

  const filePath = historyFilePath(regime, historyDir);
  const last = readLastLine(filePath);
  const lastHash = last ? regimeContentHash(last) : null;

  if (lastHash === hash) {
    return { appended: false, reason: "unchanged", hash };
  }

  try {
    mkdirSync(historyDir, { recursive: true });
    appendFileSync(filePath, JSON.stringify(regime) + "\n", "utf-8");
    return { appended: true, hash, path: filePath };
  } catch (err) {
    return { appended: false, reason: `write_failed: ${err.message}` };
  }
}
