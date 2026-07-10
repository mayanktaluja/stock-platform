import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalSwsTicker, isSwsInputArtifactEmailEligible, stableHash } from "./swsInputSnapshot.js";

export const DEFAULT_SWS_INPUT_ALERT_PREFS = Object.freeze({
  inApp: true,
  email: true,
});

export function normalizeSwsInputAlertPrefs(prefs = {}) {
  return {
    inApp: prefs.inApp !== false,
    email: prefs.email !== false,
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
const FAIR_VALUE_MATERIALITY_THRESHOLD = 0.02;
const UPSIDE_BAND_RANK = Object.freeze({
  VERY_EXPENSIVE: 0,
  EXPENSIVE: 1,
  FAIR: 2,
  DISCOUNT: 3,
  DEEP_DISCOUNT: 4,
});

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isMaterialFairValueChange(change) {
  const previous = finiteNumber(change?.previous);
  const current = finiteNumber(change?.current);
  if (previous === null || current === null || previous === 0) return true;
  return Math.abs(current - previous) / Math.abs(previous) > FAIR_VALUE_MATERIALITY_THRESHOLD;
}

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
    if (canonicalField === "fair_value.fair_value_inr" && !isMaterialFairValueChange(change)) continue;
    seen.add(canonicalField);
    out.push(canonicalField === field ? change : { ...change, field: canonicalField });
  }
  return out;
}

export function normalizeSwsInputAlert(alert) {
  const changes = filterSignalChanges(alert?.changes);
  if (!changes.length) return null;
  return {
    ...alert,
    severity: changes.some((c) => c.severity === "high") ? "high" : "medium",
    change_hash: stableHash(changes),
    changes,
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
    return { run_id: null, alerts: [], suppressed_count: 0, artifact_missing: true, artifact_email_eligible: false };
  }
  const json = JSON.parse(readFileSync(filePath, "utf-8"));
  const rawAlerts = Array.isArray(json.changes) ? json.changes : [];
  const artifactEmailEligible = isSwsInputArtifactEmailEligible(json);
  return {
    schema_version: json.schema_version || null,
    confirmation_policy: json.confirmation_policy || null,
    artifact_email_eligible: artifactEmailEligible,
    run_id: json.run_id || null,
    generated_at: json.generated_at || null,
    alerts: artifactEmailEligible ? rawAlerts : [],
    raw_alert_count: rawAlerts.length,
    raw_change_count: json.raw_change_count ?? rawAlerts.length,
    pending_count: json.pending_count || 0,
    suppressed_unconfirmed_count: json.suppressed_unconfirmed_count || 0,
    state_seeded: json.state_seeded === true,
    suppressed_count: artifactEmailEligible ? 0 : rawAlerts.length,
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
  const alerts = heldAlerts.map(normalizeSwsInputAlert).filter(Boolean);
  return {
    run_id: marketChanges?.run_id || null,
    generated_at: marketChanges?.generated_at || null,
    source,
    holdings_count: holdings.length,
    // Every held ticker, canonical + bare — not just the alert-matched ones.
    // Exposed as an ARRAY, not the internal Set: `portfolio` is re-spread and
    // fed to ledger events, and a Set JSON-stringifies to `{}`.
    //
    // UNFILTERED by design: zero-quantity/exited positions are included, and
    // canonicalizeHoldingTicker() falls through symbol → ticker → stock → name,
    // so a row with no symbol yields something like "RELIANCE INDUSTRIES LTD"
    // (which simply never matches). Series suffixes (-EQ/-BE) are not stripped
    // and must not be — BAJAJ-AUTO and UMIYA-MRO are real NSE symbols.
    held_tickers: [...heldTickers],
    alerts,
    suppressed_count: Math.max(0, heldAlerts.length - alerts.length),
    digest: digestPortfolioChanges(alerts),
  };
}

export function buildSwsInputAlertTransitionKeys(alerts) {
  const keys = [];
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const ticker = canonicalSwsTicker(alert?.ticker);
    for (const change of alert?.changes || []) {
      keys.push(stableHash({
        ticker,
        field: String(change?.field || ""),
        previous: change?.previous ?? null,
        current: change?.current ?? null,
      }));
    }
  }
  return [...new Set(keys)].sort();
}

