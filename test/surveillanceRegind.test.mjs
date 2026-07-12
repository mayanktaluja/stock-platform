/**
 * services/surveillanceRegindFetcher.js — REG_IND CSV fallback fetcher/parser.
 *
 * The fallback for NSE's broken /api/reportASM + /api/reportGSM endpoints
 * reads the daily consolidated surveillance CSV from nsearchives. This suite
 * pins: URL date formatting, header-driven parsing (incl. drifted headers),
 * unflagged sentinels, quoted-comma names, and the trading-day walk-back with
 * an injected fetch (no live network).
 *
 * Run with: node test/surveillanceRegind.test.mjs
 */

import assert from "node:assert/strict";

import {
  buildRegIndUrl,
  parseRegIndCsv,
  fetchRegIndCsv,
} from "../services/surveillanceRegindFetcher.js";

let pass = 0;
let fail = 0;
async function it(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  ✓", name);
  } catch (err) {
    fail++;
    console.log("  ✗", name, "\n   ", err && err.message);
  }
}

// Build a fake Response like the fetcher expects (ok/status/text).
function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

console.log("\nsurveillanceRegindFetcher — URL + parser\n");

await it("buildRegIndUrl formats DDMMYY with zero-padding", () => {
  assert.equal(
    buildRegIndUrl("2026-04-20"),
    "https://nsearchives.nseindia.com/content/cm/REG_IND200426.csv",
  );
  assert.equal(
    buildRegIndUrl({ y: 2026, m: 7, d: 3 }),
    "https://nsearchives.nseindia.com/content/cm/REG_IND030726.csv",
  );
});

await it("parses a plausible header with LT/ST ASM + GSM, ignores ESM", () => {
  const csv = [
    "Symbol,Security Name,Series,GSM Stage,ASM Long Term Stage,ASM Short Term Stage,ESM Stage",
    'RELIANCE,"Reliance Industries Ltd, The",EQ,N.A.,N.A.,N.A.,N.A.',
    "ZEEL,Zee Entertainment,EQ,IV,1,N.A.,N.A.",
    "SUZLON,Suzlon Energy,EQ,N.A.,N.A.,2,3",
  ].join("\n");
  const { records, columns } = parseRegIndCsv(csv);
  assert.equal(records.length, 3);
  assert.ok(columns.gsm >= 0 && columns.asmLong >= 0 && columns.asmShort >= 0);

  const rel = records.find((r) => r.symbol === "RELIANCE");
  assert.equal(rel.gsmStage, null);
  assert.equal(rel.asmLtStage, null);
  assert.equal(rel.series, "EQ");

  const zee = records.find((r) => r.symbol === "ZEEL");
  assert.equal(zee.gsmStage, "IV");
  assert.equal(zee.asmLtStage, "1");
  assert.equal(zee.asmStStage, null);

  const suz = records.find((r) => r.symbol === "SUZLON");
  assert.equal(suz.asmStStage, "2");
  // ESM column must NOT leak into any surveillance field.
  assert.equal(suz.gsmStage, null);
  assert.equal(suz.asmLtStage, null);
});

await it("handles drifted headers (LT ASM / ST ASM / GSM)", () => {
  const csv = [
    "SYMBOL,SERIES,LT ASM,ST ASM,GSM",
    "ABC,EQ,2,-,VI",
  ].join("\n");
  const { records } = parseRegIndCsv(csv);
  assert.equal(records.length, 1);
  assert.equal(records[0].asmLtStage, "2");
  assert.equal(records[0].asmStStage, null); // "-" is unflagged
  assert.equal(records[0].gsmStage, "VI");
});

await it("a single combined ASM column maps to longterm", () => {
  const csv = ["Symbol,ASM Stage,GSM Stage", "XYZ,Stage 1,NA"].join("\n");
  const { records } = parseRegIndCsv(csv);
  assert.equal(records[0].asmLtStage, "Stage 1");
  assert.equal(records[0].asmStStage, null);
  assert.equal(records[0].gsmStage, null);
});

await it("hostile inputs → 0 records + error (never throws)", () => {
  assert.equal(parseRegIndCsv("<html>blocked</html>").records.length, 0);
  assert.ok(parseRegIndCsv("<html>").error);
  assert.equal(parseRegIndCsv("Series,Name\nEQ,foo").records.length, 0); // no Symbol column
  assert.ok(parseRegIndCsv("Series,Name\nEQ,foo").error);
  assert.equal(parseRegIndCsv("").records.length, 0);
});

console.log("\nsurveillanceRegindFetcher — walk-back fetch\n");

await it("today 404 → yesterday 200 sets dateUsed to the served day", async () => {
  const now = new Date("2026-07-10T05:00:00Z"); // 10:30 IST Fri
  let hits = 0;
  const fetchImpl = async (url) => {
    hits++;
    if (url.includes("REG_IND100726")) return res(404, "not found");
    if (url.includes("REG_IND090726")) return res(200, "Symbol,GSM Stage\nABC,IV");
    return res(404, "");
  };
  const out = await fetchRegIndCsv({ now, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.dateUsed, "2026-07-09");
  assert.ok(out.csv.includes("ABC,IV"));
  assert.equal(hits, 2);
});

await it("Saturday walk-back reaches Friday's file", async () => {
  const now = new Date("2026-07-11T09:00:00Z"); // 14:30 IST Sat
  const fetchImpl = async (url) => {
    if (url.includes("REG_IND100726")) return res(200, "Symbol,GSM Stage\nDEF,II"); // Fri 10th
    return res(404, "");
  };
  const out = await fetchRegIndCsv({ now, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.dateUsed, "2026-07-10");
});

await it("all 404 → ok:false with the full attempt trail", async () => {
  const now = new Date("2026-07-10T05:00:00Z");
  const fetchImpl = async () => res(404, "");
  const out = await fetchRegIndCsv({ now, fetchImpl, maxLookbackDays: 6 });
  assert.equal(out.ok, false);
  assert.equal(out.attempts.length, 7);
  assert.match(out.error, /not available/);
});

await it("403 is recorded as blocked and surfaced in the error", async () => {
  const now = new Date("2026-07-10T05:00:00Z");
  const fetchImpl = async () => res(403, "Access Denied");
  const out = await fetchRegIndCsv({ now, fetchImpl, maxLookbackDays: 1 });
  assert.equal(out.ok, false);
  assert.match(out.error, /blocked \(HTTP 403\)/);
  assert.equal(out.attempts[0].reason, "blocked");
});

await it("a 200 that is actually HTML is not accepted as data", async () => {
  const now = new Date("2026-07-10T05:00:00Z");
  let served = 0;
  const fetchImpl = async (url) => {
    served++;
    if (url.includes("REG_IND100726")) return res(200, "<html>error</html>");
    if (url.includes("REG_IND090726")) return res(200, "Symbol,GSM Stage\nGHI,V");
    return res(404, "");
  };
  const out = await fetchRegIndCsv({ now, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.dateUsed, "2026-07-09");
  assert.equal(out.attempts[0].reason, "not-published");
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
