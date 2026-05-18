/**
 * Stream E3 — services/trackRecord/exportCsv.js regression.
 *
 * Run with: node test/trackExportCsv.test.mjs
 *
 * `tradesToCsv` converts an array of paper-trade objects to RFC-4180
 * CSV. The wire-format requirements (CRLF line endings, quoting,
 * doubled internal quotes, column order, header row) are pinned as
 * invariants — auditors / spreadsheet apps depend on them, and the
 * CSV is shipped as a download from /api/track/export.csv.
 */

import { tradesToCsv, CSV_COLUMNS } from "../services/trackRecord/exportCsv.js";

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

console.log("trackRecord/exportCsv.js regression\n");

// Sanity: column count + ordering is pinned.
{
  assert(
    "CSV_COLUMNS has exactly 19 entries",
    Array.isArray(CSV_COLUMNS) && CSV_COLUMNS.length === 19,
    CSV_COLUMNS?.length,
  );
}

// ──── 1. Empty trades → header-only output with CRLF terminator ────
{
  const csv = tradesToCsv([]);
  const lines = csv.split("\r\n");
  assert(
    "empty array → exactly one CRLF terminator (header + empty after split)",
    lines.length === 2 && lines[1] === "",
    lines,
  );
  assert(
    "empty array → ends with \\r\\n",
    csv.endsWith("\r\n"),
    csv.slice(-4),
  );
  const headerFields = lines[0].split(",");
  assert(
    "empty array → header row has exactly 19 fields",
    headerFields.length === 19,
    headerFields.length,
  );
  assert(
    "empty array → header order matches CSV_COLUMNS exactly",
    JSON.stringify(headerFields) === JSON.stringify(CSV_COLUMNS),
    headerFields,
  );
}

// ──── 2. Single trade — all fields populated, no quoting on plain ASCII ────
{
  const trade = {
    id: "trade-001",
    dateKey: "2026-01-15",
    type: "sws_top30_v3",
    symbol: "RELIANCE",
    name: "Reliance Industries",
    sector: "Energy",
    snapshotAt: "2026-01-15T10:30:00.000Z",
    priceAtSnapshot: 2450.5,
    niftyAtSnapshot: 22000,
    scoreAtSnapshot: 85,
    side: "LONG",
    section_rank: 1,
    cap_band: "LARGE",
    benchmark_proxy: "^NSEI",
    returns: { returnPct: 12.5, alpha: 4.2 },
    closedAt: null,
    closedReason: null,
  };
  const csv = tradesToCsv([trade]);
  const lines = csv.split("\r\n");
  assert(
    "single trade → 3 split parts (header, row, trailing empty)",
    lines.length === 3 && lines[2] === "",
    lines.length,
  );
  const fields = lines[1].split(",");
  assert(
    "single trade → row has 19 fields",
    fields.length === 19,
    fields.length,
  );
  // Column ordering — pin a few load-bearing positions.
  assert(
    "column 0 = id",
    fields[0] === "trade-001",
    fields[0],
  );
  assert(
    "column 3 = symbol",
    fields[3] === "RELIANCE",
    fields[3],
  );
  assert(
    "column 14 = return_pct from returns.returnPct",
    fields[14] === "12.5",
    fields[14],
  );
  assert(
    "column 15 = alpha_pct from returns.alpha",
    fields[15] === "4.2",
    fields[15],
  );
  assert(
    "plain ASCII values are NOT quoted",
    !/^"/.test(fields[3]),
    fields[3],
  );
}

// ──── 3. Field containing comma → quoted ────
{
  const trade = {
    id: "1",
    dateKey: "2026-01-15",
    type: "sws_best_buynow",
    symbol: "HDFC",
    name: "HDFC, Inc.",
    sector: "Financials",
    snapshotAt: "2026-01-15T10:30:00.000Z",
  };
  const csv = tradesToCsv([trade]);
  const lines = csv.split("\r\n");
  // Can't just split by comma because the quoted name contains one.
  // Look for the exact substring in the row.
  assert(
    "field with comma is wrapped in double-quotes",
    lines[1].includes('"HDFC, Inc."'),
    lines[1],
  );
}

// ──── 4. Field containing double-quote → quoted + internal " doubled ────
{
  const trade = {
    id: "1",
    dateKey: "2026-01-15",
    type: "sws_top30_v3",
    symbol: "X",
    name: 'He said "hello"',
    sector: "Tech",
    snapshotAt: "2026-01-15T10:30:00.000Z",
  };
  const csv = tradesToCsv([trade]);
  assert(
    'field with " is wrapped in quotes and internal " is doubled',
    csv.includes('"He said ""hello"""'),
    csv,
  );
}

// ──── 5. Field containing newline → quoted ────
{
  const trade = {
    id: "1",
    dateKey: "2026-01-15",
    type: "sws_top30_v3",
    symbol: "X",
    name: "Acme",
    sector: "Tech\nMedia",
    snapshotAt: "2026-01-15T10:30:00.000Z",
  };
  const csv = tradesToCsv([trade]);
  assert(
    "field with embedded LF is wrapped in quotes",
    csv.includes('"Tech\nMedia"'),
    csv,
  );
}

