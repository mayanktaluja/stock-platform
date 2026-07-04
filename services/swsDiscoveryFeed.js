export const DISCOVERY_FEED_SCHEMA_VERSION = "sws-discovery-feed-v1";

export const DISCOVERY_LANES = [
  { id: "future_breakout", label: "Future Breakout" },
  { id: "off_section_high_future", label: "Off-section High Future" },
  { id: "momentum_news_confirmed", label: "Momentum + News" },
  { id: "upgrade_watch", label: "Upgrade Watch" },
];

const LANE_LABELS = new Map(DISCOVERY_LANES.map((lane) => [lane.id, lane.label]));
const ACTIONABLE_SECTION_IDS = new Set([
  "top_ranked_30_v4",
  "top_ranked_30_v3",
  "best_to_buy_now",
  "deep_value",
  "growing_sector_value",
  "quality_growth",
  "best_fundamentals",
  "midterm",
  "dividend_aristocrats",
  "smallcap_gems",
  "insider_buying",
]);

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value, digits = 1) {
  const n = finiteNumber(value);
  return n == null ? "N/A" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function canonicalTicker(value) {
  return String(value || "").trim().replace(/\.(NS|BO|BSE|NSE)$/i, "").toUpperCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstNumber(...values) {
  for (const value of values) {
    const n = finiteNumber(value);
    if (n != null) return n;
  }
  return null;
}

function pickOverview(deep) {
  return deep?.overview || deep?.data?.overview || {};
}

function getSnowflakeFuture(row, deep) {
  const ov = pickOverview(deep);
  const sf = ov.snowflake || row?.snowflake || {};
  return firstNumber(sf.future_growth, sf.future, row?.future_growth, row?.snowflake_future);
}

function getReturns(row, deep) {
  const ov = pickOverview(deep);
  const returns = ov.returns || ov.returns_pct || ov.price_returns || row?.returns || {};
  return {
    r7d: firstNumber(returns.r7d, returns["7d"], returns["7D"], returns.week, row?.r7d, row?.return_7d),
    r1m: firstNumber(returns.r1m, returns["1m"], returns["1M"], returns.month, row?.r1m, row?.return_1m),
    r3m: firstNumber(returns.r3m, returns["3m"], returns["3M"], row?.r3m, row?.return_3m),
    r6m: firstNumber(returns.r6m, returns["6m"], returns["6M"], row?.r6m, row?.return_6m),
    r1y: firstNumber(returns.r1y, returns["1y"], returns["1Y"], returns.year, row?.r1y, row?.return_1y),
  };
}

function getUpsidePct(row, deep) {
  const ov = pickOverview(deep);
  return firstNumber(
    row?.upside_pct,
    row?.fv_upside_pct,
    row?.fair_value_upside_pct,
    row?.analyst_upside_pct,
    ov?.upside_pct,
    ov?.fv_upside_pct,
    ov?.fair_value_upside_pct,
    ov?.analyst_upside_pct,
  );
}

function getCurrentPrice(row, deep) {
  const ov = pickOverview(deep);
  return firstNumber(
    row?.current_price_inr,
    row?.price_inr,
    row?.current_price,
    row?.price,
    ov?.current_price_inr,
    ov?.price_inr,
    ov?.current_price,
    ov?.price,
  );
}

function midpointRangeValue(range) {
  const min = firstNumber(range?.min);
  const max = firstNumber(range?.max);
  if (min != null && max != null && min > 0 && max > 0) return (min + max) / 2;
  return firstNumber(min, max);
}

function getDisplayUpside(row, deep) {
  const trusted = getUpsidePct(row, deep);
  if (trusted != null) return { value: trusted, source: "trusted_fv", displayOnly: false };

  const ov = pickOverview(deep);
  const price = getCurrentPrice(row, deep);
  const visibleFairValue = firstNumber(
    ov?.fair_value_display_inr,
    ov?.sws_fair_value_inr,
    midpointRangeValue(ov?.fair_value_range_inr),
  );
  if (price != null && price > 0 && visibleFairValue != null && visibleFairValue > 0) {
    return {
      value: ((visibleFairValue - price) / price) * 100,
      source: "sws_visible_range_midpoint",
      displayOnly: true,
    };
  }

  return { value: null, source: "missing", displayOnly: false };
}

function momentumScore(returns) {
  let score = 0;
  if ((returns.r7d ?? -Infinity) >= 5) score += 8;
  if ((returns.r1m ?? -Infinity) >= 8) score += 14;
  if ((returns.r3m ?? -Infinity) >= 10) score += 12;
  if ((returns.r6m ?? -Infinity) >= 30) score += 8;
  if ((returns.r1y ?? -Infinity) >= 25) score += 6;
  return score;
}

const POSITIVE_NEWS_RE = /\b(eps|earnings|profit|revenue|sales|income|margin|order|contract|approval|expansion|capacity|guidance|forecast|estimate|upgrade|rating|target|dividend|buyback|growth|rally|surge|jumps|wins|record|watchlist|attention|quality)\b/i;
const POSITIVE_CONTEXT_RE = /\b(up|higher|increase|rises|rose|improves|improved|beats|beat|strong|above|raises|raised|positive|accelerat|expands|wins|secured|approved|pleased|deserve|adding)\b/i;
const NEGATIVE_NEWS_RE = /\b(down|lower|falls|fell|cuts|cut|reduces|reduced|weak|miss|risk|resign|probe|fraud|default|downgrade|decline|loss|warning|margin lower|forecast down|trimming|concern)\b/i;

function parseDate(value) {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) ? ts : null;
}

function collectNews(deep) {
  return [
    ...asArray(deep?.news),
    ...asArray(deep?.recent_news),
    ...asArray(deep?.overview?.news),
  ];
}

function epsVsPriorIsUp(title) {
  const m = String(title || "").match(/EPS:\s*[₹$]?\s*([-+]?\d+(?:\.\d+)?).*?\bvs\b\s*[₹$]?\s*([-+]?\d+(?:\.\d+)?)/i);
  if (!m) return false;
  const current = Number(m[1]);
  const prior = Number(m[2]);
  return Number.isFinite(current) && Number.isFinite(prior) && current > prior;
}

function scoreNews(deep, generatedAt) {
  const now = parseDate(generatedAt) || Date.now();
  const items = collectNews(deep)
    .map((item) => ({
      title: item?.title || item?.headline || item?.summary || "",
      date: item?.date || item?.published_at || item?.publishedAt || item?.time || null,
      source: item?.source || item?.publisher || "",
    }))
    .filter((item) => item.title);
  let score = 0;
  const material = [];
  let latestAt = null;
  for (const item of items.slice(0, 18)) {
    const ts = parseDate(item.date);
    if (ts) {
      latestAt = latestAt == null ? ts : Math.max(latestAt, ts);
      const ageDays = (now - ts) / 86_400_000;
      if (ageDays > 90) continue;
    }
    const text = String(item.title);
    const positive = (POSITIVE_NEWS_RE.test(text) && POSITIVE_CONTEXT_RE.test(text)) || epsVsPriorIsUp(text);
    const negative = NEGATIVE_NEWS_RE.test(text);
    if (positive) {
      score += 2;
      material.push({ title: item.title, date: item.date, tone: "positive", source: item.source });
    } else if (negative) {
      score -= 2;
      material.push({ title: item.title, date: item.date, tone: "negative", source: item.source });
    }
  }
  return {
    score,
    material_count: material.length,
    latest_at: latestAt ? new Date(latestAt).toISOString() : null,
    top_headlines: material.slice(0, 3),
  };
}

function buildMembershipMap(picksLatest) {
  const map = new Map();
  for (const [sectionId, rows] of Object.entries(picksLatest?.sections || {})) {
    for (const row of asArray(rows)) {
      const ticker = canonicalTicker(row?.ticker || row?.symbol);
      if (!ticker) continue;
      if (!map.has(ticker)) map.set(ticker, new Set());
      map.get(ticker).add(sectionId);
    }
  }
  return map;
}

function normaliseInputChanges(inputChanges) {
  const map = new Map();
  for (const entry of asArray(inputChanges?.changes)) {
    const ticker = canonicalTicker(entry?.ticker);
    if (!ticker) continue;
    map.set(ticker, entry);
  }
  return map;
}

function changeCurrent(change, fieldRe) {
  for (const ch of asArray(change?.changes)) {
    if (fieldRe.test(String(ch?.field || ""))) return finiteNumber(ch?.current);
  }
  return null;
}

function hasConfirmedUpgrade(change) {
  for (const ch of asArray(change?.changes)) {
    const field = String(ch?.field || "");
    const prev = finiteNumber(ch?.previous);
    const cur = finiteNumber(ch?.current);
    if (/fair_value|upside|target/i.test(field) && cur != null && (prev == null || cur > prev * 1.05)) return true;
    if (/snowflake\.(future|future_growth|value|valuation|total)/i.test(field) && cur != null && (prev == null || cur > prev)) return true;
    if (/v4.*verdict|composite_verdict|verdict/i.test(field) && String(ch?.current || "") !== String(ch?.previous || "")) return true;
  }
  return false;
}

function isFutureDataUnavailable(future, deep) {
  if (future !== 0) return false;
  const dq = pickOverview(deep).snowflake_data_quality || {};
  const affected = asArray(dq.affected_pillars).map((v) => String(v).toLowerCase());
  const byPillar = dq.by_pillar || {};
  const futureQuality = byPillar.Future || byPillar.future || {};
  return affected.includes("future") || Number(futureQuality.insufficient || 0) >= 3;
}

function surveillanceValue(row, deep) {
  return row?.regulatory_flags?.surveillance || row?.risk_overlay?.surveillance || deep?.overview?.regulatory_flags?.surveillance || null;
}

function classifySurveillance(value) {
  const raw = String(value || "").toUpperCase();
  if (!raw) return { suppressed: false, caution: null };
  if (raw.includes("GSM")) return { suppressed: true, caution: "gsm_suppressed" };
  if (raw.includes("ASM")) return { suppressed: false, caution: "surveillance_hard_caution" };
  return { suppressed: false, caution: "surveillance_hard_caution" };
}

function sectionLabel(id) {
  return String(id || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function whySurfaced(item) {
  const parts = [];
  if (item.lanes.some((lane) => lane.id === "off_section_high_future")) {
    parts.push(`Future Growth ${item.future_growth}/6 with V4 ${item.v4_score}; not in an actionable curated section.`);
  }
  if (item.lanes.some((lane) => lane.id === "momentum_news_confirmed")) {
    parts.push(`Positive tape plus material recent headline: ${item.latest_headline || "recent SWS/news event"}.`);
  }
  if (item.lanes.some((lane) => lane.id === "future_breakout")) {
    parts.push(`Future Growth is now ${item.future_growth}/6 or newly confirmed high.`);
  }
  if (item.lanes.some((lane) => lane.id === "upgrade_watch")) {
    parts.push("Confirmed SWS input or valuation upgrade needs analyst review.");
  }
  if (!parts.length) parts.push("Meets Discovery Radar review-queue thresholds.");
  return parts.join(" ");
}

export function classifyDiscoveryItem(row, { deep = null, sections = [], inputChange = null, generatedAt = new Date().toISOString(), keepCuratedUpgradeWatch = false } = {}) {
  const ticker = canonicalTicker(row?.ticker || row?.symbol);
  if (!ticker) return null;
  const v4 = firstNumber(row?.v4_score, row?.v4_score_100, row?.canonical_score?.value, row?.score);
  const verdict = row?.v4_verdict || row?.canonical_score?.verdict || row?.composite_verdict || row?.verdict || null;
  const future = getSnowflakeFuture(row, deep);
  const returns = getReturns(row, deep);
  const displayUpside = getDisplayUpside(row, deep);
  const upsidePct = displayUpside.value;
  const news = scoreNews(deep, generatedAt);
  const momentum = momentumScore(returns);
  const currentFutureHigh = future != null && future >= 4;
  const changedFuture = changeCurrent(inputChange, /snowflake\.(future|future_growth)/i);
  const confirmedFutureHigh = changedFuture != null && changedFuture >= 4;
  const actionableSections = sections.filter((id) => ACTIONABLE_SECTION_IDS.has(id));
  const offActionableSection = actionableSections.length === 0;
  const lanes = [];

  if (currentFutureHigh || confirmedFutureHigh) lanes.push("future_breakout");
  if (currentFutureHigh && (v4 ?? 0) >= 47 && offActionableSection) lanes.push("off_section_high_future");
  if ((v4 ?? 0) >= 47 && momentum > 0 && news.score > 0) lanes.push("momentum_news_confirmed");
  if (inputChange && hasConfirmedUpgrade(inputChange)) lanes.push("upgrade_watch");
  if (!lanes.length) return null;

  // Dedup vs curated Picks: a name already in a curated actionable section is,
  // by definition, already surfaced in SWS Picks — the review queue must not
  // re-list it ("no dup names"). Drop it entirely, EXCEPT when the only reason
  // it surfaced is a confirmed fresh upgrade (upgrade_watch), which still
  // warrants an analyst look even for a curated name. The carve-out is
  // caller-controllable so the policy can be tuned without editing the classifier.
  if (!offActionableSection) {
    const upgradeOnly = lanes.length === 1 && lanes[0] === "upgrade_watch";
    if (!(keepCuratedUpgradeWatch && upgradeOnly)) return null;
  }

  const surveillance = classifySurveillance(surveillanceValue(row, deep));
  if (surveillance.suppressed) return null;

  const cautions = [];
  if (surveillance.caution) cautions.push(surveillance.caution);
  if (currentFutureHigh && !(momentum > 0 && news.score > 0)) cautions.push("needs_tape_confirmation");
  if (isFutureDataUnavailable(future, deep)) cautions.push("future_data_unavailable");
  if (news.score < 0) cautions.push("news_headwind");
  if (displayUpside.displayOnly) cautions.push("fv_display_only_range");
  if (row?.fair_value_inr == null && upsidePct == null) cautions.push("fv_unavailable");
  if ((returns.r1m ?? 0) >= 25 || (returns.r6m ?? 0) >= 60) cautions.push("extended_momentum");
  if ((row?.risk_overlay?.risks_count ?? 0) >= 4) cautions.push("multi_risk_flag");

  let radarScore = 0;
  if ((future ?? 0) >= 5) radarScore += 30;
  else if ((future ?? 0) >= 4) radarScore += 22;
  else if ((future ?? 0) >= 3) radarScore += 10;
  if (confirmedFutureHigh) radarScore += 18;
  radarScore += momentum;
  if (news.score > 2) radarScore += 16;
  else if (news.score > 0) radarScore += 8;
  else if (news.score < 0) radarScore -= 8;
  if ((v4 ?? 0) >= 59) radarScore += 14;
  else if ((v4 ?? 0) >= 47) radarScore += 8;
  else if ((v4 ?? 0) >= 37) radarScore += 3;
  if (lanes.includes("off_section_high_future")) radarScore += 30;
  if (lanes.includes("upgrade_watch")) radarScore += 8;
  if (lanes.includes("momentum_news_confirmed") && isFutureDataUnavailable(future, deep)) radarScore += 18;
  if (cautions.includes("surveillance_hard_caution")) radarScore -= 20;
  if (cautions.includes("multi_risk_flag")) radarScore -= 8;

  const item = {
    ticker,
    name: row?.name || pickOverview(deep)?.name || ticker,
    sector: row?.sector || pickOverview(deep)?.sector || null,
    lanes: lanes.map((id) => ({ id, label: LANE_LABELS.get(id) || sectionLabel(id) })),
    radar_score: Math.round(radarScore * 10) / 10,
    v4_score: v4,
    v4_verdict: verdict,
    future_growth: future,
    upside_pct: upsidePct,
    upside_source: displayUpside.source,
    upside_display_only: displayUpside.displayOnly,
    returns,
    latest_headline: news.top_headlines[0]?.title || null,
    news_signal: news,
    section_membership: sections.map((id) => ({ id, label: sectionLabel(id), actionable: ACTIONABLE_SECTION_IDS.has(id) })),
    caution_flags: [...new Set(cautions)],
    why_surfaced: "",
  };
  item.why_surfaced = whySurfaced(item);
  return item;
}

export function buildSwsDiscoveryFeed({
  scoredUniverse,
  picksLatest = null,
  deepByTicker = {},
  inputChanges = null,
  lastRefresh = null,
  generatedAt = new Date().toISOString(),
  maxItems = 250,
  keepCuratedUpgradeWatch = false,
} = {}) {
  const stocks = Array.isArray(scoredUniverse) ? scoredUniverse : asArray(scoredUniverse?.stocks);
  const membership = buildMembershipMap(picksLatest);
  const changes = normaliseInputChanges(inputChanges);
  const items = [];
  for (const row of stocks) {
    const ticker = canonicalTicker(row?.ticker || row?.symbol);
    if (!ticker) continue;
    const item = classifyDiscoveryItem(row, {
      deep: deepByTicker[ticker] || deepByTicker[row?.ticker] || null,
      sections: [...(membership.get(ticker) || new Set(asArray(row?.in_sections)))],
      inputChange: changes.get(ticker) || null,
      generatedAt,
      keepCuratedUpgradeWatch,
    });
    if (item) items.push(item);
  }
  items.sort((a, b) => (b.radar_score - a.radar_score) || String(a.ticker).localeCompare(String(b.ticker)));
  const capped = items.slice(0, maxItems);
  const sections = {};
  for (const lane of DISCOVERY_LANES) {
    sections[lane.id] = capped.filter((item) => item.lanes.some((l) => l.id === lane.id)).slice(0, 60);
  }
  const counts = {
    universe: stocks.length,
    items: capped.length,
    // Curated-membership tickers seen in picks-latest.json. A zero here means
    // the membership map was empty (picks missing/stale) and the curated dedup
    // silently no-op'd — observable in the committed artifact + catchable by tests.
    membership_tickers: membership.size,
  };
  for (const lane of DISCOVERY_LANES) counts[lane.id] = sections[lane.id].length;

  return {
    schema_version: DISCOVERY_FEED_SCHEMA_VERSION,
    generated_at: generatedAt,
    run_id: inputChanges?.run_id || lastRefresh?.run_id || lastRefresh?.finished_at || picksLatest?.scanned_at || generatedAt,
    available: true,
    source: {
      scored_universe_generated_at: scoredUniverse?.generated_at || null,
      picks_scanned_at: picksLatest?.scanned_at || null,
      input_changes_generated_at: inputChanges?.generated_at || null,
      confirmation_policy: inputChanges?.confirmation_policy || "two_consecutive_full_runs",
      last_refresh_finished_at: lastRefresh?.finished_at || null,
    },
    copy: {
      title: "Discovery Radar",
      subtitle: "Review queue for SWS names where future growth, momentum, or confirmed inputs are becoming interesting.",
      guardrail: "Not a buy-now list. Use this to decide what deserves a deeper analyst review.",
    },
    lanes: DISCOVERY_LANES,
    counts,
    items: capped,
    sections,
  };
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function upsideSourceLabel(item) {
  if (item?.upside_display_only) return "SWS range";
  if (item?.upside_pct == null) return "";
  return "Trusted FV";
}

function renderUpsideHtml(item) {
  const label = upsideSourceLabel(item);
  return `${htmlEscape(pct(item?.upside_pct))}${label ? `<br><span style="color:#6b7280;">${htmlEscape(label)}</span>` : ""}`;
}

function renderUpsideText(item) {
  const label = upsideSourceLabel(item);
  return `${pct(item?.upside_pct)}${label ? ` (${label})` : ""}`;
}

function renderEmailTable(title, items) {
  if (!items?.length) return "";
  const rows = items.slice(0, 30).map((item) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;"><strong>${htmlEscape(item.ticker)}</strong><br><span style="color:#6b7280;">${htmlEscape(item.name)}</span></td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${htmlEscape(item.v4_score ?? "N/A")}<br><span style="color:#6b7280;">${htmlEscape(item.v4_verdict || "N/A")}</span></td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${htmlEscape(item.future_growth ?? "N/A")}/6</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${renderUpsideHtml(item)}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;">7D ${htmlEscape(pct(item.returns?.r7d))}<br>1M ${htmlEscape(pct(item.returns?.r1m))}<br>3M ${htmlEscape(pct(item.returns?.r3m))}</td>
      <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${htmlEscape(item.why_surfaced)}${item.caution_flags?.length ? `<br><span style="color:#b45309;">Caution: ${htmlEscape(item.caution_flags.join(", "))}</span>` : ""}</td>
    </tr>`).join("");
  return `
    <h2 style="font-size:17px;margin:24px 0 8px;color:#111827;">${htmlEscape(title)}</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <thead><tr style="background:#f9fafb;color:#374151;text-align:left;font-size:12px;text-transform:uppercase;">
        <th style="padding:9px;">Stock</th><th style="padding:9px;">V4</th><th style="padding:9px;">Future</th><th style="padding:9px;">Upside</th><th style="padding:9px;">Tape</th><th style="padding:9px;">Why surfaced</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

export function buildDiscoveryFeedEmail(feed, { baseUrl = "https://starbhai-stock-platform.vercel.app" } = {}) {
  const counts = feed?.counts || {};
  const generated = feed?.generated_at ? new Date(feed.generated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "unknown";
  const subject = `Starbhai Discovery Radar: ${counts.items || 0} SWS review names`;
  const metric = (label, value) => `
    <td style="padding:14px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;">
      <div style="font-size:22px;font-weight:800;color:#111827;">${htmlEscape(value)}</div>
      <div style="font-size:12px;color:#6b7280;">${htmlEscape(label)}</div>
    </td>`;
  const laneTables = DISCOVERY_LANES
    .map((lane) => renderEmailTable(lane.label, feed?.sections?.[lane.id] || []))
    .join("");
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;color:#111827;line-height:1.45;max-width:960px;margin:0 auto;padding:24px;">
      <h1 style="font-size:24px;margin:0 0 4px;">Discovery Radar</h1>
      <p style="margin:0 0 14px;color:#4b5563;">SWS review queue for stocks where future growth, price tape, news, or confirmed inputs moved enough to deserve attention. This is not a buy-now list.</p>
      <p style="margin:0 0 18px;color:#6b7280;font-size:12px;">Generated ${htmlEscape(generated)} · Run ${htmlEscape(feed?.run_id || "unknown")} · <a href="${htmlEscape(baseUrl)}" style="color:#2563eb;">Open Market Intelligence</a></p>
      <table role="presentation" cellpadding="0" cellspacing="8" style="width:100%;border-collapse:separate;margin-bottom:12px;"><tr>
        ${metric("Total review names", counts.items || 0)}
        ${metric("Future Breakout", counts.future_breakout || 0)}
        ${metric("Off-section High Future", counts.off_section_high_future || 0)}
        ${metric("Momentum + News", counts.momentum_news_confirmed || 0)}
        ${metric("Upgrade Watch", counts.upgrade_watch || 0)}
      </tr></table>
      ${laneTables || `<p style="color:#6b7280;">No Discovery Radar names cleared today's review thresholds.</p>`}
      <p style="margin-top:22px;color:#6b7280;font-size:12px;">Guardrail: high future-growth names without tape/news confirmation are marked as review-only. Future 0/6 can mean no-data; momentum/news can still surface those names for manual inspection.</p>
    </div>`;
  const text = [
    "Discovery Radar",
    `Generated: ${generated}`,
    `Review names: ${counts.items || 0}`,
    "This is not a buy-now list.",
    "",
    ...DISCOVERY_LANES.flatMap((lane) => {
      const rows = (feed?.sections?.[lane.id] || []).slice(0, 30);
      if (!rows.length) return [];
      return [lane.label, ...rows.map((item) => `${item.ticker}: V4 ${item.v4_score ?? "N/A"}, Future ${item.future_growth ?? "N/A"}/6, Upside ${renderUpsideText(item)}, ${item.why_surfaced}`), ""];
    }),
  ].join("\n");
  return { subject, html, text };
}
