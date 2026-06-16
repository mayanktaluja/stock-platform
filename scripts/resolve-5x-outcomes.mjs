#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Json } from "../services/multibagger/multibaggerPitSnapshot.js";

export const OUTCOMES_SCHEMA_VERSION = "multibagger-outcomes-v1";
export const OUTCOME_INPUT_SCHEMA_VERSION = "multibagger-outcomes-input-v1";
export const OUTCOME_STATUSES = Object.freeze(["RESOLVED", "UNRESOLVED", "MISSING_PRICE", "DELISTED"]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function finiteNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tickerKey(v) {
  const s = String(v || "").trim().toUpperCase();
  return s || null;
}

function dateFromIso(v) {
  const s = String(v || "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function snapshotId(snapshot, row) {
  return snapshot?.snapshot_id || snapshot?.snapshot_iso || row?.snapshot_iso || snapshot?.date_iso || row?.snapshot_date_iso || null;
}

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function atomicWriteJson(target, obj) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

function candidateRows(snapshot) {
  if (Array.isArray(snapshot?.rows)) return snapshot.rows;
  if (Array.isArray(snapshot?.candidates)) return snapshot.candidates;
  return [];
}

export function flattenPitSnapshots(snapshots) {
  const out = [];
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    for (const row of candidateRows(snapshot)) {
      const sid = snapshotId(snapshot, row);
      out.push({
        snapshot,
        row,
        snapshot_id: sid,
        snapshot_iso: row?.snapshot_iso || snapshot?.snapshot_iso || sid || null,
        snapshot_date_iso: row?.snapshot_date_iso || snapshot?.snapshot_date_iso || dateFromIso(row?.snapshot_iso || snapshot?.snapshot_iso || sid),
      });
    }
  }
  return out;
}

function outcomeRows(input) {
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input.outcomes)) return input.outcomes;
  if (Array.isArray(input.prices)) return input.prices;
  if (Array.isArray(input.rows)) return input.rows;
  return [];
}

function normalizeStatus(inputRow, outcomePrice) {
  const raw = String(inputRow?.status || inputRow?.outcome_status || "").trim().toUpperCase();
  if (raw === "DELISTED" || inputRow?.delisted === true) return "DELISTED";
  if (raw === "MISSING_PRICE" || raw === "MISSING") return "MISSING_PRICE";
  if (raw === "UNRESOLVED" || raw === "PENDING") return "UNRESOLVED";
  if (raw === "RESOLVED") return isFiniteNumber(outcomePrice) ? "RESOLVED" : "MISSING_PRICE";
  return isFiniteNumber(outcomePrice) ? "RESOLVED" : "UNRESOLVED";
}

function outcomePrice(inputRow) {
  return finiteNumberOrNull(
    inputRow?.forward_365d_price_inr ??
    inputRow?.outcome_price_inr ??
    inputRow?.exit_price_inr ??
    inputRow?.price_inr
  );
}

function makeOutcomeIndex(input) {
  const byExact = new Map();
  const byDate = new Map();
  const byTickerOnly = new Map();
  for (const row of outcomeRows(input)) {
    const ticker = tickerKey(row?.ticker || row?.symbol);
    if (!ticker) continue;
    const price = outcomePrice(row);
    const normalized = {
      ...row,
      ticker,
      forward_365d_price_inr: price,
      status: normalizeStatus(row, price),
      outcome_hash: sha256Json(row),
    };
    const sid = row?.snapshot_id || row?.snapshot_iso;
    if (sid) byExact.set(`${sid}|${ticker}`, normalized);
    const d = row?.snapshot_date_iso || dateFromIso(row?.snapshot_iso || row?.snapshot_id);
    if (d) byDate.set(`${d}|${ticker}`, normalized);
    if (!sid && !d) byTickerOnly.set(ticker, normalized);
  }
  return { byExact, byDate, byTickerOnly };
}

function findOutcome(index, flatRow) {
  const ticker = tickerKey(flatRow?.row?.ticker || flatRow?.row?.symbol);
  if (!ticker) return { input: null, match_key: null };
  const exactKey = flatRow.snapshot_id ? `${flatRow.snapshot_id}|${ticker}` : null;
  if (exactKey && index.byExact.has(exactKey)) return { input: index.byExact.get(exactKey), match_key: "snapshot_id+ticker" };
  const dateKey = flatRow.snapshot_date_iso ? `${flatRow.snapshot_date_iso}|${ticker}` : null;
  if (dateKey && index.byDate.has(dateKey)) return { input: index.byDate.get(dateKey), match_key: "snapshot_date+ticker" };
  if (index.byTickerOnly.has(ticker)) return { input: index.byTickerOnly.get(ticker), match_key: "ticker_only" };
  return { input: null, match_key: null };
}

