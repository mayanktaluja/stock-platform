#!/usr/bin/env node
/**
 * Market Wire builder (Phase 5) — reads the on-disk Telegram buffer, clusters +
 * triages + ranks the last N hours of messages, and publishes the ranked feed
 * to Vercel KV (news:wire:latest) for the Market Intelligence tab.
 *
 * The poller is the instant firehose; this is the digested, few-minute-refresh
 * consumption layer. Runs from the news-wire-build.sh wrapper (own PID lock,
 * origin/main worktree, NEWS_WIRE_DIR + --out + --cache pinned to canonical).
 *
 * Always exits 0.
 *   node scripts/refresh-news-wire.mjs                 # build + publish to KV
 *   node scripts/refresh-news-wire.mjs --skip-llm      # heuristic only (CI/offline)
 *   node scripts/refresh-news-wire.mjs --dry-run       # build + log, no mirror, no KV
 *   node scripts/refresh-news-wire.mjs --window-hours 6 --out <path> --cache <path>
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env"), override: false });

const { buildWire } = await import("../services/newsWire/wireBuilder.js");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const DRY_RUN = flag("--dry-run");
const SKIP_LLM = flag("--skip-llm");
const WINDOW_HOURS = Number(opt("--window-hours", "6")) || 6;
const OUT = opt("--out", undefined); // absolute mirror path (wrapper pins to canonical)
const CACHE = opt("--cache", undefined); // absolute cache path (wrapper pins to canonical)

async function main() {
  const { wire, stats } = await buildWire({
    windowHours: WINDOW_HOURS,
    skipLlm: SKIP_LLM,
    writeMirror: !DRY_RUN,
    publish: !DRY_RUN,
    ...(OUT ? { outPath: OUT } : {}),
    ...(CACHE ? { cachePath: CACHE } : {}),
  });
  const c = wire.counts;
  const pub = stats?.publish?.published ? "KV" : (stats?.publish?.reason || "no-publish");
  console.log(
    `[wire] window=${WINDOW_HOURS}h msgs=${c.messages} clusters=${c.clusters} items=${wire.items.length} ` +
    `llm_calls=${c.llm_calls} cache_hits=${c.cache_hits} heuristic=${c.heuristic} ` +
    `provider=${stats?.provider || "n/a"} publish=${DRY_RUN ? "dry-run" : pub}`,
  );
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.warn(`[wire] fatal (swallowed): ${err?.message || err}`);
  process.exit(0);
});
