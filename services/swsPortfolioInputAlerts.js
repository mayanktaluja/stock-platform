import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalSwsTicker, stableHash } from "./swsInputSnapshot.js";

export const DEFAULT_SWS_INPUT_ALERT_PREFS = Object.freeze({
  inApp: true,
  email: false,
});

export function normalizeSwsInputAlertPrefs(prefs = {}) {
  return {
    inApp: prefs.inApp !== false,
    email: prefs.email === true,
  };
}

// Only these SWS inputs carry investor-facing signal. Everything else the diff
// emits (statements.rewards/risks, snowflake.total, v4_score/v4_verdict,
// snowflake.data_quality, fair-value metadata, fiscal.*, forecast.*) is noise
// for the Portfolio Analyzer "SWS input changes" panel + email digest and is
// dropped. The diff emits each snowflake pillar under both a canonical key and
// a non-canonical alias (value/valuation, future/future_growth, …) — we
// normalize aliases to the canonical label and dedupe so a pillar shows once.
const SWS_PILLAR_CANONICAL = {
  value: "value",
  valuation: "value",
  future: "future",
  future_growth: "future",
  past: "past",
  past_performance: "past",
  health: "health",
  financial_health: "health",
  dividend: "dividend",
  dividends: "dividend",
};
const SWS_SIGNAL_FAIR_VALUE_FIELDS = new Set([
  "fair_value.fair_value_inr",
  "fair_value.upside_band",
]);

// Filter a change[] array down to the signal fields above, rewriting pillar
// aliases to their canonical field and deduping by canonical field (first
// occurrence wins). Returns a new array; input is not mutated.
export function filterSignalChanges(changes) {
  const out = [];
  const seen = new Set();
  for (const change of Array.isArray(changes) ? changes : []) {
    const field = String(change?.field || "");
    let canonicalField = null;
    if (SWS_SIGNAL_FAIR_VALUE_FIELDS.has(field)) {
      canonicalField = field;
    } else if (field.startsWith("snowflake.")) {
      const pillar = SWS_PILLAR_CANONICAL[field.slice("snowflake.".length)];
      if (pillar) canonicalField = `snowflake.${pillar}`;
    }
    if (!canonicalField || seen.has(canonicalField)) continue;
    seen.add(canonicalField);
    out.push(canonicalField === field ? change : { ...change, field: canonicalField });
  }
  return out;
}

export function digestPortfolioChanges(alerts) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        (Array.isArray(alerts) ? alerts : [])
          .map((a) => `${canonicalSwsTicker(a.ticker)}:${a.change_hash || stableHash(a.changes || [])}`)
          .sort(),
      ),
    )
    .digest("hex")
    .slice(0, 24);
}

export function loadMarketWideSwsInputChanges(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return { run_id: null, alerts: [], suppressed_count: 0, artifact_missing: true };
  }
  const json = JSON.parse(readFileSync(filePath, "utf-8"));
  return {
    run_id: json.run_id || null,
    generated_at: json.generated_at || null,
    alerts: Array.isArray(json.changes) ? json.changes : [],
    suppressed_count: 0,
    artifact_missing: false,
  };
}

export function canonicalizeHoldingTicker(holding) {
  const raw = holding?.symbol || holding?.ticker || holding?.stock || holding?.name || "";
  return canonicalSwsTicker(raw);
}

export async function loadUserPortfolioHoldings(sub, { analyzerStore, portfolioStore } = {}) {
  if (!sub) return { source: null, holdings: [] };
  const analyzer = analyzerStore ? await analyzerStore.read(sub) : null;
  if (Array.isArray(analyzer?.holdings) && analyzer.holdings.length > 0) {
    return { source: "analyzer", holdings: analyzer.holdings };
  }
  const portfolio = portfolioStore ? await portfolioStore.read(sub) : null;
  if (Array.isArray(portfolio?.stocks) && portfolio.stocks.length > 0) {
    return { source: "portfolio", holdings: portfolio.stocks };
  }
  return { source: null, holdings: [] };
}