// ──── 6. Null/undefined fields → empty CSV cell (no quotes) ────
{
  const trade = {
    id: "1",
    dateKey: "2026-01-15",
    type: "sws_top30_v3",
    symbol: "X",
    name: "Acme",
    sector: "Tech",
    snapshotAt: "2026-01-15T10:30:00.000Z",
    // priceAtSnapshot, niftyAtSnapshot, etc. all undefined
    returns: {}, // no returnPct, no alpha → both empty
  };
  const csv = tradesToCsv([trade]);
  const lines = csv.split("\r\n");
  const fields = lines[1].split(",");
  assert(
    "missing returns.alpha → empty CSV cell at column 15",
    fields[15] === "",
    fields[15],
  );
  assert(
    "missing returns.returnPct → empty CSV cell at column 14",
    fields[14] === "",
    fields[14],
  );
  assert(
    "missing closedAt → empty CSV cell at column 17",
    fields[17] === "",
    fields[17],
  );
  assert(
    "missing closedReason → empty CSV cell at column 18",
    fields[18] === "",
    fields[18],
  );
}

// ──── 7. Closed trade → holding_days computed from closedAt - snapshotAt ────
{
  const trade = {
    id: "1",
    dateKey: "2026-01-15",
    type: "sws_top30_v3",
    symbol: "X",
    name: "Acme",
    sector: "Tech",
    snapshotAt: "2026-01-15T10:30:00.000Z",
    closedAt: "2026-04-15T10:30:00.000Z",
    closedReason: "dropped_from_section",
    returns: { returnPct: -2.5, alpha: -3.0 },
  };
  const csv = tradesToCsv([trade]);
  const lines = csv.split("\r\n");
  const fields = lines[1].split(",");
  // 90 days between Jan 15 and Apr 15 (31 (rest of Jan) - wait: Jan 15 → Jan 31 = 16 days,
  // + Feb (28) + Mar (31) + Apr 15 = 16 + 28 + 31 + 15 = 90 days)
  assert(
    "closed trade → holding_days column = 90",
    fields[16] === "90",
    fields[16],
  );
  assert(
    "closed_at column = closedAt value (camelCase → snake_case header mapping)",
    fields[17] === "2026-04-15T10:30:00.000Z",
    fields[17],
  );
  assert(
    "closed_reason column populated",
    fields[18] === "dropped_from_section",
    fields[18],
  );
}

// ──── 8. closed_at column header reads from t.closedAt (camelCase on the trade obj) ────
{
  // Sanity-check the column ↔ field mapping pinned in tradeToRow:
  // CSV column name is "closed_at" (snake_case for spreadsheet hygiene)
  // but the trade object field is "closedAt" (camelCase JS convention).
  assert(
    "CSV column 17 is 'closed_at' (snake_case header)",
    CSV_COLUMNS[17] === "closed_at",
    CSV_COLUMNS[17],
  );

  const trade = {
    id: "x",
    dateKey: "2026-01-15",
    type: "sws_top30_v3",
    symbol: "X",
    name: "Acme",
    sector: "Tech",
    snapshotAt: "2026-01-15T10:30:00.000Z",
    closedAt: "2026-02-01T00:00:00.000Z",
  };
  const csv = tradesToCsv([trade]);
  const lines = csv.split("\r\n");
  const fields = lines[1].split(",");
  assert(
    "closedAt value lands in CSV closed_at column (index 17)",
    fields[17] === "2026-02-01T00:00:00.000Z",
    fields[17],
  );
}

// ──── 9. Multi-trade row joins use CRLF (not LF) ────
{
  const trades = [
    {
      id: "a",
      dateKey: "2026-01-15",
      type: "sws_top30_v3",
      symbol: "A",
      name: "A",
      sector: "X",
      snapshotAt: "2026-01-15T00:00:00.000Z",
    },
    {
      id: "b",
      dateKey: "2026-01-15",
      type: "sws_top30_v3",
      symbol: "B",
      name: "B",
      sector: "Y",
      snapshotAt: "2026-01-15T00:00:00.000Z",
    },
  ];
  const csv = tradesToCsv(trades);
  // Count \r\n occurrences: 1 after header + 1 between rows + 1 at EOF = 3
  const crlfCount = (csv.match(/\r\n/g) || []).length;
  assert(
    "2-trade output uses CRLF line endings (3 occurrences: header sep + row sep + trailing)",
    crlfCount === 3,
    crlfCount,
  );
  // Bare LF outside of CRLF would indicate a malformed line ending.
  // Strip every \r\n then look for any remaining \n.
  const strippedLfs = csv.replace(/\r\n/g, "");
  assert(
    "no bare LF outside CRLF sequences (RFC-4180 compliance)",
    !strippedLfs.includes("\n"),
    strippedLfs.match(/\n/g)?.length,
  );
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
