/* eslint-disable no-undef */
// Sector Outlook tab — bottom-up SWS news theme aggregation cross-checked
// against current macro regime. The EXPERIMENTAL label was dropped
// 2026-08-28 (surface is stable), but the SCOPE limits it flagged are
// unchanged and still stated in the DOM: no formal backtest gate, no named
// stock recommendations. The methodology, backtest-status and caveats
// sections are part of the SEBI-RA-conservative framing — do not remove them
// alongside the badge.

(function () {
  const LABEL_BADGE = {
    STRONG_TAILWIND: { color: "var(--emerald)", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.40)", text: "Strong tailwind" },
    TAILWIND:        { color: "var(--positive-text-emerald)", bg: "rgba(52,211,153,0.10)", border: "rgba(52,211,153,0.35)", text: "Tailwind" },
    NEUTRAL:         { color: "var(--text-gray)", bg: "rgba(156,163,175,0.10)", border: "rgba(156,163,175,0.30)", text: "Neutral" },
    HEADWIND:        { color: "var(--orange-bright)", bg: "rgba(251,146,60,0.10)", border: "rgba(251,146,60,0.35)", text: "Headwind" },
    STRONG_HEADWIND: { color: "var(--red-bright)", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.40)", text: "Strong headwind" },
  };

  const CONFIDENCE_DOT = {
    HIGH: { color: "var(--positive-text-emerald)", text: "High" },
    MED:  { color: "var(--warn-text)", text: "Medium" },
    LOW:  { color: "var(--text-gray)", text: "Low" },
  };

  const escapeHtml = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const FMT_PCT = (n, digits = 0) =>
    Number.isFinite(Number(n)) ? `${(Number(n) * 100).toFixed(digits)}%` : "—";
  const FMT_NUM = (n, digits = 1) =>
    Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : "—";
  const FMT_DATE = (s) => {
    try { return new Date(s).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" }); }
    catch { return "—"; }
  };
  const rowIdFor = (sector, horizon) =>
    `sector-outlook-drilldown-${String(horizon || "h").replace(/[^a-z0-9_-]/gi, "-")}-${String(sector || "sector").replace(/[^a-z0-9_-]/gi, "-")}`;

  function labelBadge(label) {
    const cfg = LABEL_BADGE[label] || LABEL_BADGE.NEUTRAL;
    return `<span style="display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; color:${cfg.color}; background:${cfg.bg}; border:1px solid ${cfg.border}; padding:2px 8px; border-radius:12px;">${cfg.text}</span>`;
  }

  function confidenceDot(conf) {
    const cfg = CONFIDENCE_DOT[conf] || CONFIDENCE_DOT.LOW;
    return `<span style="display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--text-muted);"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:${cfg.color};" aria-hidden="true"></span>${cfg.text}</span>`;
  }

  function decisionStateBadge(label = "Context only") {
    return `<span data-testid="decision-state" style="display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:700; color:var(--info-text-soft); background:rgba(96,165,250,0.10); border:1px solid rgba(96,165,250,0.28); padding:2px 8px; border-radius:12px;" title="Sector context only; stock-level evidence is still required.">${escapeHtml(label)}</span>`;
  }

  function trustBadge(score) {
    const n = Number(score);
    const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    const color = pct >= 75 ? "var(--positive-text-emerald)" : pct >= 45 ? "var(--warn-text)" : "var(--text-gray)";
    return `
      <span style="display:inline-flex; align-items:center; gap:7px; min-width:76px;">
        <span style="width:42px; height:6px; border-radius:999px; background:rgba(148,163,184,0.22); overflow:hidden;" aria-hidden="true">
          <span style="display:block; width:${pct}%; height:100%; background:${color};"></span>
        </span>
        <span style="font-variant-numeric:tabular-nums; color:${color}; font-weight:700;">${Number.isFinite(n) ? Math.round(n) : "—"}</span>
      </span>`;
  }

  // ── ranking model ──────────────────────────────────────────────
  // The tab ranks sectors by EXPECTED OUTLOOK DIRECTION (strongest tailwind
  // first), NOT by the trust/data-quality score. Trust is a confidence signal,
  // shown as its own column + the "Trust" sort mode, and used only as a
  // tie-break in the growth sort.
  const SORT_STORAGE_KEY = "sectorOutlookSort_v1";
  // Thin-evidence flag thresholds (90-day window). Soft: flag, don't hide.
  const NEWS_FLOOR = 40;
  const BREADTH_FLOOR = 0.2;

  const numOr = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // Signed growth-rank key for one horizon object. Prefers the authoritative
  // backend field (present after the PR2 regen); falls back to a client-side
  // de-bias for older payloads where `composite` still halves an uncorroborated
  // sector's signal toward NEUTRAL against a phantom-zero top-down.
  function growthKey(h) {
    if (!h || typeof h !== "object") return -Infinity;
    if (Number.isFinite(Number(h.growth_rank_score))) return Number(h.growth_rank_score);
    const raw = h.top_down?.status === "UNCORROBORATED"
      ? Number(h.bottom_up?.score)
      : Number(h.composite);
    return Number.isFinite(raw) ? raw : -Infinity;
  }

  function isThinEvidence(h) {
    const n = Number(h?.bottom_up?.n_news);
    const b = Number(h?.bottom_up?.breadth_pct);
    return (Number.isFinite(n) && n < NEWS_FLOOR) || (Number.isFinite(b) && b < BREADTH_FLOOR);
  }

  function thinPill(h) {
    if (!isThinEvidence(h)) return "";
    return `<span data-testid="thin-evidence" title="Thin evidence: under ${NEWS_FLOOR} classified news items or below ${Math.round(BREADTH_FLOOR * 100)}% sector breadth in the 90-day window — treat this rank as lower-confidence." style="display:inline-flex; align-items:center; gap:4px; margin-left:6px; font-size:10px; font-weight:600; color:var(--text-gray); background:rgba(156,163,175,0.10); border:1px solid rgba(156,163,175,0.30); padding:1px 6px; border-radius:10px;">⚠ thin</span>`;
  }

  // Legacy trust-first sort (kept behind the "Trust" sort mode).
  function sortSectorsByTrust(sectors, horizon) {
    const confidenceRank = { HIGH: 3, MED: 2, LOW: 1 };
    const directionRank = { STRONG_TAILWIND: 5, STRONG_HEADWIND: 4, TAILWIND: 3, HEADWIND: 2, NEUTRAL: 1 };
    return [...(sectors || [])].sort((a, b) => {
      const ah = a.horizons?.[horizon] || {};
      const bh = b.horizons?.[horizon] || {};
      const cr = (confidenceRank[bh.confidence] || 0) - (confidenceRank[ah.confidence] || 0);
      if (cr) return cr;
      const tr = (Number(bh.trust_score) || 0) - (Number(ah.trust_score) || 0);
      if (tr) return tr;
      const ar = Math.abs(Number(bh.composite) || 0) - Math.abs(Number(ah.composite) || 0);
      if (ar) return ar;
      return (directionRank[bh.outlook_label] || 0) - (directionRank[ah.outlook_label] || 0);
    });
  }

  // Default sort: signed growth key desc → trust → breadth → name (stable).
  // Comparison via `>` (not subtraction) so -Infinity sinks cleanly without NaN.
  function sortSectorsByGrowth(sectors, horizon) {
    return [...(sectors || [])].sort((a, b) => {
      const ah = a.horizons?.[horizon] || {};
      const bh = b.horizons?.[horizon] || {};
      const ga = growthKey(ah);
      const gb = growthKey(bh);
      if (ga !== gb) return gb > ga ? 1 : -1;
      const tr = (Number(bh.trust_score) || 0) - (Number(ah.trust_score) || 0);
      if (tr) return tr;
      const br = (Number(bh.bottom_up?.breadth_pct) || 0) - (Number(ah.bottom_up?.breadth_pct) || 0);
      if (br) return br;
      return String(a.sector || "").localeCompare(String(b.sector || ""));
    });
  }

  // Single-column accessors for click-to-sort headers.
  const COLUMN_ACCESSORS = {
    composite: (h) => growthKey(h),
    trust: (h) => numOr(h?.trust_score, -Infinity),
    breadth: (h) => numOr(h?.bottom_up?.breadth_pct, -Infinity),
    news: (h) => numOr(h?.bottom_up?.n_news, -Infinity),
  };

  function sortSectors(sectors, horizon, sortState) {
    const st = sortState || { key: "growth", dir: "desc" };
    if (st.key === "trustLegacy") return sortSectorsByTrust(sectors, horizon);
    if (st.key === "growth" || !COLUMN_ACCESSORS[st.key]) return sortSectorsByGrowth(sectors, horizon);
    const accessor = COLUMN_ACCESSORS[st.key];
    const mult = st.dir === "asc" ? -1 : 1; // desc default (highest on top)
    return [...(sectors || [])].sort((a, b) => {
      const va = accessor(a.horizons?.[horizon] || {});
      const vb = accessor(b.horizons?.[horizon] || {});
      if (va !== vb) return (vb > va ? 1 : -1) * mult;
      return String(a.sector || "").localeCompare(String(b.sector || ""));
    });
  }

  function readSortState() {
    try {
      const raw = localStorage.getItem(SORT_STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p.key === "string") {
          return { key: p.key, dir: p.dir === "asc" ? "asc" : "desc" };
        }
      }
    } catch { /* ignore */ }
    return { key: "growth", dir: "desc" };
  }

  function writeSortState(st) {
    try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(st)); } catch { /* ignore */ }
  }

  function renderTrustFactors(factors) {
    if (!Array.isArray(factors) || factors.length === 0) {
      return `<div style="font-size:12px; color:var(--text-muted);">Trust factors unavailable for this refresh.</div>`;
    }
    return `
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; margin-top:8px;">
        ${factors.map((f) => `
          <div style="border:1px solid var(--bg-graphite); border-radius:8px; padding:9px 10px;">
            <div style="display:flex; justify-content:space-between; gap:8px; align-items:baseline;">
              <span style="font-size:11px; color:var(--text-secondary); font-weight:700;">${escapeHtml(f.label || f.key || "Factor")}</span>
              <span style="font-size:11px; color:var(--text-muted); font-variant-numeric:tabular-nums;">${FMT_NUM(f.contribution, 1)}/${escapeHtml(f.weight ?? "—")}</span>
            </div>
            <div style="font-size:10px; color:var(--text-muted); margin-top:4px; line-height:1.35;">${escapeHtml(f.status ? `${f.status} · ${f.detail || ""}` : f.detail || "")}</div>
          </div>`).join("")}
      </div>`;
  }

  function renderHeader(doc, horizon) {
    const h = horizon || "3_12m";
    const ts = doc.generated_at
      ? new Date(doc.generated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
      : "—";
    const regimeLabel = doc.regime_at_generation?.regime || "—";
    const regimeSeverity = doc.regime_at_generation?.severity ?? "—";
    const tally = { STRONG_TAILWIND: 0, TAILWIND: 0, NEUTRAL: 0, HEADWIND: 0, STRONG_HEADWIND: 0 };
    for (const s of doc.sectors || []) {
      const l = s.horizons?.[h]?.outlook_label || "NEUTRAL";
      tally[l] = (tally[l] || 0) + 1;
    }
    const tiles = [
      { value: tally.STRONG_TAILWIND + tally.TAILWIND, label: "Tailwind sectors", color: "var(--emerald)", termId: "sector_tailwind" },
      { value: tally.HEADWIND + tally.STRONG_HEADWIND, label: "Headwind sectors", color: "var(--red-bright)", termId: "sector_headwind" },
      { value: tally.NEUTRAL, label: "Neutral / divergent", color: "var(--text-gray)", termId: "sector_neutral" },
      { value: regimeLabel, label: `Macro regime · severity ${regimeSeverity}`, color: "var(--purple-bright)", termId: "macro_regime" },
      { value: ts, label: "Last refreshed", color: "var(--text-muted)" },
    ];
    return `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; flex-wrap:wrap; gap:12px; padding-bottom:16px; border-bottom:1px solid var(--bg-graphite);">
        <div>
          <h2 class="editorial-headline" style="font-size:34px; font-weight:500; letter-spacing:-0.02em;">
            Sector Outlook
          </h2>
          <p style="font-size:12px; color:var(--text-muted); margin-top:3px; max-width:760px; line-height:1.55;">
            Indicative outlook for the same ${escapeHtml(doc.audit?.sector_count || (doc.sectors || []).length)} SWS sector labels used by India Market over two horizons (3-12 months, 12-24 months). Bottom-up news themes aggregated from SWS deep briefs, cross-checked against the current macro regime. Sector-level only - no specific stock recommendations.
          </p>
        </div>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:10px; margin-bottom:24px;">
        ${tiles.map((t) => `
          <div style="padding:14px 16px; background:var(--bg-secondary); border-radius:8px;">
            <div style="font-size:22px; font-weight:600; color:${t.color}; font-variant-numeric:tabular-nums;">${escapeHtml(t.value)}</div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:3px;">${escapeHtml(t.label)}${t.termId ? infoIcon(t.termId) : ""}</div>
          </div>`).join("")}
      </div>`;
  }

  function renderRuntimeAudit(doc) {
    const audit = doc.runtime_audit || {};
    if (!audit.stale && !audit.macro_mismatch) return "";
    const bits = [];
    if (audit.stale) {
      const age = Number.isFinite(Number(audit.age_hours)) ? `${Number(audit.age_hours).toFixed(1)}h old` : "age unknown";
      bits.push(`Outlook is stale (${age}; threshold ${escapeHtml(audit.stale_threshold_hours || 36)}h).`);
    }
    if (audit.macro_mismatch) {
      bits.push(`Generated under ${escapeHtml(audit.outlook_regime || "unknown macro")}, current macro is ${escapeHtml(audit.current_regime || "unknown")}.`);
    }
    return `
      <div style="margin:-10px 0 18px 0; padding:12px 14px; border:1px solid rgba(251,146,60,0.35); background:rgba(251,146,60,0.08); color:var(--text-secondary); border-radius:8px; font-size:12px; line-height:1.5;">
        <strong style="color:#fb923c;">Refresh warning.</strong>
        ${bits.join(" ")} Treat sector labels as directional context only until the next Sector Outlook refresh.
      </div>`;
  }

  function renderMatrixRow(sectorRow, horizon) {
    const h = sectorRow.horizons?.[horizon] || {};
    const label = h.outlook_label || "NEUTRAL";
    const conf = h.confidence || "LOW";
    const trustScore = h.trust_score;
    const composite = h.composite ?? 0;
    const bottomUp = h.bottom_up?.score ?? 0;
    const topDown = h.top_down?.score ?? 0;
    const breadth = h.bottom_up?.breadth_pct ?? 0;
    const nNews = h.bottom_up?.n_news ?? 0;
    const topThemes = (h.bottom_up?.top_themes || []).slice(0, 2);
    const topThemesStr = topThemes.map((t) => `${escapeHtml(t.theme.replace(/_/g, " "))} ${FMT_PCT(t.pct)}`).join(", ") || "—";
    const drillId = rowIdFor(sectorRow.sector, horizon);
    const gScore = growthKey(h);
    const gScoreAttr = Number.isFinite(gScore) ? gScore.toFixed(4) : "";
    return `
      <tr data-testid="sector-outlook-row" data-sector="${escapeHtml(sectorRow.sector)}" data-growth-score="${escapeHtml(gScoreAttr)}" tabindex="0" role="button" aria-expanded="false" aria-controls="${escapeHtml(drillId)}" style="border-bottom:1px solid var(--bg-graphite); cursor:pointer;" onclick="window.__sectorOutlookToggleDrillDown(this)" onkeydown="window.__sectorOutlookToggleDrillDown(this, event)">
        <td style="padding:10px 8px; font-weight:600;">${escapeHtml(sectorRow.sector)}</td>
        <td data-trust-score="${escapeHtml(Number.isFinite(Number(trustScore)) ? Number(trustScore).toFixed(2) : "")}" style="padding:10px 8px;">${trustBadge(trustScore)}</td>
        <td style="padding:10px 8px;">${labelBadge(label)} <span style="margin-left:6px;">${decisionStateBadge()}</span></td>
        <td style="padding:10px 8px;">${confidenceDot(conf)}${thinPill(h)}</td>
        <td style="padding:10px 8px; text-align:right; font-variant-numeric:tabular-nums; color:${composite > 0 ? "var(--positive-text-emerald)" : composite < 0 ? "var(--orange-bright)" : "var(--text-muted)"};">${FMT_NUM(composite, 2)}</td>
        <td style="padding:10px 8px; text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${FMT_NUM(bottomUp, 2)}</td>
        <td style="padding:10px 8px; text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${FMT_NUM(topDown, 2)}</td>
        <td style="padding:10px 8px; text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${FMT_PCT(breadth)}</td>
        <td style="padding:10px 8px; text-align:right; font-variant-numeric:tabular-nums; color:var(--text-muted);">${nNews}</td>
        <td style="padding:10px 8px; color:var(--text-muted); font-size:11px;">${topThemesStr}</td>
      </tr>`;
  }

  function renderDrillDownRow(sectorRow, horizon) {
    const h = sectorRow.horizons?.[horizon] || {};
    const evidence = h.evidence_top5 || [];
    const tdReason = h.top_down?.reason || "";
    const tdRegime = h.top_down?.regime || "";
    const topThemes = h.bottom_up?.top_themes || [];
    const drillId = rowIdFor(sectorRow.sector, horizon);
    return `
      <tr id="${escapeHtml(drillId)}" data-drilldown-for="${escapeHtml(sectorRow.sector)}" style="display:none; background:var(--bg-secondary);">
        <td colspan="10" style="padding:18px 24px;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:24px; max-width:1100px;">
            <div>
              <h4 style="font-size:13px; margin:0 0 8px 0; color:var(--text-primary);">Trust factors ${infoIcon("sector_trust_factors")}</h4>
              ${renderTrustFactors(h.trust_factors || [])}
              <h4 style="font-size:13px; margin:16px 0 8px 0; color:var(--text-primary);">Bottom-up signal</h4>
              <p style="font-size:12px; color:var(--text-muted); line-height:1.55; margin:0 0 12px 0;">
                Cross-check: <strong style="color:var(--text-secondary);">${escapeHtml(h.cross_check || "NEUTRAL")}</strong>.
                ${escapeHtml(h.bottom_up?.n_news ?? 0)} news items in the 90-day window across ${escapeHtml(h.bottom_up?.n_tickers ?? 0)} tickers.
                Catalyst proximity: ${escapeHtml(h.bottom_up?.catalyst_proximity_count ?? 0)} short-horizon events in last 30 days.
              </p>
              <div style="font-size:12px; color:var(--text-muted);">Top observed themes:</div>
              <ul style="font-size:12px; color:var(--text-secondary); padding-left:20px; margin:6px 0 0 0;">
                ${topThemes.map((t) => `<li>${escapeHtml(t.theme.replace(/_/g, " "))} — ${FMT_PCT(t.pct, 1)} of weighted signal</li>`).join("") || "<li>(no themes observed)</li>"}
              </ul>
            </div>
            <div>
              <h4 style="font-size:13px; margin:0 0 8px 0; color:var(--text-primary);">Top-down macro</h4>
              <p style="font-size:12px; color:var(--text-muted); line-height:1.55; margin:0 0 12px 0;">
                Regime: <strong style="color:var(--text-secondary);">${escapeHtml(tdRegime || "n/a")}</strong>${tdReason ? ` — ${escapeHtml(tdReason)}` : ""}
                ${h.top_down?.status ? `<br>Status: <strong style="color:var(--text-secondary);">${escapeHtml(h.top_down.status)}</strong>` : ""}
              </p>
              <h4 style="font-size:13px; margin:18px 0 8px 0; color:var(--text-primary);">Evidence (top 5 news items)</h4>
              <ul style="font-size:11px; color:var(--text-secondary); padding-left:18px; margin:0; line-height:1.55;">
                ${evidence.map((e) => `<li><strong>${escapeHtml(e.ticker)}</strong> · ${FMT_DATE(e.date)} · <em>${escapeHtml(e.theme.replace(/_/g, " "))}</em> · ${e.sign > 0 ? "+" : ""}${escapeHtml(e.sign)}<br>${escapeHtml((e.title || "").slice(0, 140))}</li>`).join("") || "<li>(no signed evidence in window)</li>"}
              </ul>
            </div>
          </div>
        </td>
      </tr>`;
  }

  // Toggle drill-down row visibility. Exposed on window for the inline onclick.
  window.__sectorOutlookToggleDrillDown = function (rowEl, ev) {
    if (ev && ev.type === "keydown") {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
    }
    const drill = rowEl.nextElementSibling?.getAttribute("data-drilldown-for")
      ? rowEl.nextElementSibling
      : null;
    if (!drill) return;
    const opening = drill.style.display === "none";
    drill.style.display = opening ? "" : "none";
    rowEl.setAttribute("aria-expanded", String(opening));
  };

  // `iconHtml` is passed pre-rendered (e.g. infoIcon("sector_trust_score")) so the
  // glossary-id literal stays in the render source for the coverage scanner.
  function sortableTh(label, iconHtml, sortKey, sortState, align) {
    const isActive = sortState?.key === sortKey;
    const ariaSort = isActive ? (sortState.dir === "asc" ? "ascending" : "descending") : "none";
    const arrow = isActive ? (sortState.dir === "asc" ? " ▲" : " ▼") : "";
    const color = isActive ? "var(--purple-bright)" : "inherit";
    return `<th data-sort-key="${sortKey}" aria-sort="${ariaSort}" class="sector-outlook-sortable-th" title="Click to sort by ${escapeHtml(label)}" style="padding:10px 8px; text-align:${align}; cursor:pointer; user-select:none; color:${color};">${label}${iconHtml || ""}${arrow}</th>`;
  }

  function renderMatrix(doc, horizon, sortState) {
    const sectors = sortSectors(doc.sectors || [], horizon, sortState);
    if (!sectors.length) {
      return `<div class="empty-state" style="padding:32px; text-align:center; color:var(--text-muted);">No sector outlooks published yet — they appear after the nightly SWS news classification.${(window.adminDetail && window.adminDetail("Refresh: scripts/refresh-sector-outlook.mjs")) || ""}</div>`;
    }
    const rows = sectors.map((s) => renderMatrixRow(s, horizon) + renderDrillDownRow(s, horizon)).join("");
    return `
      <div style="overflow-x:auto; margin-bottom:24px;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--bg-graphite); color:var(--text-muted); font-size:11px; letter-spacing:0.04em; text-transform:uppercase;">
              <th style="padding:10px 8px; text-align:left;">Sector</th>
              ${sortableTh("Trust", infoIcon("sector_trust_score"), "trust", sortState, "left")}
              <th style="padding:10px 8px; text-align:left;">Outlook${infoIcon("sector_outlook_label")}</th>
              <th style="padding:10px 8px; text-align:left;">Confidence${infoIcon("sector_outlook_confidence")}</th>
              ${sortableTh("Composite", infoIcon("sector_composite"), "composite", sortState, "right")}
              <th style="padding:10px 8px; text-align:right;">Bottom-up${infoIcon("sector_bottom_up")}</th>
              <th style="padding:10px 8px; text-align:right;">Top-down${infoIcon("sector_top_down")}</th>
              ${sortableTh("Breadth", infoIcon("sector_breadth"), "breadth", sortState, "right")}
              ${sortableTh("News (90d)", infoIcon("sector_news_90d"), "news", sortState, "right")}
              <th style="padding:10px 8px; text-align:left;">Top themes${infoIcon("sector_top_themes")}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderSortToggle(sortState) {
    const key = sortState?.key || "growth";
    const btn = (mode, label, tip) => {
      const on = key === mode;
      return `<button type="button" class="sector-outlook-sort-btn" data-sort-mode="${mode}" aria-pressed="${on}" title="${escapeHtml(tip)}"
        style="padding:6px 14px; border-radius:14px; font-size:12px; font-weight:500; border:1px solid ${on ? "rgba(167,139,250,0.4)" : "var(--bg-graphite)"}; background:${on ? "rgba(167,139,250,0.10)" : "transparent"}; color:${on ? "var(--purple-bright)" : "var(--text-muted)"}; cursor:pointer;">${escapeHtml(label)}</button>`;
    };
    return `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
        <span style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">Sort${infoIcon("sector_growth_sort")}</span>
        ${btn("growth", "Growth outlook", "Strongest tailwind first — ranked by the bottom-up news signal cross-checked with the macro regime. Indicative context, not a forecast.")}
        ${btn("trustLegacy", "Trust", "Rank by data-confidence (evidence volume, breadth, freshness) instead of outlook direction.")}
      </div>`;
  }

  function renderHorizonTabs(active) {
    const tabs = [
      { id: "3_12m", label: "3–12 months" },
      { id: "12_24m", label: "12–24 months" },
    ];
    return `
      <div role="tablist" aria-label="Sector outlook horizon" style="display:flex; gap:8px; margin-bottom:16px;">
        ${tabs.map((t) => `
          <button type="button" class="sector-outlook-horizon-tab" data-horizon="${t.id}" aria-selected="${t.id === active}"
            style="padding:6px 14px; border-radius:14px; font-size:12px; font-weight:500; border:1px solid ${t.id === active ? "rgba(167,139,250,0.4)" : "var(--bg-graphite)"}; background:${t.id === active ? "rgba(167,139,250,0.10)" : "transparent"}; color:${t.id === active ? "var(--purple-bright)" : "var(--text-muted)"}; cursor:pointer;">
            ${escapeHtml(t.label)}
          </button>`).join("")}
      </div>`;
  }

  function renderMethodologySection(doc) {
    const caveats = doc.caveats || [];
    return `
      <details style="margin-top:24px; background:var(--bg-secondary); border-radius:8px; padding:14px 20px;">
        <summary style="font-size:13px; font-weight:600; cursor:pointer; color:var(--text-primary);">Methodology · How we compute this</summary>
        <div style="font-size:12px; color:var(--text-secondary); line-height:1.7; padding-top:12px; max-width:800px;">
          <p><strong>Inputs.</strong> Per-stock news arrays from SWS deep briefs (data/sws/deep/&lt;TICKER&gt;.json:news[]), with the current macro regime classification (data/macroRegime.json) as the cross-check signal.</p>
          <p><strong>Bottom-up.</strong> Every SWS news item is classified into one of 8 themes (Capacity/Capex, M&amp;A, Order Wins, Regulatory Event, Margin Move, Earnings Move, Strategic/Geopolitical, Neutral) plus a directional sign and intensity. A deterministic keyword classifier produces the first pass; an LLM refines the ambiguous items within a 365-day recency window. Each India Market sector aggregates its news across three rolling windows (30d / 90d / 365d) into a market-cap-weighted signal, with a 15% single-issuer breadth cap so no one ticker can dominate. Macro-bucket consumers can still use conglomerate routing, but this tab preserves the user-visible India Market sector label.</p>
          <p><strong>Top-down.</strong> Indian regulator + global wire RSS headlines (RBI, SEBI, Reuters, Bloomberg, Moneycontrol, Economic Times, etc.) are classified into one of 9 macro regimes with per-sector impact scores. Sector rows keep the same labels as India Market; the macro cross-check normalizes those labels to broader macro buckets. The Sector Outlook reads only the CURRENT regime (v1 deliberately doesn&apos;t smooth across history).</p>
          <p><strong>Ranking.</strong> Rows are ranked by outlook direction — the bottom-up news signal cross-checked with the macro regime — strongest tailwind first, so the sectors where the observed news and macro flow lean most positive sit on top. This is indicative context, not a forecast. When the macro regime is neutral for a sector (uncorroborated), the composite uses the bottom-up signal directly rather than halving it toward neutral against an absent macro read.</p>
          <p><strong>Trust model.</strong> Trust is a separate 0–100 confidence score, shown in its own column — it does <em>not</em> set the rank order. It blends evidence volume, breadth, 30/90/365-day stability, macro/external agreement, classifier confidence, available sector-index confirmation, and freshness. Switch the Sort control to "Trust" to rank by confidence instead of outlook. Rows with thin evidence (few news items or low breadth) are flagged. Missing macro or index context is marked UNCORROBORATED; true opposite-sign evidence is marked DIVERGENT and reduces trust.</p>
          <p><strong>What v1 does NOT do.</strong> No formal walk-forward backtest. No named stock recommendations within a sector. No 24-36 month horizon. The macro regime history is too thin for honest analog signal at multi-year scales — that&apos;s a v2 scope decision.</p>
          ${caveats.length ? `<div style="margin-top:14px; padding:12px 14px; background:rgba(167,139,250,0.06); border:1px solid rgba(167,139,250,0.22); border-radius:6px; font-size:11px;"><strong style="color:var(--purple-bright);">Important caveats:</strong><ul style="margin:6px 0 0 0; padding-left:20px;">${caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>` : ""}
          <p style="margin-top:18px; font-size:11px; color:var(--text-muted);">Audit: classifier ${escapeHtml(doc.audit?.taxonomy_version || "—")} · synthesizer ${escapeHtml(doc.audit?.synthesizer_version || "—")} · ${escapeHtml(doc.audit?.sector_count ?? 0)} sectors · ${escapeHtml(doc.audit?.orphaned_tickers ?? 0)} orphaned tickers (sector taxonomy drift canary).</p>
        </div>
      </details>`;
  }

  function renderBacktestPanel(doc) {
    return `
      <details style="margin-top:14px; background:var(--bg-secondary); border-radius:8px; padding:14px 20px;">
        <summary style="font-size:13px; font-weight:600; cursor:pointer; color:var(--text-primary);">Backtest status</summary>
        <div style="font-size:12px; color:var(--text-secondary); line-height:1.6; padding-top:12px; max-width:800px;">
          <p><strong>No formal backtest gate yet.</strong></p>
          <p>The signal is indicative based on observed news themes + the current macro regime. v2 will add a walk-forward harness against NSE sector index returns (^CNXAUTO, ^CNXIT, ^CNXMETAL, etc.) at 90d and 365d horizons. Any future promotion label requires ≥80 resolved sector-quarters across ≥2 fiscal quarters with ≥55% directional hit-rate and Brier &lt; 0.22.</p>
          <p style="color:var(--text-muted); font-size:11px; margin-top:14px;">Gate status: <strong>${doc.gate_met ? "MET" : "NOT MET (v1 — backtest deferred)"}</strong></p>
        </div>
      </details>`;
  }

  function renderError(message) {
    return `<div style="padding:32px; text-align:center; color:var(--negative-text-soft); font-size:13px;">${escapeHtml(message)}</div>`;
  }

  function attachHorizonHandlers(rootEl, doc, currentHorizon, sortState) {
    rootEl.querySelectorAll(".sector-outlook-horizon-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("data-horizon");
        if (next === currentHorizon) return;
        renderInto(rootEl, doc, next, sortState); // preserve the active sort across horizons
      });
    });
  }

  function attachSortHandlers(rootEl, doc, horizon, sortState) {
    rootEl.querySelectorAll(".sector-outlook-sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-sort-mode");
        if (sortState?.key === mode) return;
        const next = { key: mode, dir: "desc" };
        writeSortState(next);
        renderInto(rootEl, doc, horizon, next);
      });
    });
    rootEl.querySelectorAll(".sector-outlook-sortable-th").forEach((th) => {
      th.addEventListener("click", () => {
        const colKey = th.getAttribute("data-sort-key");
        const dir = sortState?.key === colKey && sortState.dir === "desc" ? "asc" : "desc";
        const next = { key: colKey, dir };
        writeSortState(next);
        renderInto(rootEl, doc, horizon, next);
      });
    });
  }

  function renderInto(rootEl, doc, horizon, sortState) {
    const h = horizon || "3_12m";
    const st = sortState || readSortState();
    rootEl.innerHTML =
      renderHeader(doc, h) +
      renderRuntimeAudit(doc) +
      renderHorizonTabs(h) +
      renderSortToggle(st) +
      renderMatrix(doc, h, st) +
      renderMethodologySection(doc) +
      renderBacktestPanel(doc);
    attachHorizonHandlers(rootEl, doc, h, st);
    attachSortHandlers(rootEl, doc, h, st);
  }

  async function loadSectorOutlook() {
    const el = document.getElementById("sectorOutlookTab");
    if (!el) return;
    el.innerHTML = `<div style="padding:32px; text-align:center; color:var(--text-muted);">Loading Sector Outlook…</div>`;
    try {
      const res = await fetch("/api/sector-outlook/latest");
      if (res.status === 503) {
        el.innerHTML = renderError("Sector Outlook is being generated. Try again in a minute.");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      if (!doc || !Array.isArray(doc.sectors)) {
        el.innerHTML = renderError("Sector Outlook payload is malformed.");
        return;
      }
      renderInto(el, doc, "3_12m", readSortState());
    } catch (err) {
      console.error("[sectorOutlook] load failed:", err);
      el.innerHTML = renderError(`Failed to load Sector Outlook: ${err.message}`);
    }
  }

  window.loadSectorOutlook = loadSectorOutlook;
})();
