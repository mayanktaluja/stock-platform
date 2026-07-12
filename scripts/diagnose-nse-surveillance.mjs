#!/usr/bin/env node
/**
 * NSE surveillance diagnostic — a verbose, read-only probe of every strategy
 * the surveillance feed can use, meant to be run FROM AN INDIAN-IP MACHINE
 * (the Mac) when the nightly reports a surveillance failure.
 *
 * Unlike smoke-surveillance.mjs (a terse PASS/FAIL gate), this prints the raw
 * evidence needed to see WHY the /api/reportASM + /api/reportGSM endpoints
 * broke and whether the REG_IND CSV fallback is healthy — including the real
 * REG_IND header row, so a header drift can be fixed fast.
 *
 * It writes nothing (never touches surveillance.json).
 *
 * Usage:
 *   node scripts/diagnose-nse-surveillance.mjs
 */

import { nseGetDetailed } from "../nse.js";
import { buildSurveillance } from "../surveillance.js";
import {
  buildRegIndUrl,
  fetchRegIndCsv,
  parseRegIndCsv,
} from "../services/surveillanceRegindFetcher.js";

const NSE_BASE = "https://www.nseindia.com";

function head(s, n = 200) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").slice(0, n);
}

async function probeApi(path, label, referer) {
  const r = await nseGetDetailed(path, referer);
  let rowNote = "";
  if (r.ok) {
    const d = r.data;
    const n = Array.isArray(d) ? d.length
      : Array.isArray(d?.data) ? d.data.length
      : Array.isArray(d?.longterm?.data) || Array.isArray(d?.shortterm?.data)
        ? (d.longterm?.data?.length || 0) + (d.shortterm?.data?.length || 0)
        : "?";
    rowNote = ` rows≈${n}`;
  }
  console.log(
    `    [${label}] ok=${r.ok} status=${r.status ?? "-"} ` +
    `class=${r.errorClass ?? "-"} attempt=${r.attempt ?? "-"}${rowNote}` +
    (r.error ? ` error="${r.error}"` : ""),
  );
  return r;
}

async function main() {
  const results = {}; // strategy → ok

  // ── 1. API endpoints × referer ──
  console.log("\n1. NSE report API endpoints (/api/reportASM, /api/reportGSM)\n");
  for (const [path, list] of [["/api/reportASM", "ASM"], ["/api/reportGSM", "GSM"]]) {
    console.log(`  ${path}`);
    const rReports = await probeApi(path, "reports-referer", `${NSE_BASE}/reports/${list.toLowerCase()}`);
    const rDefault = await probeApi(path, "default-referer", undefined);
    results[`api-${list}`] = rReports.ok || rDefault.ok;
  }

  // ── 2. REG_IND CSV walk-back ──
  console.log("\n2. REG_IND consolidated surveillance CSV (nsearchives fallback)\n");
  console.log(`  today's candidate URL: ${buildRegIndUrl(new Date())}`);
  const reg = await fetchRegIndCsv({});
  for (const a of reg.attempts) {
    console.log(`    ${a.date}  status=${a.status ?? "-"}  ${a.reason}${a.error ? `  (${a.error})` : ""}`);
  }
  results["regind-csv"] = reg.ok;
  if (reg.ok) {
    const parsed = parseRegIndCsv(reg.csv);
    console.log(`\n  served date: ${reg.dateUsed}`);
    console.log(`  HEADER: ${head(parsed.header.join(","), 400)}`);
    console.log(`  detected columns: ${JSON.stringify(parsed.columns)}`);
    const asm = parsed.records.filter((r) => r.asmLtStage || r.asmStStage).length;
    const gsm = parsed.records.filter((r) => r.gsmStage).length;
    console.log(`  parsed ${parsed.records.length} rows · flagged ASM=${asm} GSM=${gsm}`);
    if (parsed.error) console.log(`  ⚠ parser note: ${parsed.error}`);
    for (const r of parsed.records.filter((x) => x.asmLtStage || x.asmStStage || x.gsmStage).slice(0, 3)) {
      console.log(`    sample: ${JSON.stringify(r)}`);
    }
    results["regind-csv"] = parsed.records.length > 0;
  } else {
    console.log(`\n  REG_IND unavailable: ${reg.error}`);
  }

  // ── 3. End-to-end buildSurveillance ──
  console.log("\n3. End-to-end buildSurveillance()\n");
  const snap = await buildSurveillance();
  console.log(`  fetchStatus: ${JSON.stringify(snap.fetchStatus)}`);
  console.log(`  sources:     ${JSON.stringify(snap.sources)}`);
  console.log(`  counts:      ${JSON.stringify(snap.counts)}`);
  if (snap.regind) console.log(`  regind:      ${JSON.stringify(snap.regind)}`);
  if (snap.fetchErrors) console.log(`  fetchErrors: ${JSON.stringify(snap.fetchErrors)}`);
  const e2eOk = snap.fetchStatus?.ASM === "ok" && snap.fetchStatus?.GSM === "ok";
  results["end-to-end"] = e2eOk;

  // ── 4. Summary ──
  console.log("\n──────────────  strategy summary  ──────────────");
  for (const [k, ok] of Object.entries(results)) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${k}`);
  }
  console.log("");
  process.exit(e2eOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Diagnostic crashed:", err);
  process.exit(1);
});
