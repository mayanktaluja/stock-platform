#!/usr/bin/env node
// READ-ONLY preview of the relative FV-upside block vs the legacy absolute band.
// Loads the scored universe, builds the benchmark, and prints how the FV-upside
// points (and the resulting v3 score, if only this component were swapped) would
// change. Writes NOTHING — production picks-latest.json and the live score are
// untouched.
//
//   node scripts/preview-fv-upside-relative.mjs [path-to-universe.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFvUpsideBenchmark,
  relativeFvPoints,
  DEFAULT_K,
  DEFAULT_MICRO_CAP_FLOOR_INR,
} from "../services/scoring/fvUpsideRelative.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.argv[2] || path.join(ROOT, "data/sws/sws-scored-universe.json");

// Legacy absolute band (services/swsScoring.js:305) — reconstructed from upside
// so we can subtract it from the baked-in v3 score.
const oldBand = (u) =>
  u == null ? 6 : u >= 30 ? 12 : u >= 15 ? 9 : u >= 0 ? 6 : u >= -10 ? 3 : 0;
const verdict = (s) =>
  s >= 60 ? "TOP_PICK" : s >= 45 ? "STRONG" : s >= 30 ? "ACCEPTABLE" : s >= 22 ? "WATCH" : "AVOID";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (x) => Math.round(x * 10) / 10;
const pad = (s, n) => String(s).padStart(n);
const padE = (s, n) => String(s).padEnd(n);

const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
const universe = Array.isArray(raw) ? raw : Object.values(raw).find((v) => Array.isArray(v));
console.log(`\nUniverse: ${universe.length} stocks  (${path.relative(ROOT, FILE)})`);

const benchmark = buildFvUpsideBenchmark(universe);
const medianUpside = Math.exp(benchmark.median_slog) - 1;
console.log(
  `\nBenchmark (>= ₹${DEFAULT_MICRO_CAP_FLOOR_INR / 1e7}cr, K=${DEFAULT_K}):` +
    `\n  n=${benchmark.n}  median upside≈${r1(medianUpside)}%  median_slog=${r1(benchmark.median_slog)}  ` +
    `robust_sigma=${r1(benchmark.robust_sigma)}  degenerate=${benchmark.degenerate}`,
);

// Reference ladder — intuition for the shape.
console.log("\nReference ladder (upside% -> points of 12):");
console.log("  upside |  old band |  new (relative)");
for (const u of [-50, -30, -10, 0, medianUpside, 30, 50, 100, 150, 300]) {
  const nu = u === medianUpside ? `${r1(u)}*` : String(r1(u));
  console.log(`  ${pad(nu, 6)} |  ${pad(oldBand(u), 8)} |  ${pad(r1(relativeFvPoints(u, benchmark).pts), 8)}`);
}
console.log("  (* = benchmark median upside → neutral 6)");

// Per-stock impact.
let moved = 0, up = 0, down = 0, sumAbs = 0, flips = 0, floorN = 0;
const rows = [];
const newPtsAll = [];
for (const s of universe) {
  const u = typeof s.upside_pct === "number" && Number.isFinite(s.upside_pct) ? s.upside_pct : null;
  const v3 = typeof s.v3_score_100 === "number" ? s.v3_score_100 : null;
  const oldPts = oldBand(u);
  const newPts = relativeFvPoints(u, benchmark).pts;
  newPtsAll.push(newPts);
  if (newPts <= 0.01) floorN++;
  const delta = newPts - oldPts;
  const shadow = v3 == null ? null : clamp(v3 - oldPts + newPts, 0, 100);
  if (v3 != null) {
    const d = shadow - v3;
    if (Math.abs(d) >= 0.05) { moved++; sumAbs += Math.abs(d); d > 0 ? up++ : down++; }
    if (verdict(shadow) !== (s.v3_verdict || verdict(v3))) flips++;
  }
  rows.push({
    t: s.ticker || s.symbol, u, oldPts, newPts, delta,
    v3, shadow, fromV: s.v3_verdict || (v3 != null ? verdict(v3) : "?"),
    toV: shadow != null ? verdict(shadow) : "?",
  });
}

// New-points distribution.
const sorted = [...newPtsAll].sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
console.log("\nNew FV-upside points distribution (all stocks):");
console.log(
  `  floored@0: ${floorN} (${r1((100 * floorN) / sorted.length)}%)   ` +
    `p10=${r1(q(0.1))}  p25=${r1(q(0.25))}  median=${r1(q(0.5))}  p75=${r1(q(0.75))}  p90=${r1(q(0.9))}  max=${r1(sorted[sorted.length - 1])}`,
);

console.log("\nScore impact (if ONLY the FV-upside component were swapped):");
console.log(`  scored stocks: ${rows.filter((r) => r.v3 != null).length}`);
console.log(`  moved: ${moved}  (up ${up} / down ${down})   mean |Δscore|: ${r1(sumAbs / Math.max(1, moved))}   verdict flips: ${flips}`);

const table = (title, list) => {
  console.log(`\n${title}`);
  console.log(`  ${padE("ticker", 14)} ${pad("upside%", 8)} ${pad("old", 5)} ${pad("new", 6)} ${pad("Δpts", 6)} ${pad("v3", 6)} ${pad("shadow", 7)}  verdict`);
  for (const r of list) {
    console.log(
      `  ${padE(r.t || "?", 14)} ${pad(r.u == null ? "—" : r1(r.u), 8)} ${pad(r1(r.oldPts), 5)} ${pad(r1(r.newPts), 6)} ` +
        `${pad((r.delta >= 0 ? "+" : "") + r1(r.delta), 6)} ${pad(r.v3 == null ? "—" : r1(r.v3), 6)} ${pad(r.shadow == null ? "—" : r1(r.shadow), 7)}  ` +
        `${r.fromV}${r.fromV !== r.toV ? " -> " + r.toV : ""}`,
    );
  }
};

const withU = rows.filter((r) => r.u != null);
table("Biggest gainers (high-upside names the old band capped at 12):",
  [...withU].sort((a, b) => b.delta - a.delta).slice(0, 12));
table("Biggest losers (low/negative-upside names):",
  [...withU].sort((a, b) => a.delta - b.delta).slice(0, 12));

const watch = ["RELIANCE", "TCS", "HDFCBANK", "SBIN", "INFY", "ITC", "BHARTIARTL", "LT"];
const byT = (t) => rows.find((r) => (r.t || "").toUpperCase().replace(/\.(NS|BO|BSE)$/, "") === t);
table("Bellwether large-caps:", watch.map(byT).filter(Boolean));

console.log("\n(read-only preview — no files written)\n");
