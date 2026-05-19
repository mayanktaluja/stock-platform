// Decision audit log — append-only NDJSON of every buy / sell / trim /
// stop action taken by the 5x strategy. One JSON object per line.
//
// Lives at <cwd>/data/strategy/decisions.ndjson so it's portable across
// dev / prod (Vercel reads it; the nightly script writes it). Append is
// atomic (single `fs.appendFileSync`) — concurrent writers from
// different processes won't interleave bytes within a single record.
//
// Powers post-mortem learning + N3 audit-trail North Star. Every record
// is timestamped + carries score_snapshot + counter_thesis + macro_regime
// so we can replay the why-at-the-time when a stop hits.

import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = "decision-log-v1";
const VALID_ACTIONS = new Set(["ENTRY", "TRIM", "EXIT_STOP", "EXIT_TARGET", "EXIT_FAILSAFE", "EXIT_TIMEOUT"]);

function defaultPath() {
  return path.join(process.cwd(), "data", "strategy", "decisions.ndjson");
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Required fields: ts, action, symbol, tier, qty, price_inr.
// Optional: score_snapshot, counter_thesis, macro_regime, pre_mortem,
// stop_price_inr, target_price_inr, notes.
export function logDecision(record, opts = {}) {
  if (!record || typeof record !== "object") {
    throw new Error("logDecision: record must be an object");
  }
  if (!VALID_ACTIONS.has(record.action)) {
    throw new Error(`logDecision: invalid action "${record.action}" — must be one of ${Array.from(VALID_ACTIONS).join(", ")}`);
  }
  if (!record.symbol || typeof record.symbol !== "string") {
    throw new Error("logDecision: symbol required");
  }
  if (!record.tier || typeof record.tier !== "string") {
    throw new Error("logDecision: tier required");
  }
  if (!isFiniteNumber(record.qty) || record.qty <= 0) {
    throw new Error("logDecision: qty must be a positive number");
  }
  if (!isFiniteNumber(record.price_inr) || record.price_inr <= 0) {
    throw new Error("logDecision: price_inr must be a positive number");
  }

  const ts = record.ts || new Date().toISOString();
  const out = {
    schema_version: SCHEMA_VERSION,
    ts,
    action: record.action,
    symbol: record.symbol,
    tier: record.tier,
    qty: record.qty,
    price_inr: record.price_inr,
    notional_inr: Number((record.qty * record.price_inr).toFixed(2)),
    score_snapshot: record.score_snapshot ?? null,
    counter_thesis: record.counter_thesis ?? null,
    macro_regime: record.macro_regime ?? null,
    pre_mortem: record.pre_mortem ?? null,
    stop_price_inr: isFiniteNumber(record.stop_price_inr) ? record.stop_price_inr : null,
    target_price_inr: isFiniteNumber(record.target_price_inr) ? record.target_price_inr : null,
    notes: record.notes ? String(record.notes).slice(0, 500) : null,
  };

  const target = opts.path || defaultPath();
  ensureDir(target);
  fs.appendFileSync(target, JSON.stringify(out) + "\n", { encoding: "utf8" });
  return out;
}

export function readDecisions(opts = {}) {
  const target = opts.path || defaultPath();
  if (!fs.existsSync(target)) return [];
  const raw = fs.readFileSync(target, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); }
    catch { /* skip malformed lines */ }
  }
  return out;
}

export function decisionsForSymbol(symbol, opts = {}) {
  return readDecisions(opts).filter((d) => d.symbol === symbol);
}

export function decisionsSince(iso, opts = {}) {
  const threshold = new Date(iso).getTime();
  if (Number.isNaN(threshold)) return [];
  return readDecisions(opts).filter((d) => new Date(d.ts).getTime() >= threshold);
}

export const DECISION_LOG_CONFIG = Object.freeze({
  SCHEMA_VERSION,
  VALID_ACTIONS: Array.from(VALID_ACTIONS),
});
