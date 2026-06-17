#!/usr/bin/env node
/**
 * Surveillance smoke test — verifies the NSE ASM/GSM fetcher produces the
 * shape the scorer + staleness banner expect. Run this from an Indian-IP
 * machine before trusting the nightly refresh.
 *
 * Usage:
 *   node scripts/smoke-surveillance.mjs
 *
 * Success criteria (prints PASS/FAIL):
 *   • buildSurveillance() returns a well-formed { fetchedAt, flagged, counts }
 *   • fetchedAt is a valid ISO timestamp
 *   • flagged is an object; every entry has a .NS key and list ∈ {ASM, GSM}
 *   • counts.ASM / counts.GSM are non-negative integers
 *   • ASM and GSM endpoint fetches both completed
 *   • NSE's raw GSM shape parses to GSM rows when the endpoint returns rows
 *   • all-empty snapshots fail for local/nightly use
 *
 * buildSurveillance() is defensive — NSE fetch failures are caught and yield
 * an empty list. For smoke/nightly use, that is not publishable: an all-empty
 * result usually means NSE schema drift or a session-cookie problem.
 */

import { nseGet } from "../nse.js";
import { buildSurveillance, _surveillanceParserForTests } from "../surveillance.js";

async function main() {
  console.log("Smoke-testing NSE surveillance (ASM + GSM) fetch:\n");

  const snap = await buildSurveillance();
  let fail = 0;
  const check = (name, cond) => {
    console.log(`  ${cond ? "✓" : "✗"} ${name}`);
    if (!cond) fail++;
  };

  check("returns an object", snap && typeof snap === "object");
  check(
    "fetchedAt is a valid ISO timestamp",
    !!snap.fetchedAt && Number.isFinite(new Date(snap.fetchedAt).getTime()),
  );
  check("flagged is an object", !!snap.flagged && typeof snap.flagged === "object");
  check("counts.ASM is a non-negative integer", Number.isInteger(snap.counts?.ASM) && snap.counts.ASM >= 0);
  check("counts.GSM is a non-negative integer", Number.isInteger(snap.counts?.GSM) && snap.counts.GSM >= 0);
  check("ASM endpoint fetch completed", snap.fetchStatus?.ASM === "ok");
  check("GSM endpoint fetch completed", snap.fetchStatus?.GSM === "ok");

  const entries = Object.entries(snap.flagged || {});
  check("snapshot is not all-empty", entries.length > 0);

  const badEntry = entries.find(
    ([sym, e]) => !sym.endsWith(".NS") || !["ASM", "GSM"].includes(e.list),
  );
  check("every flagged entry has a .NS key and list ∈ {ASM,GSM}", !badEntry);

  let rawGsmRows = null;
  let parsedGsmRows = null;
  try {
    const rawGsm = await nseGet("/api/reportGSM");
    rawGsmRows = Array.isArray(rawGsm) ? rawGsm : Array.isArray(rawGsm?.data) ? rawGsm.data : [];
    parsedGsmRows = _surveillanceParserForTests.parseGsmRows(rawGsm);
  } catch (err) {
    console.warn(`\n  GSM raw endpoint check failed: ${err.message}`);
  }
  check("raw GSM endpoint is readable for parser parity", rawGsmRows != null);
  check(
    "GSM parser emits rows when NSE returns GSM rows",
    rawGsmRows == null || rawGsmRows.length === 0 || parsedGsmRows.length > 0,
  );
  check(
    "snapshot keeps GSM rows when NSE returns GSM rows",
    rawGsmRows == null || rawGsmRows.length === 0 || (snap.counts?.GSM || 0) > 0,
  );

  console.log("\n──────────────");
  console.log(
    `Summary: ${entries.length} flagged (ASM: ${snap.counts?.ASM ?? 0}, ` +
      `GSM: ${snap.counts?.GSM ?? 0}), ${fail} check(s) failed`,
  );

  if (entries.length === 0) {
    console.error(
      "\nZero stocks flagged. On an Indian IP this usually means NSE schema " +
        "drift or a session-cookie problem (nse.js:refreshCookies) — not genuinely " +
        "zero surveillance. A nightly must not publish this snapshot.",
    );
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