export function filterAlertsByTransitionKeys(alerts, blockedKeys = new Set()) {
  const out = [];
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const changes = [];
    for (const change of alert?.changes || []) {
      const [key] = buildSwsInputAlertTransitionKeys([{ ...alert, changes: [change] }]);
      if (!blockedKeys.has(key)) changes.push(change);
    }
    if (changes.length) out.push(normalizeSwsInputAlert({ ...alert, changes }));
  }
  return out.filter(Boolean);
}

export function formatChangeValue(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function formatAlertFieldLabel(field) {
  const labels = {
    "fair_value.fair_value_inr": "Fair value",
    "fair_value.upside_band": "Upside band",
    "snowflake.value": "Value",
    "snowflake.future": "Future growth",
    "snowflake.past": "Past performance",
    "snowflake.health": "Financial health",
    "snowflake.dividend": "Dividend",
  };
  return labels[String(field || "")] || String(field || "SWS input");
}

function formatInrValue(value) {
  const n = finiteNumber(value);
  if (n === null) return formatChangeValue(value);
  const rounded = Math.round(n * 100) / 100;
  return `INR ${Number.isInteger(rounded) ? rounded.toLocaleString("en-IN") : rounded.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function formatAlertChangeValue(change, side) {
  const value = side === "previous" ? change?.previous : change?.current;
  if (String(change?.field || "") === "fair_value.fair_value_inr") return formatInrValue(value);
  return formatChangeValue(value);
}

export function formatAlertChangeDelta(change) {
  if (String(change?.field || "") !== "fair_value.fair_value_inr") return "";
  const previous = finiteNumber(change?.previous);
  const current = finiteNumber(change?.current);
  if (previous === null || current === null || previous === 0) return "Availability change";
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${(Math.round(pct * 100) / 100).toFixed(2)}%`;
}

export function classifySwsInputChangeImpact(change) {
  const field = String(change?.field || "");
  if (field.startsWith("snowflake.")) {
    const previous = finiteNumber(change?.previous);
    const current = finiteNumber(change?.current);
    if (previous === null || current === null) return "changed";
    if (current > previous) return "positive";
    if (current < previous) return "negative";
    return "neutral";
  }
  if (field === "fair_value.fair_value_inr") {
    const previous = finiteNumber(change?.previous);
    const current = finiteNumber(change?.current);
    if (previous === null || current === null || previous <= 0) return "changed";
    if (current > previous) return "positive";
    if (current < previous) return "negative";
    return "neutral";
  }
  if (field === "fair_value.upside_band") {
    const previous = UPSIDE_BAND_RANK[String(change?.previous || "").toUpperCase()];
    const current = UPSIDE_BAND_RANK[String(change?.current || "").toUpperCase()];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) return "changed";
    if (current > previous) return "positive";
    if (current < previous) return "negative";
    return "neutral";
  }
  return "changed";
}

export function classifySwsInputAlertImpact(changes) {
  const impacts = new Set((Array.isArray(changes) ? changes : []).map(classifySwsInputChangeImpact));
  if (impacts.has("positive") && impacts.has("negative")) return "mixed";
  if (impacts.has("negative")) return "negative";
  if (impacts.has("positive")) return "positive";
  if (impacts.has("changed")) return "changed";
  return "neutral";
}

export function formatAlertImpactLabel(impact) {
  const labels = {
    positive: "Positive",
    negative: "Negative",
    mixed: "Mixed",
    neutral: "Neutral",
    changed: "Changed",
  };
  return labels[String(impact || "").toLowerCase()] || "Changed";
}

function impactStyle(impact) {
  const styles = {
    positive: { color: "#166534", bg: "#dcfce7", border: "#86efac" },
    negative: { color: "#991b1b", bg: "#fee2e2", border: "#fca5a5" },
    mixed: { color: "#854d0e", bg: "#fef3c7", border: "#fcd34d" },
    neutral: { color: "#374151", bg: "#f3f4f6", border: "#d1d5db" },
    changed: { color: "#374151", bg: "#f3f4f6", border: "#d1d5db" },
  };
  return styles[String(impact || "").toLowerCase()] || styles.changed;
}

function formatInrAmount(value) {
  const n = finiteNumber(value);
  if (n === null || n <= 0) return null;
  const rounded = Math.round(n);
  return `INR ${rounded.toLocaleString("en-IN")}`;
}

