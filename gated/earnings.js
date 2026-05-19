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

  // UI/UX overhaul 2026-05-19 — filter state persisted to localStorage so
  // users don't lose their filters when they navigate away (e.g. click a
  // card → tab back). Symbol search resets per-session (`symbol` excluded
  // from save) because it's transient — keeping a stale ticker filter
  // across days would hide the calendar.
  const EARNINGS_FILTERS_KEY = "earnings.filters.v1";
  const _EARNINGS_DEFAULTS = { days: 30, symbol: "", quality: "ALL", runup: "ALL", verdict: "ALL", sector: "ALL" };
  function loadEarningsFilters() {
    try {
      const raw = JSON.parse(localStorage.getItem(EARNINGS_FILTERS_KEY) || "{}");
      // Merge with defaults so a missing key doesn't crash a select binding.
      const merged = { ..._EARNINGS_DEFAULTS, ...raw };
      // Drop persisted symbol — see above.
      merged.symbol = "";
      return merged;
    } catch { return { ..._EARNINGS_DEFAULTS }; }
  }
  function saveEarningsFilters(filters) {
    try {
      const { symbol, ...rest } = filters || {};
      void symbol; // not persisted
      localStorage.setItem(EARNINGS_FILTERS_KEY, JSON.stringify(rest));
    } catch {}
  }
  let _earningsFilters = loadEarningsFilters();

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

  // Single-boolean collapse state for the "Recent results" section.
  // Default = collapsed: the upcoming calendar is the primary affordance of
  // the tab; past-week results are reference. User's explicit toggle wins
  // on reload (same persistence shape as the per-date map above).
  const EARNINGS_RECENT_COLLAPSED_KEY = "earningsRecentResultsCollapsed";

  function loadRecentResultsCollapsed() {
    try {
      const v = localStorage.getItem(EARNINGS_RECENT_COLLAPSED_KEY);
      if (v === "0") return false;
      return true;
    } catch { return true; }
  }
  function saveRecentResultsCollapsed(collapsed) {
    try { localStorage.setItem(EARNINGS_RECENT_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch {}
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
    // Visual urgency cue. Red-amber-yellow-grey for upcoming; a muted
    // slate variant for past events so they don't visually compete with
    // today's. Matches the platform's existing semantic palette.
    if (typeof daysUntil !== "number") return "earnings-day-pill earnings-day-pill--unknown";
    if (daysUntil < 0) return "earnings-day-pill earnings-day-pill--past";
    if (daysUntil === 0) return "earnings-day-pill earnings-day-pill--today";
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
      <div data-testid="${c.testId || ""}" title="${escHtml(c.title || "")}" style="background:var(--panel,#0f1422); border:1px solid #1a2233; border-radius:8px; padding:8px 12px; min-width:90px;">
        <div style="font-size:10px; color:var(--text-muted); letter-spacing:0.04em; text-transform:uppercase;">${escHtml(c.label)}</div>
        <div style="font-size:18px; font-weight:600; color:${c.accent}; margin-top:2px;">${c.value}</div>
        ${c.sub ? `<div style="font-size:9px; color:var(--text-muted); margin-top:2px;">${escHtml(c.sub)}</div>` : ""}
      </div>`;

    // PR A3 — 3-metric hit-rate row (strict / lenient / catastrophic).
    // Surfaces SEBI Reg 19 disclosure of past performance with bootstrap
    // CIs. The catastrophic cell is the money-losing metric and goes red
    // when the rolling-30 alert fires; the strict + lenient cells use the
    // overall sample.
    const hr = stats.hit_rate_summary;
    const hitRateCells = hr
      ? [
          {
            testId: "hit-rate-strict",
            label: "Hit rate (strict)",
            value: hr.strict?.hit_rate_pct != null ? `${hr.strict.hit_rate_pct}%` : "—",
            sub: hr.strict?.sample_size != null
              ? `n=${hr.strict.sample_size}${
                  hr.strict.ci_low_pct != null && hr.strict.ci_high_pct != null
                    ? ` · CI ${hr.strict.ci_low_pct}–${hr.strict.ci_high_pct}%`
                    : ""
                }`
              : "—",
            accent: "#86efac",
            title: "Exact verdict match (BEAT=BEAT etc.). The harsh truth metric.",
          },
          {
            testId: "hit-rate-lenient",
            label: "Hit rate (lenient)",
            value: hr.lenient?.hit_rate_pct != null ? `${hr.lenient.hit_rate_pct}%` : "—",
            sub: hr.lenient?.sample_size != null
              ? `n=${hr.lenient.sample_size}${
                  hr.lenient.ci_low_pct != null && hr.lenient.ci_high_pct != null
                    ? ` · CI ${hr.lenient.ci_low_pct}–${hr.lenient.ci_high_pct}%`
                    : ""
                }`
              : "—",
            accent: "#fbbf24",
            title: "Off-by-one OK (BEAT predicted, INLINE actual = hit). Directional accuracy.",
          },
          {
            testId: "hit-rate-catastrophic",
            label: "Catastrophic rate",
            value: hr.catastrophic?.rate_pct != null ? `${hr.catastrophic.rate_pct}%` : "—",
            sub:
              (hr.catastrophic?.sample_size != null
                ? `n=${hr.catastrophic.sample_size}${
                    hr.catastrophic.ci_low_pct != null && hr.catastrophic.ci_high_pct != null
                      ? ` · CI ${hr.catastrophic.ci_low_pct}–${hr.catastrophic.ci_high_pct}%`
                      : ""
                  }`
                : "—") +
              (hr.rolling_30
                ? ` · rolling-30 ${hr.rolling_30.catastrophic_rate_pct}%${
                    hr.catastrophic_alert ? " ⚠" : ""
                  }`
                : ""),
            accent: hr.catastrophic_alert ? "#f87171" : "#fca5a5",
            title:
              "BEAT↔MISS reversals (off-by-2) — the metric tied to real ₹ loss. " +
              `Alert fires when rolling-30 > ${hr.catastrophic_alert_threshold_pct ?? 12}%.`,
          },
        ]
      : [];

    const hitRateRow = hitRateCells.length
      ? `<div data-testid="hit-rate-row" style="display:flex; gap:10px; flex-wrap:wrap; width:100%; margin-top:8px;">${hitRateCells.map(cellHtml).join("")}</div>`
      : "";

    el.innerHTML = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; width:100%;">${dateCells.map(cellHtml).join("")}</div>
      ${hitRateRow}
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

  // ────────── Search match + autocomplete ──────────
  // Symbol-prefix OR company-name substring match, case-insensitive. The
  // top-bar global search hits /api/search across the full NSE/BSE universe;
  // this one searches ONLY what's already in memory (upcoming + recent-7d
  // snapshot) so it's instant and gives the "is this stock in this tab?"
  // answer the user actually wants.

  function matchesSearchQuery(row, queryUpper) {
    if (!queryUpper) return true;
    const sym = String(row.symbol || "").toUpperCase();
    if (sym.startsWith(queryUpper)) return true;
    const co = String(row.company || "").toUpperCase();
    if (co.includes(queryUpper)) return true;
    return false;
  }

  // Build typeahead suggestions from the in-memory snapshot. Upcoming wins
  // over recent for the same symbol (a stock about to report is more
  // actionable than the same stock's past result). Capped at 8 — past that
  // the user should narrow the query.
  function buildSymbolSuggestions(queryUpper) {
    if (!queryUpper || !_earningsSnapshot) return [];
    const seen = new Set();
    const matches = [];
    for (const e of _earningsSnapshot.events || []) {
      if (!e?.symbol || seen.has(e.symbol)) continue;
      if (!matchesSearchQuery(e, queryUpper)) continue;
      seen.add(e.symbol);
      matches.push({
        symbol: e.symbol,
        company: e.company || e.symbol,
        days_until: typeof e.days_until === "number" ? e.days_until : null,
        event_iso_date: e.event_iso_date || null,
        source: "upcoming",
      });
    }
    for (const r of _earningsSnapshot.recent_results || []) {
      if (!r?.symbol || seen.has(r.symbol)) continue;
      if (!matchesSearchQuery(r, queryUpper)) continue;
      seen.add(r.symbol);
      matches.push({
        symbol: r.symbol,
        company: r.company || r.symbol,
        days_until: typeof r.days_until === "number" ? r.days_until : null,
        event_iso_date: r.event_iso_date || null,
        source: "recent",
      });
    }
    matches.sort((a, b) => {
      if (a.source !== b.source) return a.source === "upcoming" ? -1 : 1;
      const aDays = a.days_until ?? Infinity;
      const bDays = b.days_until ?? Infinity;
      if (a.source === "upcoming") return aDays - bDays;
      // recent: both ≤ 0; closer-to-today (larger value) first.
      return bDays - aDays;
    });
    return matches.slice(0, 8);
  }

  function renderSymbolSuggestions(matches) {
    const el = document.getElementById("earningsSymbolSuggestions");
    if (!el) return;
    const input = document.getElementById("earningsSymbolFilter");
    if (!Array.isArray(matches) || matches.length === 0) {
      el.hidden = true;
      el.innerHTML = "";
      if (input) input.setAttribute("aria-expanded", "false");
      return;
    }
    el.innerHTML = matches
      .map((m, i) => {
        const dayLabel = fmtRelativeDate(m.event_iso_date, m.days_until);
        const sourceBadge =
          m.source === "recent"
            ? `<span style="font-size:9px; color:#94a3b8; border:1px solid #2a3349; border-radius:5px; padding:1px 5px; letter-spacing:0.05em; text-transform:uppercase;">Past</span>`
            : "";
        return `
          <div class="earnings-symbol-suggestion" role="option" data-symbol="${escHtml(m.symbol)}" data-index="${i}" aria-selected="false"
               style="display:flex; align-items:center; gap:10px; padding:8px 12px; cursor:pointer; border-bottom:1px solid rgba(42,51,73,0.4);">
            <div style="flex:1; min-width:0;">
              <div style="font-size:12px; font-weight:600; color:#e2e8f0; letter-spacing:-0.01em;">${escHtml(m.symbol)}</div>
              <div style="font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(m.company)}</div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:3px; flex-shrink:0;">
              ${sourceBadge}
              <span style="font-size:10px; color:#cbd5e1; font-weight:500;">${escHtml(dayLabel)}</span>
            </div>
          </div>`;
      })
      .join("");
    el.hidden = false;
    if (input) input.setAttribute("aria-expanded", "true");
  }

  function attachSymbolSearchHandlers() {
    const input = document.getElementById("earningsSymbolFilter");
    const dropdown = document.getElementById("earningsSymbolSuggestions");
    if (!input || !dropdown) return;

    let activeIndex = -1;

    function setActive(idx) {
      const items = dropdown.querySelectorAll(".earnings-symbol-suggestion");
      if (!items.length) return;
      if (idx < 0) idx = items.length - 1;
      if (idx >= items.length) idx = 0;
      activeIndex = idx;
      items.forEach((it, i) => {
        const on = i === idx;
        it.setAttribute("aria-selected", on ? "true" : "false");
        it.style.background = on ? "rgba(96,165,250,0.12)" : "transparent";
      });
      items[idx].scrollIntoView({ block: "nearest" });
    }

    function selectSymbol(symbol) {
      input.value = symbol;
      _earningsFilters.symbol = symbol.toUpperCase();
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      input.setAttribute("aria-expanded", "false");
      applyEarningsFilters();
    }

    input.addEventListener("focus", () => {
      const q = input.value.trim().toUpperCase();
      if (q.length === 0) return;
      const matches = buildSymbolSuggestions(q);
      // If the typed value IS an exact symbol match for the only suggestion,
      // the user already settled (typed it fully or clicked the row) — don't
      // re-pop the dropdown on every focus return.
      if (matches.length === 1 && matches[0].symbol === q) return;
      renderSymbolSuggestions(matches);
    });

    input.addEventListener("keydown", (e) => {
      const items = dropdown.querySelectorAll(".earnings-symbol-suggestion");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (dropdown.hidden) {
          renderSymbolSuggestions(buildSymbolSuggestions(input.value.trim().toUpperCase()));
        }
        setActive(activeIndex + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (dropdown.hidden) return;
        setActive(activeIndex - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!dropdown.hidden && activeIndex >= 0 && items[activeIndex]) {
          selectSymbol(items[activeIndex].dataset.symbol);
        } else {
          // No row selected — apply current typed text immediately
          // (bypass the 200ms debounce on the input listener).
          _earningsFilters.symbol = input.value.trim().toUpperCase();
          dropdown.hidden = true;
          input.setAttribute("aria-expanded", "false");
          applyEarningsFilters();
        }
      } else if (e.key === "Escape") {
        dropdown.hidden = true;
        input.setAttribute("aria-expanded", "false");
        activeIndex = -1;
      }
    });

    dropdown.addEventListener("click", (e) => {
      const row = e.target.closest(".earnings-symbol-suggestion");
      if (!row) return;
      selectSymbol(row.dataset.symbol);
    });

    dropdown.addEventListener("mousemove", (e) => {
      const row = e.target.closest(".earnings-symbol-suggestion");
      if (!row) return;
      const idx = Number(row.dataset.index);
      if (Number.isFinite(idx)) setActive(idx);
    });

    // Bind document outside-click handler once. renderEarningsFilterBar
    // calls attachSymbolSearchHandlers() on every re-render (filter clear,
    // snapshot reload), so we guard with a body dataset flag to avoid
    // stacking listeners.
    if (!document.body.dataset.earningsSearchBound) {
      document.addEventListener("click", (ev) => {
        const dd = document.getElementById("earningsSymbolSuggestions");
        const inp = document.getElementById("earningsSymbolFilter");
        if (!dd || !inp || dd.hidden) return;
        if (ev.target.closest(".earnings-symbol-search")) return;
        dd.hidden = true;
        inp.setAttribute("aria-expanded", "false");
      });
      document.body.dataset.earningsSearchBound = "1";
    }
  }

  // Empty-state for "search returned nothing in either upcoming or recent"
  // — gives the user explicit feedback instead of two empty containers.
  function renderSearchEmptyState({ query, hasUpcomingMatches, hasRecentMatches }) {
    const el = document.getElementById("earningsSearchEmptyState");
    if (!el) return;
    if (!query || hasUpcomingMatches || hasRecentMatches) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <div style="padding:18px 22px; border:1px dashed #2a3349; border-radius:10px; background:rgba(15,20,34,0.5); display:flex; flex-direction:column; gap:6px;">
        <div style="font-size:13px; color:#e2e8f0; font-weight:500;">
          <span style="color:#fbbf24; font-weight:600;">${escHtml(query)}</span> — no earnings in the next 30 days or past 7 days.
        </div>
        <div style="font-size:12px; color:var(--text-muted);">
          Try a different ticker, or use the search bar at the top of the page to look up the full NSE / BSE stock universe.
        </div>
      </div>`;
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
        <div class="earnings-symbol-search" style="position:relative;">
          <input id="earningsSymbolFilter" type="text" placeholder="e.g. RELIANCE or 'tata'" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="earningsSymbolSuggestions" style="background:var(--panel,#0f1422); color:#e2e8f0; border:1px solid #2a3349; border-radius:6px; padding:6px 10px; font-size:12px; width:170px;" />
          <div id="earningsSymbolSuggestions" role="listbox" aria-label="Matching stocks in upcoming or recent earnings" hidden style="position:absolute; top:100%; left:0; right:0; z-index:50; background:var(--panel,#0f1422); border:1px solid #2a3349; border-radius:6px; margin-top:4px; max-height:280px; overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,0.5);"></div>
        </div>
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
        // Zero-latency typeahead — refresh suggestions on every keystroke
        // so the user gets immediate visual feedback.
        const q = symInp.value.trim().toUpperCase();
        renderSymbolSuggestions(buildSymbolSuggestions(q));
        // Debounced grid filter — re-rendering the whole card grid on
        // every keystroke would jank in slow tabs, so wait 200ms after
        // the user stops typing.
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          _earningsFilters.symbol = q;
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
    // Wire the autocomplete dropdown's focus/keyboard/click handlers.
    // Re-runs on every filter-bar render (the input element is replaced),
    // but the document-level outside-click listener inside is guarded
    // against re-binding.
    attachSymbolSearchHandlers();
  }

  function applyEarningsFilters() {
    // UI/UX overhaul 2026-05-19 — every filter change persists. Symbol is
    // excluded from the saved payload (transient search query). Called
    // upstream by every filter handler; cost is a single localStorage.setItem
    // which is fast enough at typing cadence.
    saveEarningsFilters(_earningsFilters);
    if (!_earningsSnapshot) return;
    const query = _earningsFilters.symbol || "";
    const events = (_earningsSnapshot.events || []).filter((e) => {
      // Search overrides sibling filters: when the user has typed a query,
      // a stock that matches symbol-prefix OR company-substring surfaces
      // regardless of days / verdict / quality / runup / sector. That way
      // a user who set Verdict=BEAT and then searches a known MISS stock
      // still finds it instead of getting an empty grid.
      if (query) return matchesSearchQuery(e, query);

      if (typeof _earningsFilters.days === "number" && Number.isFinite(_earningsFilters.days)) {
        if (typeof e.days_until === "number" && e.days_until > _earningsFilters.days) return false;
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

    // Recent results section: symbol + sector filters apply; the days /
    // verdict / quality / runup filters intentionally don't (past rows
    // have no signals block, and "Within N days" is forward-only).
    const filteredRecent = applyRecentFilters(_earningsSnapshot.recent_results);

    // Suppress the grid's generic "No upcoming results" placeholder when
    // the search itself is the reason for emptiness — the empty-state
    // banner below the filter bar already explains it.
    const suppressGridPlaceholder = !!query && events.length === 0;
    renderEarningsCardGrid(events, { suppressEmptyState: suppressGridPlaceholder });
    renderRecentResultsSection(filteredRecent);
    renderSearchEmptyState({
      query,
      hasUpcomingMatches: events.length > 0,
      hasRecentMatches: filteredRecent.length > 0,
    });
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
    if (!band) return "";
    // INSUFFICIENT_DATA (and any other basis where the builder set all three
    // cells to null) carries semantic meaning — "no projected upper/lower
    // bound, the model didn't have enough to score this print". Empty cells
    // looked like a render bug; instead we surface `n/a` per cell with a
    // tooltip explaining why. `.band-na` is styled in gated/index.html.
    const naTitle = "insufficient data — no projected upper or lower bound";
    const fmt = (cell, role) => {
      if (!cell || cell.pct == null) {
        return `<span class="band-na" title="${naTitle}">n/a</span>`;
      }
      const label = band.anchored && cell.price_inr != null
        ? `₹${cell.price_inr.toLocaleString("en-IN")}`
        : `${cell.pct >= 0 ? "+" : ""}${cell.pct}%`;
      return escHtml(label);
    };
    const pctLabel = (cell) => {
      if (!cell || cell.pct == null) return "—";
      return `${cell.pct >= 0 ? "+" : ""}${cell.pct}%`;
    };
    return `
      <div style="display:flex; gap:8px; padding-top:8px; border-top:1px dashed #1a2233; font-size:11px;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">Bear</div>
          <div style="font-weight:600; color:#fca5a5;">${fmt(band.bear, "bear")}</div>
          <div style="font-size:10px; color:var(--text-muted);">${pctLabel(band.bear)}</div>
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">Base</div>
          <div style="font-weight:600; color:#cbd5e1;">${fmt(band.base, "base")}</div>
          <div style="font-size:10px; color:var(--text-muted);">${pctLabel(band.base)}</div>
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">Bull</div>
          <div style="font-weight:600; color:#86efac;">${fmt(band.bull, "bull")}</div>
          <div style="font-size:10px; color:var(--text-muted);">${pctLabel(band.bull)}</div>
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

  function renderTradingAngle(playbook, event) {
    if (!playbook || !playbook.tradable) return "";

    // PR A2 — confidence-calibrated sizing pill. Read from event.sizing
    // (richer, lab-calibrated) first; fall back to baked playbook fields.
    const sizingPill = renderPositionSizingPill(event?.sizing, playbook);

    if (playbook.mode === "t1" && playbook.plan) {
      // Post-result variant — single resolved cell + gap-tactical.
      const tone = playbook.plan.confidence === "HIGH" ? "#86efac" : playbook.plan.confidence === "MEDIUM" ? "#fbbf24" : "#cbd5e1";
      return `
        <div style="background:rgba(15,20,34,0.6); border:1px solid #1a2233; border-radius:8px; padding:10px 12px; font-size:11px; line-height:1.5;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; gap:8px; flex-wrap:wrap;">
            <span style="color:${tone}; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; font-size:10px;">${escHtml(playbook.cell_key || "")} · ${escHtml(playbook.plan.confidence || "")}</span>
            <div style="display:flex; gap:6px; align-items:center;">
              ${sizingPill}
              <span style="font-size:10px; color:var(--text-muted);">T+1 plan</span>
            </div>
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
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap;">
            <div style="display:flex; gap:5px;">${branches.map(branchChip).join("")}</div>
            <div style="display:flex; gap:6px; align-items:center;">
              ${sizingPill}
              <span style="font-size:10px; color:var(--text-muted); letter-spacing:0.04em; text-transform:uppercase;">trading angle</span>
            </div>
          </div>
          <div style="color:#cbd5e1;">
            <span style="color:var(--text-muted); font-size:10px;">If ${escHtml(highlight || "MAINTAIN")}:</span>
            ${escHtml(stanceLine)}
          </div>
        </div>`;
    }

    return "";
  }

  // PR A2 — confidence-calibrated position-size pill. Colour-codes by tier:
  // green (1.0x), amber (0.6x), red (≤0.3x). The tooltip explains "why" so
  // the user understands the calibration came from the Risk Lab.
  function renderPositionSizingPill(sizing, playbook) {
    // Prefer the request-time sizing object (lab-calibrated). Fall back to
    // the baked playbook fields (production confidence only). If neither
    // is present, render nothing.
    let mult, source, effectivePct, prodPct, labPct, tierLabel;
    if (sizing && typeof sizing.multiplier === "number") {
      mult = sizing.multiplier;
      source = sizing.source;
      effectivePct = sizing.effective_confidence_pct;
      prodPct = sizing.production_confidence_pct;
      labPct = sizing.calibrated_confidence_pct;
      tierLabel = sizing.tier_label;
    } else if (playbook && typeof playbook.position_size_multiplier === "number") {
      mult = playbook.position_size_multiplier;
      source = "production_only";
      effectivePct = null;
      tierLabel = playbook.position_size_tier?.label || null;
    } else {
      return "";
    }
    const tone =
      mult >= 1.0
        ? { bg: "rgba(34,197,94,0.15)", color: "#86efac", border: "rgba(34,197,94,0.4)" }
        : mult >= 0.6
          ? { bg: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "rgba(251,191,36,0.35)" }
          : { bg: "rgba(239,68,68,0.12)", color: "#fca5a5", border: "rgba(239,68,68,0.4)" };
    const labelMult = `${mult}x`;
    const tipParts = [`${tierLabel || "Sized"} (${labelMult})`];
    if (source === "lab_calibrated" && labPct !== null && labPct !== undefined && prodPct !== null && prodPct !== undefined) {
      tipParts.push(`Calibrated by Risk Lab: ${Math.round(prodPct)}% → ${Math.round(labPct)}% confidence`);
    } else if (effectivePct !== null && effectivePct !== undefined) {
      tipParts.push(`Confidence ${Math.round(effectivePct)}%`);
    }
    tipParts.push("Multiplier × your normal per-trade size — decision support, not investment advice.");
    const tip = tipParts.join(" · ");
    const badge = source === "lab_calibrated" ? "⚖" : "";
    return `<span data-testid="sizing-pill" data-multiplier="${mult}" data-source="${source}" title="${escHtml(tip)}" style="display:inline-flex; align-items:center; gap:4px; padding:2px 7px; border-radius:9px; font-size:10px; font-weight:700; background:${tone.bg}; color:${tone.color}; border:1px solid ${tone.border};">${badge ? `<span style="opacity:0.85;">${badge}</span>` : ""}<span>${escHtml(labelMult)} size</span></span>`;
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

  // PR A1 — Risk Lab "second opinion" badge. Read-only projection of the
  // lab's quality + macro overlays. Surfaces a compact strip when the lab
  // either disagrees with the production prediction or has flags worth
  // surfacing. Production verdict and trading playbook above are UNCHANGED;
  // this is purely a SEBI Reg 19 risk-disclosure surface.
  function renderLabSecondOpinion(labView, prediction) {
    if (!labView) return "";
    const flagCount = Array.isArray(labView.quality_flags) ? labView.quality_flags.length : 0;
    const hasMacro = labView.has_macro_overlay === true;
    const hasQuality = labView.has_quality_overlay === true;
    const disagrees = labView.disagrees_with_prediction === true;
    // PR 1 — distinguish hard evidence from boilerplate-only.
    const hasHard = labView.has_hard_evidence === true;
    const hardCount = labView.hard_evidence_count || 0;
    const boilerplateOnlyCount = labView.counter_thesis_only_count || 0;
    // PR 3 — LLM authoritative reading (groq/gemini) supersedes heuristic.
    const llmCheck = labView.llm_disagreement_check || null;
    const llmProvider = llmCheck?.classifier_provider || null;
    const llmAuthoritative = labView.llm_authoritative === true;

    if (!disagrees && !flagCount && !hasMacro) return "";

    // Three-tier visual: DISAGREES (amber, strong) > NOTES (slate, muted)
    // > BOILERPLATE-ONLY (dim, deprioritised). Boilerplate-only never
    // claims "disagree" after PR 1 — it's the most muted variant.
    const isBoilerplateOnly = !disagrees && !hasHard && !hasMacro && boilerplateOnlyCount > 0;
    const stripeColor = disagrees ? "#fbbf24" : isBoilerplateOnly ? "#64748b" : "#94a3b8";
    const accentBg = disagrees
      ? "rgba(251,191,36,0.06)"
      : isBoilerplateOnly
        ? "rgba(100,116,139,0.025)"
        : "rgba(148,163,184,0.04)";
    const headerLabel = disagrees
      ? "Risk Lab disagrees"
      : isBoilerplateOnly
        ? "Risk Lab notes (generic)"
        : "Risk Lab notes";

    const prodVerdict = prediction?.verdict || null;
    const confDelta = labView.confidence_delta_pct;

    let verdictDeltaText = "";
    if (labView.macro_veto?.vetoed === true) {
      verdictDeltaText = `${prodVerdict || "?"} → SKIP (macro veto)`;
    } else if (
      disagrees &&
      typeof labView.combined_verdict === "string" &&
      labView.combined_verdict.startsWith("LOW_QUALITY_") &&
      prodVerdict === "BEAT"
    ) {
      verdictDeltaText = "BEAT → INLINE";
    }
    const confDeltaText =
      typeof confDelta === "number" && confDelta !== 0
        ? `confidence ${confDelta > 0 ? "+" : ""}${confDelta}pp`
        : "";
    const deltaSummary = [verdictDeltaText, confDeltaText].filter(Boolean).join(" · ");

    // PR 3 — render the LLM's top_reason FIRST when authoritative
    // (the model has read the actual SWS text and decided "yes/no with reason"),
    // followed by heuristic top_reasons. Tag each reason source so users
    // can see boilerplate vs hard evidence vs LLM.
    const llmReasonLi = llmAuthoritative && llmCheck?.top_reason
      ? `<li style="font-size:10.5px; color:#cbd5e1; line-height:1.45;"><span style="color:${stripeColor};">▸</span> <span style="font-size:9px; padding:0 4px; border-radius:3px; background:rgba(96,165,250,0.18); color:#93c5fd; margin-right:4px;">LLM (${escHtml(llmProvider)})</span>${escHtml(String(llmCheck.top_reason))}</li>`
      : "";
    const topReasons = Array.isArray(labView.top_reasons) ? labView.top_reasons.slice(0, 3) : [];
    const heuristicReasonItems = topReasons.map((r) => {
      const isBoilerplate = r.is_boilerplate === true;
      const tag = isBoilerplate
        ? '<span style="font-size:9px; padding:0 4px; border-radius:3px; background:rgba(100,116,139,0.18); color:#94a3b8; margin-right:4px;">generic</span>'
        : '<span style="font-size:9px; padding:0 4px; border-radius:3px; background:rgba(34,197,94,0.16); color:#86efac; margin-right:4px;">evidence</span>';
      return `<li style="font-size:10.5px; color:#cbd5e1; line-height:1.45;"><span style="color:${stripeColor};">▸</span> ${tag}${escHtml(
        String(r.summary || r.category || ""),
      )}</li>`;
    });
    const reasonsHtml = (llmReasonLi || heuristicReasonItems.length)
      ? `<ul style="margin:4px 0 0 0; padding:0; list-style:none;">${llmReasonLi}${heuristicReasonItems.join("")}</ul>`
      : "";

    let macroNote = "";
    if (hasMacro && labView.regime) {
      const vetoed = labView.macro_veto?.vetoed === true;
      const macroDelta = labView.macro_score_delta || 0;
      const macroBits = [`<span style="color:${stripeColor};">${escHtml(String(labView.regime))}</span>`];
      if (labView.regime_severity != null) macroBits.push(`sev ${escHtml(String(labView.regime_severity))}`);
      if (labView.regime_stale) macroBits.push('<span style="color:#fca5a5;">(stale)</span>');
      const tail = vetoed
        ? ` — <span style="color:#fca5a5;">VETO: ${escHtml(String(labView.macro_veto?.reason || ""))}</span>`
        : macroDelta
          ? ` — score Δ ${macroDelta > 0 ? "+" : ""}${escHtml(String(macroDelta))}`
          : "";
      macroNote = `<div style="font-size:10.5px; color:#cbd5e1; margin-top:4px;">↪ Macro: ${macroBits.join(" ")}${tail}</div>`;
    }

    // Discrimination diagnostic suffix — small but real signal to the user
    // about evidence depth without overwhelming the strip.
    const diagSuffix = hasHard
      ? ` (${hardCount} evidence${boilerplateOnlyCount ? ` · ${boilerplateOnlyCount} generic` : ""})`
      : isBoilerplateOnly
        ? ` (${boilerplateOnlyCount} generic)`
        : "";

    return `
      <div data-testid="lab-second-opinion" data-disagrees="${disagrees ? "true" : "false"}" data-has-hard-evidence="${hasHard ? "true" : "false"}" data-llm-provider="${escHtml(llmProvider || "none")}" style="margin-top:6px; padding:8px 10px; border-left:3px solid ${stripeColor}; background:${accentBg}; border-radius:0 6px 6px 0;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
          <span style="font-size:10.5px; color:${stripeColor}; font-weight:600; letter-spacing:0.04em; text-transform:uppercase;">⚖ ${headerLabel}${diagSuffix}</span>
          ${deltaSummary ? `<span style="font-size:10.5px; color:${stripeColor};">${escHtml(deltaSummary)}</span>` : ""}
        </div>
        ${reasonsHtml}
        ${macroNote}
        <div style="font-size:9px; color:var(--text-muted); margin-top:4px; font-style:italic;">Experimental — does not change production verdict. See Risk Lab tab.</div>
      </div>`;
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
        ${renderTradingAngle(playbook, event)}
        ${renderLabSecondOpinion(event.lab_view, prediction)}
        ${renderCounterThesisBlurb(signals)}
        ${renderPredictionBuildExpander(event)}
      </div>`;
  }

  function renderEarningsCardGrid(events, opts) {
    const el = document.getElementById("earningsCardGrid");
    if (!el) return;
    const suppressEmptyState = !!(opts && opts.suppressEmptyState);
    if (!Array.isArray(events) || events.length === 0) {
      if (suppressEmptyState) {
        // Search-driven emptiness — the #earningsSearchEmptyState banner
        // is already shown above; keep this grid silent.
        el.innerHTML = "";
        return;
      }
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

  // ────────── Recent results (past N days) ──────────
  //
  // Renders a "Recent results · past N days" section above the upcoming
  // card grid. Each card shows the original predicted verdict next to
  // the actual result + a hit/miss accuracy badge. Slim variant — no
  // signals/playbook/rationale expanders, since those were prediction-
  // time noise and the actual result either confirmed or refuted them.

  function applyRecentFilters(rows) {
    if (!Array.isArray(rows)) return [];
    const query = (_earningsFilters.symbol || "").toUpperCase();
    const sector = _earningsFilters.sector || "ALL";
    return rows.filter((r) => {
      // Search overrides the sector filter (mirrors applyEarningsFilters).
      if (query) return matchesSearchQuery(r, query);
      if (sector !== "ALL" && (r.sector || "") !== sector) return false;
      return true;
    });
  }

  function renderRecentResultCard(row) {
    if (!row || !row.symbol) return "";
    const eventDate = fmtIsoToLong(row.event_iso_date);
    const dayLabel = fmtRelativeDate(row.event_iso_date, row.days_until);
    const dayPill = dayPillClass(row.days_until);

    const predTone = predictedVerdictTone(row.predicted_verdict);
    const actualTone = predictedVerdictTone(row.actual_verdict);
    const acc = row.prediction_accuracy;
    const accBadge =
      acc === "hit"
        ? `<span title="Predicted verdict matched actual outcome" style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:10px; background:rgba(34,197,94,0.18); border:1px solid rgba(34,197,94,0.4); color:#86efac; font-size:10px; font-weight:700; letter-spacing:0.06em;">✓ HIT</span>`
        : acc === "miss"
          ? `<span title="Predicted verdict did not match actual outcome" style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:10px; background:rgba(239,68,68,0.18); border:1px solid rgba(239,68,68,0.4); color:#fca5a5; font-size:10px; font-weight:700; letter-spacing:0.06em;">✗ MISS</span>`
          : "";

    const conf = typeof row.confidence_pct === "number" ? `${row.confidence_pct}%` : "—";
    const closeStr =
      typeof row.actual_t1_close_inr === "number"
        ? `₹${row.actual_t1_close_inr.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
        : null;
    const gapPct = typeof row.actual_t1_open_gap_pct === "number" ? row.actual_t1_open_gap_pct : null;
    const gapStr =
      gapPct == null
        ? null
        : `${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(2)}%`;
    const gapColor = gapPct == null ? "#cbd5e1" : gapPct >= 0 ? "#86efac" : "#fca5a5";

    const safeClick = `if(typeof openStockDetailModal==='function'){openStockDetailModal('${escHtml(row.symbol)}','earnings');}`;
    const fq = row.fiscal_quarter ? escHtml(row.fiscal_quarter) : "";
    const sectorLabel = row.sector
      ? `<span style="font-size:10px; color:var(--text-muted); letter-spacing:0.04em;">· ${escHtml(row.sector)}</span>`
      : "";
    const sourceLabel = row.actual_source
      ? `<span style="font-size:10px; color:var(--text-muted);">via ${escHtml(row.actual_source)}</span>`
      : "";

    return `
      <div class="earnings-recent-card" data-symbol="${escHtml(row.symbol)}" data-accuracy="${escHtml(acc || "")}" onclick="${safeClick}" style="background:var(--panel,#0f1422); border:1px solid #1a2233; border-top:2px solid ${actualTone.border}; border-radius:10px; padding:14px 16px; cursor:pointer; transition:transform 120ms ease, border-color 120ms ease; display:flex; flex-direction:column; gap:9px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
          <div style="min-width:0; flex:1;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span style="font-size:15px; font-weight:600; color:#e2e8f0; letter-spacing:-0.01em;">${escHtml(row.symbol)}</span>
              ${fq ? `<span style="font-size:11px; color:var(--text-muted); letter-spacing:0.04em;">${fq}</span>` : ""}
              ${accBadge}
            </div>
            <div style="font-size:12px; color:var(--text-muted); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(row.company || row.symbol)} ${sectorLabel}</div>
          </div>
          <div style="text-align:right; flex-shrink:0;">
            <span class="${dayPill}" style="display:inline-block; padding:3px 9px; border-radius:11px; font-size:10px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase;">${escHtml(dayLabel)}</span>
            <div style="font-size:10px; color:var(--text-muted); margin-top:4px;">${escHtml(eventDate)}</div>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <div style="display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:12px; background:${predTone.bg}; border:1px solid ${predTone.border}; color:${predTone.color};">
            <span style="font-size:9px; opacity:0.7; font-weight:600; letter-spacing:0.06em;">PREDICTED</span>
            <span style="font-size:11px; font-weight:700; letter-spacing:0.04em;">${escHtml(row.predicted_verdict || "—")}</span>
            <span style="font-size:10px; opacity:0.85;">${escHtml(conf)}</span>
          </div>
          <div style="display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:12px; background:${actualTone.bg}; border:1px solid ${actualTone.border}; color:${actualTone.color};">
            <span style="font-size:9px; opacity:0.7; font-weight:600; letter-spacing:0.06em;">ACTUAL</span>
            <span style="font-size:11px; font-weight:700; letter-spacing:0.04em;">${escHtml(row.actual_verdict || "—")}</span>
          </div>
        </div>
        ${
          closeStr || gapStr
            ? `<div style="display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:var(--text-muted);">
                ${closeStr ? `<div><span style="opacity:0.7;">T+1 close</span> <span style="color:#e2e8f0; font-weight:500;">${escHtml(closeStr)}</span></div>` : ""}
                ${gapStr ? `<div><span style="opacity:0.7;">T+1 gap</span> <span style="color:${gapColor}; font-weight:500;">${escHtml(gapStr)}</span></div>` : ""}
              </div>`
            : ""
        }
        ${sourceLabel ? `<div style="margin-top:-2px;">${sourceLabel}</div>` : ""}
      </div>`;
  }

  // PR3 — renders the "qualitative signal: deterministic-only" pill in
  // the Recent Results header when the LLM lever is operating on the
  // heuristic-only fallback (GROQ/GEMINI keys not configured on the
  // refresh host). SEBI-RA-grade transparency — the user can see when
  // the predictor's qualitative read is degraded.
  function renderLlmOfflinePill(snap) {
    const health = snap && snap.health;
    if (!health || health.llm_offline !== true) return "";
    const sharePct = typeof health.llm_heuristic_share_pct === "number"
      ? `${health.llm_heuristic_share_pct}% heuristic`
      : "heuristic-only";
    return `<span
      data-testid="llm-signal-mode-pill"
      title="The qualitative LLM read is running on the deterministic heuristic fallback (${sharePct}). Set GROQ_API_KEY or GEMINI_API_KEY on the refresh host to restore Groq/Gemini classification."
      style="font-size:10px; color:#fbbf24; border:1px solid rgba(245,158,11,0.45); border-radius:6px; padding:1px 6px; letter-spacing:0.04em; text-transform:uppercase;"
    >qualitative signal: deterministic-only</span>`;
  }

  function renderRecentResultsSection(rows) {
    const el = document.getElementById("earningsRecentResults");
    if (!el) return;
    if (!Array.isArray(rows) || rows.length === 0) {
      el.innerHTML = "";
      el.style.display = "none";
      el.removeAttribute("data-collapsed");
      return;
    }
    el.style.display = "block";
    const pastWindow = _earningsSnapshot?.past_window_days ?? 7;
    const hits = rows.filter((r) => r.prediction_accuracy === "hit").length;
    const misses = rows.filter((r) => r.prediction_accuracy === "miss").length;
    const accuracyChip =
      hits + misses > 0
        ? `<span style="font-size:11px; color:var(--text-muted); letter-spacing:0.04em;">${hits}/${hits + misses} predictions correct</span>`
        : "";
    const llmPill = renderLlmOfflinePill(_earningsSnapshot);
    const isCollapsed = loadRecentResultsCollapsed();
    el.setAttribute("data-collapsed", isCollapsed ? "1" : "0");
    el.innerHTML = `
      <div class="earnings-date-header" style="display:flex; align-items:baseline; gap:10px; margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid #1a2233; flex-wrap:wrap; cursor:pointer; user-select:none;">
        <span class="earnings-date-caret" style="font-size:11px; color:var(--text-muted); width:10px; display:inline-block;">${isCollapsed ? "▸" : "▾"}</span>
        <span style="font-size:13px; font-weight:600; color:#e2e8f0; letter-spacing:-0.01em;">Recent results</span>
        <span style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">past ${pastWindow}d · ${rows.length} ${rows.length === 1 ? "result" : "results"}</span>
        ${accuracyChip}
        ${llmPill}
      </div>
      <div class="earnings-date-body" style="${isCollapsed ? "display:none;" : "display:grid;"} grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:12px;">
        ${rows.map(renderRecentResultCard).join("")}
      </div>`;

    // One-time delegated click handler. Guards against stacking on re-render
    // (renderRecentResultsSection runs on every filter change) the same way
    // the per-date grid does at lines above.
    if (!el.dataset.collapseBound) {
      el.addEventListener("click", (ev) => {
        const header = ev.target.closest(".earnings-date-header");
        if (!header || header.parentElement !== el) return;
        const wasCollapsed = el.getAttribute("data-collapsed") === "1";
        const next = !wasCollapsed;
        el.setAttribute("data-collapsed", next ? "1" : "0");
        const body = el.querySelector(".earnings-date-body");
        const caret = el.querySelector(".earnings-date-caret");
        if (body) body.style.display = next ? "none" : "grid";
        if (caret) caret.textContent = next ? "▸" : "▾";
        saveRecentResultsCollapsed(next);
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
        const recent = Array.isArray(snap?.recent_results) ? snap.recent_results.length : 0;
        const pastN = snap?.past_window_days ?? 7;
        const recentLabel = recent > 0 ? ` · ${recent} resolved in past ${pastN}d` : "";
        meta.textContent = `${total} upcoming result events in next ${snap?.window_days ?? 30}d${recentLabel} · built ${built} · NSE feed fetched ${upstream}`;
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
      .earnings-day-pill--past { background:rgba(71,85,105,0.18); color:#94a3b8; border:1px solid rgba(71,85,105,0.35); }
      .earnings-day-pill--unknown { background:rgba(148,163,184,0.08); color:#94a3b8; border:1px solid rgba(148,163,184,0.18); }
      .earnings-card:hover { transform:translateY(-1px); border-color:#2a3349; }
      .earnings-recent-card:hover { transform:translateY(-1px); border-color:#2a3349; }
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

  // Compact one-liner for the collapsed-state summary. Renders the verdict +
  // confidence + bull/base/bear levels at-a-glance. Empty when the prediction
  // is missing — caller still shows the date/quarter line.
  function _renderEarningsSummaryStrip(prediction, priceBand) {
    if (!prediction && !priceBand) return "";
    let predictionFrag = "";
    if (prediction && prediction.verdict) {
      const v = prediction.verdict;
      const conf = Number.isFinite(prediction.confidence_pct) ? `${Math.round(prediction.confidence_pct)}%` : null;
      const verdictColor = v === "BEAT" ? "#86efac" : v === "MISS" ? "#fca5a5" : "#cbd5e1";
      predictionFrag = `
        <span style="display:inline-flex; align-items:center; gap:6px; font-size:12px;">
          <strong style="color:${verdictColor}; font-weight:700; letter-spacing:0.02em;">${escHtml(v)}</strong>
          ${conf ? `<span style="color:var(--text-muted); font-size:11px;">${escHtml(conf)} conf</span>` : ""}
        </span>`;
    }
    let bandFrag = "";
    if (priceBand) {
      // INSUFFICIENT_DATA leaves all three cells null but the band object
      // still exists — show `n/a` per cell (with tooltip) instead of hiding
      // the whole strip, so the prediction stays explained.
      const naTitle = "insufficient data — no projected upper or lower bound";
      const cell = (label, c, color) => {
        let inner;
        if (!c || c.pct == null) {
          inner = `<span class="band-na" title="${naTitle}">n/a</span>`;
        } else {
          const val = priceBand.anchored && c.price_inr != null
            ? `₹${c.price_inr.toLocaleString("en-IN")}`
            : `${c.pct >= 0 ? "+" : ""}${c.pct}%`;
          inner = `<span style="color:${color}; font-weight:600;">${escHtml(val)}</span>`;
        }
        return `<span style="color:var(--text-muted); font-size:11px;">${label} ${inner}</span>`;
      };
      bandFrag = `
        <span style="display:inline-flex; gap:10px; align-items:center;">
          ${cell("Bear", priceBand.bear, "#fca5a5")}
          ${cell("Base", priceBand.base, "#cbd5e1")}
          ${cell("Bull", priceBand.bull, "#86efac")}
        </span>`;
    }
    if (!predictionFrag && !bandFrag) return "";
    return `
      <div style="display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-top:6px;">
        ${predictionFrag}
        ${bandFrag ? `<span style="color:#1a2233;">•</span>${bandFrag}` : ""}
      </div>`;
  }

  // localStorage key for the user's expanded/collapsed preference on the
  // earnings preview. Persists per browser — defaults to COLLAPSED so the
  // modal's main content (SWS scoring, snowflake, action chip) stays
  // above-the-fold instead of being pushed below 600+ px of earnings UI.
  const _EARNINGS_PREVIEW_PREF_KEY = "swsEarningsPreviewExpanded";
  function _readEarningsPreviewPref() {
    try { return window.localStorage.getItem(_EARNINGS_PREVIEW_PREF_KEY) === "true"; }
    catch { return false; }
  }
  function _writeEarningsPreviewPref(open) {
    try { window.localStorage.setItem(_EARNINGS_PREVIEW_PREF_KEY, open ? "true" : "false"); }
    catch {}
  }

  function renderEarningsPreviewPanel(event) {
    if (!event) return "";
    const { fiscal_quarter, days_until, event_iso_date } = event;
    const dayLabel = fmtRelativeDate(event_iso_date, days_until);
    const isOpen = _readEarningsPreviewPref();
    const summaryStrip = _renderEarningsSummaryStrip(event.prediction, event.price_band);
    return `
      <div id="modalEarningsPreviewSection" style="background:rgba(245,158,11,0.04); border:1px solid rgba(245,158,11,0.2); border-radius:10px; padding:0; margin-bottom:18px; overflow:hidden;">
        <details id="modalEarningsPreviewDetails"${isOpen ? " open" : ""} style="margin:0;">
          <summary style="cursor:pointer; padding:14px 20px; list-style:none; outline:none;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                  <span style="font-size:11px; color:#fbbf24; letter-spacing:0.06em; text-transform:uppercase; font-weight:700;">Upcoming earnings preview</span>
                  <span id="modalAnalyzerStance" style="display:inline-flex;"></span>
                  <span data-earnings-toggle-hint style="font-size:10px; color:var(--text-muted); font-style:italic;">click to ${isOpen ? "collapse" : "expand"}</span>
                </div>
                <div style="font-size:13px; color:#cbd5e1; margin-top:4px;">${escHtml(fiscal_quarter || "next result")} · ${escHtml(dayLabel)} (${escHtml(fmtIsoToLong(event_iso_date))})</div>
                ${summaryStrip}
              </div>
              <div style="font-size:10px; color:var(--text-muted); max-width:240px; text-align:right; line-height:1.4;">
                Algorithmic preview from public data. Confidence reflects model agreement, not certainty. Earnings are binary events.
              </div>
            </div>
          </summary>
          <div style="padding:0 20px 18px 20px;">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:8px;">
              <div>${renderModalPredictionRing(event.prediction)}</div>
              <div>${renderPriceBand(event.price_band)}</div>
            </div>
            ${renderModalRationaleParagraphs(event.rationale)}
            ${renderModalPlaybookBranches(event.playbook)}
            ${renderModalAnnouncementsList(event.signals)}
            ${renderModalDealsTable(event.signals)}
            ${renderModalFalsificationList(event.rationale)}
          </div>
        </details>
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
  // Render the analyzer-stance pill into the modal header. Used by the
  // post-injection logic AND by the analyzer tab when it pushes a fresh
  // stance into window.analyzerStanceByTicker.
  function _renderAnalyzerStancePill(stance) {
    if (!stance || !stance.action) return "";
    const action = stance.action;
    const isBearish = /^(EXIT|Reduction)/.test(action);
    const isBullish = /^Top-up|STRONG Top-up/.test(action);
    const bg = isBearish ? "rgba(248,113,113,0.14)" : isBullish ? "rgba(134,239,172,0.14)" : "rgba(251,191,36,0.14)";
    const fg = isBearish ? "#fca5a5" : isBullish ? "#86efac" : "#fbbf24";
    const border = isBearish ? "rgba(248,113,113,0.28)" : isBullish ? "rgba(134,239,172,0.28)" : "rgba(251,191,36,0.28)";
    const convictionFrag = stance.conviction
      ? ` <span style="color:var(--text-muted); font-size:9.5px; margin-left:4px;">${escHtml(stance.conviction)}</span>`
      : "";
    return `
      <button type="button" data-analyzer-stance-pill style="display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; background:${bg}; color:${fg}; border:1px solid ${border}; font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; cursor:pointer;" title="Analyzer's current action for this holding. Click to jump to the Portfolio Analyzer tab.">
        <span>Analyzer: ${escHtml(action)}</span>${convictionFrag}
      </button>`;
  }

  // Fetch the stance for the given ticker. First checks the fast-path
  // window.analyzerStanceByTicker (populated by the analyzer tab on render),
  // then falls back to /api/portfolio/stance/:symbol. Returns null when both
  // paths come up empty — pill simply doesn't render in that case.
  async function _resolveAnalyzerStance(ticker) {
    const t = String(ticker).toUpperCase();
    if (window.analyzerStanceByTicker && window.analyzerStanceByTicker[t]) {
      return window.analyzerStanceByTicker[t];
    }
    try {
      const res = await fetch(`/api/portfolio/stance/${encodeURIComponent(t)}`, { credentials: "same-origin" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function _populateAnalyzerStanceInModal(ticker) {
    const slot = document.getElementById("modalAnalyzerStance");
    if (!slot) return;
    const stance = await _resolveAnalyzerStance(ticker);
    if (!stance) return;
    // Same ticker-match guard as the earnings injection — user may have
    // moved to another modal by the time the fetch resolves.
    if (typeof window.swsModalCurrentTicker === "string" &&
        window.swsModalCurrentTicker.toUpperCase() !== String(ticker).toUpperCase()) {
      return;
    }
    slot.innerHTML = _renderAnalyzerStancePill(stance);
    const btn = slot.querySelector("[data-analyzer-stance-pill]");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Close the modal then switch to the analyzer tab. Both functions
        // are top-level declarations in gated/app.js so they're available
        // on window in the browser global scope.
        if (typeof window.closeSwsModal === "function") window.closeSwsModal();
        if (typeof window.switchTab === "function") window.switchTab("analyzer");
      });
    }
  }

  // Wire the <details> toggle to persist the user's preference so
  // expanded-by-default sticks across page loads. Idempotent — safe to call
  // every time the modal re-opens (we re-bind the listener on a freshly
  // injected element).
  function _wireEarningsPreviewToggle() {
    const det = document.getElementById("modalEarningsPreviewDetails");
    if (!det) return;
    det.addEventListener("toggle", () => {
      _writeEarningsPreviewPref(det.open);
      // Keep the inline hint text in sync with the actual state.
      const hint = det.querySelector("[data-earnings-toggle-hint]");
      if (hint) hint.textContent = `click to ${det.open ? "collapse" : "expand"}`;
    });
  }

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
    _wireEarningsPreviewToggle();
    // Stance pill is fired in parallel — it has its own ticker guard so
    // it's safe to not await here.
    _populateAnalyzerStanceInModal(targetTicker);
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
    renderPriceBand,
    matchesSearchQuery,
    buildSymbolSuggestions,
    renderSymbolSuggestions,
    renderSearchEmptyState,
    // Test-only mutator: lets e2e specs swap in a synthetic snapshot so
    // they can exercise the search helpers without depending on whatever
    // data happens to live in earnings-watch-latest.json that day.
    __setSnapshotForTest(snap) { _earningsSnapshot = snap; },
  };
})();