function resolveStatus({ input, entryPrice }) {
  if (!input) return { status: "UNRESOLVED", reason: "no_outcome_input" };
  if (input.status === "DELISTED") return { status: "DELISTED", reason: input.reason || "delisted" };
  if (input.status === "UNRESOLVED") return { status: "UNRESOLVED", reason: input.reason || "explicit_unresolved" };
  if (input.status === "MISSING_PRICE") return { status: "MISSING_PRICE", reason: input.reason || "explicit_missing_price" };
  if (!isFiniteNumber(entryPrice) || entryPrice <= 0) return { status: "MISSING_PRICE", reason: "missing_entry_price" };
  if (!isFiniteNumber(input.forward_365d_price_inr)) return { status: "MISSING_PRICE", reason: "missing_outcome_price" };
  return { status: "RESOLVED", reason: input.reason || null };
}

export function resolve5xOutcomes({ pit_snapshots = [], outcomes_input = null, built_at_iso = new Date().toISOString() } = {}) {
  const index = makeOutcomeIndex(outcomes_input);
  const rows = flattenPitSnapshots(pit_snapshots).map((flat) => {
    const row = flat.row || {};
    const ticker = tickerKey(row.ticker || row.symbol);
    const entryPrice = finiteNumberOrNull(row.entry_price_inr ?? row.current_price_inr);
    const { input, match_key } = findOutcome(index, flat);
    const status = resolveStatus({ input, entryPrice });
    const outcomePriceInr = input?.forward_365d_price_inr ?? null;
    const realizedMultiple = status.status === "RESOLVED" && isFiniteNumber(outcomePriceInr)
      ? Number((outcomePriceInr / entryPrice).toFixed(4))
      : null;
    const forwardReturnPct = realizedMultiple !== null ? Number(((realizedMultiple - 1) * 100).toFixed(1)) : null;
    return {
      schema_version: "multibagger-outcome-row-v1",
      snapshot_id: flat.snapshot_id,
      snapshot_iso: flat.snapshot_iso,
      snapshot_date_iso: flat.snapshot_date_iso,
      ticker,
      rank: finiteNumberOrNull(row.rank),
      verdict: row.verdict || null,
      score_0_100: finiteNumberOrNull(row.score_0_100),
      entry_price_inr: entryPrice,
      forward_365d_price_inr: status.status === "RESOLVED" ? outcomePriceInr : null,
      status: status.status,
      status_reason: status.reason,
      realized_multiple: realizedMultiple,
      forward_return_pct: forwardReturnPct,
      outcome_match_key: match_key,
      outcome_hash: input?.outcome_hash || null,
      candidate_hash: row.candidate_hash || null,
      source_hashes: row.source_hashes || flat.snapshot?.source_hashes || {},
    };
  });

  const status_counts = Object.fromEntries(OUTCOME_STATUSES.map((s) => [s, 0]));
  for (const row of rows) status_counts[row.status] = (status_counts[row.status] || 0) + 1;

  return {
    schema_version: OUTCOMES_SCHEMA_VERSION,
    built_at_iso,
    pit_snapshot_count: Array.isArray(pit_snapshots) ? pit_snapshots.length : 0,
    pit_row_count: rows.length,
    outcome_input_present: !!outcomes_input,
    outcome_input_hash: outcomes_input ? sha256Json(outcomes_input) : null,
    resolved_count: status_counts.RESOLVED,
    status_counts,
    rows,
  };
}

export function loadPitSnapshots(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return [];
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    const parsed = readJsonSafe(targetPath);
    return parsed ? [parsed] : [];
  }
  return fs.readdirSync(targetPath)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJsonSafe(path.join(targetPath, f)))
    .filter(Boolean);
}

export function readOutcomeInputs(inputPath) {
  return readJsonSafe(inputPath);
}

function parseArgs(argv) {
  const opts = {
    snapshots_dir: path.join(ROOT, "data", "strategy", "pit"),
    input: path.join(ROOT, "data", "strategy", "outcomes-input.json"),
    output: path.join(ROOT, "data", "strategy", "backtest-resolved.json"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--snapshots-dir") opts.snapshots_dir = path.resolve(argv[++i]);
    else if (arg === "--input") opts.input = path.resolve(argv[++i]);
    else if (arg === "--output") opts.output = path.resolve(argv[++i]);
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const pit_snapshots = loadPitSnapshots(opts.snapshots_dir);
  const outcomes_input = readOutcomeInputs(opts.input);
  const resolved = resolve5xOutcomes({ pit_snapshots, outcomes_input });
  atomicWriteJson(opts.output, resolved);
  console.log(`[5x-outcomes] snapshots=${resolved.pit_snapshot_count} rows=${resolved.pit_row_count} resolved=${resolved.resolved_count} output=${path.relative(ROOT, opts.output)}`);
  return resolved;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
