#!/usr/bin/env node
// PR 3 verification — runs the conviction engine in v1 / v2-shadow /
// v2-primary modes (each in its own subprocess so the recommender-mode
// module reads the env fresh) and prints the v1→v2 action diff plus
// sample v2 narratives. Doubles as the divergence monitor for the
// shadow-rollout phase.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, "_smoke-conviction-worker.mjs");

function run(mode) {
  const r = spawnSync(process.execPath, [WORKER], {
    env: { ...process.env, RECOMMENDER_VERSION: mode },
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    console.error("worker failed", r.stderr);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

const v1 = run("v1");
const shadow = run("v2-shadow");
const primary = run("v2-primary");

console.log("\n=== v1 vs v2 action diff ===\n");
console.log(["TICKER", "v1", "v2", "CONV", "Δnet", "SHIFT"]
  .map((c, i) => c.padEnd(i === 1 || i === 2 ? 17 : 9)).join(""));
console.log("─".repeat(80));
let shifts = 0;
for (let i = 0; i < shadow.length; i++) {
  const sh = shadow[i];
  const vp = primary[i];
  const v1Action = v1[i].action;
  const v2Action = vp.action;
  const rec = sh.v2rec;
  const cells = [
    sh.symbol.padEnd(9),
    (v1Action || "—").padEnd(17),
    (v2Action || "—").padEnd(17),
    (rec?.conviction || "—").padEnd(9),
    `${rec?.net_delta ?? "—"}`.padEnd(9),
    v1Action !== v2Action ? "← shifted" : "",
  ];
  if (v1Action !== v2Action) shifts++;
  console.log(cells.join(""));
}

console.log("\n=== Aggregate ===");
console.log(`Holdings           : ${shadow.length}`);
console.log(`Action shifts v1→v2: ${shifts}`);
const convCounts = {};
for (const r of shadow) {
  const c = r.v2rec?.conviction || "n/a";
  convCounts[c] = (convCounts[c] || 0) + 1;
}
console.log(`Conviction mix     :`);
for (const [c, n] of Object.entries(convCounts).sort()) console.log(`  ${c.padEnd(13)} ${n}`);

console.log("\n=== Sample v2 narratives (first 5 shifted) ===\n");
let shown = 0;
for (let i = 0; i < shadow.length && shown < 5; i++) {
  if (v1[i].action === primary[i].action) continue;
  const rec = shadow[i].v2rec;
  if (!rec) continue;
  console.log(`▸ ${shadow[i].symbol}  v1=${v1[i].action}  →  v2=${primary[i].action}  (${rec.conviction})`);
  for (const p of rec.narrative_paragraphs || []) console.log(`   ${p}`);
  console.log(`   ${rec.counter_thesis}`);
  console.log(`   ${rec.falsification_trigger}`);
  console.log("");
  shown++;
}
