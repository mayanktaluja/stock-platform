/**
 * OpenAI Budget Ceiling — Circuit Breaker
 *
 * Phase 2 addition. After universe expansion from 116 → 500 stocks, the
 * per-scan LLM token spend grows ~5×. A hard monthly cap prevents a bug
 * (cache miss storm, infinite retry loop, runaway macro polling) from
 * blowing the personal-use OpenAI quota.
 *
 * Budget: $20 USD / calendar month. Once tripped, callers receive
 * `shouldSkipLLM: true` and must fall back to keyword classifier (for
 * sentiment) or cached regime (for macro). The breaker resets at the
 * start of the next calendar month.
 *
 * Token pricing used (conservative for OpenAI gpt-5.4 tier):
 *   Input:  $1.00 / 1M tokens
 *   Output: $4.00 / 1M tokens
 *
 * Persistence: single JSON file at project root. Simple on purpose —
 * this is a safety rail, not an accounting system.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUDGET_FILE = path.join(__dirname, ".openai-budget.json");
const MONTHLY_CAP_USD = parseFloat(process.env.OPENAI_MONTHLY_CAP_USD || "20");
const INPUT_PRICE_PER_MTOK = 1.00;
const OUTPUT_PRICE_PER_MTOK = 4.00;

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function loadState() {
  try {
    if (!existsSync(BUDGET_FILE)) return { month: currentMonthKey(), usd: 0, calls: 0 };
    const raw = readFileSync(BUDGET_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    // Month rollover: reset on first access in a new month
    if (parsed.month !== currentMonthKey()) {
      return { month: currentMonthKey(), usd: 0, calls: 0, previousMonth: parsed };
    }
    return parsed;
  } catch {
    return { month: currentMonthKey(), usd: 0, calls: 0 };
  }
}

function saveState(state) {
  try {
    // Atomic write: tmp + rename
    const tmp = BUDGET_FILE + `.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf-8");
    // Use fs.renameSync lazily to avoid another import at top
    import("fs").then(({ renameSync }) => {
      try { renameSync(tmp, BUDGET_FILE); } catch { /* best-effort */ }
    });
  } catch {
    // Budget tracking is best-effort — never let it throw and break a call
  }
}

/**
 * Check the breaker BEFORE making an LLM call.
 * Returns { allowed, spent, cap, remaining } — when allowed=false the
 * caller should use fallback logic.
 */
export function checkBudget() {
  const state = loadState();
  const allowed = state.usd < MONTHLY_CAP_USD;
  return {
    allowed,
    spent: state.usd,
    cap: MONTHLY_CAP_USD,
    remaining: Math.max(0, MONTHLY_CAP_USD - state.usd),
    month: state.month,
  };
}

/**
 * Record token usage AFTER an LLM call completes. Call this from the
 * response handler of every OpenAI call (sentiment + macro).
 */
export function recordUsage({ inputTokens = 0, outputTokens = 0, label = "" } = {}) {
  const cost = (inputTokens / 1_000_000) * INPUT_PRICE_PER_MTOK
             + (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_MTOK;
  if (!Number.isFinite(cost) || cost <= 0) return;

  const state = loadState();
  state.usd += cost;
  state.calls = (state.calls || 0) + 1;
  if (!state.byLabel) state.byLabel = {};
  if (label) {
    state.byLabel[label] = (state.byLabel[label] || 0) + cost;
  }
  saveState(state);

  // Warn at 80% — lets us notice before the breaker trips
  if (state.usd >= MONTHLY_CAP_USD * 0.8 && state.usd - cost < MONTHLY_CAP_USD * 0.8) {
    console.warn(`[BUDGET] OpenAI monthly spend passed 80% of cap ($${MONTHLY_CAP_USD}) — currently $${state.usd.toFixed(4)}`);
  }
  if (state.usd >= MONTHLY_CAP_USD && state.usd - cost < MONTHLY_CAP_USD) {
    console.error(`[BUDGET] OpenAI monthly cap HIT — $${state.usd.toFixed(4)} / $${MONTHLY_CAP_USD}. LLM calls will fall back to keyword classifier until next month.`);
  }
}

/**
 * Expose current state for an ops endpoint or CLI.
 */
export function getBudgetSnapshot() {
  return loadState();
}
