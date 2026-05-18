// SEBI 10/10 — RFC-4180 CSV export of the paper-trade ledger.
// Pure function; zero dependencies. Endpoint streams the result with
// the right Content-Type + Content-Disposition.

export const CSV_COLUMNS = [
  "id",
  "dateKey",
  "type",
  "symbol",
  "name",
  "sector",
  "snapshotAt",
  "priceAtSnapshot",
  "niftyAtSnapshot",
  "scoreAtSnapshot",
  "side",
  "section_rank",
  "cap_band",
  "benchmark_proxy",
  "return_pct",
  "alpha_pct",
  "holding_days",
  "closed_at",
  "closed_reason",
];

function quote(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // RFC-4180: quote if contains comma, quote, CR, or LF
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function holdingDays(snapshotAt, closedAt) {
  if (!snapshotAt || !closedAt) return "";
  const ms = new Date(closedAt).getTime() - new Date(snapshotAt).getTime();
  if (!Number.isFinite(ms)) return "";
  return Math.round(ms / 86400000);
}

function tradeToRow(t) {
  const r = t.returns || {};
  return [
    t.id,
    t.dateKey,
    t.type,
    t.symbol,
    t.name,
    t.sector,
    t.snapshotAt,
    t.priceAtSnapshot,
    t.niftyAtSnapshot,
    t.scoreAtSnapshot,
    t.side,
    t.section_rank,
    t.cap_band,
    t.benchmark_proxy,
    r.returnPct != null ? r.returnPct : "",
    r.alpha != null ? r.alpha : "",
    holdingDays(t.snapshotAt, t.closedAt),
    t.closedAt || "",
    t.closedReason || "",
  ].map(quote).join(",");
}

/**
 * Convert an array of paper-trade objects to RFC-4180 CSV.
 * Header row is always emitted.
 */
export function tradesToCsv(trades) {
  const header = CSV_COLUMNS.join(",");
  if (!Array.isArray(trades) || trades.length === 0) return header + "\r\n";
  return header + "\r\n" + trades.map(tradeToRow).join("\r\n") + "\r\n";
}
