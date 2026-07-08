/**
 * Near-duplicate story gate for the Telegram alert path.
 *
 * The existing sent-ledger dedups on an EXACT normalized-text hash, so the same
 * wire reworded by a second channel ("Fed cuts rates" vs "Fed lowers rates")
 * arrives twice. This gate reuses the Market Wire's clusterer — the same
 * token-set Jaccard brain — to collapse those near-dups before they reach
 * Telegram.
 *
 * Design notes:
 *  - The wire BUFFER is written BEFORE this gate runs, so the website still sees
 *    every copy and can render an honest "3 sources" corroboration chip. Only the
 *    *Telegram send* is suppressed. One brain, two surfaces, different policies.
 *  - Stories are recorded only AFTER a confirmed delivery (never claim-before-send),
 *    so a suppressed/failed send can't permanently swallow a story.
 *  - Fails OPEN: any I/O or parse error yields "not a duplicate", i.e. the alert
 *    goes out. A rare duplicate beats a silently-lost alert (same posture as
 *    sentLedger).
 *  - Daily NDJSON files at the canonical ALERTS_LEDGER_DIR, so a throwaway
 *    worktree can't orphan them. The read window is minutes, so the file stays small.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import path from "path";
import { ledgerDir } from "./sentLedger.js";
import { normalizeTokens, jaccard } from "../newsWire/wireClusterer.js";

export const DEFAULT_WINDOW_MS = 45 * 60 * 1000; // "the same news cycle"
export const DEFAULT_THRESHOLD = 0.6; // stricter than the wire's 0.5 — suppressing a send is costlier than merging a card

function dateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10); // UTC
}

function storyFile(dir, ms) {
  return path.join(dir, `recent-stories-${dateKey(ms)}.ndjson`);
}

/** Recent stories inside the window: [{ key, ts, tokens:Set }]. Fails open with []. */
export function loadRecentStories({ env = process.env, windowMs = DEFAULT_WINDOW_MS, now = Date.now(), dir = null } = {}) {
  const d = dir || ledgerDir(env);
  const cutoff = now - windowMs;
  const out = [];
  // Today's + yesterday's UTC file, so a window straddling UTC midnight isn't truncated.
  for (const ms of [now, now - 86400000]) {
    const f = storyFile(d, ms);
    if (!existsSync(f)) continue;
    try {
      for (const line of readFileSync(f, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (Number.isFinite(o?.ts) && o.ts >= cutoff && Array.isArray(o?.tokens)) {
            out.push({ key: o.key, ts: o.ts, tokens: new Set(o.tokens) });
          }
        } catch { /* skip corrupt line */ }
      }
    } catch { /* unreadable → fail open */ }
  }
  return out;
}

/**
 * Best Jaccard match against the recent window.
 * → { matched, key, similarity }.  matched=false on empty/failed input (fail open).
 */
export function findNearDup(tokens, recent, threshold = DEFAULT_THRESHOLD) {
  const miss = { matched: false, key: null, similarity: 0 };
  if (!tokens || tokens.size === 0 || !Array.isArray(recent) || recent.length === 0) return miss;
  let bestKey = null;
  let bestSim = 0;
  for (const r of recent) {
    const s = jaccard(tokens, r.tokens);
    if (s > bestSim) { bestSim = s; bestKey = r.key; }
  }
  return { matched: bestSim >= threshold, key: bestKey, similarity: bestSim };
}

/** Append a delivered story. Call ONLY after a confirmed send. Never throws. */
export function recordStory(key, tokens, { env = process.env, now = Date.now(), dir = null } = {}) {
  const d = dir || ledgerDir(env);
  try {
    mkdirSync(d, { recursive: true });
    appendFileSync(storyFile(d, now), JSON.stringify({ key, ts: now, tokens: [...tokens] }) + "\n", "utf-8");
    return { recorded: true };
  } catch {
    return { recorded: false };
  }
}

/** Drop story files older than keepDays. Never throws. */
export function pruneRecentStories({ env = process.env, now = Date.now(), keepDays = 2, dir = null } = {}) {
  const d = dir || ledgerDir(env);
  if (!existsSync(d)) return { pruned: [] };
  const cutoffKey = dateKey(now - keepDays * 86400000);
  const pruned = [];
  let entries;
  try { entries = readdirSync(d); } catch { return { pruned: [] }; }
  for (const f of entries) {
    const m = f.match(/^recent-stories-(\d{4}-\d{2}-\d{2})\.ndjson$/);
    if (!m) continue;
    if (m[1] < cutoffKey) {
      try { unlinkSync(path.join(d, f)); pruned.push(f); } catch { /* best effort */ }
    }
  }
  return { pruned };
}

/** Convenience: tokenize once at the call site. */
export { normalizeTokens };

export default { loadRecentStories, findNearDup, recordStory, pruneRecentStories, normalizeTokens, DEFAULT_WINDOW_MS, DEFAULT_THRESHOLD };