export async function buildPortfolioSwsInputAlerts(sub, marketChanges, stores = {}) {
  const { source, holdings } = await loadUserPortfolioHoldings(sub, stores);
  const heldTickers = new Set(holdings.map(canonicalizeHoldingTicker).filter(Boolean));
  const changes = Array.isArray(marketChanges?.alerts)
    ? marketChanges.alerts
    : Array.isArray(marketChanges?.changes)
      ? marketChanges.changes
      : [];
  const heldAlerts = changes.filter((change) => heldTickers.has(canonicalSwsTicker(change?.ticker)));
  // Filter each held alert's changes to signal fields, drop alerts left with
  // nothing, and recompute alert-level severity + change_hash from the survivors
  // so the digest (used for ledger dedup) reflects the filtered set.
  const alerts = [];
  for (const alert of heldAlerts) {
    const filteredChanges = filterSignalChanges(alert.changes);
    if (!filteredChanges.length) continue;
    alerts.push({
      ...alert,
      severity: filteredChanges.some((c) => c.severity === "high") ? "high" : "medium",
      change_hash: stableHash(filteredChanges),
      changes: filteredChanges,
    });
  }
  return {
    run_id: marketChanges?.run_id || null,
    generated_at: marketChanges?.generated_at || null,
    source,
    holdings_count: holdings.length,
    alerts,
    suppressed_count: Math.max(0, changes.length - alerts.length),
    digest: digestPortfolioChanges(alerts),
  };
}

export function formatChangeValue(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function formatAlertStockLabel(alert) {
  const ticker = canonicalSwsTicker(alert?.ticker);
  const name = String(alert?.name || "").trim();
  if (ticker && name && name.toUpperCase() !== ticker) return `${name} (${ticker})`;
  return ticker || name || "Unknown stock";
}

export function formatAlertChangeSummary(change) {
  const field = String(change?.field || "SWS input").trim();
  return `${field} changed from ${formatChangeValue(change?.previous)} to ${formatChangeValue(change?.current)}`;
}

export function buildSwsInputAlertEmail({ alerts, runId, generatedAt, appUrl = "https://starbhai-stock-platform.vercel.app/" }) {
  const alertList = Array.isArray(alerts) ? alerts : [];
  const count = alertList.length;
  const stockLabels = alertList.map(formatAlertStockLabel);
  const firstChange = alertList.flatMap((alert) => alert.changes || [])[0] || null;
  const subject = count === 1
    ? `SWS inputs changed for ${stockLabels[0]}`
    : `SWS inputs changed for ${count} portfolio holding(s)`;
  const lines = [
    subject,
    "",
    `${count === 1 ? "Affected stock" : "Affected stocks"}: ${stockLabels.join(", ") || "n/a"}`,
    `What changed: ${firstChange ? formatAlertChangeSummary(firstChange) : "See stock details below."}`,
    `SWS refresh timestamp: ${runId || generatedAt || "unknown"}`,
    `Portfolio Analyzer: ${appUrl.replace(/\/$/, "")}/?tab=analyzer`,
    "",
    "Review the Starbhai score/report before taking any decision. This email contains no buy/sell instruction.",
    "",
  ];

  for (const alert of alertList) {
    lines.push(`${formatAlertStockLabel(alert)} - ${alert.severity || "medium"} severity`);
    for (const change of (alert.changes || []).slice(0, 5)) {
      lines.push(`- ${formatAlertChangeSummary(change)}`);
    }
    lines.push("");
  }

  lines.push("Preferences: open Portfolio Analyzer in Starbhai to turn SWS input alert emails off.");
  const text = lines.join("\n");
  const html = text
    .split("\n")
    .map((line) => {
      if (!line) return "<br>";
      if (line.startsWith("- ")) return `<div>${escapeHtml(line)}</div>`;
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("\n");
  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
