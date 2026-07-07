// Unit tests for the forward-ledger staleness guard (pure function only).
// Locks the dormancy detection that would have caught the 2026-05→07 outage.

import assert from "node:assert";
import { computeLedgerFreshness } from "../scripts/monitor-forward-ledger-staleness.mjs";

let passed = 0;
function t(name, fn) { fn(); passed++; }

const NOW = Date.parse("2026-07-07T00:00:00Z");
const v2 = (day, extra = {}) => ({
  snapshotAt: `${day}T05:00:00Z`,
  returns_by_horizon: extra.rbh || { "1m": { status: "open" } },
  target_horizons: ["1m", "3m", "6m", "12m"],
});
const v1 = (day) => ({ snapshotAt: `${day}T05:00:00Z`, closedAt: `${day}T06:00:00Z`, closingPrice: 100 });

t("fresh: latest V2 accrual within threshold → not stale", () => {
  const r = computeLedgerFreshness([v2("2026-07-06"), v2("2026-07-05")], NOW, 4);
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.latest_v2_snapshot, "2026-07-06");
  assert.strictEqual(r.v2_rows, 2);
  assert.ok(r.days_since_accrual >= 0 && r.days_since_accrual < 2);
});

t("dormant: latest V2 accrual older than threshold → STALE (the 2-month-gap case)", () => {
  // newest V2 is 2026-05-08, now is 2026-07-07 → ~60 days stale.
  const r = computeLedgerFreshness([v2("2026-05-08"), v2("2026-05-07")], NOW, 4);
  assert.strictEqual(r.stale, true);
  assert.ok(r.days_since_accrual > 50);
});

t("no V2 rows at all (only V1 backfill) → STALE", () => {
  const r = computeLedgerFreshness([v1("2026-05-01"), v1("2026-05-02")], NOW, 4);
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.v2_rows, 0);
  assert.strictEqual(r.latest_v2_snapshot, null);
});

t("resolved counting: a closed horizon counts, an all-open row does not", () => {
  const resolvedRow = v2("2026-07-06", { rbh: { "1m": { status: "closed", alpha_pct: 3.2 }, "3m": { status: "open" } } });
  const openRow = v2("2026-07-06");
  const r = computeLedgerFreshness([resolvedRow, openRow], NOW, 4);
  assert.strictEqual(r.v2_rows, 2);
  assert.strictEqual(r.resolved_rows, 1);
});

t("empty ledger → stale, zero counts, no crash", () => {
  const r = computeLedgerFreshness([], NOW, 4);
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.total_rows, 0);
  assert.strictEqual(r.v2_rows, 0);
});

console.log(`monitorForwardLedgerStaleness: ${passed} tests passed`);
