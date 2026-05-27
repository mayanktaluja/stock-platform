/**
 * Regression tests for Track Record seed + overlay storage.
 *
 * Run with: node test/paperTradesStorage.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { filterPublicTrackTrades } from "../paperTrades.js";
import { FileStorage, MergedPaperTradeStorage, SeedStorage } from "../paperTradesStorage.js";

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
}

function trade(overrides) {
  return {
    id: overrides.id,
    dateKey: overrides.dateKey || "2026-05-01",
    type: overrides.type || "sws_top30_v3",
    symbol: overrides.symbol || "TEST.NS",
    name: overrides.name || "Test Ltd",
    snapshotAt: overrides.snapshotAt || "2026-05-01T04:00:00.000Z",
    priceAtSnapshot: overrides.priceAtSnapshot || 100,
    ...overrides,
  };
}

console.log("paperTradesStorage seed overlay regression\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "track-storage-"));
const seedPath = path.join(tmp, "seed.jsonl");
const overlayPath = path.join(tmp, "overlay.jsonl");

try {
  // ──── 1. Seed-only rows populate public reads while audit-only rows stay hidden ────
  {
    writeJsonl(seedPath, [
      trade({ id: "seed-public", type: "sws_top30_v3", symbol: "AAA.NS" }),
      trade({ id: "seed-audit", type: "sws_avoid", symbol: "BAD.NS" }),
    ]);
    const storage = new MergedPaperTradeStorage(new FileStorage(overlayPath), new SeedStorage(seedPath));
    const rows = await storage.readAll();
    const publicRows = filterPublicTrackTrades(rows);
    assert("seed rows are returned when overlay is empty", rows.length === 2, rows);
    assert("public filter keeps seed public row", publicRows.length === 1 && publicRows[0].id === "seed-public", publicRows);
  }

  // ──── 2. Overlay dedupes by id and wins over seed ────
  {
    writeJsonl(seedPath, [
      trade({ id: "same-id", type: "sws_top30_v3", symbol: "AAA.NS", priceAtSnapshot: 100 }),
      trade({ id: "seed-only", type: "sws_deep_value", symbol: "BBB.NS", priceAtSnapshot: 200 }),
    ]);
    writeJsonl(overlayPath, [
      trade({ id: "same-id", type: "sws_top30_v3", symbol: "AAA.NS", priceAtSnapshot: 111 }),
    ]);
    const storage = new MergedPaperTradeStorage(new FileStorage(overlayPath), new SeedStorage(seedPath));
    const rows = await storage.readAll();
    const same = rows.find((row) => row.id === "same-id");
    assert("merged read dedupes to two rows", rows.length === 2, rows.map((row) => row.id));
    assert("overlay row wins on id collision", same?.priceAtSnapshot === 111, same);
  }

  // ──── 3. updateById closes a seed-only row by writing a full overlay row ────
  {
    writeJsonl(seedPath, [
      trade({ id: "seed-close", type: "sws_quality_growth", symbol: "CCC.NS", priceAtSnapshot: 300 }),
    ]);
    fs.writeFileSync(overlayPath, "", "utf-8");
    const storage = new MergedPaperTradeStorage(new FileStorage(overlayPath), new SeedStorage(seedPath));
    const result = await storage.updateById([
      { id: "seed-close", closedAt: "2026-05-02T04:00:00.000Z", closingPrice: 330 },
    ]);
    const rows = await storage.readAll();
    const closed = rows.find((row) => row.id === "seed-close");
    const overlayRows = await new FileStorage(overlayPath).readAll();
    assert("seed-only update reports one updated row", result.updated === 1, result);
    assert("seed-only update writes one overlay replacement", overlayRows.length === 1, overlayRows);
    assert("overlay replacement wins on merged read", closed?.closingPrice === 330 && closed?.closedAt, closed);
  }

  // ──── 4. append dedup checks merged seed+overlay, not overlay only ────
  {
    writeJsonl(seedPath, [
      trade({ id: "already-seeded", type: "sws_midterm", symbol: "DDD.NS" }),
    ]);
    fs.writeFileSync(overlayPath, "", "utf-8");
    const storage = new MergedPaperTradeStorage(new FileStorage(overlayPath), new SeedStorage(seedPath));
    const result = await storage.append([
      trade({ id: "already-seeded", type: "sws_midterm", symbol: "DDD.NS" }),
      trade({ id: "new-overlay", type: "sws_midterm", symbol: "EEE.NS" }),
    ]);
    assert("append skips seed duplicate and writes new row", result.written === 1 && result.skipped === 1, result);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
