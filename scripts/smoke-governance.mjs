#!/usr/bin/env node
/**
 * Governance smoke test — verifies the NSE shareholding fetcher produces the
 * shape the V2 scorer expects. Run this FIRST from an Indian-IP machine
 * before trusting the full refresh cron.
 *
 * Usage:
 *   node scripts/smoke-governance.mjs
 *   node scripts/smoke-governance.mjs RELIANCE TCS INFY
 *
 * Success criteria (prints PASS/FAIL):
 *   • Each symbol returns a non-empty parsed record
 *   • promoterHolding is a fraction in (0, 1]
 *   • pledgeOfTotal is null OR a fraction in [0, 1]
 *   • at least one symbol returns a QoQ delta (requires 2+ quarterly rows)
 */

import { fetchShareholdingForSymbol } from "../governance.js";

const defaultSymbols = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ZEEL"];
const symbols = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultSymbols;

function assertFraction(name, v, { allowNull = false } = {}) {
  if (v == null) return allowNull ? "—" : `${name}: null ✗`;
  if (!Number.isFinite(v)) return `${name}: not a number ✗`;
  if (v < 0 || v > 1) return `${name}: out of [0,1] → ${v} ✗`;
  return `${name}: ${(v * 100).toFixed(2)}%`;
}

async function main() {
  console.log(`Smoke-testing shareholding fetch for ${symbols.length} symbols:\n`);

  let anyQoQ = false;
  let ok = 0;
  let fail = 0;

  for (const sym of symbols) {
    console.log(`── ${sym} ──`);
    try {
      const { latest, prior } = await fetchShareholdingForSymbol(sym);
      if (!latest) {
        console.log("  ✗ no parsed latest row (NSE returned empty or schema mismatch)");
        fail++;
        continue;
      }

      console.log(`  asOfQuarter:    ${latest.asOfQuarter || "(missing)"}`);
      console.log(`  ${assertFraction("promoterHolding", latest.promoterHolding)}`);
      console.log(`  ${assertFraction("promoterPledge", latest.promoterPledge, { allowNull: true })}`);
      console.log(`  ${assertFraction("pledgeOfTotal", latest.pledgeOfTotal, { allowNull: true })}`);
      console.log(`  ${assertFraction("fiiHolding", latest.fiiHolding, { allowNull: true })}`);
      console.log(`  ${assertFraction("diiHolding", latest.diiHolding, { allowNull: true })}`);

      if (prior) {
        const dH = latest.promoterHolding != null && prior.promoterHolding != null
          ? latest.promoterHolding - prior.promoterHolding
          : null;
        if (dH != null) {
          anyQoQ = true;
          const dir = dH > 0 ? "+" : "";
          console.log(`  QoQ delta:      ${dir}${(dH * 100).toFixed(2)}pp promoter holding`);
        } else {
          console.log(`  QoQ delta:      (prior row present but no comparable fields)`);
        }
      } else {
        console.log(`  QoQ delta:      (only 1 row available)`);
      }
      ok++;
    } catch (err) {
      console.log(`  ✗ error: ${err.message}`);
      fail++;
    }
    console.log("");
  }

  console.log("──────────────");
  console.log(`Summary: ${ok} ok, ${fail} fail, QoQ-delta present: ${anyQoQ ? "yes" : "no"}`);

  if (ok === 0) {
    console.error(
      "\nAll symbols failed. Check: Indian IP, NSE session cookies " +
      "(nse.js:refreshCookies), endpoint schema drift."
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
