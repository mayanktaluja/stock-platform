/**
 * earnings.js — Earnings Watch tab UI.
 *
 * Carved out of app.js (already 11k+ lines) so the earnings feature
 * can grow without bloating the monolith. Loads after app.js, reuses
 * its globals: switchTab(), openStockDetailModal(), escapeHtml(),
 * fmtINR(), formatRelativeTime(). When this file ships ahead of those
 * globals being set, the loaders gracefully no-op and the tab simply
 * shows its loading skeleton.
 *
 * Milestone A scope: calendar list with fiscal quarter, days-until,
 * ancillary tags. Filter bar is days-until + symbol search. Later
 * milestones light up: predicted-verdict badge, confidence ring,
 * Bull/Base/Bear price band, top-3 rationale, falsification triggers,
 * data-quality badge, T+1 reaction playbook.
 */

(function () {
  "use strict";

  // ────────── Module state ──────────
  // Last successful API responses, kept so the filter bar can re-render
  // without re-fetching. Refresh button blows them away.
  let _earningsSnapshot = null;
  let _earningsStats = null;
  let _earningsFilters = { days: 30, symbol: "", quality: "ALL", runup: "ALL", verdict: "ALL", sector: "ALL" };

  // Per-date collapsed state for the calendar — persisted across reloads
  // so a user who collapsed e.g. May 30 doesn't see it re-expand the next
  // time they open the tab. Mirrors the SWS Picks collapse pattern in
  // app.js without sharing the helper (earnings.js is an isolated IIFE).
  const EARNINGS_COLLAPSED_KEY = "earningsCollapsedDates";

  function loadEarningsCollapsedState() {
    try { return JSON.parse(localStorage.getItem(EARNINGS_COLLAPSED_KEY)) || {}; }
    catch { return {}; }
  }
  function saveEarningsCollapsedState(state) {
    try { localStorage.setItem(EARNINGS_COLLAPSED_KEY, JSON.stringify(state)); } catch {}
  }

  // ────────── Tiny safe formatters ──────────
  // We intentionally do not depend on the app.js helpers being loaded
  // first — earnings.js has `defer` so it runs after app.js, but a
  // future refactor that swaps the load order shouldn't break us.

  function escHtml(s) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(s);
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function fmtRelativeDate(isoDate, daysUntil) {
    if (typeof daysUntil === "number") {
      if (daysUntil === 0) return "today";
      if (daysUntil === 1) return "tomorrow";
      if (daysUntil > 0) return `in ${daysUntil}d`;
      if (daysUntil === -1) return "yesterday";
      return `${Math.abs(daysUntil)}d ago`;
    }
    return isoDate || "?";
  }

  function fmtIsoToLong(isoDate) {
    if (!isoDate || typeof isoDate !== "string") return "";
    const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return isoDate;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthIdx = Number(m[2]) - 1;
    if (monthIdx < 0 || monthIdx > 11) return isoDate;
    return `${m[3]} ${months[monthIdx]} ${m[1]}`;
  }

  function dayPillClass(daysUntil) {
    // Visual urgency cue. Red-amber-yellow-grey; matches the platform's
    // existing semantic palette without introducing new tokens.
    if (typeof daysUntil !== "number") return "earnings-day-pill earnings-day-pill--unknown";
    if (daysUntil <= 0) return "earnings-day-pill earnings-day-pill--today";
    if (daysUntil <= 3) return "earnings-day-pill earnings-day-pill--soon";
    if (daysUntil <= 7) return "earnings-day-pill earnings-day-pill--this-week";
    return "earnings-day-pill earnings-day-pill--later";
  }

  // ────────── Stats strip ──────────

  function renderEarningsStatsStrip(stats) {
    const el = document.getElementById("earningsStatsStrip");
    if (!el) return;
    if (!stats || stats._missing) {
      el.innerHTML =
        `<div style="font-size:12px;color:var(--text-muted);">Stats unavailable — run <code>node scripts/refresh-earnings.mjs</code> locally.</div>`;
      return;
    }
    const buckets = stats.bucket_by_days || {};
    const dq = stats.signals?.by_data_quality || { HIGH: 0, MEDIUM: 0, LOW: 0 };
    const runup = stats.signals?.by_pre_runup || { spike: 0, smooth: 0, lagging: 0, neutral: 0 };
    const pred = stats.predictions?.by_verdict || { BEAT: 0, INLINE: 0, MISS: 0, INSUFFICIENT_DATA: 0 };
    const avgConf = stats.predictions?.avg_confidence_pct;

    // Three-row strip: dates → predicted verdicts → quality + runup.
    // The verdict row is what a trader scanning the tab actually wants
    // first ("how many BEATs are coming"); we put it before quality
    // chips so it lands above the fold on most viewports.
    const dateCells = [
      { label: "Today", value: buckets.d0 || 0, accent: "#f87171" },
      { label: "Next 1–3d", value: buckets.d1to3 || 0, accent: "#fbbf24" },
      { label: "4–7d", value: buckets.d4to7 || 0, accent: "#facc15" },
      { label: "8–14d", value: buckets.d8to14 || 0, accent: "#94a3b8" },
      { label: "15–30d", value: buckets.d15to30 || 0, accent: "#94a3b8" },
      { label: "Total", value: stats.event_count || 0, accent: "#60a5fa" },
    ];
    const verdictCells = [
      { label: "Predicted BEAT", value: pred.BEAT || 0, accent: "#86efac", title: "Composite score ≥ 65 — model expects upside surprise" },
      { label: "INLINE", value: pred.INLINE || 0, accent: "#93c5fd", title: "Score 35–64 — balanced inputs, no clear directional edge" },
      { label: "MISS", value: pred.MISS || 0, accent: "#fca5a5", title: "Score < 35 — model expects downside surprise" },
      { label: "INSUFFICIENT", value: pred.INSUFFICIENT_DATA || 0, accent: "#cbd5e1", title: "Data too thin to score — calendar fact only" },
      { label: "Avg confidence", value: avgConf != null ? `${avgConf}%` : "—", accent: "#fbbf24", title: "Mean confidence across scored verdicts. V1 cap 65%" },
    ];
    const qualityCells = [
      { label: "HIGH signal", value: dq.HIGH || 0, accent: "#86efac", title: "Full SWS upcoming-earnings reasoning attached" },
      { label: "MEDIUM", value: dq.MEDIUM || 0, accent: "#fbbf24", title: "SWS deep + sector + returns; no upcoming-earnings reasoning blob" },
      { label: "LOW", value: dq.LOW || 0, accent: "#cbd5e1", title: "Calendar fact only — predictor returns INSUFFICIENT_DATA" },
      { label: "Pre-runup spike", value: runup.spike || 0, accent: "#fca5a5", title: "1M >10% AND >8%pts above sector — chase risk" },
      { label: "Smooth runup", value: runup.smooth || 0, accent: "#fbbf24", title: "3–8%pts above sector — informed-flow shape" },
      { label: "Lagging", value: runup.lagging || 0, accent: "#93c5fd", title: ">5%pts below sector — room to surprise on a beat" },
    ];

    const cellHtml = (c) => `
      <div title="${escHtml(c.title || "")}" style="background:var(--panel,#0f1422); border:1px solid #1a2233; border-radius:8px; padding:8px 12px; min-width:90px;">
        <div style="font-size:10px; color:var(--text-muted); letter-spacing:0.04em; text-transform:uppercase;">${escHtml(c.label)}</div>
        <div style="font-size:18px; font-weight:600; color:${c.accent}; margin-top:2px;">${c.value}</div>
      </div>`;

    el.innerHTML = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; width:100%;">${dateCells.map(cellHtml).join("")}</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; width:100%; margin-top:8px;">${verdictCells.map(cellHtml).join("")}</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; width:100%; margin-top:8px;">${qualityCells.map(cellHtml).join("")}</div>
    `;
    el.style.flexDirection = "column";
    el.style.gap = "0";
  }

  // ────────── Filter bar ──────────

  function uniqueSectorsInSnapshot() {
    if (!_earningsSnapshot || !Array.isArray(_earningsSnapshot.events)) return [];
    const set = new Set();
    for (const e of _earningsSnapshot.events) {
      if (e.signals?.sector) set.add(e.signals.sector);
    }
    return Array.from(set).sort();
  }

  function renderEarningsFilterBar() {
    const el = document.getElementById("earningsFilterBar");
    if (!el) return;
    const sectorOptions = ["ALL"].concat(uniqueSectorsInSnapshot())
      .map((s) => `<option value="${escHtml(s)}"${s === _earningsFilters.sector ? " selected" : ""}>${s === "ALL" ? "all" : escHtml(s)}</option>`)
      .join("");
    el.innerHTML = `
      <label style="font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
        Within
        <select id="earningsDaysFilter" style="background:var(--panel,#0f1422); color:#e2e8f0; border:1px solid #2a3349; border-radius:6px; padding:6px 10px; font-size:12px;">
          <option value="0">today</option>
          <option value="3">3 days</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30" selected>30 days</option>
        </select>
      </label>
      <label style="font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
        Verdict
        <select id="earningsVerdictFilter" style="background:var(--panel,#0f1422); color:#e2e8f0; border:1px solid #2a3349; border-radius:6px; padding:6px 10px; font-size:12px;">
          <option value="ALL" selected>all</option>
          <option value="BEAT">BEAT</option>
          <option value="INLINE">INLINE</option>
          <option value="MISS">MISS</option>
          <option value="INSUFFICIENT_DATA">INSUFFICIENT</option>
        </select>
      </label>
      <label style="font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
        Quality
        <select id="earningsQualityFilter" style="background:var(--panel,#0f1422); color:#e2e8f0; border:1px solid #2a3349; border-radius:6px; padding:6px 10px; font-size:12px;">
          <option value="ALL" selected>all</option>
          <option value="HIGH">HIGH only</option>
          <option value="HIGH+MEDIUM">HIGH + MEDIUM</option>
          <option value="LOW">LOW only</option>
        </select>
      </label>
      <label style="font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
        Runup
        <select id="earningsRunupFilter" style="background:var(--panel,#0f1422); color:#e2e8f0; border:1px solid #2a3349; border-radius:6px; padding:6px 10px; font-size:12px;">
          <option value="ALL" selected>all</option>
          <option value="spike">spike (chase risk)</option>
          <option value="smooth">smooth (informed)</option>
          <option value="lagging">lagging (room to surprise)</option>
          <option value="neutral">neutral</option>
        </select>
      </label>
      <label style="font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
        Sector
        <select id="earningsSectorFilter" style="background:var(--panel,#0f1422); color:#e2e8f0; border:1px solid #2a3349; border-radius:6px; padding:6px 10px; font-size:12px; max-width:180px;">
          ${sectorOptions}
        </select>
      </label>
      <label style="font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
        Symbol
        <input id="earningsSymbolFilter" type="text" placeholder="e.g. RELIANCE" style="background:var(--panel,#0f1422); color:#e2e8f0; border:1px solid #2a3349; border-radius:6px; padding:6px 10px; font-size:12px; width:140px;" />
      </label>
      <button id="earningsClearFilters" style="background:transparent; color:var(--text-muted); border:1px solid #2a3349; border-radius:6px; padding:6px 10px; font-size:12px; cursor:pointer;">Clear</button>
    `;

    // Wire events. We rely on the in-memory snapshot, so filter changes
    // are zero-latency — no re-fetch.
    const daysSel = el.querySelector("#earningsDaysFilter");
    const verdictSel = el.querySelector("#earningsVerdictFilter");
    const qualSel = el.querySelector("#earningsQualityFilter");
    const runupSel = el.querySelector("#earningsRunupFilter");
    const symInp = el.querySelector("#earningsSymbolFilter");
    const clearBtn = el.querySelector("#earningsClearFilters");
    if (daysSel) {
      daysSel.value = String(_earningsFilters.days);
      daysSel.addEventListener("change", () => {
        _earningsFilters.days = Number(daysSel.value) || 0;
        applyEarningsFilters();
      });
    }
    if (verdictSel) {
      verdictSel.value = _earningsFilters.verdict || "ALL";
      verdictSel.addEventListener("change", () => {
        _earningsFilters.verdict = verdictSel.value;
        applyEarningsFilters();
      });
    }
    if (qualSel) {
      qualSel.value = _earningsFilters.quality || "ALL";
      qualSel.addEventListener("change", () => {
        _earningsFilters.quality = qualSel.value;
        applyEarningsFilters();
      });
    }
    if (runupSel) {
      runupSel.value = _earningsFilters.runup || "ALL";
      runupSel.addEventListener("change", () => {
        _earningsFilters.runup = runupSel.value;
        applyEarningsFilters();
      });
    }
    const sectorSel = el.querySelector("#earningsSectorFilter");
    if (sectorSel) {
      sectorSel.value = _earningsFilters.sector || "ALL";
      sectorSel.addEventListener("change", () => {
        _earningsFilters.sector = sectorSel.value;
        applyEarningsFilters();
      });
    }
    if (symInp) {
      symInp.value = _earningsFilters.symbol || "";
      let debounceTimer = null;
      symInp.addEventListener("input", () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          _earningsFilters.symbol = symInp.value.trim().toUpperCase();
          applyEarningsFilters();
        }, 200);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        _earningsFilters = { days: 30, symbol: "", quality: "ALL", runup: "ALL", verdict: "ALL", sector: "ALL" };
        renderEarningsFilterBar();
        applyEarningsFilters();
      });
    }
  }

  function applyEarningsFilters() {
    if (!_earningsSnapshot) return;
    const events = (_earningsSnapshot.events || []).filter((e) => {
      if (typeof _earningsFilters.days === "number" && Number.isFinite(_earningsFilters.days)) {
        if (typeof e.days_until === "number" && e.days_until > _earningsFilters.days) return false;
      }
      if (_earningsFilters.symbol) {
        if (!String(e.symbol || "").toUpperCase().startsWith(_earningsFilters.symbol)) return false;
      }
      if (_earningsFilters.quality && _earningsFilters.quality !== "ALL") {
        const q = e.signals?.data_quality || "UNKNOWN";
        if (_earningsFilters.quality === "HIGH+MEDIUM") {
          if (q !== "HIGH" && q !== "MEDIUM") return false;
        } else if (q !== _earningsFilters.quality) {
          return false;
        }
      }
      if (_earningsFilters.runup && _earningsFilters.runup !== "ALL") {
        const r = e.signals?.momentum?.pre_runup_signal;
        if (r !== _earningsFilters.runup) return false;
      }
      if (_earningsFilters.verdict && _earningsFilters.verdict !== "ALL") {
        const v = e.prediction?.verdict || "INSUFFICIENT_DATA";
        if (v !== _earningsFilters.verdict) return false;
      }
      if (_earningsFilters.sector && _earningsFilters.sector !== "ALL") {
        if ((e.signals?.sector || "") !== _earningsFilters.sector) return false;
      }
      return true;
    });
    renderEarningsCardGrid(events);
  }

  // ────────── Card rendering ──────────

  function renderTagPills(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return "";
    return tags
      .map(
        (t) =>
          `<span style="display:inline-block; background:rgba(96,165,250,0.1); border:1px solid rgba(96,165,250,0.3); color:#93c5fd; font-size:10px; letter-spacing:0.05em; padding:2px 8px; border-radius:10px; margin-left:6px;">${escHtml(t)}</span>`,
      )
      .join("");
  }

  // ────────── Signal-block sub-renderers ──────────
  // All accept a missing/null block and return "" — every card decides
  // its own opt-ins based on which signal blocks are populated.

  function dataQualityBadge(quality) {
    if (!quality) return "";
    const tone =
      quality === "HIGH"
        ? { bg: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.3)", color: "#86efac" }
        : quality === "MEDIUM"
          ? { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.3)", color: "#fbbf24" }
          : { bg: "rgba(148,163,184,0.12)", border: "rgba(148,163,184,0.25)", color: "#cbd5e1" };
    return `<span title="Signal quality tier (HIGH = full reasoning blob from SWS upcoming-earnings; MEDIUM = SWS deep + sector + returns; LOW = calendar-only)" style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600; letter-spacing:0.05em; background:${tone.bg}; border:1px solid ${tone.border}; color:${tone.color};">${escHtml(quality)}</span>`;
  }

  function runupPill(signal, deltaVsSector) {
    if (!signal || signal === "neutral") return "";
    const labelMap = {
      spike: { label: "Pre-runup spike", color: "#fca5a5", bg: "rgba(239,68,68,0.1)" },
      smooth: { label: "Informed-flow runup", color: "#fbbf24", bg: "rgba(245,158,11,0.08)" },
      lagging: { label: "Lagging sector", color: "#93c5fd", bg: "rgba(96,165,250,0.08)" },
    };
    const m = labelMap[signal];
    if (!m) return "";
    const delta =
      typeof deltaVsSector === "number"
        ? ` ${deltaVsSector >= 0 ? "+" : ""}${deltaVsSector.toFixed(1)}% vs sector`
        : "";
    return `<span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:500; background:${m.bg}; color:${m.color}; border:1px solid ${m.bg.replace("0.1", "0.3").replace("0.08", "0.25")};">${escHtml(m.label)}${escHtml(delta)}</span>`;
  }

  function fmtSignedPct(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  }

  function fmtCrore(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "—";
    if (v >= 1e7) return `₹${(v / 1e7).toFixed(0)} Cr`;
    return `₹${v.toLocaleString("en-IN")}`;
  }

  function renderSignalsRow(signals) {
    if (!signals) return "";
    const m = signals.momentum || {};
    const cells = [];
    if (typeof m.ret_1m_pct === "number") cells.push({ label: "1M", value: fmtSignedPct(m.ret_1m_pct), positive: m.ret_1m_pct >= 0 });
    if (typeof m.ret_3m_pct === "number") cells.push({ label: "3M", value: fmtSignedPct(m.ret_3m_pct), positive: m.ret_3m_pct >= 0 });
    if (typeof m.ret_1y_pct === "number") cells.push({ label: "1Y", value: fmtSignedPct(m.ret_1y_pct), positive: m.ret_1y_pct >= 0 });
    if (typeof signals.snowflake_total === "number") cells.push({ label: "Snow", value: `${signals.snowflake_total}/30`, positive: signals.snowflake_total >= 18 });
    if (typeof signals.upside_pct === "number") cells.push({ label: "FV", value: fmtSignedPct(signals.upside_pct), positive: signals.upside_pct >= 0 });
    if (cells.length === 0) return "";
    return `
      <div style="display:flex; gap:10px; flex-wrap:wrap; padding-top:8px; border-top:1px dashed #1a2233;">
        ${cells.map((c) => `
          <div style="display:flex; flex-direction:column; min-width:46px;">
            <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">${escHtml(c.label)}</div>
            <div style="font-size:12px; font-weight:600; color:${c.positive ? "#86efac" : "#fca5a5"};">${escHtml(c.value)}</div>
          </div>`).join("")}
      </div>`;
  }

  function renderCounterThesisBlurb(signals) {
    const upc = signals?.sws_upcoming_earnings;
    if (!upc) return "";
    const ct = upc.counter_thesis;
    const oneLine = upc.one_line;
    if (!ct?.text && !oneLine) return "";

    const verdictBadge = upc.composite_verdict
      ? `<span style="display:inline-block; padding:2px 8px; border-radius:8px; font-size:10px; font-weight:700; letter-spacing:0.05em; background:${verdictBg(upc.composite_verdict)}; color:${verdictColor(upc.composite_verdict)};">${escHtml(upc.composite_verdict)}</span>`
      : "";

    return `
      <div style="font-size:11px; color:#94a3b8; line-height:1.5; padding-top:8px; border-top:1px dashed #1a2233; display:flex; gap:8px; align-items:flex-start;">
        ${verdictBadge ? `<div style="flex-shrink:0; padding-top:1px;">${verdictBadge}</div>` : ""}
        <div>${escHtml(oneLine || ct.text || "")}</div>
      </div>`;
  }

  // ────────── Prediction-tier rendering ──────────
  // Milestone C lights up: predicted verdict pill, confidence, headline,
  // and (when present) a compact Bull/Base/Bear price band.

  function predictedVerdictTone(verdict) {
    switch (verdict) {
      case "BEAT":
        return { bg: "rgba(34,197,94,0.18)", border: "rgba(34,197,94,0.4)", color: "#86efac" };
      case "MISS":
        return { bg: "rgba(239,68,68,0.18)", border: "rgba(239,68,68,0.4)", color: "#fca5a5" };
      case "INLINE":
        return { bg: "rgba(96,165,250,0.14)", border: "rgba(96,165,250,0.3)", color: "#93c5fd" };
      case "INSUFFICIENT_DATA":
      default:
        return { bg: "rgba(148,163,184,0.12)", border: "rgba(148,163,184,0.25)", color: "#cbd5e1" };
    }
  }

  function renderPredictedVerdictBadge(prediction) {
    if (!prediction) return "";
    const v = prediction.verdict || "INSUFFICIENT_DATA";
    const conf = typeof prediction.confidence_pct === "number" ? `${prediction.confidence_pct}%` : "—";
    const tone = predictedVerdictTone(v);
    const label = v === "INSUFFICIENT_DATA" ? "INSUFFICIENT" : v;
    return `
      <div title="Predicted earnings outcome with V1 confidence (capped at 65% pending backtest)" style="display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:14px; background:${tone.bg}; border:1px solid ${tone.border}; color:${tone.color};">
        <span style="font-size:11px; font-weight:700; letter-spacing:0.06em;">${escHtml(label)}</span>
        ${v !== "INSUFFICIENT_DATA" ? `<span style="font-size:10px; opacity:0.85; font-weight:500;">${escHtml(conf)} conf</span>` : ""}
      </div>`;
  }

  function renderPriceBand(band) {
    if (!band || !band.bull || !band.base || !band.bear) return "";
    const fmt = (cell) => {
      if (band.anchored && cell.price_inr != null) {
        return `₹${cell.price_inr.toLocaleString("en-IN")}`;
      }
      return `${cell.pct >= 0 ? "+" : ""}${cell.pct}%`;
    };
    return `
      <div style="display:flex; gap:8px; padding-top:8px; border-top:1px dashed #1a2233; font-size:11px;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">Bear</div>
          <div style="font-weight:600; color:#fca5a5;">${escHtml(fmt(band.bear))}</div>
          <div style="font-size:10px; color:var(--text-muted);">${band.bear.pct >= 0 ? "+" : ""}${band.bear.pct}%</div>
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">Base</div>
          <div style="font-weight:600; color:#cbd5e1;">${escHtml(fmt(band.base))}</div>
          <div style="font-size:10px; color:var(--text-muted);">${band.base.pct >= 0 ? "+" : ""}${band.base.pct}%</div>
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">Bull</div>
          <div style="font-weight:600; color:#86efac;">${escHtml(fmt(band.bull))}</div>
          <div style="font-size:10px; color:var(--text-muted);">${band.bull.pct >= 0 ? "+" : ""}${band.bull.pct}%</div>
        </div>
      </div>`;
  }

  function renderRationaleHeadline(rationale) {
    if (!rationale?.headline) return "";
    return `
      <div style="font-size:11.5px; color:#cbd5e1; line-height:1.45; padding-top:6px;">
        ${escHtml(rationale.headline)}
      </div>`;
  }

  // ────────── "How this prediction was built" expander ──────────
  // A collapsible audit panel on each card. Surfaces the top-3 component
  // impacts, the SWS V3 breakdown bars, the LLM qualitative read, and
  // the version audit trail.
  //
  // SEBI-RA boundary: the LLM read renders in a SEPARATELY-LABELLED,
  // visually-distinct block — it is NEVER woven into the deterministic
  // rationale paragraphs. The label says so explicitly.
  //
  // onclick:stopPropagation on the <details> so toggling the expander
  // doesn't also fire the card's open-modal handler. <details>/<summary>
  // is natively keyboard-accessible; the bars carry ARIA progressbar
  // roles. Collapsed by default on every viewport — no layout cost
  // until the user opts in.

  const COMPONENT_LABELS = {
    v3_future_past: "V3 future + past",
    v3_valuation: "V3 valuation",
    v3_overlay: "V3 risk overlay",
    runup: "Pre-runup vs sector",
    sector_momentum: "Sector momentum",
    trajectory: "EPS YoY trajectory",
    last_quarter_echo: "Last-quarter echo",
    announcements: "Corporate announcements",
    deal_flow: "Bulk/block deal flow",
    llm_signal: "LLM qualitative signal",
  };

  function v3Bar(label, value, max, opts) {
    const negative = !!(opts && opts.negative);
    const mag = Math.abs(Number(value) || 0);
    const pct = max > 0 ? Math.min(100, (mag / max) * 100) : 0;
    const fill = negative ? "#fca5a5" : "#86efac";
    const valLabel = negative ? `−${mag.toFixed(0)}` : `${(Number(value) || 0).toFixed(0)}`;
    return `
      <div style="display:flex; align-items:center; gap:8px; font-size:10px;">
        <span style="width:88px; flex-shrink:0; color:var(--text-muted);">${escHtml(label)}</span>
        <div role="progressbar" aria-label="${escHtml(label)}" aria-valuenow="${mag}" aria-valuemin="0" aria-valuemax="${max}"
             style="flex:1; height:6px; background:rgba(148,163,184,0.12); border-radius:3px; overflow:hidden;">
          <div style="width:${pct}%; height:100%; background:${fill};"></div>
        </div>
        <span style="width:36px; flex-shrink:0; text-align:right; color:#cbd5e1;">${valLabel}/${max}</span>
      </div>`;
  }

  function renderPredictionBuildExpander(event) {
    const prediction = event && event.prediction;
    if (!prediction || prediction.verdict === "INSUFFICIENT_DATA") return "";
    const signals = event.signals || {};

    // 1 — top 3 components by absolute impact.
    const comps = Array.isArray(prediction.components_by_impact) ? prediction.components_by_impact : [];
    const top3 = comps.slice(0, 3).map((c) => {
      const pts = Number(c.pts) || 0;
      const tone = pts > 0 ? "#86efac" : pts < 0 ? "#fca5a5" : "#94a3b8";
      const sign = pts > 0 ? "+" : "";
      const label = COMPONENT_LABELS[c.name] || c.name;
      return `<div style="font-size:10.5px; line-height:1.5; color:#94a3b8;">
        <span style="color:${tone}; font-weight:700;">${sign}${pts}</span>
        <span style="color:#cbd5e1;"> ${escHtml(label)}</span> — ${escHtml(c.why || "")}
      </div>`;
    }).join("");

    // 2 — SWS V3 breakdown bars.
    const v3 = signals.v3;
    let v3Html = "";
    if (v3 && v3.breakdown) {
      const b = v3.breakdown;
      v3Html = `
        <div>
          <div style="font-size:9px; color:var(--text-muted); letter-spacing:0.06em; text-transform:uppercase; margin-bottom:5px;">
            SWS V3 breakdown · ${escHtml(v3.v3_verdict || "")} ${v3.v3_score_100 != null ? `(${v3.v3_score_100}/100)` : ""} · ${escHtml(v3.source || "")}
          </div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            ${v3Bar("Future", b.pts_future, 20)}
            ${v3Bar("Past", b.pts_past, 12)}
            ${v3Bar("Valuation", b.pts_fv_upside, 12)}
            ${v3Bar("Risk overlay", b.pts_overlay, 15, { negative: true })}
          </div>
        </div>`;
    }

    // 3 — AI qualitative read. SEPARATELY LABELLED, non-deterministic —
    // never part of the deterministic rationale above it.
    const llm = signals.llm_signal;
    let llmHtml = "";
    if (llm && llm.bias) {
      const biasTone = llm.bias === "lean_beat" ? "#86efac" : llm.bias === "lean_miss" ? "#fca5a5" : "#94a3b8";
      const delta = Number(llm.confidence_delta_pct) || 0;
      llmHtml = `
        <div style="background:rgba(96,165,250,0.05); border:1px dashed rgba(96,165,250,0.3); border-radius:6px; padding:8px 10px;">
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:5px; flex-wrap:wrap;">
            <span style="font-size:9px; color:#93c5fd; letter-spacing:0.06em; text-transform:uppercase; font-weight:700;">AI qualitative read</span>
            <span title="Non-deterministic. A separate ±10-pt input — it does NOT alter the rationale paragraphs."
                  style="font-size:8px; color:var(--text-muted); border:1px solid #2a3349; border-radius:6px; padding:1px 5px;">non-deterministic · ${escHtml(llm.classifier_provider || "?")}</span>
          </div>
          <div style="font-size:10.5px; color:#cbd5e1; line-height:1.5;">
            <span style="color:${biasTone}; font-weight:700;">${escHtml(llm.bias)}</span>${delta ? ` (${delta > 0 ? "+" : ""}${delta})` : ""} — ${escHtml(llm.top_reason || "")}
          </div>
          ${llm.top_risk ? `<div style="font-size:10px; color:#94a3b8; margin-top:3px;">Watch: ${escHtml(llm.top_risk)}</div>` : ""}
        </div>`;
    }

    // 4 — version audit trail.
    const auditRows = [
      ["Predictor", prediction.predictor_version],
      ["Narrator", event.rationale && event.rationale.version],
      ["Playbook", event.playbook && event.playbook.version],
      ["LLM", llm ? `${llm.classifier_provider || "?"} · ${llm.model_id || "?"}` : null],
    ].filter((row) => row[1]);
    const auditHtml = `
      <div style="font-size:9px; color:var(--text-muted); line-height:1.7;">
        <span style="letter-spacing:0.06em; text-transform:uppercase;">Audit trail</span> ·
        ${auditRows.map((r) => `${escHtml(r[0])}: ${escHtml(r[1])}`).join(" · ")}
      </div>`;

    return `
      <details class="earnings-build-expander" onclick="event.stopPropagation()" style="border-top:1px dashed #1a2233; padding-top:8px; margin-top:2px;">
        <summary style="cursor:pointer; font-size:10px; color:var(--text-muted); letter-spacing:0.05em; text-transform:uppercase;">How this prediction was built</summary>
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:12px;">
          <div style="display:flex; flex-direction:column; gap:4px;">
            <div style="font-size:9px; color:var(--text-muted); letter-spacing:0.06em; text-transform:uppercase;">Top drivers</div>
            ${top3 || '<div style="font-size:10px; color:var(--text-muted);">No component detail.</div>'}
          </div>
          ${v3Html}
          ${llmHtml}
          ${auditHtml}
        </div>
      </details>`;
  }

  // ────────── Milestone D pills: announcements + deal flow ──────────
  // Rendered as inline chips next to the verdict + quality badges.
  // Compact by design — full announcement / deal lists go in the
  // detail modal (out of scope for V1 but the data ships in
  // signals.announcements.recent_for_ui and signals.deals_7d.recent_for_ui).

  function classificationTone(cls) {
    const positive = ["ORDER_WIN", "CAPACITY_EXPANSION", "MA_DEAL", "BUYBACK", "BONUS"];
    const negative = ["LITIGATION"];
    const informational = ["RATING_ACTION", "FUND_RAISING", "MGMT_CHANGE"];
    if (positive.includes(cls)) return { color: "#86efac", bg: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.3)" };
    if (negative.includes(cls)) return { color: "#fca5a5", bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)" };
    if (informational.includes(cls)) return { color: "#93c5fd", bg: "rgba(96,165,250,0.1)", border: "rgba(96,165,250,0.25)" };
    return { color: "#cbd5e1", bg: "rgba(148,163,184,0.1)", border: "rgba(148,163,184,0.2)" };
  }

  function renderAnnouncementPills(signals) {
    const ann = signals?.announcements;
    if (!ann || !Array.isArray(ann.top3) || ann.top3.length === 0) return "";
    // Show only material classifications on the card front (skip OTHER /
    // SHAREHOLDER_MEET / DIVIDEND-only). The full list is available in the
    // detail modal.
    const isMaterial = (cls) => !["OTHER", "SHAREHOLDER_MEET", "DIVIDEND", "RESULT_INTIMATION"].includes(cls);
    const materialTop3 = ann.top3.filter((a) => isMaterial(a.classification));
    if (materialTop3.length === 0) return "";
    return materialTop3
      .slice(0, 2)
      .map((a) => {
        const tone = classificationTone(a.classification);
        const labelMap = {
          ORDER_WIN: "Order win",
          CAPACITY_EXPANSION: "Capex / capacity",
          MA_DEAL: "M&A",
          LITIGATION: "Litigation",
          RATING_ACTION: "Rating",
          FUND_RAISING: "Fund raise",
          BUYBACK: "Buyback",
          BONUS: "Bonus",
          MGMT_CHANGE: "Mgmt change",
        };
        const label = labelMap[a.classification] || a.classification;
        return `<span title="${escHtml(a.subject || "")}" style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:500; background:${tone.bg}; color:${tone.color}; border:1px solid ${tone.border};">${escHtml(label)}</span>`;
      })
      .join("");
  }

  function renderDealFlowPill(signals) {
    const d = signals?.deals_7d;
    if (!d) return "";
    const net = typeof d.net_notional_inr === "number" ? d.net_notional_inr : 0;
    const mcap = signals.market_cap_inr || 0;
    if (Math.abs(net) < 1e7 || mcap < 1e7) return "";
    const pctMcap = (net / mcap) * 100;
    if (Math.abs(pctMcap) < 0.05) return ""; // skip noise

    const inrCr = net / 1e7;
    const sign = inrCr >= 0 ? "+" : "";
    const tone = inrCr >= 0
      ? { color: "#86efac", bg: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.3)" }
      : { color: "#fca5a5", bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.3)" };
    const dirLabel = inrCr >= 0 ? "Inst. accumulation" : "Inst. distribution";
    const tooltip = `Net bulk+block flow over ${d.last_deal_date_iso ? "last 7d" : "the window"}: ${d.net_buys || 0} buys / ${d.net_sells || 0} sells · ${pctMcap.toFixed(2)}% of mcap`;
    return `<span title="${escHtml(tooltip)}" style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:500; background:${tone.bg}; color:${tone.color}; border:1px solid ${tone.border};">${escHtml(dirLabel)} ${sign}₹${Math.round(Math.abs(inrCr))} Cr</span>`;
  }

  // ────────── Reaction playbook (Milestone E) ──────────
  // Pre-result: shows the predicted-verdict cell branches with one
  // branch highlighted. Each chip tells the user the cell label + a
  // one-line stance, so a trader scanning the tab can see the trading
  // angle without opening any modal.
  //
  // Post-result (mode=t1): shows the resolved cell + the gap-aware
  // tactical note. Activated once Milestone F starts populating
  // actual results.

  function renderTradingAngle(playbook) {
    if (!playbook || !playbook.tradable) return "";

    if (playbook.mode === "t1" && playbook.plan) {
      // Post-result variant — single resolved cell + gap-tactical.
      const tone = playbook.plan.confidence === "HIGH" ? "#86efac" : playbook.plan.confidence === "MEDIUM" ? "#fbbf24" : "#cbd5e1";
      return `
        <div style="background:rgba(15,20,34,0.6); border:1px solid #1a2233; border-radius:8px; padding:10px 12px; font-size:11px; line-height:1.5;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span style="color:${tone}; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; font-size:10px;">${escHtml(playbook.cell_key || "")} · ${escHtml(playbook.plan.confidence || "")}</span>
            <span style="font-size:10px; color:var(--text-muted);">T+1 plan</span>
          </div>
          <div style="color:#e2e8f0; font-weight:500;">${escHtml(playbook.plan.stance || "")}</div>
          ${playbook.tactical_note ? `<div style="color:#94a3b8; margin-top:4px;">${escHtml(playbook.tactical_note)}</div>` : ""}
        </div>`;
    }

    if (playbook.mode === "preview") {
      const branches = Array.isArray(playbook.branches) ? playbook.branches : [];
      const highlight = playbook.highlight_branch;
      const branchChip = (b) => {
        const tone =
          b.guidance === "RAISE"
            ? { bg: "rgba(34,197,94,0.12)", color: "#86efac", border: "rgba(34,197,94,0.3)" }
            : b.guidance === "CUT"
              ? { bg: "rgba(239,68,68,0.12)", color: "#fca5a5", border: "rgba(239,68,68,0.3)" }
              : { bg: "rgba(96,165,250,0.1)", color: "#93c5fd", border: "rgba(96,165,250,0.25)" };
        const isOn = b.is_highlighted;
        return `<span title="${escHtml(b.plan?.stance || "")}" style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:${isOn ? "700" : "500"}; background:${tone.bg}; color:${tone.color}; border:1px solid ${tone.border}; opacity:${isOn ? "1" : "0.55"};">${escHtml(b.guidance)}</span>`;
      };
      const highlightedBranch = branches.find((b) => b.is_highlighted) || branches[1] || null;
      const stanceLine = highlightedBranch?.plan?.stance || "Stance unresolved.";
      return `
        <div style="background:rgba(15,20,34,0.5); border:1px solid #1a2233; border-radius:8px; padding:10px 12px; font-size:11px; line-height:1.5;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:4px;">
            <div style="display:flex; gap:5px;">${branches.map(branchChip).join("")}</div>
            <span style="font-size:10px; color:var(--text-muted); letter-spacing:0.04em; text-transform:uppercase;">trading angle</span>
          </div>
          <div style="color:#cbd5e1;">
            <span style="color:var(--text-muted); font-size:10px;">If ${escHtml(highlight || "MAINTAIN")}:</span>
            ${escHtml(stanceLine)}
          </div>
        </div>`;
    }

    return "";
  }

  function verdictBg(v) {
    switch (v) {
      case "TOP_PICK":   return "rgba(34,197,94,0.18)";
      case "STRONG":     return "rgba(34,197,94,0.12)";
      case "ACCEPTABLE": return "rgba(96,165,250,0.12)";
      case "HOLD":       return "rgba(148,163,184,0.12)";
      case "AVOID":      return "rgba(239,68,68,0.15)";
      default:           return "rgba(148,163,184,0.1)";
    }
  }
  function verdictColor(v) {
    switch (v) {
      case "TOP_PICK":   return "#86efac";
      case "STRONG":     return "#86efac";
      case "ACCEPTABLE": return "#93c5fd";
      case "HOLD":       return "#cbd5e1";
      case "AVOID":      return "#fca5a5";
      default:           return "#cbd5e1";
    }
  }

  function renderEarningsCard(event) {
    if (!event || !event.symbol) return "";
    const dayPill = dayPillClass(event.days_until);
    const dayLabel = fmtRelativeDate(event.event_iso_date, event.days_until);
    const dateLong = fmtIsoToLong(event.event_iso_date);
    const fq = event.fiscal_quarter ? escHtml(event.fiscal_quarter) : "";
    const desc = event.description ? escHtml(event.description) : "";
    const tagPills = renderTagPills(event.tags);

    const signals = event.signals || null;
    const prediction = event.prediction || null;
    const priceBand = event.price_band || null;
    const rationale = event.rationale || null;
    const playbook = event.playbook || null;
    const dqBadge = dataQualityBadge(signals?.data_quality);
    const verdictBadge = renderPredictedVerdictBadge(prediction);
    const runup = runupPill(signals?.momentum?.pre_runup_signal, signals?.momentum?.runup_vs_sector_pct);
    const sectorLabel = signals?.sector
      ? `<span style="font-size:10px; color:var(--text-muted); letter-spacing:0.04em;">· ${escHtml(signals.sector)}</span>`
      : "";

    // Visual emphasis: card border tints with predicted-verdict tone so
    // BEAT cards read green-leaning at-a-glance, MISS reads red. Subtle —
    // not a heavy fill — to keep the grid scannable.
    const verdictTone = prediction ? predictedVerdictTone(prediction.verdict) : null;
    const cardBorder = verdictTone && prediction.verdict !== "INSUFFICIENT_DATA"
      ? `border-top: 2px solid ${verdictTone.border};`
      : "";

    // openStockDetailModal exists on app.js — guard the call so a load-
    // order surprise just opens nothing instead of throwing.
    const safeClick = `if(typeof openStockDetailModal==='function'){openStockDetailModal('${escHtml(event.symbol)}','earnings');}`;

    return `
      <div class="earnings-card" data-symbol="${escHtml(event.symbol)}" data-quality="${escHtml(signals?.data_quality || "UNKNOWN")}" data-verdict="${escHtml(prediction?.verdict || "")}" onclick="${safeClick}" style="background:var(--panel,#0f1422); border:1px solid #1a2233; ${cardBorder} border-radius:10px; padding:16px 18px; cursor:pointer; transition:transform 120ms ease, border-color 120ms ease; display:flex; flex-direction:column; gap:10px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
          <div style="min-width:0; flex:1;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span style="font-size:16px; font-weight:600; color:#e2e8f0; letter-spacing:-0.01em;">${escHtml(event.symbol)}</span>
              ${fq ? `<span style="font-size:11px; color:var(--text-muted); letter-spacing:0.04em;">${fq}</span>` : ""}
              ${verdictBadge}
              ${dqBadge}
              ${tagPills}
            </div>
            <div style="font-size:12px; color:var(--text-muted); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(event.company || event.symbol)} ${sectorLabel}</div>
          </div>
          <div style="text-align:right; flex-shrink:0;">
            <span class="${dayPill}" style="display:inline-block; padding:4px 10px; border-radius:12px; font-size:11px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase;">${escHtml(dayLabel)}</span>
            <div style="font-size:10px; color:var(--text-muted); margin-top:4px;">${escHtml(dateLong)}</div>
          </div>
        </div>
        ${renderRationaleHeadline(rationale)}
        ${(() => {
          // Compact catalyst row: pre-runup pill + Milestone-D pills.
          // Skipped entirely if everything is empty.
          const dPills = [renderAnnouncementPills(signals), renderDealFlowPill(signals)].filter(Boolean).join(" ");
          if (!runup && !dPills) return "";
          return `<div style="display:flex; flex-wrap:wrap; gap:5px; align-items:center;">${runup || ""}${dPills}</div>`;
        })()}
        ${renderSignalsRow(signals)}
        ${renderPriceBand(priceBand)}
        ${renderTradingAngle(playbook)}
        ${renderCounterThesisBlurb(signals)}
        ${renderPredictionBuildExpander(event)}
      </div>`;
  }

  function renderEarningsCardGrid(events) {
    const el = document.getElementById("earningsCardGrid");
    if (!el) return;
    if (!Array.isArray(events) || events.length === 0) {
      el.innerHTML = `
        <div style="padding:40px; text-align:center; color:var(--text-muted); border:1px dashed #2a3349; border-radius:10px;">
          <div style="font-size:14px; font-weight:500; margin-bottom:6px;">No upcoming results in this window.</div>
          <div style="font-size:12px;">Try widening the days filter or clearing the symbol search.</div>
        </div>`;
      return;
    }

    // Group by event_iso_date so the user gets a date-by-date view —
    // mirrors how a trader scans their results calendar each morning.
    const groups = new Map();
    for (const ev of events) {
      const key = ev.event_iso_date || "?";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    }
    const sortedKeys = Array.from(groups.keys()).sort();

    // Default-expanded date is sortedKeys[0] — groups only get keys when
    // an event is pushed, so the first key is guaranteed non-empty. User
    // overrides (explicit collapse/expand) always win over the default.
    const collapsedState = loadEarningsCollapsedState();
    const defaultOpen = sortedKeys[0];

    let html = "";
    for (const date of sortedKeys) {
      const items = groups.get(date);
      const long = fmtIsoToLong(date);
      const sample = items[0];
      const rel = fmtRelativeDate(date, sample?.days_until);
      const isCollapsed = Object.prototype.hasOwnProperty.call(collapsedState, date)
        ? !!collapsedState[date]
        : date !== defaultOpen;
      html += `
        <div data-earnings-date="${escHtml(date)}" data-collapsed="${isCollapsed ? "1" : "0"}" style="margin-bottom:18px;">
          <div class="earnings-date-header" style="display:flex; align-items:baseline; gap:10px; margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid #1a2233; cursor:pointer; user-select:none;">
            <span class="earnings-date-caret" style="font-size:11px; color:var(--text-muted); width:10px; display:inline-block;">${isCollapsed ? "▸" : "▾"}</span>
            <span style="font-size:13px; font-weight:600; color:#e2e8f0; letter-spacing:-0.01em;">${escHtml(long)}</span>
            <span style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">${escHtml(rel)} · ${items.length} ${items.length === 1 ? "result" : "results"}</span>
          </div>
          <div class="earnings-date-body" style="${isCollapsed ? "display:none;" : "display:grid;"} grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:12px;">
            ${items.map(renderEarningsCard).join("")}
          </div>
        </div>`;
    }
    el.innerHTML = html;

    // One-time delegated click handler. renderEarningsCardGrid runs on
    // every filter change so we guard with a dataset flag — without it
    // each filter tweak would stack another listener and clicks would
    // toggle N times.
    if (!el.dataset.collapseBound) {
      el.addEventListener("click", (ev) => {
        const header = ev.target.closest(".earnings-date-header");
        if (!header) return;
        const wrap = header.parentElement;
        const date = wrap && wrap.getAttribute("data-earnings-date");
        if (!date) return;
        const wasCollapsed = wrap.getAttribute("data-collapsed") === "1";
        const next = !wasCollapsed;
        wrap.setAttribute("data-collapsed", next ? "1" : "0");
        const body = wrap.querySelector(".earnings-date-body");
        const caret = wrap.querySelector(".earnings-date-caret");
        if (body) body.style.display = next ? "none" : "grid";
        if (caret) caret.textContent = next ? "▸" : "▾";
        const state = loadEarningsCollapsedState();
        state[date] = next;
        saveEarningsCollapsedState(state);
      });
      el.dataset.collapseBound = "1";
    }
  }

  // ────────── Public loader ──────────

  async function loadEarningsWatch() {
    const grid = document.getElementById("earningsCardGrid");
    const meta = document.getElementById("earningsMeta");
    if (grid) {
      grid.innerHTML =
        '<div class="loading"><div class="loading-spinner"></div><div class="loading-text">Loading upcoming results…</div></div>';
    }
    if (meta) meta.textContent = "Loading…";

    try {
      const [snapRes, statsRes] = await Promise.all([
        fetch("/api/earnings/upcoming"),
        fetch("/api/earnings/upcoming/stats"),
      ]);
      const snap = snapRes.ok ? await snapRes.json() : null;
      const stats = statsRes.ok ? await statsRes.json() : null;
      _earningsSnapshot = snap;
      _earningsStats = stats;

      if (snap && snap.missing) {
        if (grid) {
          grid.innerHTML = `
            <div style="padding:40px; text-align:center; color:var(--text-muted); border:1px dashed #f59e0b; border-radius:10px; background:rgba(245,158,11,0.04);">
              <div style="font-size:14px; font-weight:500; color:#fbbf24; margin-bottom:6px;">Earnings snapshot not generated yet.</div>
              <div style="font-size:12px;">Run <code style="background:#0b1020; padding:2px 6px; border-radius:4px;">node scripts/refresh-earnings.mjs</code> locally and commit the resulting JSON.</div>
            </div>`;
        }
        if (meta) meta.textContent = "Snapshot missing — run refresh script.";
        renderEarningsStatsStrip(stats);
        renderEarningsFilterBar();
        return;
      }

      renderEarningsStatsStrip(stats);
      renderEarningsFilterBar();
      applyEarningsFilters();

      if (meta) {
        const built = snap?.built_at ? new Date(snap.built_at).toLocaleString() : "?";
        const upstream = snap?.upstream_fetched_at ? new Date(snap.upstream_fetched_at).toLocaleString() : "?";
        const total = snap?.total_event_count ?? snap?.event_count ?? 0;
        meta.textContent = `${total} upcoming result events in next ${snap?.window_days ?? 30}d · built ${built} · NSE feed fetched ${upstream}`;
      }
    } catch (err) {
      console.error("loadEarningsWatch failed:", err);
      if (grid) {
        grid.innerHTML = `
          <div style="padding:30px; text-align:center; color:#fca5a5; border:1px solid rgba(239,68,68,0.3); border-radius:10px; background:rgba(239,68,68,0.06);">
            <div style="font-size:13px; font-weight:500; margin-bottom:4px;">Failed to load earnings data.</div>
            <div style="font-size:11px; color:var(--text-muted);">${escHtml(err && err.message ? err.message : "unknown error")}</div>
          </div>`;
      }
      if (meta) meta.textContent = "Load failed.";
    }
  }

  // ────────── Tiny CSS injection for day pills ──────────
  // Inlined so earnings.js is self-contained and we don't have to edit
  // the global stylesheet for a single-tab feature. All other styles are
  // inline-style attributes on the rendered HTML above.

  function injectEarningsStyles() {
    if (document.getElementById("earnings-watch-styles")) return;
    const css = `
      .earnings-day-pill--today { background:rgba(239,68,68,0.15); color:#fca5a5; border:1px solid rgba(239,68,68,0.3); }
      .earnings-day-pill--soon { background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.3); }
      .earnings-day-pill--this-week { background:rgba(250,204,21,0.12); color:#facc15; border:1px solid rgba(250,204,21,0.28); }
      .earnings-day-pill--later { background:rgba(148,163,184,0.12); color:#cbd5e1; border:1px solid rgba(148,163,184,0.25); }
      .earnings-day-pill--unknown { background:rgba(148,163,184,0.08); color:#94a3b8; border:1px solid rgba(148,163,184,0.18); }
      .earnings-card:hover { transform:translateY(-1px); border-color:#2a3349; }
      .earnings-build-expander summary:hover { color:#cbd5e1; }
      .earnings-build-expander summary:focus-visible { outline:2px solid #60a5fa; outline-offset:2px; border-radius:3px; }
    `;
    const style = document.createElement("style");
    style.id = "earnings-watch-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Inject styles once on script load.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectEarningsStyles, { once: true });
  } else {
    injectEarningsStyles();
  }

  // ────────── Stock-detail modal injection ──────────
  // Called by app.js's openStockDetailModal() AFTER the main SWS /
  // live-only render completes. Probes /api/earnings/<ticker> and, if
  // the stock has an upcoming result event, prepends a rich "Upcoming
  // Earnings" panel into the existing modal body so the user sees the
  // full prediction + price band + playbook + recent catalysts +
  // 3-paragraph rationale + falsification triggers in one place.
  //
  // The panel is purely additive — never replaces existing modal
  // content. If the API 404s (no upcoming event for the symbol), we
  // silently no-op so the modal renders as before.

  function renderModalPredictionRing(prediction) {
    if (!prediction || prediction.verdict === "INSUFFICIENT_DATA") {
      return `<div style="background:rgba(148,163,184,0.1); border:1px solid rgba(148,163,184,0.2); padding:12px 16px; border-radius:8px;">
        <div style="font-size:11px; color:var(--text-muted); letter-spacing:0.04em; text-transform:uppercase;">Predicted outcome</div>
        <div style="font-size:18px; font-weight:600; color:#cbd5e1; margin-top:4px;">INSUFFICIENT DATA</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Calendar event only — too thin to score.</div>
      </div>`;
    }
    const tone = predictedVerdictTone(prediction.verdict);
    return `<div style="background:${tone.bg}; border:1px solid ${tone.border}; padding:12px 16px; border-radius:8px;">
      <div style="font-size:11px; color:var(--text-muted); letter-spacing:0.04em; text-transform:uppercase;">Predicted outcome</div>
      <div style="display:flex; align-items:baseline; gap:10px; margin-top:4px;">
        <span style="font-size:24px; font-weight:700; color:${tone.color}; letter-spacing:-0.01em;">${escHtml(prediction.verdict)}</span>
        <span style="font-size:13px; color:${tone.color}; opacity:0.85;">${prediction.confidence_pct}% conf</span>
      </div>
      <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Score ${prediction.score_100}/100 · ${escHtml(prediction.predictor_version || "")}</div>
    </div>`;
  }

  function renderModalRationaleParagraphs(rationale) {
    if (!rationale || !Array.isArray(rationale.paragraphs)) return "";
    const paras = rationale.paragraphs
      .map((p, i) => `<p style="margin:0 0 ${i < rationale.paragraphs.length - 1 ? "10px" : "0"}; font-size:13px; line-height:1.55; color:#cbd5e1;">${escHtml(p)}</p>`)
      .join("");
    return `
      <div style="background:rgba(15,20,34,0.4); border:1px solid #1a2233; border-radius:8px; padding:14px 16px; margin-top:12px;">
        <div style="font-size:11px; font-weight:600; color:var(--text-muted); letter-spacing:0.06em; text-transform:uppercase; margin-bottom:10px;">Reasoning</div>
        ${paras}
      </div>`;
  }

  function renderModalFalsificationList(rationale) {
    const triggers = rationale?.falsification_triggers;
    if (!Array.isArray(triggers) || triggers.length === 0) return "";
    return `
      <div style="background:rgba(239,68,68,0.05); border:1px solid rgba(239,68,68,0.2); border-radius:8px; padding:12px 14px; margin-top:10px;">
        <div style="font-size:11px; font-weight:600; color:#fca5a5; letter-spacing:0.06em; text-transform:uppercase; margin-bottom:8px;">Falsification triggers</div>
        <ul style="margin:0; padding-left:18px; color:#fca5a5; font-size:12px; line-height:1.6;">
          ${triggers.map((t) => `<li>${escHtml(t)}</li>`).join("")}
        </ul>
      </div>`;
  }

  function renderModalPlaybookBranches(playbook) {
    if (!playbook || !playbook.tradable || playbook.mode !== "preview") return "";
    const branches = Array.isArray(playbook.branches) ? playbook.branches : [];
    if (branches.length === 0) return "";

    const branchHtml = branches.map((b) => {
      const tone =
        b.guidance === "RAISE" ? { color: "#86efac", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.25)" }
        : b.guidance === "CUT" ? { color: "#fca5a5", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.25)" }
        : { color: "#93c5fd", bg: "rgba(96,165,250,0.06)", border: "rgba(96,165,250,0.2)" };
      const plan = b.plan || {};
      const isOn = b.is_highlighted;
      return `
        <div style="border-left:3px solid ${tone.border}; background:${isOn ? tone.bg : "transparent"}; padding:10px 12px; ${isOn ? "" : "opacity:0.7;"}">
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
            <span style="font-size:11px; font-weight:700; color:${tone.color}; letter-spacing:0.06em;">IF ${escHtml(b.guidance)}${isOn ? " · highlighted" : ""}</span>
            <span style="font-size:10px; color:var(--text-muted);">${escHtml(plan.confidence || "")} · ${escHtml(plan.time_horizon || "")}</span>
          </div>
          <div style="font-size:12px; color:#e2e8f0; font-weight:500; margin-bottom:6px;">${escHtml(plan.label || "")}</div>
          <div style="font-size:11.5px; color:#94a3b8; line-height:1.5;"><strong style="color:#cbd5e1;">Stance:</strong> ${escHtml(plan.stance || "")}</div>
          ${plan.entry ? `<div style="font-size:11.5px; color:#94a3b8; line-height:1.5; margin-top:4px;"><strong style="color:#cbd5e1;">Entry:</strong> ${escHtml(plan.entry)}</div>` : ""}
          ${plan.stoploss ? `<div style="font-size:11.5px; color:#94a3b8; line-height:1.5; margin-top:4px;"><strong style="color:#cbd5e1;">Stop:</strong> ${escHtml(plan.stoploss)}</div>` : ""}
          ${plan.target ? `<div style="font-size:11.5px; color:#94a3b8; line-height:1.5; margin-top:4px;"><strong style="color:#cbd5e1;">Target:</strong> ${escHtml(plan.target)}</div>` : ""}
        </div>`;
    }).join("");

    return `
      <div style="background:rgba(15,20,34,0.4); border:1px solid #1a2233; border-radius:8px; padding:14px 16px; margin-top:12px;">
        <div style="font-size:11px; font-weight:600; color:var(--text-muted); letter-spacing:0.06em; text-transform:uppercase; margin-bottom:10px;">Trading playbook — three guidance scenarios</div>
        <div style="font-size:12px; color:#cbd5e1; line-height:1.5; margin-bottom:10px;">${escHtml(playbook.headline || "")}</div>
        <div style="display:flex; flex-direction:column; gap:8px;">${branchHtml}</div>
      </div>`;
  }

  function renderModalAnnouncementsList(signals) {
    const recent = signals?.announcements?.recent_for_ui;
    if (!Array.isArray(recent) || recent.length === 0) return "";
    const rows = recent.slice(0, 6).map((a) => {
      const tone = classificationTone(a.classification || "OTHER");
      return `
        <div style="display:flex; gap:10px; padding:8px 0; border-bottom:1px dashed #1a2233;">
          <div style="flex-shrink:0; padding-top:1px;">
            <span style="display:inline-block; padding:2px 7px; border-radius:8px; font-size:9px; font-weight:600; letter-spacing:0.05em; background:${tone.bg}; color:${tone.color}; border:1px solid ${tone.border};">${escHtml(a.classification || "OTHER")}</span>
          </div>
          <div style="min-width:0; flex:1;">
            <div style="font-size:11.5px; color:#cbd5e1; line-height:1.5;">${escHtml(a.subject || "(no subject)")}</div>
            <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">${escHtml(a.announced_at_iso || "")}${a.pdf_url ? ` · <a href="${escHtml(a.pdf_url)}" target="_blank" rel="noopener" style="color:#60a5fa; text-decoration:none;">PDF ↗</a>` : ""}</div>
          </div>
        </div>`;
    }).join("");
    return `
      <div style="background:rgba(15,20,34,0.4); border:1px solid #1a2233; border-radius:8px; padding:14px 16px; margin-top:12px;">
        <div style="font-size:11px; font-weight:600; color:var(--text-muted); letter-spacing:0.06em; text-transform:uppercase; margin-bottom:6px;">Recent corporate announcements</div>
        ${rows}
      </div>`;
  }

  function renderModalDealsTable(signals) {
    const deals = signals?.deals_7d?.recent_for_ui;
    if (!Array.isArray(deals) || deals.length === 0) return "";
    const rows = deals.slice(0, 8).map((d) => {
      const sideColor = d.side === "BUY" ? "#86efac" : "#fca5a5";
      const notional = d.notional_inr != null ? `₹${(d.notional_inr / 1e7).toFixed(1)} Cr` : "—";
      return `
        <tr>
          <td style="padding:6px 8px; font-size:11px; color:var(--text-muted);">${escHtml(d.date_iso || "")}</td>
          <td style="padding:6px 8px; font-size:11px; color:#cbd5e1;">${escHtml(d.kind)}</td>
          <td style="padding:6px 8px; font-size:11px; font-weight:600; color:${sideColor};">${escHtml(d.side)}</td>
          <td style="padding:6px 8px; font-size:11px; color:#cbd5e1;">${escHtml(d.client_name || "—")}</td>
          <td style="padding:6px 8px; font-size:11px; color:#cbd5e1; text-align:right;">${notional}</td>
        </tr>`;
    }).join("");
    return `
      <div style="background:rgba(15,20,34,0.4); border:1px solid #1a2233; border-radius:8px; padding:14px 16px; margin-top:12px; overflow-x:auto;">
        <div style="font-size:11px; font-weight:600; color:var(--text-muted); letter-spacing:0.06em; text-transform:uppercase; margin-bottom:6px;">Bulk / block deals — last 7 days</div>
        <table style="width:100%; border-collapse:collapse;">
          <thead><tr style="border-bottom:1px solid #1a2233;">
            <th style="padding:6px 8px; font-size:9px; color:var(--text-muted); text-align:left; letter-spacing:0.05em; text-transform:uppercase; font-weight:600;">Date</th>
            <th style="padding:6px 8px; font-size:9px; color:var(--text-muted); text-align:left; letter-spacing:0.05em; text-transform:uppercase; font-weight:600;">Type</th>
            <th style="padding:6px 8px; font-size:9px; color:var(--text-muted); text-align:left; letter-spacing:0.05em; text-transform:uppercase; font-weight:600;">Side</th>
            <th style="padding:6px 8px; font-size:9px; color:var(--text-muted); text-align:left; letter-spacing:0.05em; text-transform:uppercase; font-weight:600;">Client</th>
            <th style="padding:6px 8px; font-size:9px; color:var(--text-muted); text-align:right; letter-spacing:0.05em; text-transform:uppercase; font-weight:600;">Notional</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderEarningsPreviewPanel(event) {
    if (!event) return "";
    const { fiscal_quarter, days_until, event_iso_date } = event;
    const dayLabel = fmtRelativeDate(event_iso_date, days_until);
    return `
      <div id="modalEarningsPreviewSection" style="background:rgba(245,158,11,0.04); border:1px solid rgba(245,158,11,0.2); border-radius:10px; padding:18px 20px; margin-bottom:18px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:14px;">
          <div>
            <div style="font-size:11px; color:#fbbf24; letter-spacing:0.06em; text-transform:uppercase; font-weight:700;">Upcoming earnings preview</div>
            <div style="font-size:13px; color:#cbd5e1; margin-top:4px;">${escHtml(fiscal_quarter || "next result")} · ${escHtml(dayLabel)} (${escHtml(fmtIsoToLong(event_iso_date))})</div>
          </div>
          <div style="font-size:10px; color:var(--text-muted); max-width:240px; text-align:right; line-height:1.4;">
            Algorithmic preview from public data. Confidence reflects model agreement, not certainty. Earnings are binary events.
          </div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <div>${renderModalPredictionRing(event.prediction)}</div>
          <div>${renderPriceBand(event.price_band)}</div>
        </div>
        ${renderModalRationaleParagraphs(event.rationale)}
        ${renderModalPlaybookBranches(event.playbook)}
        ${renderModalAnnouncementsList(event.signals)}
        ${renderModalDealsTable(event.signals)}
        ${renderModalFalsificationList(event.rationale)}
      </div>`;
  }

  /**
   * Public injection hook called from app.js's openStockDetailModal.
   * Probes /api/earnings/<ticker>; if the stock has an upcoming-result
   * event, prepends the preview panel into the modal body.
   *
   * The probe is fire-and-forget — modal continues rendering its
   * normal content while we wait. If we beat the user's next click,
   * the panel slots in. If they navigate away, we no-op via the
   * ticker-match guard.
   */
  async function injectEarningsPreviewIntoModal(ticker) {
    if (!ticker) return;
    const targetTicker = String(ticker).toUpperCase();
    let event = null;
    try {
      const res = await fetch(`/api/earnings/${encodeURIComponent(targetTicker)}`, { credentials: "same-origin" });
      if (!res.ok) return; // 403/404/500 — silent no-op
      const data = await res.json();
      event = data?.event;
    } catch {
      return;
    }
    if (!event) return;

    // Guard: user may have closed/navigated to a different stock by now.
    if (typeof window.swsModalCurrentTicker === "string" &&
        window.swsModalCurrentTicker.toUpperCase() !== targetTicker) {
      return;
    }
    const body = document.getElementById("swsModalBody");
    if (!body) return;

    // Don't double-inject (race / re-open).
    if (body.querySelector("#modalEarningsPreviewSection")) return;
    body.insertAdjacentHTML("afterbegin", renderEarningsPreviewPanel(event));
  }

  // ────────── Public exports (window globals) ──────────
  // app.js's switchTab() looks up loaders by name from window scope, so
  // these need to live there.

  window.loadEarningsWatch = loadEarningsWatch;
  // Called by app.js's openStockDetailModal to inject the earnings
  // preview panel into the existing stock detail modal.
  window.injectEarningsPreviewIntoModal = injectEarningsPreviewIntoModal;
  // Exposed for test/debug; not used by app.js.
  window.__earnings = {
    renderEarningsCard,
    renderEarningsCardGrid,
    renderEarningsPreviewPanel,
    renderPredictionBuildExpander,
  };
})();
