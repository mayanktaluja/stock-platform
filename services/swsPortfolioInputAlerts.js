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
  const alerts = changes.filter((change) => heldTickers.has(canonicalSwsTicker(change?.ticker)));
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

export function buildSwsInputAlertEmail({ alerts, runId, generatedAt, appUrl = "https://starbhai-stock-platform.vercel.app/" }) {
  const count = Array.isArray(alerts) ? alerts.length : 0;
  const subject = `SWS inputs changed for ${count} portfolio holding(s)`;
  const lines = [
    subject,
    "",
    `SWS refresh timestamp: ${runId || generatedAt || "unknown"}`,
    `Portfolio Analyzer: ${appUrl.replace(/\/$/, "")}/?tab=analyzer`,
    "",
    "Review the Starbhai score/report before taking any decision. This email contains no buy/sell instruction.",
    "",
  ];

  for (const alert of alerts || []) {
    lines.push(`${alert.ticker} — ${alert.name || alert.ticker} (${alert.severity || "medium"})`);
    for (const change of (alert.changes || []).slice(0, 5)) {
      lines.push(`- ${change.field}: ${formatChangeValue(change.previous)} -> ${formatChangeValue(change.current)}`);
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
