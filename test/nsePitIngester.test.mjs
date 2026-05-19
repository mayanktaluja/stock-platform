/**
 * Tests for services/promoter/nsePitIngester.js.
 *
 * Run with: node test/nsePitIngester.test.mjs
 *
 * Covers: row normalization (BUY/SELL classification, category mapping,
 * date parsing, value conversion), rolling-merge dedup + window cutoff,
 * staleness evaluator, computePromoterSignal aggregation.
 */

import {
  normalizeRow,
  mergeIntoRolling,
  evaluateStaleness,
  computePromoterSignal,
  STALENESS_ALERT_HOURS,
} from "../services/promoter/nsePitIngester.js";

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

console.log("\nnsePitIngester — normalizeRow");

const buyRow = normalizeRow({
  symbol: "RELIANCE",
  company: "Reliance Industries Ltd",
  acqName: "M D Ambani",
  personCategory: "Promoter",
  acqMode: "Market Purchase",
  secAcq: "50000",
  acqAmt: "75000000",
  acqfromDt: "15-May-2026",
  dt: "16-May-2026",
  afterAcqSharesPer: "2.31",
});
assert("buyRow normalises symbol", buyRow?.symbol === "RELIANCE", buyRow);
assert("classifies Market Purchase as BUY", buyRow?.txn_type === "BUY", buyRow?.txn_type);
assert("category Promoter", buyRow?.category === "Promoter");
assert("value_inr_cr = 7.5", Math.abs(buyRow?.value_inr_cr - 7.5) < 1e-9, buyRow?.value_inr_cr);
assert("txn_date_iso parsed", buyRow?.txn_date_iso === "2026-05-15", buyRow?.txn_date_iso);
assert("filing_date_iso parsed", buyRow?.filing_date_iso === "2026-05-16");

const sellRow = normalizeRow({
  symbol: "TCS",
  acqMode: "Market Sale",
  acqfromDt: "10-May-2026",
  acqAmt: "10000000",
  personCategory: "Director",
});
assert("classifies Market Sale as SELL", sellRow?.txn_type === "SELL");
assert("category Director", sellRow?.category === "Director");

const pledgeRow = normalizeRow({
  symbol: "X",
  acqMode: "Other",
  remarks: "Pledged shares with bank",
  acqfromDt: "10-May-2026",
});
assert("classifies pledge", pledgeRow?.txn_type === "PLEDGE");

const releaseRow = normalizeRow({
  symbol: "X",
  acqMode: "Other",
  remarks: "Pledge release / revocation",
  acqfromDt: "10-May-2026",
});
assert("classifies pledge-release", releaseRow?.txn_type === "RELEASE");

assert("returns null on missing symbol", normalizeRow({ acqMode: "Buy" }) === null);
assert("returns null on missing date", normalizeRow({ symbol: "X" }) === null);
assert("invalid input returns null", normalizeRow(null) === null);

console.log("\nnsePitIngester — mergeIntoRolling");

const existing = {
  schema_version: "promoter-pit-rolling-v1",
  transactions: [
    {
      symbol: "OLD", person_name: "p", txn_type: "BUY", shares: 100,
      txn_date_iso: "2026-03-01", value_inr_cr: 1, category: "Promoter",
    },
    {
      symbol: "KEEP", person_name: "p2", txn_type: "SELL", shares: 200,
      txn_date_iso: "2026-05-10", value_inr_cr: 2, category: "Promoter",
    },
  ],
};
const fresh = [
  {
    symbol: "NEW", person_name: "p3", txn_type: "BUY", shares: 300,
    txn_date_iso: "2026-05-18", value_inr_cr: 5, category: "Promoter",
  },
  {
    // Duplicate of "KEEP" — should be dedup'd
    symbol: "KEEP", person_name: "p2", txn_type: "SELL", shares: 200,
    txn_date_iso: "2026-05-10", value_inr_cr: 2, category: "Promoter",
  },
];
const merged = mergeIntoRolling(existing, fresh, { today_iso: "2026-05-19", windowDays: 30 });
assert("OLD (>30d) excluded by cutoff", !merged.transactions.find((t) => t.symbol === "OLD"));
assert("KEEP retained", merged.transactions.some((t) => t.symbol === "KEEP"));
assert("NEW added", merged.transactions.some((t) => t.symbol === "NEW"));
assert("dedup keeps single row (not two KEEPs)", merged.transactions.filter((t) => t.symbol === "KEEP").length === 1);
assert("transaction_count=2", merged.transaction_count === 2, merged.transaction_count);
assert("sorted DESC by date — NEW first", merged.transactions[0].symbol === "NEW", merged.transactions);

console.log("\nnsePitIngester — evaluateStaleness");

const fresh_status = { last_success_iso: new Date(Date.now() - 12 * 3_600_000).toISOString() };
assert(
  "12h since success → not stale",
  evaluateStaleness(fresh_status).stale === false,
);
const stale_status = { last_success_iso: new Date(Date.now() - 48 * 3_600_000).toISOString() };
assert(
  "48h since success → stale (>36h)",
  evaluateStaleness(stale_status).stale === true,
);
assert(
  "never-succeeded → stale",
  evaluateStaleness(null).stale === true,
);
assert(
  "alert threshold is 36h",
  STALENESS_ALERT_HOURS === 36,
);

console.log("\nnsePitIngester — computePromoterSignal");

const rolling = {
  transactions: [
    { symbol: "BUY1", category: "Promoter", txn_type: "BUY", value_inr_cr: 5, txn_date_iso: "2026-05-18" },
    { symbol: "BUY1", category: "Promoter", txn_type: "BUY", value_inr_cr: 3, txn_date_iso: "2026-05-17" },
    { symbol: "SELL1", category: "Promoter", txn_type: "SELL", value_inr_cr: 10, txn_date_iso: "2026-05-18" },
    { symbol: "MIXED", category: "Promoter", txn_type: "BUY", value_inr_cr: 4, txn_date_iso: "2026-05-18" },
    { symbol: "MIXED", category: "Promoter", txn_type: "SELL", value_inr_cr: 7, txn_date_iso: "2026-05-17" },
    // Outside window (>7d)
    { symbol: "OLD", category: "Promoter", txn_type: "BUY", value_inr_cr: 99, txn_date_iso: "2026-04-01" },
    // Non-promoter (Director) — excluded
    { symbol: "DIRBUY", category: "Director", txn_type: "BUY", value_inr_cr: 5, txn_date_iso: "2026-05-18" },
  ],
};
const sig = computePromoterSignal(rolling, { today_iso: "2026-05-19", windowDays: 7 });
assert("BUY1 net +8 BUY", sig.BUY1?.direction === "BUY" && sig.BUY1?.net_inr_cr === 8, sig.BUY1);
assert("SELL1 net -10 SELL", sig.SELL1?.direction === "SELL" && sig.SELL1?.net_inr_cr === -10);
assert("MIXED net -3 SELL", sig.MIXED?.direction === "SELL" && sig.MIXED?.net_inr_cr === -3);
assert("OLD not in signal (outside window)", !sig.OLD);
assert("DIRBUY (non-promoter) not in signal", !sig.DIRBUY);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
