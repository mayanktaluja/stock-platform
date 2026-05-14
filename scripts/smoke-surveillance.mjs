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
 *
 * buildSurveillance() is defensive — NSE fetch failures are caught and yield
 * an empty list, so this never throws. But an all-empty result on an Indian
 * IP is a strong signal of NSE schema drift or a session-cookie problem,
 * which this surfaces as a warning.
 */

import { buildSurveillance } from "../surveillance.js";

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

  const entries = Object.entries(snap.flagged || {});
  const badEntry = entries.find(
    ([sym, e]) => !sym.endsWith(".NS") || !["ASM", "GSM"].includes(e.list),
  );
  check("every flagged entry has a .NS key and list ∈ {ASM,GSM}", !badEntry);

  console.log("\n──────────────");
  console.log(
    `Summary: ${entries.length} flagged (ASM: ${snap.counts?.ASM ?? 0}, ` +
      `GSM: ${snap.counts?.GSM ?? 0}), ${fail} check(s) failed`,
  );

  if (entries.length === 0) {
    console.warn(
      "\n⚠  Zero stocks flagged. On an Indian IP this usually means NSE schema " +
        "drift or a session-cookie problem (nse.js:refreshCookies) — not genuinely " +
        "zero surveillance. Verify before trusting a nightly that wrote an empty file.",
    );
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