function normalizeReductionHighlight(row) {
  const ticker = canonicalSwsTicker(row?.ticker || row?.symbol);
  if (!ticker) return null;
  const name = String(row?.name || "").trim();
  const action = String(row?.action || row?.rawAction || "").trim();
  if (!action) return null;
  const tradeRupees = finiteNumber(row?.tradeRupees ?? row?.trimRupees);
  const reasons = (Array.isArray(row?.reasons) ? row.reasons : [])
    .map((r) => String(r || "").trim())
    .filter(Boolean)
    .slice(0, 2);
  return {
    ticker,
    name,
    action,
    tradeRupees,
    reasons,
  };
}

export function normalizeReductionHighlights(highlights) {
  return (Array.isArray(highlights) ? highlights : [])
    .map(normalizeReductionHighlight)
    .filter(Boolean);
}

function formatReductionHighlightLabel(row) {
  if (row.name && row.name.toUpperCase() !== row.ticker) return `${row.name} (${row.ticker})`;
  return row.ticker;
}

function formatReductionHighlightSummary(row) {
  const amount = formatInrAmount(row.tradeRupees);
  return amount
    ? `${row.action} review; estimated trim amount ${amount}`
    : `${row.action} review`;
}

function buildReductionHighlightsText(highlights) {
  if (!highlights.length) return [];
  const lines = [
    "Portfolio Analyzer reduction review",
    "Starbhai now flags the following alert-affected holding(s) for reduction review. Please open Starbhai and verify before acting.",
    "",
  ];
  for (const row of highlights) {
    lines.push(`${formatReductionHighlightLabel(row)} - ${formatReductionHighlightSummary(row)}`);
    for (const reason of row.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  return lines;
}

function buildReductionHighlightsHtml(highlights) {
  if (!highlights.length) return "";
  const rows = highlights.map((row) => {
    const amount = formatInrAmount(row.tradeRupees) || "Review in Starbhai";
    const reasons = row.reasons.length
      ? `<div style="margin-top:5px;color:#6b7280;">${escapeHtml(row.reasons.join(" "))}</div>`
      : "";
    return `
      <tr>
        <td style="padding:10px 12px;border-top:1px solid #fecaca;font-family:Arial,sans-serif;font-size:13px;color:#111827;font-weight:700;">${escapeHtml(formatReductionHighlightLabel(row))}</td>
        <td style="padding:10px 12px;border-top:1px solid #fecaca;font-family:Arial,sans-serif;font-size:13px;color:#991b1b;font-weight:700;">${escapeHtml(row.action)}</td>
        <td style="padding:10px 12px;border-top:1px solid #fecaca;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(amount)}${reasons}</td>
      </tr>`;
  }).join("\n");
  return `
        <tr>
          <td style="padding:0 20px 16px;">
            <table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #fca5a5;background:#fff7f7;">
              <thead>
                <tr>
                  <th colspan="3" align="left" style="padding:12px;background:#fee2e2;font-family:Arial,sans-serif;font-size:14px;color:#7f1d1d;">Portfolio Analyzer reduction review</th>
                </tr>
                <tr>
                  <td colspan="3" style="padding:10px 12px;font-family:Arial,sans-serif;font-size:13px;color:#7f1d1d;">Starbhai now flags these alert-affected holding(s) for reduction review. Please open Starbhai and verify before acting.</td>
                </tr>
                <tr>
                  <th align="left" style="padding:10px 12px;background:#fff1f2;font-family:Arial,sans-serif;font-size:12px;color:#7f1d1d;">Holding</th>
                  <th align="left" style="padding:10px 12px;background:#fff1f2;font-family:Arial,sans-serif;font-size:12px;color:#7f1d1d;">Analyzer action</th>
                  <th align="left" style="padding:10px 12px;background:#fff1f2;font-family:Arial,sans-serif;font-size:12px;color:#7f1d1d;">Review detail</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </td>
        </tr>`;
}

// ──── Upcoming-earnings section ────
// Optional bottom section, same contract as the reduction highlights above:
// returns "" / [] when there are no rows, so callers interpolate it blindly.
// Rows come from services/earnings/portfolioEarningsSection.js and carry
// scalars only — no price bands, no position sizing, no entry/stop/target.
// The footer below asserts "no buy/sell instruction"; keep it true.

const EARNINGS_SECTION_TITLE = "Upcoming results in your portfolio";
const EARNINGS_SECTION_NOTE =
  "Guidance (Raise / Maintain / Cut) is disclosed at the concall, not before — all three scenarios stay open until then.";

// Verdict direction reuses the existing impact palette rather than adding a
// second colour system: BEAT reads positive, MISS negative, everything else neutral.
function verdictStyle(verdict) {
  if (verdict === "BEAT") return impactStyle("positive");
  if (verdict === "MISS") return impactStyle("negative");
  return impactStyle("neutral");
}

function formatEarningsRowLabel(row) {
  const symbol = String(row?.symbol || "").trim();
  const company = String(row?.company || "").trim();
  if (symbol && company && company.toUpperCase() !== symbol) return `${company} (${symbol})`;
  return symbol || company || "Unknown stock";
}

function formatEarningsWhen(row) {
  // days_until_label is always a non-empty string — a raw 0 would vanish
  // through escapeHtml's `String(s || "")`. See portfolioEarningsSection.js.
  const when = String(row?.days_until_label || "").trim() || "—";
  const iso = String(row?.event_iso_date || "").trim();
  return iso ? `${when} (${iso})` : when;
}

function formatEarningsModelView(row) {
  const verdict = String(row?.verdict_label || "").trim() || "Insufficient data";
  const confidence = String(row?.confidence_label || "").trim();
  return confidence && confidence !== "—" ? `${verdict}, ${confidence} confidence` : verdict;
}

export function buildEarningsSectionText(rows, earningsUrl = "") {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const lines = [EARNINGS_SECTION_TITLE, EARNINGS_SECTION_NOTE];
  if (earningsUrl) lines.push(`Earnings Watch: ${earningsUrl}`);
  lines.push("");
  for (const row of list) {
    lines.push(`${formatEarningsRowLabel(row)} - ${formatEarningsWhen(row)}, ${row?.fiscal_quarter || "—"}`);
    lines.push(`- Model view: ${formatEarningsModelView(row)}`);
    if (row?.branch_tree) lines.push(`- Scenarios: ${row.branch_tree}`);
    lines.push("");
  }
  return lines;
}

export function buildEarningsSectionHtml(rows, earningsUrl = "") {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const link = earningsUrl
    ? ` <a href="${escapeAttr(earningsUrl)}" style="color:#2563eb;text-decoration:underline;">Open Earnings Watch</a>`
    : "";
  const bodyRows = list.map((row) => {
    const style = verdictStyle(row?.verdict);
    const confidence = String(row?.confidence_label || "").trim();
    const confidenceCell = confidence && confidence !== "—"
      ? ` <span style="color:#374151;">${escapeHtml(confidence)} confidence</span>`
      : "";
    const tree = row?.branch_tree
      ? `<div style="margin-top:5px;color:#6b7280;">${escapeHtml(row.branch_tree)}</div>`
      : "";
    return `
      <tr>
        <td style="padding:10px 12px;border-top:1px solid #bfdbfe;font-family:Arial,sans-serif;font-size:13px;color:#111827;font-weight:700;">${escapeHtml(formatEarningsRowLabel(row))}</td>
        <td style="padding:10px 12px;border-top:1px solid #bfdbfe;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(formatEarningsWhen(row))}</td>
        <td style="padding:10px 12px;border-top:1px solid #bfdbfe;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(row?.fiscal_quarter || "—")}</td>
        <td style="padding:10px 12px;border-top:1px solid #bfdbfe;font-family:Arial,sans-serif;font-size:13px;color:#374151;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;border:1px solid ${style.border};background:${style.bg};color:${style.color};font-weight:700;font-size:12px;">${escapeHtml(row?.verdict_label || "Insufficient data")}</span>${confidenceCell}${tree}</td>
      </tr>`;
  }).join("\n");
  return `
        <tr>
          <td style="padding:0 20px 16px;">
            <table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #bfdbfe;background:#f8fbff;">
              <thead>
                <tr>
                  <th colspan="4" align="left" style="padding:12px;background:#dbeafe;font-family:Arial,sans-serif;font-size:14px;color:#1e3a8a;">${escapeHtml(EARNINGS_SECTION_TITLE)}</th>
                </tr>
                <tr>
                  <td colspan="4" style="padding:10px 12px;font-family:Arial,sans-serif;font-size:13px;color:#1e3a8a;">${escapeHtml(EARNINGS_SECTION_NOTE)}${link}</td>
                </tr>
                <tr>
                  <th align="left" style="padding:10px 12px;background:#eff6ff;font-family:Arial,sans-serif;font-size:12px;color:#1e3a8a;">Holding</th>
                  <th align="left" style="padding:10px 12px;background:#eff6ff;font-family:Arial,sans-serif;font-size:12px;color:#1e3a8a;">Reports</th>
                  <th align="left" style="padding:10px 12px;background:#eff6ff;font-family:Arial,sans-serif;font-size:12px;color:#1e3a8a;">Quarter</th>
                  <th align="left" style="padding:10px 12px;background:#eff6ff;font-family:Arial,sans-serif;font-size:12px;color:#1e3a8a;">Model view &amp; guidance scenarios</th>
                </tr>
              </thead>
              <tbody>
                ${bodyRows}
              </tbody>
            </table>
          </td>
        </tr>`;
}

// "What's NEW in Earnings Watch today" — admin-gated, GLOBAL (calendar-wide)
// additions + material BEAT<->MISS verdict flips, from services/earnings/
// earningsWatchDiff.js. Held holdings are starred (⭐) per-user at render time;
// the ⭐ set is passed in already canonical. Same "" / [] empty contract as the
// upcoming-results section above, so callers interpolate blindly.

const EARNINGS_ADDED_SECTION_TITLE = "New in Earnings Watch today";
const EARNINGS_ADDED_SECTION_NOTE =
  "Companies newly scheduled on the results calendar since the last snapshot. Model view is a prediction, not a recommendation.";
const EARNINGS_CHANGED_SUBTITLE = "Verdict changed since the last snapshot";
const DEFAULT_ADDED_RENDER_ROWS = 20;

function addedRowLabel(row, heldSet) {
  const base = formatEarningsRowLabel(row);
  return heldSet && heldSet.has(row?.symbol) ? `⭐ ${base}` : base;
}

// Holdings are ALWAYS shown; non-held additions fill the remaining rows by
// soonest report date. Never a silent truncation — the header reports the total.
function selectAddedRows(delta, heldSet, maxRows = DEFAULT_ADDED_RENDER_ROWS) {
  const added = Array.isArray(delta?.added) ? delta.added : [];
  const isHeld = (r) => !!(heldSet && heldSet.has(r?.symbol));
  const held = added.filter(isHeld);
  const nonHeld = added.filter((r) => !isHeld(r));
  const room = Math.max(0, maxRows - held.length);
  const rows = [...held, ...nonHeld.slice(0, room)].sort(
    (a, b) => (a.days_until - b.days_until) || String(a.symbol).localeCompare(String(b.symbol)),
  );
  return { rows, heldCount: held.length, total: Number(delta?.added_total) || added.length, shown: rows.length };
}

function addedCountLine(sel) {
  const parts = [`${sel.total} newly scheduled`];
  if (sel.shown < sel.total) parts.push(`showing nearest ${sel.shown}`);
  if (sel.heldCount > 0) parts.push(`${sel.heldCount} ⭐ you hold`);
  return parts.join(" · ");
}

export function hasEarningsAddedContent(delta) {
  if (!delta) return false;
  const added = Array.isArray(delta.added) ? delta.added.length : 0;
  const changed = Array.isArray(delta.verdict_changed) ? delta.verdict_changed.length : 0;
  return added > 0 || changed > 0;
}

export function buildEarningsAddedSectionText(delta, heldSet, earningsUrl = "") {
  if (!hasEarningsAddedContent(delta)) return [];
  const sel = selectAddedRows(delta, heldSet);
  const changed = Array.isArray(delta.verdict_changed) ? delta.verdict_changed : [];
  const lines = [EARNINGS_ADDED_SECTION_TITLE, EARNINGS_ADDED_SECTION_NOTE];
  if (earningsUrl) lines.push(`Earnings Watch: ${earningsUrl}`);
  if (sel.rows.length) {
    lines.push(addedCountLine(sel), "");
    for (const row of sel.rows) {
      lines.push(`${addedRowLabel(row, heldSet)} - ${formatEarningsWhen(row)}, ${row?.fiscal_quarter || "—"}`);
      lines.push(`- Model view: ${formatEarningsModelView(row)}`);
    }
    lines.push("");
  }
  if (changed.length) {
    lines.push(EARNINGS_CHANGED_SUBTITLE, "");
    for (const row of changed) {
      const was = String(row?.prev_verdict_label || row?.prev_verdict || "—");
      lines.push(`${addedRowLabel(row, heldSet)} - ${formatEarningsWhen(row)}: ${was} → ${row?.verdict_label || "—"}`);
    }
    lines.push("");
  }
  return lines;
}

export function buildEarningsAddedSectionHtml(delta, heldSet, earningsUrl = "") {
  if (!hasEarningsAddedContent(delta)) return "";
  const sel = selectAddedRows(delta, heldSet);
  const changed = Array.isArray(delta.verdict_changed) ? delta.verdict_changed : [];
  const link = earningsUrl
    ? ` <a href="${escapeAttr(earningsUrl)}" style="color:#047857;text-decoration:underline;">Open Earnings Watch</a>`
    : "";

  const addedTable = sel.rows.length
    ? `
            <table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #a7f3d0;background:#f0fdf9;">
              <thead>
                <tr>
                  <th colspan="4" align="left" style="padding:12px;background:#d1fae5;font-family:Arial,sans-serif;font-size:14px;color:#065f46;">${escapeHtml(EARNINGS_ADDED_SECTION_TITLE)}</th>
                </tr>
                <tr>
                  <td colspan="4" style="padding:10px 12px;font-family:Arial,sans-serif;font-size:13px;color:#065f46;">${escapeHtml(EARNINGS_ADDED_SECTION_NOTE)} <span style="color:#047857;">${escapeHtml(addedCountLine(sel))}.</span>${link}</td>
                </tr>
                <tr>
                  <th align="left" style="padding:10px 12px;background:#ecfdf5;font-family:Arial,sans-serif;font-size:12px;color:#065f46;">Company</th>
                  <th align="left" style="padding:10px 12px;background:#ecfdf5;font-family:Arial,sans-serif;font-size:12px;color:#065f46;">Reports</th>
                  <th align="left" style="padding:10px 12px;background:#ecfdf5;font-family:Arial,sans-serif;font-size:12px;color:#065f46;">Quarter</th>
                  <th align="left" style="padding:10px 12px;background:#ecfdf5;font-family:Arial,sans-serif;font-size:12px;color:#065f46;">Model view</th>
                </tr>
              </thead>
              <tbody>
                ${sel.rows.map((row) => {
                  const style = verdictStyle(row?.verdict);
                  const confidence = String(row?.confidence_label || "").trim();
                  const confidenceCell = confidence && confidence !== "—"
                    ? ` <span style="color:#374151;">${escapeHtml(confidence)} confidence</span>`
                    : "";
                  return `
                <tr>
                  <td style="padding:10px 12px;border-top:1px solid #a7f3d0;font-family:Arial,sans-serif;font-size:13px;color:#111827;font-weight:700;">${escapeHtml(addedRowLabel(row, heldSet))}</td>
                  <td style="padding:10px 12px;border-top:1px solid #a7f3d0;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(formatEarningsWhen(row))}</td>
                  <td style="padding:10px 12px;border-top:1px solid #a7f3d0;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(row?.fiscal_quarter || "—")}</td>
                  <td style="padding:10px 12px;border-top:1px solid #a7f3d0;font-family:Arial,sans-serif;font-size:13px;color:#374151;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;border:1px solid ${style.border};background:${style.bg};color:${style.color};font-weight:700;font-size:12px;">${escapeHtml(row?.verdict_label || "Insufficient data")}</span>${confidenceCell}</td>
                </tr>`;
                }).join("\n")}
              </tbody>
            </table>`
    : "";

  const changedTable = changed.length
    ? `
            <table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #a7f3d0;background:#f0fdf9;margin-top:12px;">
              <thead>
                <tr>
                  <th colspan="3" align="left" style="padding:10px 12px;background:#d1fae5;font-family:Arial,sans-serif;font-size:13px;color:#065f46;">${escapeHtml(EARNINGS_CHANGED_SUBTITLE)}</th>
                </tr>
                <tr>
                  <th align="left" style="padding:10px 12px;background:#ecfdf5;font-family:Arial,sans-serif;font-size:12px;color:#065f46;">Company</th>
                  <th align="left" style="padding:10px 12px;background:#ecfdf5;font-family:Arial,sans-serif;font-size:12px;color:#065f46;">Reports</th>
                  <th align="left" style="padding:10px 12px;background:#ecfdf5;font-family:Arial,sans-serif;font-size:12px;color:#065f46;">Verdict was → now</th>
                </tr>
              </thead>
              <tbody>
                ${changed.map((row) => {
                  const style = verdictStyle(row?.verdict);
                  const was = escapeHtml(String(row?.prev_verdict_label || row?.prev_verdict || "—"));
                  return `
                <tr>
                  <td style="padding:10px 12px;border-top:1px solid #a7f3d0;font-family:Arial,sans-serif;font-size:13px;color:#111827;font-weight:700;">${escapeHtml(addedRowLabel(row, heldSet))}</td>
                  <td style="padding:10px 12px;border-top:1px solid #a7f3d0;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(formatEarningsWhen(row))}</td>
                  <td style="padding:10px 12px;border-top:1px solid #a7f3d0;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${was} → <span style="display:inline-block;padding:2px 7px;border-radius:999px;border:1px solid ${style.border};background:${style.bg};color:${style.color};font-weight:700;font-size:12px;">${escapeHtml(row?.verdict_label || "—")}</span></td>
                </tr>`;
                }).join("\n")}
              </tbody>
            </table>`
    : "";

  return `
        <tr>
          <td style="padding:0 20px 16px;">${addedTable}${changedTable}
          </td>
        </tr>`;
}

export function formatAlertStockLabel(alert) {
  const ticker = canonicalSwsTicker(alert?.ticker);
  const name = String(alert?.name || "").trim();
  if (ticker && name && name.toUpperCase() !== ticker) return `${name} (${ticker})`;
  return ticker || name || "Unknown stock";
}

export function formatAlertChangeSummary(change) {
  const field = formatAlertFieldLabel(change?.field);
  const delta = formatAlertChangeDelta(change);
  const suffix = delta ? ` (${delta})` : "";
  return `${field} changed from ${formatAlertChangeValue(change, "previous")} to ${formatAlertChangeValue(change, "current")}${suffix}`;
}

export function buildSwsInputAlertEmail({ alerts, runId, generatedAt, appUrl = "https://starbhai-stock-platform.vercel.app/", reductionHighlights = [], earningsRows = [], earningsAdded = null, heldTickers = [] }) {
  const alertList = Array.isArray(alerts) ? alerts : [];
  const normalizedReductionHighlights = normalizeReductionHighlights(reductionHighlights);
  const earningsList = Array.isArray(earningsRows) ? earningsRows : [];
  // ⭐ set for the "new in Earnings Watch" section — canonicalized so a
  // RELIANCE.NS holding stars the canonical RELIANCE row.
  const heldSet = new Set(
    (Array.isArray(heldTickers) ? heldTickers : []).map(canonicalSwsTicker).filter(Boolean),
  );
  const count = alertList.length;
  const stockLabels = alertList.map(formatAlertStockLabel);
  const subject = count === 1
    ? `SWS inputs changed for ${stockLabels[0]}`
    : `SWS inputs changed for ${count} portfolio holding(s)`;
  // gated/app.js routes on the hash fragment (parseHash() reads location.hash
  // only, never location.search). The old "?tab=analyzer" silently dropped
  // users on the default picks tab.
  const baseUrl = appUrl.replace(/\/$/, "");
  const analyzerUrl = `${baseUrl}/#tab=analyzer`;
  const earningsUrl = `${baseUrl}/#tab=earnings`;
  const timestamp = runId || generatedAt || "unknown";
  const lines = [
    subject,
    "",
    `${count === 1 ? "Affected stock" : "Affected stocks"}: ${stockLabels.join(", ") || "n/a"}`,
    `SWS refresh timestamp: ${timestamp}`,
    `Portfolio Analyzer: ${analyzerUrl}`,
    "",
  ];
  lines.push(...buildReductionHighlightsText(normalizedReductionHighlights));

  for (const alert of alertList) {
    lines.push(`${formatAlertStockLabel(alert)} - ${formatAlertImpactLabel(classifySwsInputAlertImpact(alert.changes))} impact`);
    for (const change of (alert.changes || []).slice(0, 5)) {
      lines.push(`- ${formatAlertImpactLabel(classifySwsInputChangeImpact(change))} impact: ${formatAlertChangeSummary(change)}`);
    }
    lines.push("");
  }

  lines.push(...buildEarningsSectionText(earningsList, earningsUrl));
  lines.push(...buildEarningsAddedSectionText(earningsAdded, heldSet, earningsUrl));

  lines.push("Review the Starbhai score/report before taking any decision. This email contains no buy/sell instruction.");
  if (earningsList.length || hasEarningsAddedContent(earningsAdded)) {
    lines.push("Earnings verdicts/scenarios are model predictions conditional on guidance disclosed at the concall. Open Earnings Watch for methodology and measured hit-rate.");
  }
  lines.push("Preferences: open Portfolio Analyzer in Starbhai to turn SWS input alert emails off.");
  const text = lines.join("\n");
  const html = buildSwsInputAlertEmailHtml({
    alertList,
    subject,
    timestamp,
    analyzerUrl,
    earningsUrl,
    reductionHighlights: normalizedReductionHighlights,
    earningsRows: earningsList,
    earningsAdded,
    heldSet,
  });
  return { subject, text, html };
}

function buildSwsInputAlertEmailHtml({ alertList, subject, timestamp, analyzerUrl, earningsUrl = "", reductionHighlights = [], earningsRows = [], earningsAdded = null, heldSet = new Set() }) {
  const rows = [];
  for (const alert of alertList) {
    const stock = formatAlertStockLabel(alert);
    for (const change of (alert.changes || []).slice(0, 5)) {
      const impact = classifySwsInputChangeImpact(change);
      const style = impactStyle(impact);
      rows.push(`
        <tr>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#111827;font-weight:700;">${escapeHtml(stock)}</td>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:12px;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;border:1px solid ${style.border};background:${style.bg};color:${style.color};font-weight:700;">${escapeHtml(formatAlertImpactLabel(impact))}</span></td>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(formatAlertFieldLabel(change.field))}</td>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(formatAlertChangeValue(change, "previous"))}</td>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(formatAlertChangeValue(change, "current"))}</td>
          <td style="padding:10px 12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#374151;">${escapeHtml(formatAlertChangeDelta(change) || "-")}</td>
        </tr>`);
    }
  }
  const bodyRows = rows.length
    ? rows.join("\n")
    : `<tr><td colspan="6" style="padding:14px 12px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:13px;color:#6b7280;">No material portfolio holding input changes.</td></tr>`;
  return `
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;background:#f8fafc;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:720px;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:20px 20px 12px;font-family:Arial,sans-serif;">
            <div style="font-size:18px;font-weight:700;color:#111827;">${escapeHtml(subject)}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:6px;">SWS refresh timestamp: ${escapeHtml(timestamp)}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:6px;"><a href="${escapeAttr(analyzerUrl)}" style="color:#2563eb;text-decoration:underline;">Open Portfolio Analyzer</a></div>
          </td>
        </tr>
        ${buildReductionHighlightsHtml(reductionHighlights)}
        <tr>
          <td style="padding:0 20px 16px;">
            <table width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border:1px solid #e5e7eb;">
              <thead>
                <tr>
                  <th align="left" style="padding:10px 12px;background:#f3f4f6;font-family:Arial,sans-serif;font-size:12px;color:#374151;">Stock</th>
                  <th align="left" style="padding:10px 12px;background:#f3f4f6;font-family:Arial,sans-serif;font-size:12px;color:#374151;">Impact</th>
                  <th align="left" style="padding:10px 12px;background:#f3f4f6;font-family:Arial,sans-serif;font-size:12px;color:#374151;">Signal</th>
                  <th align="left" style="padding:10px 12px;background:#f3f4f6;font-family:Arial,sans-serif;font-size:12px;color:#374151;">Previous</th>
                  <th align="left" style="padding:10px 12px;background:#f3f4f6;font-family:Arial,sans-serif;font-size:12px;color:#374151;">Current</th>
                  <th align="left" style="padding:10px 12px;background:#f3f4f6;font-family:Arial,sans-serif;font-size:12px;color:#374151;">Change</th>
                </tr>
              </thead>
              <tbody>
                ${bodyRows}
              </tbody>
            </table>
          </td>
        </tr>
        ${buildEarningsSectionHtml(earningsRows, earningsUrl)}
        ${buildEarningsAddedSectionHtml(earningsAdded, heldSet, earningsUrl)}
        <tr>
          <td style="padding:16px 20px;border-top:1px solid #e5e7eb;font-family:Arial,sans-serif;font-size:12px;color:#6b7280;">
            Review the Starbhai score/report before taking any decision. This email contains no buy/sell instruction.
            ${((Array.isArray(earningsRows) && earningsRows.length) || hasEarningsAddedContent(earningsAdded))
              ? "<br>Earnings verdicts/scenarios are model predictions conditional on guidance disclosed at the concall. Open Earnings Watch for methodology and measured hit-rate."
              : ""}
            <br>Preferences: open Portfolio Analyzer in Starbhai to turn SWS input alert emails off.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
