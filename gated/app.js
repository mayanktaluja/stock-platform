/**
 * Starbhai · Indian Stock Intelligence — Frontend Application
 */

// State
let currentView = "dashboard"; // dashboard | stock
let currentSymbol = null;
let refreshTimer = null;
let newsRefreshTimer = null;
let searchTimeout = null;
let searchAbortController = null;
const searchClientCache = new Map(); // FIFO, capped at SEARCH_CLIENT_CACHE_MAX
const SEARCH_CLIENT_CACHE_MAX = 50;
let watchlist = new Set(); // symbol set for quick lookup

// DOM Elements
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const stockDetail = document.getElementById("stockDetail");
const dashboard = document.getElementById("dashboard");

// ==================== INITIALIZATION ====================

// Methodology config consumed by the per-card "Methodology & risk parameters"
// pane. RA-mode plumbing was removed by user request — the platform does not
// hold itself out as a SEBI-registered analyst service. methodologyVersion is
// the only field still read; the rest are kept as nulls so the pane degrades
// gracefully if anything still references the old shape.
window.RA_CONFIG = { methodologyVersion: null };

// ==================== TELEMETRY ====================
//
// Tiny fire-and-forget client for the KPI dataset behind NS-1 Time-to-Verdict,
// NS-5 Watchlist→action conversion, and basic retention. Backed by
// POST /api/telemetry which appends one NDJSON line per event in local dev
// (no-op on Vercel because the FS is read-only there).
//
// Public API:
//   telemetry.emit(event, payload?)         — generic event
//   telemetry.markVerdictVisible(surface)   — call once per page when the
//     headline verdict / KPI hero is on screen. NS-1 = ts(this) − ts(page_load).
const telemetry = (() => {
  const SESSION_KEY = "starbhai_telemetry_session";
  let sessionId = "";
  try {
    sessionId = sessionStorage.getItem(SESSION_KEY) || "";
    if (!sessionId) {
      sessionId =
        (typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      sessionStorage.setItem(SESSION_KEY, sessionId);
    }
  } catch {
    sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const verdictMarkedFor = new Set();
  function emit(event, payload) {
    try {
      const body = JSON.stringify({
        event: String(event).slice(0, 64),
        page: String(currentView || "unknown").slice(0, 64),
        ts: Date.now(),
        sessionId,
        payload: payload && typeof payload === "object" ? payload : undefined,
      });
      const beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
      if (beacon) {
        const blob = new Blob([body], { type: "application/json" });
        if (beacon("/api/telemetry", blob)) return;
      }
      fetch("/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }
  function markVerdictVisible(surface) {
    const key = String(surface || currentView || "unknown");
    if (verdictMarkedFor.has(key)) return;
    verdictMarkedFor.add(key);
    emit("verdict_visible", { surface: key });
  }
  return { emit, markVerdictVisible, sessionId };
})();
window.telemetry = telemetry;
telemetry.emit("page_load", { ua: navigator.userAgent.slice(0, 200) });

// ==================== AUTH (header user menu) ====================
//
// Populates the avatar/name/email in the header from /api/auth/me, and
// wires the dropdown + sign-out. The page-level gate already redirects
// unauthenticated requests to /login.html, so a 401 here is just a
// safety net (e.g. the cookie expired between page load and this fetch).
const auth = {
  async init() {
    const menu = document.getElementById("userMenu");
    if (!menu) return;
    let me = null;
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (res.ok) me = await res.json();
    } catch { /* offline; leave menu hidden */ }
    if (!me || !me.userId) return;

    const avatar = document.getElementById("userAvatar");
    const nameEl = document.getElementById("userMenuName");
    const emailEl = document.getElementById("userMenuEmail");
    const trigger = document.getElementById("userMenuBtn");
    const dropdown = document.getElementById("userMenuDropdown");
    const signout = document.getElementById("userMenuSignout");

    if (avatar && me.picture) avatar.src = me.picture;
    if (avatar) avatar.alt = me.name || me.email || "Account";
    if (nameEl) nameEl.textContent = me.name || me.email || "Signed in";
    if (emailEl) emailEl.textContent = me.email || "";
    menu.hidden = false;

    // Expose admin status so the Users tab can self-gate (server still
    // enforces via /api/admin/users 403). Reveal the tab button only when
    // the signed-in user is an admin — non-admins never see it in the DOM.
    window.__starbhai_isAdmin = !!me.isAdmin;
    if (me.isAdmin) {
      const usersTabBtn = document.getElementById("usersTabBtn");
      if (usersTabBtn) usersTabBtn.hidden = false;
    }

    const closeDropdown = () => {
      if (dropdown) dropdown.hidden = true;
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    };
    const openDropdown = () => {
      if (dropdown) dropdown.hidden = false;
      if (trigger) trigger.setAttribute("aria-expanded", "true");
    };

    if (trigger && dropdown) {
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdown.hidden) openDropdown(); else closeDropdown();
      });
      document.addEventListener("click", (e) => {
        if (!menu.contains(e.target)) closeDropdown();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeDropdown();
      });
    }

    if (signout) {
      signout.addEventListener("click", async () => {
        try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); }
        catch { /* ignore — redirect anyway */ }
        window.location.href = "/login.html";
      });
    }
  },
};

document.addEventListener("DOMContentLoaded", () => {
  updateClock();
  setInterval(updateClock, 1000);
  loadMacroRegime(); // global: shown on every tab
  // Hourly poll — server cache TTL is 24h, so polling more aggressively
  // wouldn't yield fresher data. Users can force a refresh via the banner's
  // refresh button.
  setInterval(loadMacroRegime, 60 * 60 * 1000);
  // Ticker lives in the persistent header above the tabs, so it must load
  // independently of whichever tab the user lands on. Server caches /api/market
  // for 30s; a 60s refresh keeps the indices fresh without hammering upstreams.
  loadMarketData();
  setInterval(loadMarketData, 60 * 1000);
  // PR W3 — hydrate the in-memory `watchlist` Set before the first
  // openSwsModal renders, so the modal star paints with the correct
  // aria-pressed even when the user hasn't visited the Watchlist tab.
  hydrateWatchlistSet();
  // PR T5 — sync the misses-shown checkbox + label with the persisted
  // localStorage state before loadTrackRecord runs. Sticky-ON default.
  hydrateMissesShownToggle();
  switchTab('picks');
  setupSearch();
  attachGlossaryTooltips(); // event delegation for all .info-icon clicks/hovers
  auth.init();
  // Snapshot freshness banner — surfaces when any underlying fixture
  // (fundamentals, surveillance, governance, picks-latest, macro) is older
  // than its source-specific staleness threshold. Polled once at boot, then
  // hourly. Silent when everything is fresh.
  loadSnapshotHealth();
  setInterval(loadSnapshotHealth, 60 * 60 * 1000);
});

// PR W3 — fire-and-forget watchlist Set hydration. Run on boot so the
// modal-star aria-pressed paints correctly even before the Watchlist tab
// is visited. Failures stay silent — the Watchlist tab itself re-syncs
// the Set when opened.
async function hydrateWatchlistSet() {
  try {
    const res = await fetch("/api/watchlist");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.stocks)) {
      watchlist = new Set(data.stocks.map((s) => s.symbol));
    }
  } catch { /* silent — non-critical */ }
}

function hydrateMissesShownToggle() {
  const cb = document.getElementById("trackMissesShownToggle");
  const lbl = document.getElementById("trackMissesShownLabel");
  const on = getMissesShown();
  if (cb) cb.checked = on;
  if (lbl) lbl.textContent = on ? "Shown" : "Hidden";
}

// ==================== SNAPSHOT HEALTH BANNER ====================
//
// Reads /api/health/snapshots and renders a thin warning bar above the
// macro-regime banner when any data source is stale. The actual data
// (fundamentals, surveillance, etc.) still renders — the banner just makes
// the user aware that what they're looking at may be a few days behind.
//
// Why this matters: the cron at /api/cron/refresh-{surveillance,governance}
// originates NSE traffic that Vercel's datacenter IPs can't reach, so the
// prod cron silently no-ops. Without a banner, users have no way to know
// they're seeing 19-day-old fundamentals.

async function loadSnapshotHealth() {
  let health;
  try {
    const res = await fetch("/api/health/snapshots", { credentials: "same-origin" });
    if (!res.ok) return; // 401 in dev when auth gate is half-set; silent fail is fine
    health = await res.json();
  } catch { return; }
  const banner = document.getElementById("snapshotHealthBanner");
  if (!banner) return; // banner element may not be in older HTML cuts
  if (!health || (!health.anyStale && !health.anyDegraded)) {
    banner.hidden = true;
    return;
  }
  const labels = {
    fundamentals: "Fundamentals",
    surveillance: "Surveillance (ASM/GSM)",
    governance: "Governance (shareholding)",
    picks_latest: "SWS picks",
    macro_regime: "Macro regime",
    fundamentals_history: "Fundamentals history",
    macro_calendar: "Macro calendar",
    events_latest: "Corporate events",
    oi_deltas: "F&O OI deltas",
    earnings_watch: "Earnings watch",
    universe: "SWS universe",
  };
  const chips = [];

  // Orange chip — file genuinely stale (refresh script broken or hasn't run).
  if (health.anyStale && Array.isArray(health.staleKeys) && health.staleKeys.length > 0) {
    const parts = health.staleKeys.map((k) => {
      const s = health.snapshots[k];
      const label = labels[k] || k;
      if (s.age_hours == null) return `${label} (no data)`;
      const days = s.age_hours >= 48 ? `${Math.round(s.age_hours / 24)}d` : `${Math.round(s.age_hours)}h`;
      return `${label} (${days} old)`;
    });
    chips.push(`
      <div style="color:#E0B060; padding:2px 0;">
        <span style="font-weight:600;">⚠ Stale data:</span>
        <span style="opacity:0.9;"> ${parts.join(" · ")}</span>
        <span style="opacity:0.7;margin-left:8px;font-size:11px;">Values may not reflect today's market — underlying refresh has not run.</span>
      </div>
    `);
  }

  // Amber chip — file is fresh but classifier degraded. Distinct remediation
  // (rotate LLM keys / wait out throttle) vs the stale chip (fix refresh).
  if (health.anyDegraded && Array.isArray(health.degradedKeys) && health.degradedKeys.includes("macro_regime")) {
    const ph = health.snapshots.macro_regime?.llmProviderHealth || {};
    const authBroken = ph.groq === "auth_error" || ph.gemini === "auth_error";
    const notWired = ph.groq === "not_configured" && ph.gemini === "not_configured";
    const copy = authBroken
      ? "Macro regime — LLM keys need rotation (running on keyword fallback)."
      : notWired
      ? "Macro regime — LLM keys not configured (running on keyword fallback)."
      : "Macro regime — keyword-only (LLM unavailable, will recover on next quota window).";
    chips.push(`
      <div style="color:#C8A06A; padding:2px 0;">
        <span style="font-weight:600;">ℹ ${copy}</span>
      </div>
    `);
  }

  banner.innerHTML = chips.join("");
  banner.hidden = chips.length === 0;
}

// ==================== GLOSSARY TOOLTIP SYSTEM ====================
//
// Single-source-of-truth tooltip system. Two helper functions are exposed
// globally so renderers in any tab can wrap technical terms with explanations:
//
//   infoIcon('rsi')              → '<span class="info-icon" data-term-id="rsi">i</span>'
//   wrapTerm('RSI', 'rsi')       → '<span class="glossary-term" data-term-id="rsi">RSI</span>'
//
// At startup we attach a single delegated event listener to document so any
// element matching .info-icon or .glossary-term gets tooltips for free, even
// if it's added to the DOM after page load (every renderer outputs HTML
// strings — there's no need to re-bind events on each render).

function infoIcon(termId) {
  if (!termId || !window.GLOSSARY || !window.GLOSSARY[termId]) return "";
  return `<span class="info-icon" data-term-id="${termId}" tabindex="0" aria-label="Info: ${termId}">i</span>`;
}

// Click handler for SWS Pick cards. Opens the modal unless the click landed
// on an info icon, a glossary term, or an embedded link — those have their
// own behavior (tooltip / external nav) and shouldn't double-fire.
function handlePickCardClick(event, ticker) {
  if (event.target.closest("[data-term-id]")) return; // info icon / glossary term
  if (event.target.closest("a")) return; // SWS link
  openSwsModal(ticker);
}

function wrapTerm(text, termId) {
  if (!window.GLOSSARY || !window.GLOSSARY[termId]) return text;
  return `<span class="glossary-term" data-term-id="${termId}">${text}</span>`;
}

/**
 * Map a free-text recommendation label like "STRONG BUY" to its glossary ID.
 * Used wherever a recommendation badge is shown so the user can hover the
 * label and learn what the rating means.
 */
function recIdFromLabel(label) {
  if (!label) return null;
  const map = {
    "STRONG BUY": "strong_buy",
    "BUY": "buy",
    "WEAK BUY": "weak_buy",
    "HOLD": "hold",
    "WEAK SELL": "weak_sell",
    "SELL": "sell",
    "STRONG SELL": "strong_sell",
  };
  return map[String(label).toUpperCase().trim()] || null;
}

/** Map a fundamental verdict (DEEP_VALUE etc) or v3 verdict (TOP_PICK etc) to its glossary ID. */
function verdictIdFromLabel(verdict) {
  if (!verdict) return null;
  const map = {
    // v1 fundamentals verdicts
    DEEP_VALUE: "deep_value",
    QUALITY_GROWTH: "quality_growth",
    FAIR_VALUE: "fair_value",
    FULLY_VALUED: "fully_valued",
    OVERVALUED: "overvalued",
    // v3 composite verdicts (used on SWS Pick cards)
    TOP_PICK: "v3_top_pick",
    STRONG: "v3_strong",
    ACCEPTABLE: "v3_acceptable",
    WATCH: "v3_watch",
    AVOID: "v3_avoid",
  };
  return map[String(verdict).toUpperCase().trim()] || null;
}

/** Map a portfolio action label to its glossary ID. */
function portfolioActionIdFromLabel(action) {
  if (!action) return null;
  const map = {
    "CUT_LOSS": "cut_loss",
    "CUT LOSS": "cut_loss",
    "REVIEW_GOVERNANCE": "review_governance",  // glossary term for the pledge-gate REVIEW verdict
    "TRIM": "trim",
    "ADD": "add",
    "STRONG_ADD": "strong_add",
    "STRONG ADD": "strong_add",
    "BOOK_PROFIT": "book_profit",
    "BOOK PROFIT": "book_profit",
  };
  return map[String(action).toUpperCase().trim()] || null;
}

/** Map a macro regime ID to its glossary entry. */
function regimeIdFromLabel(regime) {
  if (!regime) return null;
  const map = {
    OIL_SHOCK: "oil_shock",
    WAR_ESCALATION: "war_escalation",
    RATE_HIKE: "rate_hike",
    RATE_CUT: "rate_cut",
    POLICY_STIMULUS: "policy_stimulus",
    CALM: "calm",
  };
  return map[String(regime).toUpperCase().trim()] || "macro_regime";
}

let _activeTooltipTermId = null;

function attachGlossaryTooltips() {
  const tooltip = document.getElementById("starbhaiTooltip");
  if (!tooltip) return;

  // Show on hover or focus
  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[data-term-id]");
    if (!target) return;
    showTooltip(target, target.getAttribute("data-term-id"));
  });

  // Hide on mouseout (when leaving the trigger element)
  document.addEventListener("mouseout", (e) => {
    const target = e.target.closest("[data-term-id]");
    if (!target) return;
    // Don't hide if the cursor moved INTO the tooltip itself
    const related = e.relatedTarget;
    if (related && (related.id === "starbhaiTooltip" || related.closest?.("#starbhaiTooltip"))) return;
    hideTooltip();
  });

  // Tap-to-open on mobile
  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-term-id]");
    if (!target) {
      hideTooltip();
      return;
    }
    e.stopPropagation();
    const id = target.getAttribute("data-term-id");
    if (_activeTooltipTermId === id) {
      hideTooltip();
    } else {
      showTooltip(target, id);
    }
  });

  // Escape closes
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTooltip();
  });

  // Hide tooltip when scrolling (otherwise it floats out of place)
  window.addEventListener("scroll", hideTooltip, { passive: true });
}

function showTooltip(triggerEl, termId) {
  const def = window.GLOSSARY?.[termId];
  if (!def) return;
  const tooltip = document.getElementById("starbhaiTooltip");
  if (!tooltip) return;

  tooltip.innerHTML = `
    <div class="tip-header">
      ${escapeHtml(def.term)}
      ${def.category ? `<span class="tip-category">${escapeHtml(def.category)}</span>` : ""}
    </div>
    <div class="tip-short">${escapeHtml(def.short)}</div>
    <div class="tip-full">${escapeHtml(def.full)}</div>
  `;

  // Position the tooltip below the trigger by default; flip above if it
  // would overflow the viewport
  tooltip.classList.add("visible");
  tooltip.classList.remove("below-flip");
  const rect = triggerEl.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left;
  if (top + tooltipRect.height > window.innerHeight - 16) {
    top = rect.top - tooltipRect.height - 8;
    tooltip.classList.add("below-flip");
  }
  // Keep tooltip inside the horizontal viewport
  if (left + tooltipRect.width > window.innerWidth - 16) {
    left = window.innerWidth - tooltipRect.width - 16;
  }
  if (left < 8) left = 8;
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
  tooltip.setAttribute("aria-hidden", "false");
  _activeTooltipTermId = termId;
}

function hideTooltip() {
  const tooltip = document.getElementById("starbhaiTooltip");
  if (!tooltip) return;
  tooltip.classList.remove("visible");
  tooltip.setAttribute("aria-hidden", "true");
  _activeTooltipTermId = null;
}

// Fetch + render the macro regime banner independently of any specific tab.
// Sourced from /api/macro/regime so the banner is available even before the
// first scanner/portfolio call completes.
//
// When force=true, hits ?refresh=1 to bypass the server cache and trigger a
// fresh classification. Used by the manual refresh button.
async function loadMacroRegime({ force = false } = {}) {
  try {
    const url = force ? "/api/macro/regime?refresh=1" : "/api/macro/regime";
    const res = await fetch(url);
    if (!res.ok) return;
    const regime = await res.json();
    renderMacroBanner(regime);
  } catch (err) {
    // Silent — the banner is additive, failure means no banner.
  }
}

// Manual refresh handler invoked by the banner's refresh button.
// Shows a loading state while the server re-classifies, then re-renders.
window.macroRefreshClick = async function macroRefreshClick(btn) {
  if (!btn || btn.dataset.loading === "1") return;
  btn.dataset.loading = "1";
  const originalHTML = btn.innerHTML;
  btn.innerHTML = '<span class="macro-refresh-spinner" aria-hidden="true"></span> Refreshing&hellip;';
  btn.disabled = true;
  try {
    await loadMacroRegime({ force: true });
  } finally {
    // renderMacroBanner replaces innerHTML, so the button is gone — only
    // restore on the off-chance the banner re-renders into the same DOM node.
    if (document.body.contains(btn)) {
      btn.innerHTML = originalHTML;
      btn.disabled = false;
      delete btn.dataset.loading;
    }
  }
};

function updateClock() {
  const now = new Date();
  // Use Asia/Kolkata timezone directly — this is always correct regardless of user's local timezone
  const timeStr = now.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const dateStr = now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  document.getElementById("currentTime").textContent = timeStr;
  const dateEl = document.getElementById("currentDate");
  if (dateEl) dateEl.textContent = dateStr;
}

// ==================== MARKET DATA ====================

async function loadMarketData() {
  try {
    const res = await fetch("/api/market");
    const data = await res.json();

    // Update market status pill
    const pill = document.getElementById("marketStatusPill");
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const isOpen = data.marketStatus === "OPEN";

    if (pill) pill.className = `market-status-pill ${isOpen ? "open" : "closed"}`;
    statusDot.className = `status-dot ${isOpen ? "open" : "closed"}`;
    statusText.textContent = isOpen ? "NSE Open" : "NSE Closed";

    // Update ticker
    const ticker = document.getElementById("marketTicker");
    if (data.indices && data.indices.length > 0) {
      ticker.innerHTML = data.indices
        .map((idx) => {
          const isPos = idx.change >= 0;
          const name =
            idx.symbol === "^NSEI"     ? "NIFTY 50"    :
            idx.symbol === "^BSESN"    ? "SENSEX"      :
            idx.symbol === "^NSEBANK"  ? "BANK NIFTY"  :
            idx.symbol === "GIFTNIFTY" ? "GIFT NIFTY"  : idx.name;
          // GIFT Nifty trades on NSE IX in two sessions and can sit stale
          // for hours between them — so we pin a "Last traded HH:MM IST"
          // reference to the pill. This is the single most important
          // piece of context for reading the number: a 0.4% move from
          // four hours ago is very different from one from thirty
          // seconds ago.
          const isGift = idx.symbol === "GIFTNIFTY";
          const lttLabel = isGift ? formatGiftNiftyLtt(idx.lastTradedAt) : "";
          const giftChangeTitle = isGift
            ? "% premium/discount vs current NIFTY 50"
            : "";
          return `
            <div class="ticker-item${isGift ? " ticker-gift" : ""}">
              <span class="ticker-name">${name}</span>
              <span class="ticker-price ${isPos ? "positive" : "negative"}">${formatNumber(idx.price)}</span>
              <span class="ticker-change ${isPos ? "positive-bg" : "negative-bg"}"${giftChangeTitle ? ` title="${giftChangeTitle}"` : ""}>
                ${isPos ? "+" : ""}${formatNumber(idx.change)}&nbsp;(${isPos ? "+" : ""}${idx.changePercent?.toFixed(2)}%)
              </span>
              ${lttLabel ? `<span class="ticker-ltt" title="GIFT Nifty last traded time on NSE IX">${lttLabel}</span>` : ""}
            </div>`;
        })
        .join("");
    }
  } catch (err) {
    console.error("Failed to load market data:", err);
  }
}

// ==================== SEARCH ====================

function setupSearch() {
  searchInput.addEventListener("input", (e) => {
    const query = e.target.value.trim();
    if (searchTimeout) clearTimeout(searchTimeout);

    // Single-char queries match 200+ stocks and burn cache for no real signal.
    if (query.length < 2) {
      if (searchAbortController) searchAbortController.abort();
      searchResults.classList.remove("active");
      return;
    }

    searchTimeout = setTimeout(() => searchStocks(query), 300);
  });

  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim().length >= 2) {
      searchResults.classList.add("active");
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-container")) {
      searchResults.classList.remove("active");
    }
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchResults.classList.remove("active");
      searchInput.blur();
    }
  });
}

function renderSearchResults(query, results) {
  if (results && results.length > 0) {
    searchResults.innerHTML = results
      .map(
        (r) => `
        <div class="search-result-item" onclick="openStockDetailModal('${r.symbol}','search')">
          <div>
            <div class="search-result-name">${escapeHtml(r.name)}</div>
            <div class="search-result-sector">${r.sector || r.exchange || ""}</div>
          </div>
          <span class="search-result-symbol">${r.symbol}</span>
        </div>
      `
      )
      .join("");
  } else {
    searchResults.innerHTML = `
      <div style="padding: 20px; text-align: center; color: var(--text-muted);">
        No Indian stocks found for "${escapeHtml(query)}"
      </div>
    `;
  }
  searchResults.classList.add("active");
}

async function searchStocks(query) {
  const cacheKey = query.toLowerCase().trim();
  const cached = searchClientCache.get(cacheKey);
  if (cached) {
    renderSearchResults(query, cached);
    return;
  }

  searchResults.innerHTML = `<div class="search-loading">Searching…</div>`;
  searchResults.classList.add("active");

  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();
  const signal = searchAbortController.signal;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal });
    const data = await res.json();

    if (signal.aborted) return;

    const results = data.results || [];
    if (searchClientCache.size >= SEARCH_CLIENT_CACHE_MAX) {
      searchClientCache.delete(searchClientCache.keys().next().value);
    }
    searchClientCache.set(cacheKey, results);

    renderSearchResults(query, results);
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("Search failed:", err);
    searchResults.innerHTML = `
      <div style="padding: 20px; text-align: center; color: var(--text-muted);">
        Search unavailable. Try again in a moment.
      </div>
    `;
    searchResults.classList.add("active");
  }
}

// ==================== STOCK DETAIL ====================

async function loadStock(symbol) {
  searchResults.classList.remove("active");
  searchInput.value = "";
  currentSymbol = symbol;
  currentView = "stock";

  // Show stock detail, hide dashboard
  stockDetail.classList.add("active");
  dashboard.style.display = "none";

  stockDetail.innerHTML = `
    <div class="loading">
      <div class="loading-spinner"></div>
      <div class="loading-text">Analyzing ${symbol}...</div>
      <div style="font-size:12px; color:var(--text-muted); margin-top:8px;">Fetching price data, scanning news, running technical + sentiment analysis</div>
    </div>
  `;

  try {
    const res = await fetch(`/api/stock/${encodeURIComponent(symbol)}`);
    const data = await res.json();

    if (data.error) {
      stockDetail.innerHTML = `
        <button class="back-btn" onclick="showDashboard()">&#8592; Back to Dashboard</button>
        <div class="empty-state">
          <div class="empty-icon">&#9888;</div>
          <div class="empty-text">${escapeHtml(data.error)}</div>
        </div>
      `;
      return;
    }

    renderStockDetail(data);
  } catch (err) {
    stockDetail.innerHTML = `
      <button class="back-btn" onclick="showDashboard()">&#8592; Back to Dashboard</button>
      <div class="empty-state">
        <div class="empty-icon">&#9888;</div>
        <div class="empty-text">Failed to load stock data. Please try again.</div>
      </div>
    `;
  }
}

// SEBI Phase 0: NSE surveillance warning banner.
// Renders nothing when the stock is not under ASM/GSM. When flagged, it
// sits just below the stock header so users see the regulatory context
// before any "recommendation-style" language. Non-dismissible.
function surveillanceBanner(surveillance) {
  if (!surveillance || !surveillance.list) return "";
  const list = surveillance.list; // "ASM" | "GSM"
  const stage = surveillance.stage || surveillance.timeframe || null;
  const also = surveillance.alsoOn ? ` (also on ${surveillance.alsoOn})` : "";
  const reason = list === "GSM"
    ? "Graded Surveillance Measure — this stock is under the strictest NSE surveillance regime. Trading is restricted (e.g. 100% margin, call-auction only, delivery-based)."
    : "Additional Surveillance Measure — NSE has placed this stock under enhanced surveillance. Expect tighter circuit filters and periodic call auctions. Liquidity may be impaired.";
  return `
    <div class="surveillance-banner" role="alert">
      <div class="sv-icon">&#9888;</div>
      <div>
        <div class="sv-title">Under NSE ${list} surveillance${also}${stage ? `<span class="sv-stage">${stage}</span>` : ""}</div>
        <div class="sv-body">${reason} This stock is <strong>excluded from Starbhai's Deep Value and Quality Growth surfaces</strong> as a compliance precaution. Analytical scores are still shown for reference — not as a recommendation.</div>
      </div>
    </div>
  `;
}

/**
 * Simply-Wall-Street-style Snowflake hexagon radar chart.
 *
 * Renders a 6-axis SVG radar for V2 scorer pillars (Value / Future / Past /
 * Health / Dividend / Governance). Pillar scores are 0–5; null means N/A
 * and the axis is plotted at 0 with a "N/A" label so the user sees why the
 * shape is asymmetric rather than silently fudging to zero.
 *
 * Design notes:
 *  - Concentric reference rings at scores 1/2/3/4/5 so readers can sight-read
 *    the polygon without a legend.
 *  - Dashed amber "threshold" ring at score=3 — above=strong, below=weak.
 *  - Polygon fill is tinted by the average pillar score (green/amber/red).
 *  - N/A pillars do NOT get a vertex dot so they read as "no data" rather
 *    than "scored 0".
 *
 * @param {object} pillars - The `pillars` field of a V2 scorer result.
 * @param {object} [opts]  - { size: number, title: string }
 * @returns {string} Inline SVG markup (for html-string-based rendering).
 */
function renderSnowflakeHexagon(pillars, opts = {}) {
  if (!pillars) return '';
  const size = opts.size || 340;
  const center = size / 2;
  const maxRadius = size * 0.32;

  const order = ['value', 'future', 'past', 'health', 'dividend', 'governance'];
  const labels = {
    value: 'Value', future: 'Future', past: 'Past',
    health: 'Health', dividend: 'Dividend', governance: 'Governance',
  };

  // Start at 12 o'clock (-π/2) and step clockwise in 60° increments.
  const axisAngles = order.map((_, i) => -Math.PI / 2 + i * (Math.PI / 3));

  const pointAt = (score, axisIdx, scale = 5) => {
    const safe = score == null ? 0 : Math.max(0, Math.min(scale, score));
    const r = (safe / scale) * maxRadius;
    const a = axisAngles[axisIdx];
    return { x: center + r * Math.cos(a), y: center + r * Math.sin(a) };
  };
  const outerVertex = (axisIdx, k = 1) => {
    const a = axisAngles[axisIdx];
    return { x: center + maxRadius * k * Math.cos(a), y: center + maxRadius * k * Math.sin(a) };
  };

  // Axis spokes
  const axisLines = order.map((_, i) => {
    const p = outerVertex(i);
    return `<line x1="${center}" y1="${center}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />`;
  }).join('');

  // Reference rings at 1/2/3/4/5
  const rings = [1, 2, 3, 4, 5].map(lvl => {
    const pts = order.map((_, i) => pointAt(lvl, i)).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1" />`;
  }).join('');

  // Amber "average" threshold at score=3
  const threshPts = order.map((_, i) => pointAt(3, i)).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const threshold = `<polygon points="${threshPts}" fill="none" stroke="rgba(251,191,36,0.35)" stroke-width="1" stroke-dasharray="3 3" />`;

  // Data polygon
  const scores = order.map(k => pillars[k]?.score);
  const dataPts = order.map((_, i) => pointAt(scores[i], i));
  const dataPtsStr = dataPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const defined = scores.filter(s => s != null);
  const avg = defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : 0;
  const strokeColor = avg >= 3.5 ? '#34d399' : avg >= 2.5 ? '#fbbf24' : '#f87171';
  const fillColor   = avg >= 3.5 ? 'rgba(52,211,153,0.22)' : avg >= 2.5 ? 'rgba(251,191,36,0.18)' : 'rgba(248,113,113,0.18)';

  const dataPolygon = `<polygon points="${dataPtsStr}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2" stroke-linejoin="round" />`;

  // Pillar scores are floats (e.g. 2.4444) — format to 1 decimal for display.
  const fmt = (n) => (n == null ? 'N/A' : (Math.round(n * 10) / 10).toFixed(1));

  // Data vertex dots (skip N/A)
  const dots = order.map((k, i) => {
    const sc = scores[i];
    if (sc == null) return '';
    const p = dataPts[i];
    const tipText = `${labels[k]}: ${fmt(sc)}/5 (${pillars[k]?.grade || ''})`;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${strokeColor}" stroke="#0f1319" stroke-width="1.5"><title>${tipText}</title></circle>`;
  }).join('');

  // Axis labels (pillar name + score/grade), positioned just outside the max ring
  const labelEls = order.map((k, i) => {
    const outer = outerVertex(i, 1.24);
    const sc = scores[i];
    const isNA = sc == null;
    const grade = pillars[k]?.grade || '';
    const scoreText = isNA ? 'N/A' : `${fmt(sc)}/5`;
    const subLine = isNA ? 'no data' : grade;
    const mainColor = isNA ? '#64748b' : '#e2e8f0';
    const subColor  = isNA ? '#475569' : '#94a3b8';

    // Anchor + dy tweaked so labels don't overlap the polygon
    const anchor = outer.x < center - 8 ? 'end' : outer.x > center + 8 ? 'start' : 'middle';
    const above  = outer.y < center - 8;
    const below  = outer.y > center + 8;
    const dy1 = above ? -6 : below ? 12 : -2;
    const dy2 = dy1 + 13;

    const tip = isNA
      ? `${labels[k]}: N/A — pillar could not be scored (data missing or redistributed)`
      : `${labels[k]}: ${fmt(sc)}/5 — ${grade}`;

    return `
      <text x="${outer.x.toFixed(1)}" y="${(outer.y + dy1).toFixed(1)}" text-anchor="${anchor}" fill="${mainColor}" font-size="12" font-weight="600" font-family="system-ui,-apple-system,sans-serif"><title>${tip}</title>${labels[k]} <tspan fill="${subColor}" font-weight="500">${scoreText}</tspan></text>
      <text x="${outer.x.toFixed(1)}" y="${(outer.y + dy2).toFixed(1)}" text-anchor="${anchor}" fill="${subColor}" font-size="10.5" font-family="system-ui,-apple-system,sans-serif">${subLine}</text>
    `;
  }).join('');

  return `
    <svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:${size}px;display:block;margin:0 auto;" role="img" aria-label="Snowflake pillar radar — ${defined.length}/6 pillars scored, average ${avg.toFixed(1)}/5">
      ${axisLines}
      ${rings}
      ${threshold}
      ${dataPolygon}
      ${dots}
      ${labelEls}
    </svg>
  `;
}

/**
 * Accompanying legend / narrative block for the hexagon. Shows each pillar's
 * score, grade, and the top signal so the hexagon isn't just a pretty shape.
 */
function renderSnowflakePillarList(pillars) {
  if (!pillars) return '';
  const order = ['value', 'future', 'past', 'health', 'dividend', 'governance'];
  const labels = {
    value: 'Value', future: 'Future', past: 'Past',
    health: 'Health', dividend: 'Dividend', governance: 'Governance',
  };
  const fmt = (n) => (n == null ? 'N/A' : (Math.round(n * 10) / 10).toFixed(1));
  const rows = order.map(k => {
    const p = pillars[k] || {};
    const sc = p.score;
    const grade = p.grade || '';
    const topSig = (p.signals && p.signals[0]) ? p.signals[0] : '';
    const isNA = sc == null;
    const color = isNA ? '#64748b' : (sc >= 4 ? '#34d399' : sc >= 3 ? '#94e2a8' : sc >= 2 ? '#fbbf24' : '#f87171');
    const bar = isNA ? 0 : (sc / 5) * 100;
    return `
      <div style="display:grid;grid-template-columns:84px 42px 1fr;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;">
        <div style="color:var(--text-secondary);font-weight:600;">${labels[k]}</div>
        <div style="font-family:var(--font-mono);color:${color};font-weight:700;">${isNA ? 'N/A' : fmt(sc) + '/5'}</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="flex:0 0 70px;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
            <div style="width:${bar}%;height:100%;background:${color};"></div>
          </div>
          <div style="color:var(--text-muted);font-size:11.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(topSig)}">
            <span style="color:var(--text-secondary);">${grade || '—'}</span>${topSig ? ' · ' + escapeHtml(topSig) : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
  return `<div style="padding:8px 12px;background:rgba(0,0,0,0.18);border-radius:10px;">${rows}</div>`;
}

/**
 * Decide which V2 payload (if any) to feed the hexagon, based on SCORER_MODE.
 *
 *   v1                      → no hexagon (V2 wasn't computed)
 *   v2-shadow               → use `shadowV2` (V1 is authoritative, V2 rides along)
 *   v2-primary              → use `fundamentals` itself (V2 IS the primary)
 *   v2-primary-fallback-v1  → no hexagon (V2 threw, fell back to V1)
 */
function selectV2PayloadForHexagon(scorerMode, fundamentals, shadowV2) {
  if (scorerMode === 'v2-primary' && fundamentals?.pillars) return fundamentals;
  if (scorerMode === 'v2-shadow' && shadowV2?.pillars) return shadowV2;
  // Defensive: if the mode is unknown but we have V2 data somewhere, show it.
  if (shadowV2?.pillars) return shadowV2;
  if (fundamentals?.pillars) return fundamentals;
  return null;
}

// ── Starbhai long-term narrative renderer ─────────────────────────────
//
// Shared between the stock detail page (Long-Term Outlook info-card) and
// the Portfolio Analyzer holding cards. Renders a structured 3–12 month
// thesis with collapsible Growth Drivers / Key Risks / Catalysts groups,
// a news strip with sentiment chips, and a confidence badge.
//
// Returns "" for missing data so the caller can inline-interpolate it.
function renderLongTermNarrative(longTerm) {
  const n = longTerm?.narrative;
  if (!n) return "";

  const confColor = n.confidence === "HIGH"   ? "rgba(52,211,153,0.15);color:#34d399"
                  : n.confidence === "LOW"    ? "rgba(239,68,68,0.15);color:#ef4444"
                  : "rgba(245,158,11,0.15);color:#f59e0b";

  const flagPills = (longTerm.qualityFlags || []).map((f) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:4px;margin-right:4px;font-size:10px;background:rgba(245,158,11,0.12);color:#f59e0b;">${escapeHtml(f.replace(/_/g, " "))}</span>`
  ).join("");

  const bullets = (arr) =>
    (Array.isArray(arr) ? arr : []).map((b) => `<li style="margin:4px 0;">${escapeHtml(b)}</li>`).join("");

  const newsItems = longTerm?.news?.items || [];
  const newsStrip = newsItems.length > 0
    ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">
         <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Recent News (last 30 days)</div>
         ${newsItems.slice(0, 3).map((it) => {
           const sentColor = it.sentiment === "POSITIVE" ? "#34d399"
                           : it.sentiment === "NEGATIVE" ? "#ef4444" : "var(--text-muted)";
           const matBadge = it.materiality === "MATERIAL"
             ? `<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:9px;background:rgba(96,165,250,0.18);color:#60a5fa;margin-right:6px;">MATERIAL</span>`
             : "";
           return `<div style="font-size:11px;line-height:1.5;margin-bottom:6px;">
             ${matBadge}
             <a href="${escapeHtml(it.link || '#')}" target="_blank" rel="noopener" style="color:var(--text-secondary);text-decoration:none;">${escapeHtml(it.title || '')}</a>
             <span style="color:${sentColor};font-size:10px;margin-left:6px;">${escapeHtml(it.sentiment || '')}</span>
             ${it.source ? `<span style="color:var(--text-muted);font-size:10px;margin-left:6px;">· ${escapeHtml(it.source)}</span>` : ""}
           </div>`;
         }).join("")}
       </div>`
    : "";

  return `
    <div class="lt-narrative" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">
          Starbhai Thesis${infoIcon('long_term_narrative')}
        </div>
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.5px;${confColor};">
          ${escapeHtml(n.confidence || 'MEDIUM')} confidence
        </span>
      </div>
      <div style="font-size:13px;line-height:1.6;color:var(--text-secondary);margin-bottom:10px;">
        ${escapeHtml(n.thesis || '')}
      </div>
      ${flagPills ? `<div style="margin-bottom:10px;">${flagPills}</div>` : ""}
      <details style="margin-bottom:6px;">
        <summary style="cursor:pointer;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Growth drivers (${(n.growthDrivers || []).length})</summary>
        <ul style="margin:6px 0 0 20px;font-size:12px;line-height:1.55;color:var(--text-secondary);">${bullets(n.growthDrivers)}</ul>
      </details>
      <details style="margin-bottom:6px;">
        <summary style="cursor:pointer;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Key risks (${(n.keyRisks || []).length})</summary>
        <ul style="margin:6px 0 0 20px;font-size:12px;line-height:1.55;color:var(--text-secondary);">${bullets(n.keyRisks)}</ul>
      </details>
      <details style="margin-bottom:8px;">
        <summary style="cursor:pointer;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Catalysts to watch (${(n.catalystsToWatch || []).length})</summary>
        <ul style="margin:6px 0 0 20px;font-size:12px;line-height:1.55;color:var(--text-secondary);">${bullets(n.catalystsToWatch)}</ul>
      </details>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.5;">
        <strong style="color:var(--text-secondary);">Horizon view:</strong> ${escapeHtml(n.horizonView || '')}
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.5;">
        <strong style="color:var(--text-secondary);">News context:</strong> ${escapeHtml(n.newsContext || 'No material recent news.')}
      </div>
      ${newsStrip}
      ${n.source === "fallback" ? `<div style="font-size:10px;color:var(--text-muted);margin-top:8px;font-style:italic;">Generated from metrics (LLM unavailable or budget cap reached) — observational, not advice.</div>` : ""}
    </div>
  `;
}

function renderStockDetail(data) {
  const { quote, analysis, midTerm, sentiment, fundamentals, news, macro, stockVerdict, historicalChart, lastUpdated, surveillance, shadowV2, legacyV1, scorerMode } = data;

  if (!quote) {
    stockDetail.innerHTML = `
      <button class="back-btn" onclick="showDashboard()">&#8592; Back to Dashboard</button>
      <div class="empty-state"><div class="empty-text">No data available</div></div>
    `;
    return;
  }

  const isPos = (quote.change || 0) >= 0;
  // Use combined recommendation if available, otherwise fall back to technical-only
  const mainRec = analysis?.combinedRecommendation || analysis?.recommendation;
  const recClass = getRecClass(mainRec);
  const recColor = getRecColor(mainRec);

  let html = `
    <button class="back-btn" onclick="showDashboard()">&#8592; Back to Dashboard</button>

    <!-- Stock Header -->
    <div class="stock-header">
      <div class="stock-title">
        <div class="stock-name">
          ${escapeHtml(quote.name)}
          ${watchlistButton(quote.symbol, quote.name, '')}
        </div>
        <div class="stock-symbol-badge">
          ${quote.symbol} &middot; ${quote.exchange || "NSE"} &middot; ${quote.currency || "INR"} &middot; ${quote.marketState || ""}
          <span onclick="event.stopPropagation(); addToCompare('${quote.symbol.replace('.NS','')}')" style="cursor:pointer;font-size:11px;padding:2px 8px;border-radius:4px;background:rgba(96,165,250,0.1);color:var(--blue);border:1px solid rgba(96,165,250,0.25);margin-left:8px;" title="Add to comparison (select 2 stocks to compare side-by-side)">+ Compare</span>
        </div>
      </div>
      <div class="stock-price-block">
        <div class="stock-current-price ${isPos ? "positive" : "negative"}">&#8377;${formatNumber(quote.price)}</div>
        <div class="stock-price-change ${isPos ? "positive" : "negative"}">
          ${isPos ? "+" : ""}${formatNumber(quote.change)} (${isPos ? "+" : ""}${quote.changePercent?.toFixed(2)}%)
        </div>
      </div>
    </div>
  `;

  // SEBI Phase 0: surveillance warning banner (no-op when stock is not flagged)
  html += surveillanceBanner(surveillance);

  // Recommendation Banner — use combined score if available
  if (analysis && !analysis.error) {
    const displayScore = analysis.combinedScore ?? analysis.score;
    const displayRec   = analysis.combinedRecommendation ?? analysis.recommendation;
    const displayAction  = analysis.combinedAction ?? analysis.action;
    const displayUrgency = analysis.combinedUrgency ?? analysis.urgency;
    const techScore = analysis.technicalScore ?? analysis.score;
    // newsScore is null when sentiment was unavailable — do NOT default to 50,
    // that was the inflation bug from the previous version.
    const newsScore = analysis.sentimentScore;
    const newsAvailable = sentiment?.available === true && newsScore != null;

    // Sentiment label for display
    const sentLabel = sentiment?.label || "neutral";
    const sentColor =
      !newsAvailable ? "var(--text-muted)" :
      sentLabel.includes("bullish") ? "var(--green)" :
      sentLabel.includes("bearish") ? "var(--red)" : "var(--yellow)";

    // Fix #1: show the portfolio-basis score alongside the 3-factor score so
    // the user understands why the Portfolio card and Stock Detail page can
    // show slightly different numbers for the same stock. If they're within
    // 1 point of each other, we skip the second pill (nothing interesting).
    const portfolioBasisScore = analysis.portfolioBasisScore;
    const scannerScoreVal = analysis.scannerScore;
    const scoresDiffer = portfolioBasisScore != null && Math.abs(portfolioBasisScore - displayScore) >= 2;
    const showScannerScore = scannerScoreVal != null && Math.abs(scannerScoreVal - displayScore) >= 2;

    html += `
      <div class="recommendation-banner ${getRecClass(displayRec)}">
        <div class="rec-header">
          <div class="rec-badge" style="color:${getRecColor(displayRec)}">${displayRec}${infoIcon(recIdFromLabel(displayRec))}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <div class="rec-score" title="Includes technical, news sentiment and fundamentals — answers 'what does the market think of this stock right now?'">Market view: ${displayScore}/100${infoIcon('combined_score')}</div>
            ${showScannerScore ? `
              <div class="rec-score" style="border-color:rgba(52,211,153,0.3);background:rgba(52,211,153,0.08);color:#34d399;" title="This is the score the Buy Now scanner uses (50% Technical + 50% Fundamentals, with the quality guardrail applied). Matches the number shown on the scanner card.">Scanner: ${scannerScoreVal}/100</div>
            ` : ''}
            ${scoresDiffer ? `
              <div class="rec-score" style="border-color:rgba(96,165,250,0.3);background:rgba(96,165,250,0.08);color:#60a5fa;" title="Excludes news sentiment to give a stabler read for position decisions. This is the number the Portfolio tab uses.">Portfolio basis: ${portfolioBasisScore}/100</div>
            ` : ''}
          </div>
        </div>
        <div class="rec-action">${displayAction}</div>
        <div class="rec-urgency">${displayUrgency}</div>
        ${scoresDiffer ? `
          <div style="margin-top:10px;padding:8px 12px;background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.15);border-radius:6px;font-size:12px;color:var(--text-secondary);line-height:1.5;">
            <strong style="color:#60a5fa;">Why two scores?</strong>
            &nbsp;Market view (${displayScore}) includes news sentiment. Portfolio basis (${portfolioBasisScore}) excludes news because it's too noisy for position-sizing decisions.
            ${portfolioBasisScore < displayScore
              ? "The news sentiment is lifting this stock's score — treat with caution."
              : "The news sentiment is dragging this stock's score down — the underlying picture is stronger than news suggests."}
          </div>
        ` : ''}
        ${macro && macro.delta !== 0 ? `
          <div class="macro-pill ${macro.delta > 0 ? 'pos' : 'neg'}" title="${escapeHtml(macro.reason || '')}">
            <span>Macro:</span>
            <strong>${macro.delta > 0 ? '+' : ''}${macro.delta.toFixed(1)}</strong>
            <span>(${escapeHtml(macro.sector || '')} &middot; ${escapeHtml((macro.regimeLabel || macro.regime || '').toLowerCase())})</span>
          </div>
          <div style="margin-top:6px;font-size:11px;color:var(--text-muted);line-height:1.4;">
            ${escapeHtml(macro.reason || '')}. This tilts the Buy Now scanner ranking but does not change the Market View or Portfolio Basis score.
          </div>
        ` : ''}

        <!-- Stock-specific verdict: should I buy THIS stock TODAY? -->
        ${stockVerdict ? renderStockVerdictCard(stockVerdict) : ''}

        <!-- Score breakdown (2 or 3 columns depending on fundamentals availability) -->
        <div style="display:flex;gap:16px;margin-top:16px;flex-wrap:wrap;">
          <div style="flex:1;min-width:180px;background:rgba(0,0,0,0.2);border-radius:10px;padding:14px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;margin-bottom:6px;">Technical</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:800;">${techScore}<span style="font-size:13px;color:var(--text-muted);">/100</span></div>
            <div class="score-gauge" style="margin-top:8px;">
              <div class="score-fill" style="width:${techScore}%; background: linear-gradient(90deg, var(--red) 0%, var(--yellow) 40%, var(--green) 100%);"></div>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">RSI, MACD, trend, momentum</div>
          </div>
          <div style="flex:1;min-width:180px;background:rgba(0,0,0,0.2);border-radius:10px;padding:14px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;margin-bottom:6px;">News Sentiment</div>
            ${newsAvailable ? `
              <div style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:800;color:${sentColor};">${newsScore}<span style="font-size:13px;color:var(--text-muted);">/100</span></div>
              <div class="score-gauge" style="margin-top:8px;">
                <div class="score-fill" style="width:${newsScore}%; background: linear-gradient(90deg, var(--red) 0%, var(--yellow) 40%, var(--green) 100%);"></div>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${sentiment.bullish_count} bullish, ${sentiment.bearish_count} bearish headlines</div>
            ` : `
              <div style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:700;color:var(--text-muted);">Unavailable</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.5;">
                No news found. Combined score uses technical${fundamentals ? ' + fundamentals' : ''} only &mdash; not faked.
              </div>
            `}
          </div>
          ${fundamentals ? `
          <div style="flex:1;min-width:180px;background:rgba(0,0,0,0.2);border-radius:10px;padding:14px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;margin-bottom:6px;">Fundamentals</div>
            <div style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:800;">${fundamentals.score}<span style="font-size:13px;color:var(--text-muted);">/100</span></div>
            <div class="score-gauge" style="margin-top:8px;">
              <div class="score-fill" style="width:${fundamentals.score}%; background: linear-gradient(90deg, var(--red) 0%, var(--yellow) 40%, var(--green) 100%);"></div>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${fundamentals.verdict.replace(/_/g, ' ')}</div>
          </div>` : ''}
        </div>

        <div class="score-gauge" style="margin-top:16px;height:10px;">
          <div class="score-fill" style="width:${displayScore}%; background: linear-gradient(90deg, var(--red) 0%, var(--yellow) 40%, var(--green) 100%);border-radius:5px;"></div>
        </div>
        <div class="score-labels">
          <span>Strong Sell</span>
          <span>Sell</span>
          <span>Hold</span>
          <span>Buy</span>
          <span>Strong Buy</span>
        </div>

        <div class="rec-reasoning">
          <div class="rec-reasoning-title">Analysis Reasoning ${fundamentals ? '(Technical + News + Fundamentals)' : '(Technical + News)'}</div>
          ${(analysis.combinedReasoning || analysis.reasoning || '').replace(/\n/g, '<br>')}
        </div>
      </div>
    `;

    // ── Fundamentals Section ──
    if (fundamentals && fundamentals.snapshot) {
      const fs = fundamentals.snapshot;
      const verdictColor =
        fundamentals.verdict === "DEEP_VALUE" ? "var(--green)" :
        fundamentals.verdict === "QUALITY_GROWTH" ? "var(--blue)" :
        fundamentals.verdict === "FAIR_VALUE" ? "var(--text-secondary)" :
        fundamentals.verdict === "FULLY_VALUED" ? "var(--yellow)" : "var(--red)";

      let pos = null;
      if (fs.price && fs.week52Low && fs.week52High && fs.week52High > fs.week52Low) {
        pos = Math.round(((fs.price - fs.week52Low) / (fs.week52High - fs.week52Low)) * 100);
      }

      html += `
        <div class="signals-section" style="margin-top:20px;">
          <div class="section-title" style="display:flex;align-items:center;gap:10px;">
            Fundamentals
            <span style="font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px;background:${verdictColor}22;color:${verdictColor};">
              ${fundamentals.verdict.replace(/_/g, ' ')}${infoIcon(verdictIdFromLabel(fundamentals.verdict))} (${fundamentals.score}/100)
            </span>
          </div>
          <div class="grid-3" style="margin-top:12px;">
            <div class="card">
              <div class="card-title">P/E Ratio${infoIcon('pe_ratio')}</div>
              <div class="card-value">${fs.pe ? fs.pe.toFixed(1) : 'N/A'}</div>
              <div class="card-sub">Sector avg: ${fs.sectorPe ? fs.sectorPe.toFixed(1) : 'N/A'}
                ${fs.pe && fs.sectorPe ? (fs.pe < fs.sectorPe ? ' · <span class="positive">' + ((1 - fs.pe / fs.sectorPe) * 100).toFixed(0) + '% discount</span>' : ' · <span class="negative">' + ((fs.pe / fs.sectorPe - 1) * 100).toFixed(0) + '% premium</span>') : ''}
              </div>
            </div>
            <div class="card">
              <div class="card-title">Market Cap${infoIcon('market_cap')}</div>
              <div class="card-value" style="font-size:16px;">${fs.marketCap ? formatMarketCap(fs.marketCap) : 'N/A'}</div>
              <div class="card-sub">${fundamentals.breakdown?.tier || ''}</div>
            </div>
            <div class="card">
              <div class="card-title">52W Position</div>
              <div class="card-value">${pos != null ? pos + '%' : 'N/A'}</div>
              <div class="card-sub">
                ${fs.week52Low ? '&#8377;' + formatNumber(fs.week52Low) : '?'} - ${fs.week52High ? '&#8377;' + formatNumber(fs.week52High) : '?'}
              </div>
            </div>
          </div>
          <div style="margin-top:14px;padding:12px 14px;background:rgba(0,0,0,0.2);border-radius:10px;font-size:13px;color:var(--text-secondary);line-height:1.6;">
            <strong style="color:${verdictColor};">${fundamentals.verdict.replace(/_/g, ' ')}:</strong> ${escapeHtml(fundamentals.reasoning)}
          </div>
          ${(() => {
            // Snowflake hexagon: 6-pillar V2 radar. Only rendered when we
            // have V2 pillar data; under SCORER_MODE=v1 this slot stays empty.
            const v2 = selectV2PayloadForHexagon(scorerMode, fundamentals, shadowV2);
            if (!v2?.pillars) return '';
            const naCount = Object.values(v2.pillars).filter(p => p.score == null).length;
            const modeTag = scorerMode === 'v2-primary'
              ? `<span style="background:rgba(52,211,153,0.12);color:#34d399;padding:2px 8px;border-radius:10px;font-size:10.5px;font-weight:600;">V2 (authoritative)</span>`
              : scorerMode === 'v2-shadow'
                ? `<span style="background:rgba(96,165,250,0.12);color:var(--blue);padding:2px 8px;border-radius:10px;font-size:10.5px;font-weight:600;">V2 (shadow)</span>`
                : '';
            return `
              <div style="margin-top:16px;padding:16px;background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(0,0,0,0.18));border:1px solid var(--border-soft);border-radius:12px;">
                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
                  <div>
                    <div style="font-size:13px;font-weight:700;color:var(--text-secondary);letter-spacing:0.3px;text-transform:uppercase;">Snowflake${infoIcon('snowflake_hexagon') || ''}</div>
                    <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">
                      Six-pillar fundamental profile · ${v2.sectorKind || 'sector-adapted'} weights
                      ${naCount ? ` · <span style="color:#fbbf24;">${naCount} pillar${naCount === 1 ? '' : 's'} N/A</span>` : ''}
                    </div>
                  </div>
                  ${modeTag}
                </div>
                ${renderSnowflakeHexagon(v2.pillars)}
                <div style="margin-top:12px;">
                  ${renderSnowflakePillarList(v2.pillars)}
                </div>
                <div style="margin-top:10px;font-size:10.5px;color:var(--text-muted);line-height:1.5;">
                  Dashed amber ring marks the average threshold (3/5). Pillars inside it are weak,
                  outside are strong. N/A pillars redistribute their weight — see the signals list
                  for context.
                </div>
              </div>
            `;
          })()}
          ${fundamentals.scoredAt ? `
            <div style="margin-top:10px;padding:8px 12px;border:1px solid var(--border-soft);border-radius:6px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);display:flex;gap:14px;flex-wrap:wrap;align-items:center;" title="Audit trail: this analytical verdict is reproducible from the inputs captured at the time of scoring.">
              <span><span style="color:var(--text-faint);">scored</span> ${new Date(fundamentals.scoredAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              ${fundamentals.scorerVersion ? `<span><span style="color:var(--text-faint);">scorer</span> ${fundamentals.scorerVersion}</span>` : ''}
            </div>
          ` : ''}
        </div>
      `;
    }

    // (News Sentiment section moved to the end — after technical indicators)

    // Intraday & Mid-term info row
    html += `<div class="info-row">`;

    if (midTerm) {
      const mtColor = midTerm.score >= 58 ? "positive" : midTerm.score <= 42 ? "negative" : "";
      html += `
        <div class="info-card">
          <div class="info-card-title">&#128200; Mid-Term Outlook${infoIcon('trend')}</div>
          <div class="info-card-value ${mtColor}">${midTerm.recommendation}</div>
          <div style="font-size:11px;color:var(--text-muted);margin:4px 0 6px;padding:4px 8px;background:rgba(255,255,255,0.03);border-radius:4px;display:inline-block;">
            &#128337; Holding period: <strong style="color:var(--text-secondary);">2&ndash;4 weeks</strong> &mdash; swing trade based on trend &amp; momentum signals
          </div>
          <div class="info-card-detail">
            Mid-Term Score: ${midTerm.score}/100 &middot;
            Trend: ${midTerm.trendAlignment}
          </div>
          ${midTerm.stopLoss && midTerm.target ? `
            <div style="display:flex;gap:14px;align-items:center;margin-top:10px;padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;font-size:12px;font-family:'JetBrains Mono',monospace;">
              <div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;display:block;">Stop Loss</span><span style="color:var(--red);font-weight:700;">&#8377;${formatNumber(midTerm.stopLoss)}</span></div>
              <div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;display:block;">Target</span><span style="color:var(--green);font-weight:700;">&#8377;${formatNumber(midTerm.target)}</span></div>
              <div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;display:block;">Volatility</span><span style="color:var(--yellow);font-weight:700;">${midTerm.volatilityPct}%</span></div>
              <div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;display:block;">R:R</span><span style="font-weight:700;">${midTerm.riskReward}x</span></div>
            </div>
          ` : ""}
          ${midTerm.slConfirmationNote ? `
            <div style="margin-top:8px;padding:6px 10px;background:${midTerm.slConfirmed ? 'rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3)'};border-radius:6px;font-size:11px;">
              <span style="color:${midTerm.slConfirmed ? 'var(--red)' : 'var(--yellow)'};font-weight:700;">${midTerm.slConfirmed ? '&#128308;' : '&#9888;'}</span>
              ${midTerm.slConfirmationNote}
            </div>
          ` : ""}
          ${midTerm.trailingStop ? `
            <div style="margin-top:8px;padding:6px 10px;background:${midTerm.trailingStop.triggered ? 'rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25)' : 'rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.2)'};border-radius:6px;font-size:11px;color:var(--text-muted);">
              <span style="color:${midTerm.trailingStop.triggered ? 'var(--red)' : '#34d399'};font-weight:700;">&#8593; Trailing Stop: &#8377;${formatNumber(midTerm.trailingStop.currentLevel)}</span>
              (from peak &#8377;${formatNumber(midTerm.trailingStop.highestClose)}) &mdash; <em>${midTerm.trailingStop.explanation}</em>
            </div>
          ` : ""}
        </div>
      `;
    }

    // ── Long-Term Outlook card (3–12 months, fundamentals-driven) ──
    const longTerm = data.longTerm;
    if (longTerm) {
      const ltColor = longTerm.score >= 62 ? "positive" : longTerm.score <= 35 ? "negative" : "";
      const km = longTerm.keyMetrics || {};
      const fmtPct = (v) => v != null ? (v * 100).toFixed(1) + "%" : "—";
      const fmtRatio = (v) => v != null ? v.toFixed(2) : "—";
      const verdictBadge = longTerm.fundamentalVerdict
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.5px;margin-left:8px;${
            longTerm.fundamentalVerdict === "DEEP_VALUE" ? "background:rgba(52,211,153,0.15);color:#34d399;" :
            longTerm.fundamentalVerdict === "QUALITY_GROWTH" ? "background:rgba(96,165,250,0.15);color:#60a5fa;" :
            longTerm.fundamentalVerdict === "OVERVALUED" ? "background:rgba(239,68,68,0.15);color:#ef4444;" :
            "background:rgba(245,158,11,0.15);color:#f59e0b;"
          }">${longTerm.fundamentalVerdict.replace("_", " ")}</span>`
        : "";

      html += `
        <div class="info-card">
          <div class="info-card-title">&#127970; Long-Term Outlook${infoIcon('long_term_outlook')}${verdictBadge}</div>
          <div class="info-card-value ${ltColor}">${longTerm.recommendation}</div>
          <div style="font-size:11px;color:var(--text-muted);margin:4px 0 6px;padding:4px 8px;background:rgba(255,255,255,0.03);border-radius:4px;display:inline-block;">
            &#128337; Holding period: <strong style="color:var(--text-secondary);">${longTerm.holdingPeriod}</strong> &mdash; based on business quality &amp; valuation
          </div>
          <div class="info-card-detail">
            Long-Term Score: ${longTerm.score}/100 &middot;
            Fund: ${longTerm.fundamentalScore ?? "—"}/100 &middot;
            Trend: ${longTerm.trendContextScore}/100
          </div>

          ${longTerm.target && longTerm.stopLoss ? `
            <div style="display:flex;gap:14px;align-items:center;margin-top:10px;padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;font-size:12px;font-family:'JetBrains Mono',monospace;">
              <div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;display:block;">Stop Loss</span><span style="color:var(--red);font-weight:700;">&#8377;${formatNumber(longTerm.stopLoss)}</span></div>
              <div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;display:block;">Target</span><span style="color:var(--green);font-weight:700;">&#8377;${formatNumber(longTerm.target)}</span></div>
              ${longTerm.riskReward ? `<div><span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;display:block;">R:R</span><span style="font-weight:700;">${longTerm.riskReward}x</span></div>` : ""}
            </div>
            ${longTerm.valuationBasis ? `<div style="font-size:10px;color:var(--text-muted);margin-top:6px;font-style:italic;">Target basis: ${longTerm.valuationBasis}</div>` : ""}
          ` : ""}

          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;">
            <div style="text-align:center;">
              <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">ROE</div>
              <div style="font-size:13px;font-weight:700;color:${km.roe != null && km.roe >= 0.15 ? 'var(--green)' : km.roe != null && km.roe < 0.05 ? 'var(--red)' : 'var(--text-primary)'};">${fmtPct(km.roe)}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Debt/Equity</div>
              <div style="font-size:13px;font-weight:700;color:${km.debtToEquity != null && km.debtToEquity <= 0.5 ? 'var(--green)' : km.debtToEquity != null && km.debtToEquity > 1 ? 'var(--red)' : 'var(--text-primary)'};">${fmtRatio(km.debtToEquity)}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Net Margin</div>
              <div style="font-size:13px;font-weight:700;color:${km.profitMargin != null && km.profitMargin >= 0.10 ? 'var(--green)' : km.profitMargin != null && km.profitMargin < 0 ? 'var(--red)' : 'var(--text-primary)'};">${fmtPct(km.profitMargin)}</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Rev Growth</div>
              <div style="font-size:13px;font-weight:700;color:${km.revenueGrowth != null && km.revenueGrowth >= 0.10 ? 'var(--green)' : km.revenueGrowth != null && km.revenueGrowth < 0 ? 'var(--red)' : 'var(--text-primary)'};">${fmtPct(km.revenueGrowth)}</div>
            </div>
            <div style="text-align:center;grid-column:span 2;">
              <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">P/E vs Sector</div>
              <div style="font-size:13px;font-weight:700;">${km.pe != null ? km.pe.toFixed(1) : "—"} <span style="font-size:10px;color:var(--text-muted);">vs</span> ${km.sectorPe != null ? km.sectorPe.toFixed(1) : "—"}</div>
            </div>
          </div>
          ${renderLongTermNarrative(longTerm)}
        </div>
      `;
    }

    html += `</div>`;

    // Quick stats
    html += `
      <div class="grid-4" style="margin-top:20px;">
        <div class="card">
          <div class="card-title">Day Range</div>
          <div class="card-value" style="font-size:14px;">&#8377;${formatNumber(quote.dayLow)} - &#8377;${formatNumber(quote.dayHigh)}</div>
          <div class="card-sub">Open: &#8377;${formatNumber(quote.open)} | Prev Close: &#8377;${formatNumber(quote.previousClose)}</div>
        </div>
        <div class="card">
          <div class="card-title">Volume${infoIcon('volume')}</div>
          <div class="card-value">${formatVolume(quote.volume)}</div>
          <div class="card-sub">Avg: ${formatVolume(quote.avgVolume)}</div>
        </div>
        <div class="card">
          <div class="card-title">52-Week Range${infoIcon('fifty_two_week_high')}</div>
          <div class="card-value" style="font-size:14px;">&#8377;${formatNumber(quote.fiftyTwoWeekLow)} - &#8377;${formatNumber(quote.fiftyTwoWeekHigh)}</div>
          <div class="card-sub">50D Avg: &#8377;${formatNumber(quote.fiftyDayAvg)}</div>
        </div>
        <div class="card">
          <div class="card-title">Moving Averages</div>
          <div class="card-value ${quote.price >= (quote.fiftyDayAvg || 0) ? "positive" : "negative"}" style="font-size:14px;">50D: &#8377;${formatNumber(quote.fiftyDayAvg)}</div>
          <div class="card-sub">200D: &#8377;${formatNumber(quote.twoHundredDayAvg)}${quote.pe ? ` | P/E: ${quote.pe.toFixed(1)}` : ""}</div>
        </div>
      </div>
    `;

    // Technical Indicators
    if (analysis.indicators) {
      html += `
        <div class="signals-section">
          <div class="section-title">Technical Indicators</div>
          <div class="indicator-grid">
            <div class="indicator-card">
              <div class="indicator-name">RSI (14)${infoIcon('rsi')}</div>
              <div class="indicator-value ${rsiColor(analysis.indicators.rsi)}">${analysis.indicators.rsi}</div>
              <div class="indicator-detail">${rsiLabel(analysis.indicators.rsi)}</div>
            </div>
            ${
              analysis.indicators.macd
                ? `
              <div class="indicator-card">
                <div class="indicator-name">MACD${infoIcon('macd')}</div>
                <div class="indicator-value ${parseFloat(analysis.indicators.macd.histogram) >= 0 ? "positive" : "negative"}">${analysis.indicators.macd.value}</div>
                <div class="indicator-detail">Signal: ${analysis.indicators.macd.signal} | Hist: ${analysis.indicators.macd.histogram}</div>
              </div>
            `
                : ""
            }
            ${
              analysis.indicators.bollinger
                ? `
              <div class="indicator-card">
                <div class="indicator-name">Bollinger %B${infoIcon('bollinger_bands')}</div>
                <div class="indicator-value">${analysis.indicators.bollinger.percentB}%</div>
                <div class="indicator-detail">Upper: &#8377;${analysis.indicators.bollinger.upper} | Lower: &#8377;${analysis.indicators.bollinger.lower}</div>
              </div>
            `
                : ""
            }
            ${
              analysis.indicators.stochastic
                ? `
              <div class="indicator-card">
                <div class="indicator-name">Stochastic${infoIcon('stochastic')}</div>
                <div class="indicator-value">%K: ${analysis.indicators.stochastic.k}</div>
                <div class="indicator-detail">%D: ${analysis.indicators.stochastic.d}</div>
              </div>
            `
                : ""
            }
            ${
              analysis.indicators.atr
                ? `
              <div class="indicator-card">
                <div class="indicator-name">ATR (14)${infoIcon('atr')}</div>
                <div class="indicator-value">&#8377;${analysis.indicators.atr}</div>
                <div class="indicator-detail">Average True Range (volatility)</div>
              </div>
            `
                : ""
            }
            ${
              analysis.indicators.vwap
                ? `
              <div class="indicator-card">
                <div class="indicator-name">VWAP${infoIcon('vwap')}</div>
                <div class="indicator-value ${quote.price >= parseFloat(analysis.indicators.vwap) ? "positive" : "negative"}">&#8377;${analysis.indicators.vwap}</div>
                <div class="indicator-detail">Price ${quote.price >= parseFloat(analysis.indicators.vwap) ? "above" : "below"} VWAP</div>
              </div>
            `
                : ""
            }
            ${
              analysis.indicators.momentum
                ? `
              <div class="indicator-card">
                <div class="indicator-name">Momentum</div>
                <div class="indicator-value ${parseFloat(analysis.indicators.momentum.roc5) >= 0 ? "positive" : "negative"}">${analysis.indicators.momentum.roc5}%</div>
                <div class="indicator-detail">5-day ROC | 10-day: ${analysis.indicators.momentum.roc10}%</div>
              </div>
            `
                : ""
            }
            ${
              analysis.indicators.trend
                ? `
              <div class="indicator-card">
                <div class="indicator-name">Trend${infoIcon('trend')}</div>
                <div class="indicator-value" style="font-size:14px;">${analysis.indicators.trend.trend}</div>
                <div class="indicator-detail">SMA 20: &#8377;${analysis.indicators.trend.sma20?.toFixed(2) || "N/A"}</div>
              </div>
            `
                : ""
            }
          </div>
        </div>
      `;
    }

    // Candlestick Patterns
    if (analysis.candlestickPatterns && analysis.candlestickPatterns.length > 0) {
      html += `
        <div class="signals-section">
          <div class="section-title">Candlestick Patterns Detected</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${analysis.candlestickPatterns
              .map(
                (p) => `
              <div class="signal-badge ${p.signal === "bullish" ? "signal-buy" : p.signal === "bearish" ? "signal-sell" : "signal-neutral"}">
                ${p.name} - ${p.description}
              </div>
            `
              )
              .join("")}
          </div>
        </div>
      `;
    }

    // Signal Details Table
    if (analysis.signals && analysis.signals.length > 0) {
      html += `
        <div class="signals-section">
          <div class="section-title">Signal Breakdown</div>
          <div style="overflow-x:auto;">
            <table class="signals-table">
              <thead>
                <tr>
                  <th>Indicator</th>
                  <th>Signal</th>
                  <th>Detail</th>
                  <th>Impact</th>
                </tr>
              </thead>
              <tbody>
                ${analysis.signals
                  .map(
                    (s) => `
                  <tr>
                    <td style="font-weight:600;">${s.indicator}</td>
                    <td><span class="signal-badge ${getSignalBadgeClass(s.signal)}">${s.signal}</span></td>
                    <td style="color:var(--text-secondary); font-size:13px;">${s.detail}</td>
                    <td style="font-family:'JetBrains Mono',monospace; font-weight:600; ${parseInt(s.impact) > 0 ? "color:var(--green)" : parseInt(s.impact) < 0 ? "color:var(--red)" : "color:var(--text-muted)"}">${s.impact}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
  } else if (analysis?.error) {
    html += `
      <div class="card" style="margin-top:16px; text-align:center; padding:30px;">
        <div style="color:var(--yellow); font-size:14px;">${analysis.error}</div>
      </div>
    `;
  }

  // ── News Sentiment Section (at the end, after all technical/fundamental data) ──
  if (sentiment && sentiment.headlines && sentiment.headlines.length > 0) {
    const sentLabel = sentiment?.label || "neutral";
    const sentColor =
      sentLabel.includes("bullish") ? "var(--green)" :
      sentLabel.includes("bearish") ? "var(--red)" : "var(--text-muted)";
    const newsScore = analysis?.sentimentScore ?? sentiment?.score;

    html += `
      <div class="signals-section" style="margin-top:20px;">
        <div class="section-title" style="display:flex;align-items:center;gap:10px;">
          News Sentiment Analysis
          <span style="font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px;background:${sentColor}22;color:${sentColor};">
            ${sentLabel.replace('_', ' ').toUpperCase()} (${newsScore}/100)
          </span>
        </div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;">${sentiment.summary}</div>
        <div class="news-list">
          ${sentiment.headlines.slice(0, 10).map(renderNewsHeadline).join("")}
        </div>
      </div>
    `;
  }

  // Last updated
  if (lastUpdated) {
    html += `
      <div style="text-align:center; padding:16px; font-size:12px; color:var(--text-muted);">
        Data last updated: ${new Date(lastUpdated).toLocaleString("en-IN")}
      </div>
    `;
  }

  // Price chart (SVG sparkline with volume bars)
  if (historicalChart && historicalChart.length >= 10) {
    html += renderPriceChart(historicalChart, quote);
  }

  stockDetail.innerHTML = html;
}

// ==================== DASHBOARD ====================

function showDashboard() {
  currentView = "dashboard";
  currentSymbol = null;
  stockDetail.classList.remove("active");
  stockDetail.innerHTML = "";
  dashboard.style.display = "block";
}

function goHome() {
  currentSymbol = null;
  stockDetail.classList.remove("active");
  stockDetail.innerHTML = "";
  switchTab("picks");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 8B: Editorial Terminal — subtle scroll-reveal motion.
// Fades + rises .dashboard-section blocks (and any .reveal-on-scroll element)
// as they enter the viewport. Respects prefers-reduced-motion.
// ═══════════════════════════════════════════════════════════════════════════
(function setupScrollReveal() {
  if (typeof IntersectionObserver === "undefined") return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("revealed");
        observer.unobserve(entry.target);
      }
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });

  function attach() {
    // Dashboard sections + any explicitly marked .reveal-on-scroll element
    const targets = document.querySelectorAll(".dashboard-section, .reveal-on-scroll");
    targets.forEach((el) => {
      if (el.classList.contains("reveal") || el.classList.contains("revealed")) return;
      el.classList.add("reveal");
      observer.observe(el);
    });
  }

  // Run on initial load + whenever tabs switch (new content may appear).
  document.addEventListener("DOMContentLoaded", attach);
  // Also expose a helper in case other code wants to trigger a re-scan.
  window.reinitScrollReveal = attach;
})();


// ──────────────── Combined Score (Tech + Fund + SWS) UI helpers ────────────────
//
// Drives the new SWS chip + Combined Score chip + divergence badge that
// appear on every scanner card, plus the methodology disclosure footer
// at the bottom of each scanner section.
//
// Methodology version is stamped server-side as `combined-v1-2026-04` and
// surfaced in tooltips. SEBI IA Reg 2013 Reg 15(2) — every recommendation
// surface must disclose its scoring methodology.

function _combinedScoreColor(score) {
  if (score == null) return "var(--text-muted)";
  if (score >= 70) return "var(--green)";
  if (score >= 55) return "var(--blue)";
  if (score >= 40) return "var(--yellow)";
  return "var(--red)";
}

function _swsVerdictColor(verdict) {
  switch (verdict) {
    case "TOP_PICK":   return "var(--green)";
    case "STRONG":     return "var(--blue)";
    case "ACCEPTABLE": return "var(--text-secondary)";
    case "WATCH":      return "var(--yellow)";
    case "AVOID":      return "var(--red)";
    default:           return "var(--text-muted)";
  }
}

function renderCombinedScoreChip(stock) {
  if (stock?.combinedScore == null) return "";
  const color = _combinedScoreColor(stock.combinedScore);
  const w = stock.combinedWeights || {};
  const conf = stock.combinedDataConfidence || "high";
  const tip =
    `Combined Score (${stock.combinedScoreVersion || "combined-v1"}): ` +
    `Tech ${Math.round((w.tech || 0) * 100)}% · Fund ${Math.round((w.fund || 0) * 100)}% · SWS ${Math.round((w.sws || 0) * 100)}%. ` +
    `Confidence: ${conf}. Dims: ${(stock.combinedDims || []).join("+")}.`;
  const opacity = conf === "low" ? "0.65" : "1";
  return `<span class="combined-chip" style="font-size:10px;padding:3px 8px;border-radius:6px;background:${color}18;color:${color};border:1px solid ${color}55;font-weight:700;opacity:${opacity};font-family:'JetBrains Mono',monospace;" title="${tip.replace(/"/g, "&quot;")}">&#9678; ${stock.combinedScore}/100</span>`;
}

function renderSwsChip(stock) {
  if (stock?.swsScore == null && !stock?.swsVerdict) return "";
  const v = stock.swsVerdict || "—";
  const color = _swsVerdictColor(v);
  const score = stock.swsScore != null ? Math.round(stock.swsScore) : "—";
  const fallback = stock.swsSource === "fallback";
  const labelV = v === "—" ? "" : v.replace(/_/g, " ");
  const tip = fallback
    ? `SWS coverage missing — score derived from fundamentalsV2 fallback. SWS v3 score ${score}/100, verdict ${v}.`
    : `Simply Wall St v3 score ${score}/100, verdict ${v}. Snowflake total ${stock.snowflakeTotal ?? "—"}/30.`;
  const fallbackTag = fallback ? ` <span style="opacity:0.7;font-size:9px;">(fallback)</span>` : "";
  return `<span class="sws-chip" style="font-size:10px;padding:3px 8px;border-radius:6px;background:${color}18;color:${color};border:1px solid ${color}33;font-weight:700;" title="${tip.replace(/"/g, "&quot;")}">SWS ${score}${labelV ? " · " + labelV : ""}${fallbackTag}</span>`;
}

function renderDivergenceBadge(stock) {
  if (!stock?.combinedDivergence) return "";
  const spread = stock.combinedDivergenceSpread != null ? stock.combinedDivergenceSpread : "—";
  const tip = `Divergent signals: spread ${spread} between Tech (${stock.score ?? "—"}), Fund (${stock.fundamentalScore ?? "—"}), SWS (${stock.swsScore ?? "—"}). Alpha-rich or trap-rich — verify before acting.`;
  return `<span class="divergence-chip" style="font-size:10px;padding:3px 8px;border-radius:6px;background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b66;font-weight:700;" title="${tip.replace(/"/g, "&quot;")}">&#9888; Divergent</span>`;
}

// SEBI IA Reg 2013 §15(4): warn the user when a recommendation is for a
// name they already hold — re-recommending without flagging concentration
// is a regulatory miss. Tier the colour: <7% blue (informational),
// 7–10% gold (caution), >10% red (overweight).
function renderPortfolioChip(stock) {
  if (!stock?.inPortfolio) return "";
  const w = Number(stock.currentWeight);
  if (!Number.isFinite(w)) return "";
  const after = stock.concentrationAfterTopUp;
  let color = "var(--blue, #38bdf8)";
  let bg = "rgba(56,189,248,0.12)";
  let border = "rgba(56,189,248,0.32)";
  let prefix = "ALREADY HELD";
  if (w >= 10) {
    color = "#f87171"; bg = "rgba(248,113,113,0.12)"; border = "rgba(248,113,113,0.4)";
    prefix = "OVERWEIGHT";
  } else if (w >= 7) {
    color = "#fbbf24"; bg = "rgba(251,191,36,0.12)"; border = "rgba(251,191,36,0.36)";
    prefix = "ALREADY HELD";
  }
  const tip = `${prefix}: this name is ${w.toFixed(2)}% of your cost-basis book.${
    after != null ? ` A ₹50k top-up would push it to ~${after.toFixed(2)}%.` : ""
  } Verify concentration before adding.`;
  const trail = after != null ? ` &rarr; ${after.toFixed(1)}%` : "";
  return `<span class="portfolio-chip" style="font-size:10px;padding:3px 8px;border-radius:6px;background:${bg};color:${color};border:1px solid ${border};font-weight:700;" title="${tip.replace(/"/g, "&quot;")}">${prefix} ${w.toFixed(1)}%${trail}</span>`;
}

// Per-recommendation methodology pane. Renders a collapsed <details> block on
// every Buy Now / Mid-Term / Sell card containing holding period, target/SL/
// R:R, score band, timing observation, methodology weights and data-as-of.
// No analyst-identity / RA-registration claims — this is internal research
// tooling, not a published SEBI RA service.
function convictionBandLabel(score, type) {
  const s = Number(score);
  if (!Number.isFinite(s)) return "—";
  if (type === "sell") {
    if (s <= 25) return "STRONG SELL";
    if (s <= 37) return "SELL";
    return "WEAK SELL";
  }
  if (s >= 75) return "STRONG";
  if (s >= 65) return "MODERATE";
  if (s >= 55) return "WEAK";
  return "BELOW THRESHOLD";
}

function holdingPeriodLabel(type) {
  if (type === "midterm") return "1–4 weeks (~7–28 trading days)";
  if (type === "sell") return "Exit signal — close on next confirmed close below SL";
  return "4–12 weeks (~28–84 trading days)";
}

function renderSebiDisclosure(stock, type) {
  const cfg = window.RA_CONFIG || {};

  const score = type === "midterm" ? stock?.midTerm?.score : (stock?.score ?? stock?.adjustedScore);
  const band = convictionBandLabel(score, type);
  const holdPeriod = holdingPeriodLabel(type);

  const sl = type === "midterm" ? stock?.midTerm?.stopLoss : stock?.stopLoss;
  const tgt = type === "midterm" ? stock?.midTerm?.target : stock?.target;
  const rr = type === "midterm" ? stock?.midTerm?.riskReward : stock?.riskReward;
  const slTgtLine = (sl && tgt)
    ? `SL ₹${formatNumber(sl)} · Target ₹${formatNumber(tgt)}${rr ? ` · R:R ${rr}` : ""}`
    : "Not specified for this scanner type";

  const dataAsOf = stock?.lastUpdated || stock?.snapshotAt || new Date().toISOString();
  const dataAsOfPretty = (() => {
    try {
      return new Date(dataAsOf).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    } catch (_e) { return dataAsOf; }
  })();

  const methodVersion = stock?.combinedScoreVersion || cfg.methodologyVersion || "combined-v1-2026-04";
  const weights = stock?.combinedWeights;
  const weightsLine = weights
    ? `Tech ${Math.round(weights.tech * 100)}% · Fund ${Math.round((weights.fund || 0) * 100)}% · SWS ${Math.round((weights.sws || 0) * 100)}%`
    : "Tech + Fund (legacy 50/50)";

  return `
    <details class="sebi-disclosure" onclick="event.stopPropagation()" style="margin-top:10px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,0.015);">
      <summary style="cursor:pointer;list-style:none;padding:8px 12px;font-size:11px;font-weight:600;color:var(--text-secondary);display:flex;align-items:center;gap:8px;">
        <span style="font-family:'JetBrains Mono',monospace;color:var(--gold,#fbbf24);">METHOD</span>
        <span>Methodology &amp; risk parameters</span>
        <span style="margin-left:auto;font-weight:400;color:var(--text-muted);">${band} conviction · v=${methodVersion}</span>
      </summary>
      <div style="padding:10px 12px 12px;font-size:11px;color:var(--text-muted);line-height:1.6;border-top:1px solid var(--border);">
        <div><strong style="color:var(--text-secondary);">Holding period:</strong> ${holdPeriod}</div>
        <div><strong style="color:var(--text-secondary);">Risk parameters:</strong> ${slTgtLine}</div>
        <div><strong style="color:var(--text-secondary);">Score band:</strong> ${score != null ? Math.round(score) : "—"}/100 → ${band}${
          Number.isFinite(stock?.convictionPct)
            ? ` · realized hit-rate ${(stock.convictionPct * 100).toFixed(0)}% (band ${stock.convictionBand || ""})`
            : " (calibration pending — needs ≥ 10 trades in this band)"
        }</div>
        ${stock?.timingObservation ? `
        <div><strong style="color:var(--text-secondary);">Today the right day?</strong> <strong style="color:${
          stock.timingObservation.verdict === "Yes" ? "var(--green)" :
          stock.timingObservation.verdict === "Yes-not-urgent" ? "var(--blue, #38bdf8)" :
          stock.timingObservation.verdict === "Soft-no" ? "var(--gold, #fbbf24)" :
          stock.timingObservation.verdict === "Wait-for-open" ? "var(--blue, #38bdf8)" :
          stock.timingObservation.verdict === "No" ? "#f87171" : "var(--text-muted)"
        };">${escapeHtml(stock.timingObservation.verdict)}</strong>${
          stock.timingObservation.window ? ` · ${escapeHtml(stock.timingObservation.window)}` : ""
        } — ${escapeHtml(stock.timingObservation.reason)}</div>
        ` : ""}
        <div><strong style="color:var(--text-secondary);">Methodology weights:</strong> ${weightsLine}</div>
        <div><strong style="color:var(--text-secondary);">Data as of:</strong> ${dataAsOfPretty}</div>
        <div style="margin-top:8px;font-style:italic;font-size:10px;">
          Educational content only.
        </div>
      </div>
    </details>
  `;
}

function renderCombinedScoreRow(stock) {
  const a = renderCombinedScoreChip(stock);
  const b = renderSwsChip(stock);
  const c = renderDivergenceBadge(stock);
  const d = renderPortfolioChip(stock);
  if (!a && !b && !c && !d) return "";
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;">${a}${b}${c}${d}</div>`;
}

function renderMethodologyFooter(methodology) {
  if (!methodology || !methodology.weights) return "";
  const wp = methodology.weightsPercent || {};
  const refresh = methodology.lastSwsRefresh
    ? new Date(methodology.lastSwsRefresh).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : "—";
  const sources = (methodology.sources || []).join(" · ");
  return `
    <div class="methodology-footer" style="margin-top:18px;padding:10px 12px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:8px;font-size:10px;color:var(--text-muted);font-family:'JetBrains Mono',monospace;line-height:1.55;">
      <div><strong style="color:var(--text-secondary);">Combined Score</strong> · Tech ${wp.tech || 0}% · Fund ${wp.fund || 0}% · SWS ${wp.sws || 0}% · v=${methodology.version || "—"}</div>
      <div>Sources: ${sources} · SWS last refresh: ${refresh} (${methodology.swsScoredCount || 0} stocks)</div>
      <div style="margin-top:4px;font-style:italic;">Educational content only.</div>
    </div>`;
}



// ──────────────────── Macro Regime Banner ────────────────────

/**
 * Render the macro regime banner above the Buy Now section.
 * Hides itself when regime === "CALM" and severity === 1 (no actionable signal).
 */
function renderMacroBanner(regime) {
  const banner = document.getElementById("macroRegimeBanner");
  if (!banner) return;

  // Degraded-classifier check runs FIRST. When the OpenAI quota is exceeded
  // (or the news fetch is broken), the regime API returns a synthetic CALM
  // with confidence=0 / headlineCount=0 plus an error string in `reasoning`.
  // The old early-return below would treat that as a no-op and silently
  // serve picks with macroBoost=0 — i.e., the user couldn't tell the macro
  // tilt was off. Surface a yellow degraded banner instead.
  const reasoning = String(regime?.reasoning || "");
  const degraded = !regime
    || regime.confidence === 0
    || regime.headlineCount === 0
    || /classifier error|quota|429|fetch failed|unavailable/i.test(reasoning);
  if (degraded) {
    const headlines = regime?.headlineCount ?? 0;
    const stalenessMs = regime?.staleness ?? null;
    const staleHours = stalenessMs != null ? Math.round(stalenessMs / 3600000) : null;
    const quotaUntil = regime?.quotaLimitedUntil ?? null;

    let bannerTitle = "&#9888; Macro classifier degraded";
    let bannerReasoning = `${escapeHtml(reasoning || "Macro feed unavailable.")} Picks below are running without macro tilt &mdash; treat sector recommendations as best-effort until the classifier recovers.`;

    if (quotaUntil && quotaUntil > Date.now()) {
      const resumeStr = new Date(quotaUntil).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
      });
      bannerTitle = "&#9203; Macro classifier paused (Groq quota)";
      bannerReasoning = `Daily token quota reached &mdash; ${staleHours != null ? `last classification ${staleHours}h ago` : "showing last known classification"}. Resumes automatically at ${resumeStr} IST.`;
    }

    banner.className = "macro-banner severity-degraded";
    banner.innerHTML = `
      <div class="macro-banner-header">
        <div class="macro-banner-title">${bannerTitle}</div>
        <div class="macro-banner-meta">
          <span>Headlines: ${headlines} &middot; Confidence: 0%${staleHours != null ? ` &middot; Last update ${staleHours}h ago` : ""}</span>
          <button type="button" class="macro-refresh-btn" onclick="macroRefreshClick(this)" title="Force a fresh classification (uses Groq quota).">&#8635; Refresh</button>
        </div>
      </div>
      <div class="macro-banner-reasoning">${bannerReasoning}</div>
    `;
    banner.style.display = "block";
    return;
  }

  if (regime.regime === "CALM" && regime.severity <= 1) {
    banner.style.display = "none";
    return;
  }

  // Severity tint: risk-off regimes red, stimulus green, everything else neutral amber
  const RISK_OFF = ["WAR_ESCALATION", "OIL_SHOCK", "RATE_HIKE", "REGULATORY_SHOCK", "GLOBAL_RISK_OFF", "CURRENCY_WEAKNESS"];
  const STIMULUS = ["POLICY_STIMULUS", "RATE_CUT", "WAR_DE_ESCALATION"];
  let severityClass = "severity-neutral";
  if (RISK_OFF.includes(regime.regime)) severityClass = "severity-risk-off";
  else if (STIMULUS.includes(regime.regime)) severityClass = "severity-stimulus";

  const staleMinutes = regime.generatedAt
    ? Math.round((Date.now() - new Date(regime.generatedAt).getTime()) / 60000)
    : null;

  const sectorChips = (regime.sectorImpacts || [])
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .map((s) => {
      const cls = s.impact > 0 ? "pos" : "neg";
      const sign = s.impact > 0 ? "+" : "";
      const reasonAttr = escapeHtml(s.reason || "");
      return `<span class="macro-sector-chip ${cls}" title="${reasonAttr}">${escapeHtml(s.sector)} ${sign}${s.impact}</span>`;
    })
    .join("");

  const confidencePct = Math.round((regime.confidence || 0) * 100);
  const regimeName = regime.regimeLabel || regime.regime || "UNKNOWN";
  const sourcesList = (regime.sources || []).map((s) => s.name).join(", ");

  banner.className = `macro-banner ${severityClass}`;
  banner.innerHTML = `
    <div class="macro-banner-header">
      <div class="macro-banner-title">
        <span>Market Regime${infoIcon('macro_regime')}:</span>
        <span class="macro-banner-regime-name">${escapeHtml(regimeName)}${infoIcon(regimeIdFromLabel(regime.regime))}</span>
      </div>
      <div class="macro-banner-meta">
        <span>Severity ${regime.severity}/5 &middot; Confidence ${confidencePct}%</span>
        <button type="button" class="macro-refresh-btn" onclick="macroRefreshClick(this)" title="Force a fresh classification (uses Groq quota).">&#8635; Refresh</button>
      </div>
    </div>
    ${regime.reasoning ? `<div class="macro-banner-reasoning">${escapeHtml(regime.reasoning)}</div>` : ""}
    ${sectorChips ? `<div class="macro-sector-chips">${sectorChips}</div>` : ""}
    ${renderTransitionAlert(regime.transition)}
    <div class="macro-banner-footer">
      Applied across all scanners + portfolio actions &middot;
      ${staleMinutes != null ? `Updated ${staleMinutes === 0 ? "just now" : staleMinutes + " min ago"}` : "Generated recently"}
      ${sourcesList ? ` &middot; Sources: ${escapeHtml(sourcesList)}` : ""}
      ${regime.fallbacksUsed && regime.fallbacksUsed.length > 0 ? ` &middot; <span class="macro-fallback-indicator" title="Primary sources were unavailable; these fallbacks took over.">Fallbacks: ${escapeHtml(regime.fallbacksUsed.join(", "))}</span>` : ""}
    </div>
  `;
  banner.style.display = "block";
}

/**
 * Render the regime transition alert — shown when the macro regime recently
 * changed (e.g., OIL_SHOCK → WAR_DE_ESCALATION). This is a buy/sell timing
 * signal based on the transition direction.
 */
function renderTransitionAlert(transition) {
  if (!transition || !transition.signal) return "";

  const sig = transition.signal;
  const isBuy = sig.action.includes("BUY");
  const isSell = sig.action.includes("SELL") || sig.action.includes("TRIM");
  const alertColor = isBuy ? "rgba(52,211,153,0.12)" : isSell ? "rgba(248,113,113,0.12)" : "rgba(251,191,36,0.12)";
  const borderColor = isBuy ? "rgba(52,211,153,0.3)" : isSell ? "rgba(248,113,113,0.3)" : "rgba(251,191,36,0.3)";
  const textColor = isBuy ? "#34d399" : isSell ? "#f87171" : "#fbbf24";
  const actionIcon = isBuy ? "&#9650;" : isSell ? "&#9660;" : "&#9679;";

  const sectorChips = (sig.sectors || []).map((s) => {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:${alertColor};color:${textColor};font-size:10px;font-weight:700;border:1px solid ${borderColor};">${escapeHtml(s)}</span>`;
  }).join(" ");

  const fromLabel = (transition.from || "").replace(/_/g, " ");
  const toLabel = (transition.to || "").replace(/_/g, " ");

  // How long ago was the transition detected?
  const agoMs = transition.detectedAt ? Date.now() - new Date(transition.detectedAt).getTime() : 0;
  const agoHours = Math.floor(agoMs / 3600000);
  const agoText = agoHours < 1 ? "just now" : agoHours < 24 ? `${agoHours}h ago` : `${Math.floor(agoHours / 24)}d ago`;

  return `
    <div style="margin-top:12px;padding:12px 16px;background:${alertColor};border:1px solid ${borderColor};border-radius:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-size:16px;color:${textColor};">${actionIcon}</span>
        <span style="font-size:13px;font-weight:800;color:${textColor};">REGIME SHIFT: ${sig.action}</span>
        <span style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(251,191,36,0.15);color:var(--gold);font-weight:700;">BETA</span>
        <span style="font-size:10px;color:var(--text-muted);margin-left:auto;">${escapeHtml(fromLabel)} → ${escapeHtml(toLabel)} · ${agoText}</span>
      </div>
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px;">
        ${escapeHtml(sig.summary)}
      </div>
      ${sectorChips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;">${sectorChips}</div>` : ""}
    </div>`;
}



// ==================== TABS ====================

function switchTab(tab) {
  try { telemetry.emit("tab_switch", { from: currentView, to: tab }); } catch {}
  const tabs = document.querySelectorAll("#mainTabs .tab");
  // A11y: mirror aria-selected on every tab so screen readers announce the
  // active tab correctly. The actual activation happens further down where
  // activeBtn.classList.add("active") runs.
  tabs.forEach((t) => {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
  });

  const newsEl = document.getElementById("newsTab");
  const portEl = document.getElementById("portfolioTab");
  const trackEl = document.getElementById("trackTab");
  const analyzerEl = document.getElementById("analyzerTab");
  const picksEl = document.getElementById("picksTab");
  const watchEl = document.getElementById("watchlistTab");
  const usersEl = document.getElementById("usersTab");
  const earningsEl = document.getElementById("earningsTab");

  newsEl.style.display = "none";
  portEl.style.display = "none";
  if (trackEl) trackEl.style.display = "none";
  if (analyzerEl) analyzerEl.style.display = "none";
  if (picksEl) picksEl.style.display = "none";
  if (watchEl) watchEl.style.display = "none";
  if (usersEl) usersEl.style.display = "none";
  if (earningsEl) earningsEl.style.display = "none";
  if (newsRefreshTimer) { clearInterval(newsRefreshTimer); newsRefreshTimer = null; }

  // Refresh the global macro banner on every tab switch. This is a cheap
  // lookup (cached on the server) but it guarantees the banner stays in sync
  // even if the user has the app open across a background refresh cycle, and
  // avoids any per-tab loader stomping on the banner state.
  loadMacroRegime();

  // Find and activate the matching tab button by its onclick attribute.
  // This is index-independent, so tab reordering doesn't break navigation.
  const activeBtn = Array.from(tabs).find((t) => t.getAttribute("onclick")?.includes(tab));
  if (activeBtn) {
    activeBtn.classList.add("active");
    activeBtn.setAttribute("aria-selected", "true");
  }

  if (tab === "news") {
    newsEl.style.display = "block";
    loadMarketNews();
    newsRefreshTimer = setInterval(() => loadMarketNews({ silent: true }), 10 * 60 * 1000);
  } else if (tab === "portfolio") {
    portEl.style.display = "block";
    loadPortfolio();
  } else if (tab === "track") {
    if (trackEl) trackEl.style.display = "block";
    loadTrackRecord();
  } else if (tab === "analyzer") {
    if (analyzerEl) analyzerEl.style.display = "block";
    initPortfolioAnalyzer();
    loadAnalyzerOnTabOpen();
  } else if (tab === "picks") {
    if (picksEl) picksEl.style.display = "block";
    loadPicks();
  } else if (tab === "watchlist") {
    if (watchEl) watchEl.style.display = "block";
    loadWatchlist();
  } else if (tab === "users") {
    // Defence-in-depth: server enforces admin via 403 on /api/admin/users,
    // but bail here too so a non-admin who somehow forces the URL doesn't
    // see a half-rendered tab while the fetch is in flight.
    if (!window.__starbhai_isAdmin) return;
    if (usersEl) usersEl.style.display = "block";
    loadUsersList();
  } else if (tab === "earnings") {
    if (earningsEl) earningsEl.style.display = "block";
    if (typeof loadEarningsWatch === "function") loadEarningsWatch();
  } else {
    // Default: picks tab
    const picksBtn = Array.from(tabs).find((t) => t.getAttribute("onclick")?.includes("picks"));
    if (picksBtn) {
      picksBtn.classList.add("active");
      picksBtn.setAttribute("aria-selected", "true");
    }
    if (picksEl) picksEl.style.display = "block";
    loadPicks();
  }
}

// ==================== USERS (admin) ====================
//
// Renders the admin Users tab. The tab itself is gated client-side
// (auth.init unhides the button only for admins) but the real gate is
// the server's 403 on /api/admin/users for non-admins. Layout follows
// the watchlist/picks pattern: header + table + per-row drill-down for
// the user's loginEvents history.

const _usersExpanded = new Set();

function _fmtIST(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

function _escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function _shortUA(ua) {
  if (!ua) return "—";
  const s = String(ua);
  // Best-effort one-glance label. Keep raw UA in the tooltip so admins can
  // copy it if they ever need the full string.
  let label = "Unknown";
  if (/iPhone|iPad/.test(s)) label = "iOS";
  else if (/Android/.test(s)) label = "Android";
  else if (/Macintosh/.test(s)) label = "macOS";
  else if (/Windows/.test(s)) label = "Windows";
  else if (/Linux/.test(s)) label = "Linux";
  let browser = "";
  if (/Edg\//.test(s)) browser = "Edge";
  else if (/Chrome\//.test(s)) browser = "Chrome";
  else if (/Firefox\//.test(s)) browser = "Firefox";
  else if (/Safari\//.test(s)) browser = "Safari";
  return browser ? `${label} · ${browser}` : label;
}

function _renderUsersTable(users) {
  if (!users.length) {
    return '<div style="padding:24px;text-align:center;color:var(--text-muted);">No users yet.</div>';
  }
  const rows = users.map((u) => {
    const events = Array.isArray(u.loginEvents) ? u.loginEvents : [];
    const visitCount = events.length;
    // sessionCount is server-derived; for legacy records that pre-date
    // session tracking, fall back to the login-event count so the column
    // isn't empty.
    const sessionCount = (typeof u.sessionCount === "number")
      ? u.sessionCount
      : events.length;
    const lastSeenAt = u.lastSeenAt || u.lastLoginAt;
    const open = _usersExpanded.has(u.sub);
    const adminBadge = u.isAdmin
      ? '<span style="background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;">ADMIN</span>'
      : "";
    const avatar = u.picture
      ? `<img src="${_escHtml(u.picture)}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;" referrerpolicy="no-referrer">`
      : '<div style="width:32px;height:32px;border-radius:50%;background:#1a2233;"></div>';

    let drilldown = "";
    if (open) {
      const eventRows = events.length
        ? [...events].reverse().map((ev) => `
            <tr>
              <td style="padding:6px 12px;font-variant-numeric:tabular-nums;">${_escHtml(_fmtIST(ev.ts))}</td>
              <td style="padding:6px 12px;color:var(--text-muted);">${_escHtml(ev.ip || "—")}</td>
              <td style="padding:6px 12px;color:var(--text-muted);" title="${_escHtml(ev.ua || "")}">${_escHtml(_shortUA(ev.ua))}</td>
            </tr>`).join("")
        : `<tr><td colspan="3" style="padding:12px;color:var(--text-muted);text-align:center;">No visit log yet — first tracked visit will appear here.</td></tr>`;
      drilldown = `
        <tr>
          <td colspan="8" style="padding:0;background:rgba(255,255,255,0.02);">
            <div style="padding:12px 16px;">
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Visit log (most recent first)</div>
              <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead>
                  <tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid #1a2233;">
                    <th style="padding:6px 12px;font-weight:500;">When (IST)</th>
                    <th style="padding:6px 12px;font-weight:500;">IP</th>
                    <th style="padding:6px 12px;font-weight:500;">Device</th>
                  </tr>
                </thead>
                <tbody>${eventRows}</tbody>
              </table>
            </div>
          </td>
        </tr>`;
    }

    // stopPropagation so the download click doesn't also toggle the visit-log drilldown.
    const portfolioCell = u.hasPortfolio
      ? `<a href="/api/admin/users/${encodeURIComponent(u.sub)}/portfolio.xlsx" download
            onclick="event.stopPropagation()"
            style="color:#60a5fa;text-decoration:underline;font-size:12px;">XLSX</a>`
      : '<span style="color:var(--text-muted);font-size:12px;">—</span>';

    return `
      <tr style="cursor:pointer;border-bottom:1px solid #1a2233;" onclick="_toggleUserRow('${_escHtml(u.sub)}')">
        <td style="padding:10px 12px;">${avatar}</td>
        <td style="padding:10px 12px;">
          <div style="font-weight:500;">${_escHtml(u.name || "—")}</div>
          <div style="font-size:11px;color:var(--text-muted);">${_escHtml(u.email || "")}</div>
        </td>
        <td style="padding:10px 12px;">${adminBadge}</td>
        <td style="padding:10px 12px;font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-muted);">${_escHtml(_fmtIST(u.createdAt))}</td>
        <td style="padding:10px 12px;font-variant-numeric:tabular-nums;font-size:12px;" title="Last activity (any authenticated request)">${_escHtml(_fmtIST(lastSeenAt))}</td>
        <td style="padding:10px 12px;font-variant-numeric:tabular-nums;text-align:right;" title="Total OAuth logins (cookie expires every 30 days)">${visitCount}</td>
        <td style="padding:10px 12px;font-variant-numeric:tabular-nums;text-align:right;" title="Distinct visits — new session counted after 30+ min idle gap">${sessionCount}</td>
        <td style="padding:10px 12px;text-align:right;">${portfolioCell}</td>
      </tr>
      ${drilldown}
    `;
  }).join("");

  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid #1a2233;">
          <th style="padding:10px 12px;font-weight:500;width:48px;"></th>
          <th style="padding:10px 12px;font-weight:500;">User</th>
          <th style="padding:10px 12px;font-weight:500;width:80px;">Role</th>
          <th style="padding:10px 12px;font-weight:500;">First seen</th>
          <th style="padding:10px 12px;font-weight:500;">Last seen</th>
          <th style="padding:10px 12px;font-weight:500;text-align:right;" title="Total OAuth logins">Visits</th>
          <th style="padding:10px 12px;font-weight:500;text-align:right;" title="Distinct platform visits — new session after 30+ min idle">Sessions</th>
          <th style="padding:10px 12px;font-weight:500;text-align:right;">Portfolio</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function _toggleUserRow(sub) {
  if (_usersExpanded.has(sub)) _usersExpanded.delete(sub);
  else _usersExpanded.add(sub);
  loadUsersList({ silent: true, useCache: true });
}

let _usersCache = null;

async function loadUsersList(opts = {}) {
  const container = document.getElementById("usersTabContent");
  const meta = document.getElementById("usersMeta");
  if (!container) return;

  // Re-render from cache (used by the row toggle so we don't refetch on every
  // expand/collapse).
  if (opts.useCache && _usersCache) {
    container.innerHTML = _renderUsersTable(_usersCache);
    return;
  }

  if (!opts.silent) {
    container.innerHTML = '<div class="loading"><div class="loading-spinner"></div><div class="loading-text">Loading users…</div></div>';
    if (meta) meta.textContent = "Loading…";
  }
  try {
    const res = await fetch("/api/admin/users", { credentials: "same-origin" });
    if (res.status === 403) {
      container.innerHTML = '<div style="padding:24px;text-align:center;color:#f87171;">Access denied. This view is admin-only.</div>';
      if (meta) meta.textContent = "";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _usersCache = data.users || [];
    container.innerHTML = _renderUsersTable(_usersCache);
    if (meta) meta.textContent = `${data.count} user${data.count === 1 ? "" : "s"} • click a row to see their visit log`;
  } catch (err) {
    container.innerHTML = `<div style="padding:24px;text-align:center;color:#f87171;">Failed to load users: ${_escHtml(err.message || err)}</div>`;
    if (meta) meta.textContent = "";
  }
}

// ==================== PORTFOLIO ====================

// Fix #2: `forceBust` tells the backend to skip its 30-second portfolio cache
// and recompute from scratch. Called from the "Refresh Prices" button so the
// user never sees stale data when they explicitly ask for fresh.
async function loadPortfolio(forceBust = false) {
  const stocksEl = document.getElementById("portfolioStocks");
  const summaryEl = document.getElementById("portfolioSummary");
  const mfEl = document.getElementById("portfolioMF");
  const updatedEl = document.getElementById("portfolioLastUpdated");

  try {
    const url = forceBust ? "/api/portfolio?bust=1" : "/api/portfolio";
    const res = await fetch(url);
    const data = await res.json();

    if (updatedEl && data.lastUpdated) {
      updatedEl.textContent = `Portfolio synced: ${new Date(data.lastUpdated).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
    }

    if ((!data.stocks || data.stocks.length === 0) && (!data.mutualFunds || data.mutualFunds.length === 0)) {
      summaryEl.innerHTML = "";
      stocksEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#128188;</div>
          <div class="empty-text">${data.message || "No portfolio data. Ask Claude to import from Groww."}</div>
        </div>`;
      mfEl.innerHTML = "";
      return;
    }

    // Render summary cards + Portfolio Intelligence header (health score + urgent actions)
    if (data.summary) {
      const s = data.summary;
      const intel = data.intelligence || {};
      const isPos = s.totalPnl >= 0;

      summaryEl.innerHTML = `
        <div class="grid-4">
          <div class="card">
            <div class="card-title">Total Invested</div>
            <div class="card-value">&#8377;${formatNumber(s.totalInvested)}</div>
          </div>
          <div class="card">
            <div class="card-title">Current Value</div>
            <div class="card-value ${isPos ? 'positive' : 'negative'}">&#8377;${formatNumber(s.totalCurrent)}</div>
          </div>
          <div class="card">
            <div class="card-title">Total P&amp;L</div>
            <div class="card-value ${isPos ? 'positive' : 'negative'}">${isPos ? '+' : ''}&#8377;${formatNumber(s.totalPnl)}</div>
          </div>
          <div class="card">
            <div class="card-title">Returns</div>
            <div class="card-value ${isPos ? 'positive' : 'negative'}">${isPos ? '+' : ''}${s.totalPnlPercent.toFixed(2)}%</div>
          </div>
        </div>

        ${renderHealthAndActionsBanner(intel)}
        ${renderPortfolioAnalyticsRow(intel)}
      `;
    }

    // Render stocks as action-aware cards, sorted by urgency
    if (data.stocks && data.stocks.length > 0) {
      // Urgency order: high → medium → low → none (HOLD goes to the bottom)
      const urgencyRank = { high: 0, medium: 1, low: 2, none: 3 };
      const sortedStocks = [...data.stocks].sort((a, b) => {
        const ua = urgencyRank[a.intelligence?.urgency ?? "none"];
        const ub = urgencyRank[b.intelligence?.urgency ?? "none"];
        if (ua !== ub) return ua - ub;
        // Same urgency → sort by absolute ₹ P&L magnitude (biggest impact first)
        return Math.abs(b.pnl || 0) - Math.abs(a.pnl || 0);
      });

      stocksEl.innerHTML = `
        <div style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
          <div class="section-title">Holdings (${data.stocks.length}) · sorted by urgency</div>
          <div style="font-size:11px;color:var(--text-muted);">Click any card to see full analysis</div>
        </div>
        <div class="portfolio-cards">
          ${sortedStocks.map((h) => renderPortfolioHoldingCard(h)).join("")}
        </div>`;
    }

    // Render mutual funds with summary
    if (data.mutualFunds && data.mutualFunds.length > 0) {
      const ms = data.mfSummary || {};
      const mfPos = (ms.totalPnl || 0) >= 0;

      mfEl.innerHTML = `
        <div style="padding-top:24px;border-top:1px solid #1a2233;">
          <div class="section-title" style="margin-bottom:16px;">Mutual Funds (${data.mutualFunds.length})</div>

          <div class="grid-4" style="margin-bottom:20px;">
            <div class="card">
              <div class="card-title">MF Invested</div>
              <div class="card-value">&#8377;${formatNumber(ms.totalInvested)}</div>
            </div>
            <div class="card">
              <div class="card-title">MF Current Value</div>
              <div class="card-value ${mfPos ? 'positive' : 'negative'}">&#8377;${formatNumber(ms.totalCurrent)}</div>
            </div>
            <div class="card">
              <div class="card-title">MF Total P&amp;L</div>
              <div class="card-value ${mfPos ? 'positive' : 'negative'}">${mfPos ? '+' : ''}&#8377;${formatNumber(ms.totalPnl)}</div>
            </div>
            <div class="card">
              <div class="card-title">MF Returns</div>
              <div class="card-value ${mfPos ? 'positive' : 'negative'}">${mfPos ? '+' : ''}${ms.totalPnlPercent?.toFixed(2) || 0}%</div>
            </div>
          </div>

          <div style="overflow-x:auto;">
            <table class="signals-table" style="min-width:700px;">
              <thead>
                <tr>
                  <th>Scheme</th>
                  <th>Category</th>
                  <th>XIRR</th>
                  <th>Invested</th>
                  <th>Current</th>
                  <th>P&amp;L</th>
                  <th>Returns</th>
                </tr>
              </thead>
              <tbody>
                ${data.mutualFunds.map((mf) => {
                  const isPos = (mf.returns || 0) >= 0;
                  const pnl = (mf.current || 0) - (mf.invested || 0);
                  return `
                    <tr>
                      <td>
                        <div style="font-weight:600;max-width:250px;">${escapeHtml(mf.name)}</div>
                      </td>
                      <td style="font-size:12px;color:var(--text-muted);">${mf.category || ''}</td>
                      <td style="font-family:'JetBrains Mono',monospace;font-size:12px;${(mf.xirr || 0) >= 0 ? 'color:var(--green)' : 'color:var(--red)'};">${mf.xirr?.toFixed(2) || 0}%</td>
                      <td style="font-family:'JetBrains Mono',monospace;">&#8377;${formatNumber(mf.invested)}</td>
                      <td style="font-family:'JetBrains Mono',monospace;">&#8377;${formatNumber(mf.current)}</td>
                      <td class="${pnl >= 0 ? 'positive' : 'negative'}" style="font-family:'JetBrains Mono',monospace;font-weight:600;">
                        ${pnl >= 0 ? '+' : ''}&#8377;${formatNumber(pnl)}
                      </td>
                      <td>
                        <span class="signal-badge ${isPos ? 'signal-buy' : 'signal-sell'}" style="font-family:'JetBrains Mono',monospace;">
                          ${isPos ? '+' : ''}${mf.returns?.toFixed(2) || 0}%
                        </span>
                      </td>
                    </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
        </div>`;
    } else {
      mfEl.innerHTML = "";
    }
  } catch (err) {
    stocksEl.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><div class="empty-text">Failed to load portfolio.</div></div>`;
  }
}

// Mapping from action colour keywords (from portfolioIntelligence.js) to
// concrete CSS values used in the cards. Keeping this in one place so the
// colour scheme is consistent across the health banner and per-holding cards.
const ACTION_COLORS = {
  "dark-red":   { bg: "rgba(220,38,38,0.12)",  border: "rgba(220,38,38,0.35)",  text: "#ef4444", glow: "rgba(220,38,38,0.15)" },
  "red":        { bg: "rgba(239,68,68,0.10)",  border: "rgba(239,68,68,0.30)",  text: "#ef4444", glow: "rgba(239,68,68,0.12)" },
  "orange":     { bg: "rgba(249,115,22,0.12)", border: "rgba(249,115,22,0.35)", text: "#f97316", glow: "rgba(249,115,22,0.12)" },
  "yellow":     { bg: "rgba(234,179,8,0.12)",  border: "rgba(234,179,8,0.35)",  text: "#eab308", glow: "rgba(234,179,8,0.12)" },
  "blue":       { bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.22)", text: "#60a5fa", glow: "rgba(59,130,246,0.08)" },
  "green":      { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.35)",  text: "#22c55e", glow: "rgba(34,197,94,0.12)" },
  "dark-green": { bg: "rgba(22,163,74,0.15)",  border: "rgba(22,163,74,0.45)",  text: "#16a34a", glow: "rgba(22,163,74,0.15)" },
  "gray":       { bg: "rgba(107,114,128,0.10)",border: "rgba(107,114,128,0.25)",text: "#9ca3af", glow: "rgba(107,114,128,0.08)" },
};

// Verdict colors for the health score banner
const HEALTH_VERDICT_COLORS = {
  HEALTHY:            { text: "#22c55e", bg: "rgba(34,197,94,0.10)",  label: "HEALTHY" },
  GOOD:               { text: "#60a5fa", bg: "rgba(59,130,246,0.10)", label: "GOOD" },
  NEEDS_ATTENTION:    { text: "#eab308", bg: "rgba(234,179,8,0.10)",  label: "NEEDS ATTENTION" },
  AT_RISK:            { text: "#ef4444", bg: "rgba(239,68,68,0.10)",  label: "AT RISK" },
  INSUFFICIENT_DATA:  { text: "#9ca3af", bg: "rgba(107,114,128,0.08)",label: "INSUFFICIENT DATA" },
};

/**
 * Top banner combining the Portfolio Health Score (big number + verdict)
 * and the Urgent Actions queue (top 4 non-HOLD items). If there are no
 * urgent actions, shows an "all on track" reassurance message.
 */
function renderHealthAndActionsBanner(intel) {
  if (!intel || intel.healthScore == null) return "";

  const hv = HEALTH_VERDICT_COLORS[intel.healthVerdict] || HEALTH_VERDICT_COLORS.INSUFFICIENT_DATA;
  const urgent = intel.urgentActions || [];
  const topUrgent = urgent.slice(0, 4);
  const stats = intel.healthStats || {};
  const bd = intel.healthBreakdown || {};

  // Human-readable breakdown tooltip
  const macroExp = bd.macroExposure ?? 0;
  const macroLine = macroExp !== 0
    ? `Macro exposure: ${macroExp > 0 ? '+' : ''}${macroExp} (${stats.macroActiveCount || 0} holdings in impacted sectors)`
    : null;
  const breakdownLines = [
    `Quality: +${bd.quality ?? 0} (avg of holding scores)`,
    `Diversification: +${bd.diversification ?? 0} (across ${stats.sectorCount ?? 0} sectors)`,
    bd.concentration !== 0 ? `Concentration: ${bd.concentration}` : null,
    bd.lossRatio !== 0 ? `Loss ratio: ${bd.lossRatio} (${stats.inLoss}/${stats.totalHoldings} in loss)` : null,
    bd.valuation !== 0 ? `Valuation: ${bd.valuation} (${stats.overvaluedCount} overvalued)` : null,
    bd.profitRatio !== 0 ? `Profit ratio: +${bd.profitRatio}` : null,
    macroLine,
  ].filter(Boolean).join("\n");

  // Inline macro exposure chip (shown only when regime is active)
  const macroChip = macroExp !== 0
    ? `<div style="font-size:10px;color:${macroExp > 0 ? '#22c55e' : '#ef4444'};margin-top:6px;font-weight:700;">Macro: ${macroExp > 0 ? '+' : ''}${macroExp} ${macroExp > 0 ? 'tailwind' : 'headwind'}</div>`
    : "";

  return `
    <div style="display:grid;grid-template-columns:minmax(220px,280px) 1fr;gap:16px;margin-top:20px;margin-bottom:24px;">
      <!-- Health Score card -->
      <div style="padding:18px 20px;background:${hv.bg};border:1px solid ${hv.text}33;border-radius:12px;" title="${escapeHtml(breakdownLines)}">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;margin-bottom:6px;">Portfolio Health${infoIcon('health_score')}</div>
        <div style="display:flex;align-items:baseline;gap:8px;">
          <div style="font-family:'JetBrains Mono',monospace;font-size:40px;font-weight:800;color:${hv.text};line-height:1;">${intel.healthScore}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--text-muted);">/100</div>
        </div>
        <div style="font-size:12px;font-weight:700;color:${hv.text};margin-top:6px;letter-spacing:0.3px;">${hv.label}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:10px;line-height:1.5;">
          ${stats.inProfit} winners · ${stats.inLoss} losers · ${stats.sectorCount} sectors
        </div>
        ${macroChip}
      </div>

      <!-- Urgent Actions list -->
      <div style="padding:18px 20px;background:rgba(0,0,0,0.2);border:1px solid var(--border);border-radius:12px;">
        ${urgent.length === 0 ? `
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;">Urgent Actions</div>
            <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(34,197,94,0.12);color:#22c55e;font-weight:700;">NONE</span>
          </div>
          <div style="font-size:14px;color:var(--text-secondary);margin-top:10px;">
            ✓ Your portfolio is on track. No positions need attention this week.
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;">Urgent Actions</div>
            <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(234,179,8,0.15);color:#eab308;font-weight:700;">${urgent.length} NEED REVIEW</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${topUrgent.map((u) => {
              const c = ACTION_COLORS[u.color] || ACTION_COLORS.gray;
              const isPos = (u.pnl || 0) >= 0;
              return `
                <div onclick="openStockDetailModal('${u.symbol}','watchlist')" style="cursor:pointer;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;background:${c.bg};border:1px solid ${c.border};">
                  <span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:4px;background:${c.text}22;color:${c.text};letter-spacing:0.4px;white-space:nowrap;">${u.displayAction}</span>
                  <div style="min-width:0;">
                    <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.name || u.symbol)}</div>
                    <div style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml((u.reasoning || "").slice(0, 80))}${u.reasoning?.length > 80 ? "…" : ""}</div>
                  </div>
                  <div style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:${isPos ? 'var(--green)' : 'var(--red)'};text-align:right;white-space:nowrap;">
                    ${isPos ? '+' : ''}${u.pnlPercent?.toFixed(1) || 0}%
                  </div>
                </div>`;
            }).join("")}
            ${urgent.length > 4 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;text-align:center;">…and ${urgent.length - 4} more below</div>` : ""}
          </div>
        `}
      </div>
    </div>`;
}

/**
 * Sector allocation bar chart. Each bar shows sector weight as a fraction of
 * the portfolio, colour-coded by concentration risk:
 *   • > 30%  → red (overconcentrated)
 *   • 20-30% → yellow (moderate)
 *   • < 20%  → green (diversified)
 *
 * Sorted descending. Limited to top 10 sectors to keep the panel compact.
 */
function renderSectorAllocation(sectorAllocation) {
  if (!sectorAllocation || sectorAllocation.length === 0) return "";

  // Find the max for bar scaling (so the biggest sector uses 100% of the bar width)
  const maxWeight = Math.max(...sectorAllocation.map((s) => s.weight));
  const flagColor = (flag) =>
    flag === "overconcentrated" ? "#ef4444" :
    flag === "moderate"         ? "#eab308" :
                                  "#22c55e";

  const rows = sectorAllocation.slice(0, 10).map((s) => {
    const barPct = (s.weight / maxWeight) * 100;
    const color = flagColor(s.flag);
    // Per-sector macro chip (only when regime has a non-zero impact on this sector)
    let macroChipInline = "";
    if (s.macroImpact && s.macroImpact !== 0) {
      const cls = s.macroImpact > 0 ? "pos" : "neg";
      const sign = s.macroImpact > 0 ? "+" : "";
      const tip = escapeHtml(s.macroReason || "");
      macroChipInline = `<span class="macro-sector-chip ${cls}" title="${tip}" style="font-size:9px;padding:1px 6px;">${sign}${s.macroImpact}</span>`;
    }
    return `
      <div style="display:grid;grid-template-columns:110px 1fr auto auto;gap:10px;align-items:center;font-size:12px;">
        <div style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${escapeHtml(s.sector)}</div>
        <div style="height:8px;background:rgba(255,255,255,0.04);border-radius:4px;overflow:hidden;">
          <div style="width:${barPct}%;height:100%;background:${color};border-radius:4px;"></div>
        </div>
        ${macroChipInline || '<span></span>'}
        <div style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${color};min-width:48px;text-align:right;">${s.weight.toFixed(1)}%</div>
      </div>`;
  }).join("");

  return `
    <div style="padding:18px 20px;background:rgba(0,0,0,0.2);border:1px solid var(--border);border-radius:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;margin-bottom:12px;">Sector Allocation (${sectorAllocation.length} sectors)</div>
      <div style="display:flex;flex-direction:column;gap:8px;">${rows}</div>
    </div>`;
}

/**
 * Top winners + top losers by absolute ₹ P&L impact. Two small lists side by
 * side. This reframes the user's attention from "who has the biggest %" to
 * "who is actually moving my portfolio" — which is the thing that matters.
 */
function renderTopMovers(topWinners, topLosers) {
  if ((!topWinners || topWinners.length === 0) && (!topLosers || topLosers.length === 0)) return "";

  const row = (mover, color) => {
    const isPos = mover.pnl >= 0;
    return `
      <div onclick="openStockDetailModal('${mover.symbol}','top-movers')" style="cursor:pointer;display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:7px 10px;border-radius:6px;background:rgba(255,255,255,0.02);border:1px solid ${color}22;">
        <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(mover.name || mover.symbol)}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:${color};font-weight:700;white-space:nowrap;">
          ${isPos ? "+" : ""}₹${formatNumber(Math.abs(mover.pnl))}
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted);min-width:48px;text-align:right;">
          ${isPos ? "+" : ""}${mover.pnlPercent?.toFixed(1)}%
        </div>
      </div>`;
  };

  return `
    <div style="padding:18px 20px;background:rgba(0,0,0,0.2);border:1px solid var(--border);border-radius:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;margin-bottom:12px;">Top Contributors</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div>
          <div style="font-size:10px;color:#22c55e;font-weight:700;margin-bottom:6px;letter-spacing:0.4px;">WINNERS</div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            ${topWinners.length > 0 ? topWinners.map(w => row(w, "#22c55e")).join("") : '<div style="font-size:11px;color:var(--text-muted);padding:8px;">None yet</div>'}
          </div>
        </div>
        <div>
          <div style="font-size:10px;color:#ef4444;font-weight:700;margin-bottom:6px;letter-spacing:0.4px;">DETRACTORS</div>
          <div style="display:flex;flex-direction:column;gap:5px;">
            ${topLosers.length > 0 ? topLosers.map(l => row(l, "#ef4444")).join("") : '<div style="font-size:11px;color:var(--text-muted);padding:8px;">None</div>'}
          </div>
        </div>
      </div>
    </div>`;
}

/**
 * Phase 2 analytics row — sits below the Health + Urgent Actions banner.
 * Two columns: Sector allocation chart on the left, Top Contributors on the right.
 */
function renderPortfolioAnalyticsRow(intel) {
  if (!intel) return "";
  const sectors = intel.sectorAllocation || [];
  const winners = intel.topWinners || [];
  const losers = intel.topLosers || [];
  if (sectors.length === 0 && winners.length === 0 && losers.length === 0) return "";

  return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
      ${renderSectorAllocation(sectors)}
      ${renderTopMovers(winners, losers)}
    </div>`;
}

/**
 * Compact helper that renders the recovery-math block for a loser card.
 * Returns a tiny block like:
 *   Break-even: ₹1,308.98 (+74% needed) · Low probability
 * Only shown on holdings in loss.
 */
function renderRecoveryInfo(recoveryMath) {
  if (!recoveryMath) return "";
  const probColors = {
    "very_low":  "#ef4444",
    "low":       "#f97316",
    "moderate":  "#eab308",
    "high":      "#22c55e",
  };
  const probLabels = {
    "very_low":  "very low",
    "low":       "low",
    "moderate":  "moderate",
    "high":      "high",
  };
  const col = probColors[recoveryMath.recoveryProbability] || "#9ca3af";
  const lbl = probLabels[recoveryMath.recoveryProbability] || recoveryMath.recoveryProbability;

  return `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:center;padding:8px 10px;background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.15);border-radius:6px;font-size:11px;">
      <div style="color:var(--text-muted);">Break-even</div>
      <div style="text-align:right;">
        <span style="font-family:'JetBrains Mono',monospace;font-weight:700;">₹${formatNumber(recoveryMath.breakEvenPrice)}</span>
        <span style="color:var(--text-muted);">&nbsp;·&nbsp;</span>
        <span style="font-family:'JetBrains Mono',monospace;color:#ef4444;font-weight:700;">+${recoveryMath.upsideNeededPct.toFixed(0)}%</span>
        <span style="color:var(--text-muted);">&nbsp;needed · </span>
        <span style="color:${col};font-weight:700;text-transform:uppercase;">${lbl}</span>
      </div>
    </div>`;
}

/**
 * Position sizing indicator. Shows where current weight is vs target range
 * and flags under/over/appropriate. Just one line, kept minimal.
 */
function renderPositionSizing(sizing) {
  if (!sizing || sizing.status === "no_data") return "";
  const statusColors = {
    "overweight":          "#ef4444",
    "slightly_overweight": "#eab308",
    "underweight":         "#60a5fa",
    "appropriate":         "#22c55e",
  };
  const statusLabels = {
    "overweight":          "OVERWEIGHT",
    "slightly_overweight": "TOO HIGH",
    "underweight":         "ROOM TO ADD",
    "appropriate":         "SIZED RIGHT",
  };
  const col = statusColors[sizing.status] || "#9ca3af";
  const lbl = statusLabels[sizing.status] || sizing.status;
  return `
    <span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px;background:${col}22;color:${col};letter-spacing:0.3px;">${lbl} · target ${sizing.targetRange}</span>
  `;
}

/**
 * Catalyst badge — shows the next upcoming earnings/dividend date for the
 * holding, if any. Extracted from NSE's event calendar on the backend.
 */
function renderCatalyst(catalysts) {
  if (!catalysts || catalysts.length === 0) return "";
  // Find the nearest future earnings, fallback to any event
  const earnings = catalysts.find((c) => c.category === "earnings");
  const next = earnings || catalysts[0];
  const icon = next.category === "earnings" ? "📊" :
               next.category === "dividend" ? "💰" :
               next.category === "corporate_action" ? "⚙" : "📅";
  const label = next.category === "earnings" ? "Earnings" :
                next.category === "dividend" ? "Dividend" :
                next.category === "corporate_action" ? "Corp Action" : "Event";
  return `
    <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.22);border-radius:6px;font-size:11px;">
      <span>${icon}</span>
      <span style="color:var(--text-muted);">${label}:</span>
      <span style="font-weight:700;color:#60a5fa;font-family:'JetBrains Mono',monospace;">${escapeHtml(next.date)}</span>
    </div>`;
}

/**
 * Render the per-holding macro row — headwind warning (red) if the sector is
 * impacted negatively, tailwind (green) if positive. Returns empty string if
 * no meaningful macro impact.
 */
function renderMacroRow(intel) {
  if (!intel) return "";
  if (intel.macroWarning) {
    return `
      <div style="display:flex;align-items:flex-start;gap:6px;padding:6px 10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:6px;font-size:11px;color:#fca5a5;line-height:1.4;">
        ${escapeHtml(intel.macroWarning)}
      </div>`;
  }
  if (intel.macroTailwind) {
    return `
      <div style="display:flex;align-items:flex-start;gap:6px;padding:6px 10px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:6px;font-size:11px;color:#86efac;line-height:1.4;">
        ${escapeHtml(intel.macroTailwind)}
      </div>`;
  }
  // No action-changing macro but still has a delta → show a subtle chip
  if (intel.macroInfo && Math.abs(intel.macroInfo.delta) >= 0.5) {
    const d = intel.macroInfo.delta;
    const sign = d > 0 ? "+" : "";
    const cls = d > 0 ? "pos" : "neg";
    const tip = escapeHtml(intel.macroInfo.reason || "");
    return `
      <div style="font-size:10px;color:var(--text-muted);display:flex;align-items:center;gap:6px;">
        <span class="macro-boost-badge ${cls}" title="${tip}">${sign}${d.toFixed(1)} macro</span>
      </div>`;
  }
  return "";
}

/**
 * One card per holding. Big action badge top-right, all the P&L numbers,
 * the Tech/Fund/Combined scores, and a one-line reasoning. The whole card
 * is clickable — opens the full stock detail view.
 */
function renderPortfolioHoldingCard(h) {
  const intel = h.intelligence || {};
  const color = ACTION_COLORS[intel.color] || ACTION_COLORS.gray;
  const isPnlPos = (h.pnl || 0) >= 0;
  const isTodayPos = (h.changePercent || 0) >= 0;

  // Score mini-bars
  const techScore = intel.technicalScore ?? null;
  const fundScore = intel.fundamentalScore ?? null;
  const combinedScore = intel.combinedScore ?? null;

  const scoreBar = (score, label) => {
    if (score == null) return `<div style="font-size:10px;color:var(--text-muted);"><strong>${label}:</strong> N/A</div>`;
    const barColor = score >= 70 ? "#22c55e" : score >= 50 ? "#eab308" : score >= 35 ? "#f97316" : "#ef4444";
    return `
      <div style="display:flex;align-items:center;gap:6px;font-size:10px;">
        <span style="color:var(--text-muted);font-weight:600;min-width:32px;">${label}</span>
        <div style="flex:1;height:4px;background:rgba(255,255,255,0.05);border-radius:2px;overflow:hidden;min-width:40px;max-width:80px;">
          <div style="width:${score}%;height:100%;background:${barColor};"></div>
        </div>
        <span style="font-family:'JetBrains Mono',monospace;color:${barColor};font-weight:700;min-width:20px;">${score}</span>
      </div>`;
  };

  // Position weight bar
  const weight = intel.positionWeight ?? 0;
  const weightColor = weight >= 15 ? "#eab308" : weight >= 10 ? "#60a5fa" : "var(--text-muted)";

  return `
    <div class="portfolio-card" onclick="openStockDetailModal('${h.symbol}','portfolio')" style="
      cursor:pointer;
      background:var(--bg-card);
      border:1px solid ${color.border};
      border-left:4px solid ${color.text};
      border-radius:10px;
      padding:16px;
      display:flex;
      flex-direction:column;
      gap:12px;
      transition:all 0.15s;
    " onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 16px ${color.glow}';" onmouseout="this.style.transform='none';this.style.boxShadow='none';">
      <!-- Header: name + action badge -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div style="min-width:0;flex:1;">
          <div style="font-weight:800;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(h.name || h.symbol)}</div>
          <div style="font-size:10px;color:var(--text-muted);font-family:'JetBrains Mono',monospace;margin-top:2px;">${h.symbol}${h.sector && h.sector !== "Unknown" ? " · " + escapeHtml(h.sector) : ""}</div>
        </div>
        <span style="font-size:10px;font-weight:800;padding:5px 10px;border-radius:6px;background:${color.bg};color:${color.text};border:1px solid ${color.border};letter-spacing:0.4px;white-space:nowrap;display:inline-flex;align-items:center;">${intel.displayAction || "HOLD"}${infoIcon(portfolioActionIdFromLabel(intel.action))}</span>
      </div>

      <!-- P&L row -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Position</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;margin-top:2px;">${h.quantity} @ ₹${formatNumber(h.avgPrice)}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);">Now ₹${h.currentPrice != null ? formatNumber(h.currentPrice) : 'N/A'} ${h.changePercent != null ? `<span class="${isTodayPos ? 'positive' : 'negative'}">(${isTodayPos ? '+' : ''}${h.changePercent.toFixed(2)}%)</span>` : ''}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">P&amp;L</div>
          <div class="${isPnlPos ? 'positive' : 'negative'}" style="font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:800;margin-top:2px;">
            ${h.pnl != null ? (isPnlPos ? '+' : '') + '₹' + formatNumber(h.pnl) : 'N/A'}
          </div>
          <div class="${isPnlPos ? 'positive' : 'negative'}" style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;">
            ${h.pnlPercent != null ? (isPnlPos ? '+' : '') + h.pnlPercent.toFixed(2) + '%' : ''}
          </div>
        </div>
      </div>

      <!-- Score mini-bars (tech / fund / combined) -->
      <div style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:rgba(0,0,0,0.15);border-radius:6px;">
        ${scoreBar(techScore, "Tech")}
        ${scoreBar(fundScore, "Fund")}
        ${scoreBar(combinedScore, "Total")}
      </div>

      ${renderRecoveryInfo(intel.recoveryMath)}

      ${h.catalysts && h.catalysts.length > 0 ? renderCatalyst(h.catalysts) : ""}

      ${renderMacroRow(intel)}

      <!-- Reasoning -->
      <div style="font-size:12px;line-height:1.5;color:var(--text-secondary);border-top:1px solid rgba(255,255,255,0.05);padding-top:10px;">
        ${escapeHtml(intel.reasoning || "No analysis available.")}
      </div>

      <!-- Footer: weight + sizing badge + current value -->
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:10px;color:var(--text-muted);padding-top:6px;border-top:1px solid rgba(255,255,255,0.03);flex-wrap:wrap;">
        <span>Weight: <span style="color:${weightColor};font-weight:700;font-family:'JetBrains Mono',monospace;">${weight.toFixed(1)}%</span></span>
        ${renderPositionSizing(intel.positionSizing)}
        <span>Current: <span style="color:var(--text-secondary);font-family:'JetBrains Mono',monospace;">₹${h.currentValue != null ? formatNumber(h.currentValue) : 'N/A'}</span></span>
      </div>
    </div>
  `;
}

// ==================== MARKET NEWS ====================

let _newsDigest = null; // cached digest for filter re-renders
let _newsLoading = false; // debounce concurrent loads

function setNewsLoadingBanner(visible) {
  const b = document.getElementById("newsLoadingBanner");
  if (b) b.hidden = !visible;
}

async function loadMarketNews(opts = {}) {
  if (_newsLoading) return;
  _newsLoading = true;
  const silent = !!opts.silent;
  if (!silent) setNewsLoadingBanner(true);

  const container = document.getElementById("newsContainer");

  try {
    // Three endpoints feed the slim Market Intelligence tab: digest, verdict, heatmap
    const [newsRes, verdictRes, heatmapRes] = await Promise.all([
      fetch("/api/news/market"),
      fetch("/api/market-verdict").catch(() => null),
      fetch("/api/sector-heatmap").catch(() => null),
    ]);
    const data = await newsRes.json();
    const verdict = verdictRes && verdictRes.ok ? await verdictRes.json().catch(() => null) : null;
    const heatmap = heatmapRes && heatmapRes.ok ? await heatmapRes.json().catch(() => null) : null;

    if (data.error) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><div class="empty-text">${escapeHtml(data.error)}</div></div>`;
      return;
    }

    _newsDigest = data.digest || null;

    const updatedEl = document.getElementById("newsLastUpdated");
    if (updatedEl) updatedEl.textContent = `Updated: ${new Date(data.lastUpdated).toLocaleTimeString("en-IN")}`;

    renderNewsPage(_newsDigest, verdict, heatmap);
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><div class="empty-text">Failed to load news. Try again.</div></div>`;
  } finally {
    if (!silent) setNewsLoadingBanner(false);
    _newsLoading = false;
  }
}

function renderNewsPage(digest, verdict, heatmap) {
  const container = document.getElementById("newsContainer");

  let html = "";

  // ── Today's Verdict (5-signal dashboard) ──
  if (verdict && verdict.signals) {
    const vc = verdict.verdictColor === "green" ? "var(--green)" : verdict.verdictColor === "red" ? "var(--red)" : "var(--yellow)";
    const vBg = verdict.verdictColor === "green" ? "rgba(52,211,153,0.1)" : verdict.verdictColor === "red" ? "rgba(248,113,113,0.1)" : "rgba(251,191,36,0.1)";
    const vBorder = verdict.verdictColor === "green" ? "rgba(52,211,153,0.3)" : verdict.verdictColor === "red" ? "rgba(248,113,113,0.3)" : "rgba(251,191,36,0.3)";
    const verdictIcon = verdict.verdictColor === "green" ? "&#9650;" : verdict.verdictColor === "red" ? "&#9660;" : "&#9679;";

    const signalRows = verdict.signals.map((s) => {
      const sc = s.signal === "green" ? "var(--green)" : s.signal === "red" ? "var(--red)" : s.signal === "neutral" ? "var(--text-muted)" : "var(--yellow)";
      const sBg = s.signal === "green" ? "rgba(52,211,153,0.06)" : s.signal === "red" ? "rgba(248,113,113,0.06)" : "rgba(255,255,255,0.02)";
      return `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:12px;padding:10px 14px;border-radius:8px;background:${sBg};border:1px solid ${sc}22;">
          <div style="font-size:18px;">${s.icon}</div>
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <span style="font-size:12px;font-weight:700;color:var(--text-primary);">${escapeHtml(s.name)}</span>
              <span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${sc};font-weight:700;">${escapeHtml(s.value)}</span>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.4;">${escapeHtml(s.action)}</div>
          </div>
        </div>`;
    }).join("");

    html += `
      <div style="background:${vBg};border:1px solid ${vBorder};border-radius:var(--card-radius);padding:20px 24px;margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <span style="font-size:24px;color:${vc};">${verdictIcon}</span>
          <div>
            <div style="font-size:20px;font-weight:800;color:${vc};letter-spacing:-0.3px;">${escapeHtml(verdict.verdict)}</div>
            <div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(verdict.verdictAction)}</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${signalRows}
        </div>
        <div style="margin-top:12px;font-size:10px;color:var(--text-muted);text-align:right;">5-signal composite · Score: ${verdict.score} · Educational content only</div>
      </div>
    `;
  }

  // ── AI Market Digest (the morning briefing) ──
  if (digest) {
    const moodColor = digest.marketMood === "bullish" ? "var(--green)" : digest.marketMood === "bearish" ? "var(--red)" : "var(--yellow)";
    const moodBg = digest.marketMood === "bullish" ? "rgba(52,211,153,0.08)" : digest.marketMood === "bearish" ? "rgba(248,113,113,0.08)" : "rgba(251,191,36,0.08)";
    const moodBorder = digest.marketMood === "bullish" ? "rgba(52,211,153,0.25)" : digest.marketMood === "bearish" ? "rgba(248,113,113,0.25)" : "rgba(251,191,36,0.25)";
    const moodIcon = digest.marketMood === "bullish" ? "&#9650;" : digest.marketMood === "bearish" ? "&#9660;" : "&#9679;";
    const moodLabel = (digest.marketMood || "mixed").toUpperCase();

    html += `
      <div style="background:${moodBg};border:1px solid ${moodBorder};border-radius:var(--card-radius);padding:20px 24px;margin-bottom:24px;">
        <!-- Market Mood -->
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
          <span style="font-size:20px;color:${moodColor};">${moodIcon}</span>
          <span style="font-size:18px;font-weight:800;color:${moodColor};">${moodLabel}</span>
          <span style="font-size:14px;color:var(--text-secondary);margin-left:4px;">${escapeHtml(digest.moodSummary || "")}</span>
        </div>

        <!-- Key Takeaways -->
        ${digest.keyTakeaways && digest.keyTakeaways.length > 0 ? `
          <div style="margin-bottom:20px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:700;margin-bottom:10px;">Key Takeaways</div>
            <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;">
              ${digest.keyTakeaways.map((t) => `<li style="font-size:13px;color:var(--text-primary);line-height:1.6;">${escapeHtml(t)}</li>`).join("")}
            </ul>
          </div>
        ` : ""}

        <!-- Bullish / Bearish columns -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <!-- Top Bullish Headlines -->
          <div style="padding:14px 16px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.18);border-radius:10px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--green);font-weight:700;margin-bottom:10px;">&#9650; Top Bullish Headlines</div>
            ${digest.bullishDrivers && digest.bullishDrivers.length > 0
              ? `<ul style="margin:0;padding-left:16px;display:flex;flex-direction:column;gap:6px;">
                  ${digest.bullishDrivers.map((d) => `<li style="font-size:12px;color:var(--text-secondary);line-height:1.5;">${escapeHtml(d)}</li>`).join("")}
                </ul>`
              : `<div style="font-size:12px;color:var(--text-muted);">No clear bullish signals today.</div>`
            }
          </div>

          <!-- Top Bearish Headlines -->
          <div style="padding:14px 16px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.18);border-radius:10px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--red);font-weight:700;margin-bottom:10px;">&#9660; Top Bearish Headlines</div>
            ${digest.bearishRisks && digest.bearishRisks.length > 0
              ? `<ul style="margin:0;padding-left:16px;display:flex;flex-direction:column;gap:6px;">
                  ${digest.bearishRisks.map((d) => `<li style="font-size:12px;color:var(--text-secondary);line-height:1.5;">${escapeHtml(d)}</li>`).join("")}
                </ul>`
              : `<div style="font-size:12px;color:var(--text-muted);">No significant risks flagged.</div>`
            }
          </div>
        </div>

        <!-- Sectors to Watch -->
        ${digest.sectorsToWatch && digest.sectorsToWatch.length > 0 ? `
          <div style="margin-top:16px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:700;margin-bottom:8px;">Sectors to Watch</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${digest.sectorsToWatch.map((s) => `<span style="display:inline-block;padding:4px 10px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid var(--border);font-size:11px;color:var(--text-secondary);">${escapeHtml(s)}</span>`).join("")}
            </div>
          </div>
        ` : ""}

        <div style="margin-top:14px;font-size:10px;color:var(--text-muted);text-align:right;">Composite of headlines + sectors + FII/DII · Educational content only</div>
      </div>
    `;
  }

  // ── Sector heatmap (19 sectors, ranked by avgChange) ──
  html += renderSectorHeatmap(heatmap);

  container.innerHTML = html;
}

// ── Sector heatmap (19 sectors, ranked by avgChange) ──
function renderSectorHeatmap(heatmap) {
  if (!heatmap || !Array.isArray(heatmap.sectors) || heatmap.sectors.length === 0) {
    return `
      <div class="card" style="margin-bottom:24px;">
        <div class="card-title">Sector Heatmap</div>
        <div class="card-sub">Sector data unavailable. First fetch warms cache (~4s).</div>
      </div>`;
  }

  // Already sorted desc by avgChange server-side
  const rows = heatmap.sectors.map((s) => {
    const chg = Number(s.avgChange ?? 0);
    const intensity = Math.min(Math.abs(chg) / 2.5, 1); // cap at 2.5% for full intensity
    const bg = chg > 0
      ? `rgba(52,211,153,${0.05 + intensity * 0.18})`
      : chg < 0
        ? `rgba(248,113,113,${0.05 + intensity * 0.18})`
        : "rgba(255,255,255,0.02)";
    const chgColor = chg > 0 ? "var(--green)" : chg < 0 ? "var(--red)" : "var(--text-muted)";
    const arrow = chg > 0 ? "&#9650;" : chg < 0 ? "&#9660;" : "&#9679;";
    const tg = s.topGainer;
    const tl = s.topLoser;
    const tgChip = tg ? `<span style="font-size:10px;color:var(--green);">${escapeHtml(tg.symbol?.replace(".NS","") || "")} ${tg.change >= 0 ? "+" : ""}${Number(tg.change).toFixed(1)}%</span>` : "";
    const tlChip = tl ? `<span style="font-size:10px;color:var(--red);">${escapeHtml(tl.symbol?.replace(".NS","") || "")} ${Number(tl.change).toFixed(1)}%</span>` : "";

    return `
      <div style="display:grid;grid-template-columns:1.4fr auto auto 1fr 1fr;gap:12px;align-items:center;padding:10px 14px;border-radius:8px;background:${bg};border:1px solid var(--border);">
        <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${escapeHtml(s.sector || "Unknown")}</div>
        <div style="font-size:13px;font-weight:700;font-family:'JetBrains Mono',monospace;color:${chgColor};text-align:right;">${arrow} ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</div>
        <div style="font-size:10px;color:var(--text-muted);"><span style="color:var(--green);">${s.winners ?? 0}</span>/<span style="color:var(--red);">${s.losers ?? 0}</span></div>
        <div style="text-align:right;">${tgChip}</div>
        <div style="text-align:right;">${tlChip}</div>
      </div>`;
  }).join("");

  return `
    <div style="margin-bottom:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:700;">Sector Heatmap · ${heatmap.sectors.length} sectors · Nifty 100 universe</div>
        <div style="font-size:10px;color:var(--text-muted);">Sorted by avg % change</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${rows}
      </div>
    </div>
  `;
}

// ==================== HELPERS ====================

function formatNumber(num) {
  if (num === null || num === undefined) return "N/A";
  return Number(num).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format the NSE IX GIFT Nifty last-traded-time string.
 *
 * NSE IX returns IST strings like "21-Apr-2026 02:18:17". We shorten them
 * to "Last 02:18 IST" for today, and include the date for anything older
 * (e.g. "Last Apr 19 22:47 IST" on a Monday morning after a weekend gap).
 * GIFT Nifty runs two sessions with a 55-minute gap; outside those windows
 * the timestamp can legitimately be several hours old, and the user needs
 * to see that at a glance before reading the price move.
 *
 * Returns an empty string on any parse failure — the pill just renders
 * without the timestamp rather than breaking.
 */
function formatGiftNiftyLtt(raw) {
  if (!raw || typeof raw !== "string") return "";
  const m = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return "";
  const [, dd, mon, yyyy, hh, mm] = m;
  const now = new Date();
  const today = `${String(now.getDate()).padStart(2, "0")}`;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const isToday =
    Number(yyyy) === now.getFullYear() &&
    mon === months[now.getMonth()] &&
    dd.padStart(2, "0") === today;
  const timePart = `${hh.padStart(2, "0")}:${mm}`;
  return isToday
    ? `Last ${timePart} IST`
    : `Last ${mon} ${Number(dd)} ${timePart} IST`;
}

function formatVolume(vol) {
  if (!vol) return "N/A";
  if (vol >= 10000000) return (vol / 10000000).toFixed(2) + " Cr";
  if (vol >= 100000) return (vol / 100000).toFixed(2) + " L";
  if (vol >= 1000) return (vol / 1000).toFixed(1) + " K";
  return vol.toString();
}

function formatMarketCap(cap) {
  if (!cap) return "N/A";
  if (cap >= 10000000000000) return "&#8377;" + (cap / 10000000000000).toFixed(2) + " L Cr";
  if (cap >= 100000000000) return "&#8377;" + (cap / 100000000000).toFixed(2) + " K Cr";
  if (cap >= 10000000) return "&#8377;" + (cap / 10000000).toFixed(2) + " Cr";
  return "&#8377;" + formatNumber(cap);
}

function timeAgo(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-IN");
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function getRecClass(rec) {
  if (!rec) return "";
  const r = rec.toUpperCase();
  if (r === "STRONG BUY") return "rec-strong-buy";
  if (r === "BUY") return "rec-buy";
  if (r === "WEAK BUY") return "rec-weak-buy";
  if (r === "HOLD") return "rec-hold";
  if (r === "WEAK SELL") return "rec-weak-sell";
  if (r === "SELL") return "rec-sell";
  if (r === "STRONG SELL") return "rec-strong-sell";
  return "rec-hold";
}

function getRecColor(rec) {
  if (!rec) return "#64748b";
  const r = rec.toUpperCase();
  if (r.includes("STRONG BUY")) return "#10b981";
  if (r.includes("BUY")) return "#34d399";
  if (r === "HOLD") return "#f59e0b";
  if (r.includes("STRONG SELL")) return "#ef4444";
  if (r.includes("SELL")) return "#f87171";
  return "#94a3b8";
}

function getSignalBadgeClass(signal) {
  if (!signal) return "signal-neutral";
  const s = signal.toLowerCase();
  if (s.includes("strong buy")) return "signal-strong-buy";
  if (s.includes("buy") || s === "bullish" || s === "slightly bullish") return "signal-buy";
  if (s.includes("strong sell")) return "signal-strong-sell";
  if (s.includes("sell") || s === "bearish" || s === "slightly bearish") return "signal-sell";
  return "signal-neutral";
}

function rsiColor(rsi) {
  const val = parseFloat(rsi);
  if (isNaN(val)) return "";
  if (val < 30) return "positive";
  if (val > 70) return "negative";
  return "";
}

function rsiLabel(rsi) {
  const val = parseFloat(rsi);
  if (isNaN(val)) return "N/A";
  if (val < 25) return "Heavily Oversold";
  if (val < 30) return "Oversold";
  if (val < 40) return "Approaching Oversold";
  if (val > 80) return "Heavily Overbought";
  if (val > 70) return "Overbought";
  if (val > 60) return "Approaching Overbought";
  return "Normal Range";
}

// ==================== TRACK RECORD (PAPER-TRADE TRACKER) ====================

const TRACK_TYPE_LABELS = {
  // SWS picks — primary source of truth, snapshotted on every pipeline run
  sws_top30_v3: "SWS · Top 30 (v3)",
  sws_best_buynow: "SWS · Best to Buy Now",
  sws_deep_value: "SWS · Deep Value",
  sws_quality_growth: "SWS · Quality Growth",
  sws_midterm: "SWS · Mid-term",
  sws_dividend_aristocrats: "SWS · Dividend Aristocrats",
  sws_smallcap_gems: "SWS · Small-Cap Gems",
  sws_insider_buying: "SWS · Insider Buying",
  sws_upcoming_earnings: "SWS · Upcoming Earnings",
  sws_avoid: "SWS · Avoid (sell signal)",
  // Legacy scanners — preserved for historical continuity
  buynow_nifty100: "Buy Now (Nifty 100)",
  smallcap_buynow: "Small-Cap Buy Now",
  fundamental_deep_value: "Fundamental Deep Value",
};

// Types whose semantics invert "beats Nifty" — a win means the pick
// under-performed the index, as we predicted.
const TRACK_SHORT_TYPES = new Set(["sws_avoid"]);

// PR T5 — Track Record hero state. Misses-shown defaults ON per locked
// decision (hiding losers destroys trust); we still persist user toggles
// across reloads via localStorage, but the absence of a stored value or a
// parse failure reverts to ON. Sticky-ON contract.
const TRACK_MISSES_KEY = "starbhai_missesShown";
function getMissesShown() {
  try {
    const raw = localStorage.getItem(TRACK_MISSES_KEY);
    if (raw == null) return true; // default ON
    return raw !== "off";
  } catch {
    return true; // localStorage disabled (private browsing) → in-memory ON
  }
}
function setMissesShown(on) {
  try { localStorage.setItem(TRACK_MISSES_KEY, on ? "on" : "off"); } catch {}
}
// Latest trades array captured by loadTrackRecord so the toggle can
// re-render the history table without re-fetching.
let _trackLastTrades = null;
// PR B8 will populate this when the backtest endpoint ships; for now the
// hero shows "—" with a backfilling sub-line.
let _trackLastBrier = null;

window.onTrackMissesShownToggle = function onTrackMissesShownToggle(on) {
  setMissesShown(!!on);
  const lbl = document.getElementById("trackMissesShownLabel");
  if (lbl) lbl.textContent = on ? "Shown" : "Hidden";
  const tableEl = document.getElementById("trackHistoryTable");
  if (tableEl && Array.isArray(_trackLastTrades)) {
    tableEl.innerHTML = renderTrackHistoryTable(_trackLastTrades);
  }
};

function populateTrackHero(perf, data) {
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  const setHtml = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

  // Hit Rate — perf.winRate is already a %. Color it via the verdict
  // palette so the eye lands on it first.
  if (perf.winRate != null) {
    const sc = signedColorFor(perf.winRate - 50);
    setHtml("trackHitRateValue",
      `<span style="color:${perf.winRate >= 50 ? "var(--positive)" : "var(--negative)"};">${perf.winRate}%</span>`);
    setText("trackHitRateSub", `n = ${perf.total || 0} picks`);
  } else {
    setText("trackHitRateValue", "—");
    setText("trackHitRateSub", "no picks yet");
  }

  // Avg α — fall back to avgReturn when the explicit alpha field is absent.
  const alpha = (perf.avgAlpha != null) ? perf.avgAlpha : perf.avgReturn;
  if (alpha != null && Number.isFinite(alpha)) {
    const sc = signedColorFor(alpha);
    setHtml("trackAvgAlphaValue",
      `<span style="color:${sc.color};" aria-label="${sc.srLabel}"><span aria-hidden="true">${sc.glyph}</span> ${alpha >= 0 ? "+" : ""}${alpha.toFixed(2)}%</span>`);
  } else {
    setText("trackAvgAlphaValue", "—");
  }

  // % Beat Nifty — paint above-55 green, below-45 red, otherwise warn.
  if (perf.beatsNiftyRate != null && Number.isFinite(perf.beatsNiftyRate)) {
    const colour = perf.beatsNiftyRate >= 55 ? "var(--positive)" :
                   perf.beatsNiftyRate >= 45 ? "var(--warn)" :
                   "var(--negative)";
    setHtml("trackBeatNiftyValue", `<span style="color:${colour};">${perf.beatsNiftyRate}%</span>`);
    // Wilson-style CI matches the maturity-warning logic at line 3337.
    if (perf.total > 5) {
      const p = perf.beatsNiftyRate / 100;
      const n = perf.benchmarkSampleSize || perf.total;
      const se = Math.sqrt(p * (1 - p) / n);
      const lo = Math.max(0, (p - 1.96 * se) * 100).toFixed(0);
      const hi = Math.min(100, (p + 1.96 * se) * 100).toFixed(0);
      setText("trackBeatNiftySub", `CI ${lo}–${hi}%`);
    } else {
      setText("trackBeatNiftySub", "thin sample");
    }
  } else {
    setText("trackBeatNiftyValue", "—");
    setText("trackBeatNiftySub", "—");
  }

  // Brier — populated by PR B8 when the backtest endpoint ships. Honest
  // empty state until then.
  if (_trackLastBrier != null && Number.isFinite(_trackLastBrier)) {
    const sub = _trackLastBrier <= 0.18 ? "target ≤ 0.18" : `closing on 0.18`;
    setText("trackBrierValue", _trackLastBrier.toFixed(3));
    setText("trackBrierSub", sub);
  } else {
    setText("trackBrierValue", "—");
    setText("trackBrierSub", "backfilling — PR B8");
  }

  // Subline below the hero strip — honest sample size + oldest snapshot.
  const oldestSnap = (Array.isArray(data.trades) && data.trades.length)
    ? data.trades[data.trades.length - 1]?.snapshotAt
    : null;
  const ageDays = oldestSnap
    ? Math.floor((Date.now() - new Date(oldestSnap).getTime()) / 86400000)
    : null;
  const subBits = [];
  if (perf.total != null) subBits.push(`${perf.total} pick${perf.total === 1 ? "" : "s"}`);
  if (ageDays != null) subBits.push(`${ageDays} day${ageDays === 1 ? "" : "s"} of history`);
  if (perf.total != null && perf.total < 100) subBits.push("Early data — need ~100 picks for statistical significance");
  setText("trackHeroSubline", subBits.join(" · "));
}

// PR T7 — calibration plot. 5-bucket SVG bar grid, no chart library;
// rendered below the Track Record hero. Thin buckets (n < 30) paint
// greyed with a "thin data" badge so the UI never implies confidence in
// a 4-sample bucket.
async function loadTrackCalibration() {
  const wrap = document.getElementById("trackCalibrationSvgWrap");
  if (!wrap) return;
  try {
    const res = await fetch("/api/track/calibration");
    if (!res.ok) {
      wrap.innerHTML = `<div class="tx-meta">Calibration unavailable.</div>`;
      return;
    }
    const data = await res.json();
    wrap.innerHTML = renderCalibrationSvg(data);
    const sub = document.getElementById("trackCalibrationSub");
    if (sub) {
      sub.textContent = data.resolved && data.resolved > 0
        ? `${data.resolved} of ${data.total || data.resolved} forecasts bucketed by predicted confidence`
        : "No resolved forecasts yet — chart fills in as snapshots mature";
    }
  } catch (e) {
    wrap.innerHTML = `<div class="tx-meta" style="color: var(--negative);">Calibration error: ${escapeHtml(e && e.message || "unknown")}</div>`;
  }
}

function renderCalibrationSvg(data) {
  const buckets = (data && Array.isArray(data.buckets)) ? data.buckets : [];
  if (buckets.length === 0) {
    return `<div class="tx-meta" style="padding:20px 0;">No buckets to plot yet.</div>`;
  }
  // SVG geometry — 600 × 260 viewBox, scales fluidly. Plot area inset for
  // axis labels: left=42, right=12, top=12, bottom=42.
  const W = 600, H = 260;
  const padL = 42, padR = 12, padT = 12, padB = 42;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xFor = (pct) => padL + (pct / 100) * innerW;
  const yFor = (pct) => padT + (1 - pct / 100) * innerH;
  // Reference 45° diagonal — perfect-calibration line.
  const diag = `M${xFor(0)},${yFor(0)} L${xFor(100)},${yFor(100)}`;
  const bars = buckets.map((b) => {
    const x = xFor(b.bucket_low);
    const width = xFor(b.bucket_high) - x;
    if (b.realised_pct == null) {
      // Empty bucket — placeholder marker only.
      return `<g><rect x="${x.toFixed(2)}" y="${yFor(0).toFixed(2)}" width="${width.toFixed(2)}" height="0" /></g>`;
    }
    const y = yFor(b.realised_pct);
    const height = yFor(0) - y;
    const fill = b.thin ? "rgba(237,237,237,0.18)" : "var(--positive)";
    const stroke = b.thin ? "rgba(237,237,237,0.35)" : "var(--positive-strong)";
    const ciTop = yFor(b.ci_hi_pct);
    const ciBot = yFor(b.ci_lo_pct);
    const ciCx = x + width / 2;
    const title = `predicted ${b.bucket_low}–${b.bucket_high}% · realised ${b.realised_pct.toFixed(1)}% · n=${b.n} · CI ${b.ci_lo_pct.toFixed(0)}–${b.ci_hi_pct.toFixed(0)}%${b.thin ? " · thin data (n<30)" : ""}`;
    return `
      <g aria-label="${title}">
        <title>${title}</title>
        <rect x="${(x + 4).toFixed(2)}" y="${y.toFixed(2)}" width="${(width - 8).toFixed(2)}" height="${height.toFixed(2)}"
              fill="${fill}" stroke="${stroke}" stroke-width="1" rx="3" />
        <line x1="${ciCx.toFixed(2)}" y1="${ciTop.toFixed(2)}" x2="${ciCx.toFixed(2)}" y2="${ciBot.toFixed(2)}"
              stroke="${b.thin ? "rgba(237,237,237,0.4)" : "var(--gold)"}" stroke-width="2" />
        <text x="${ciCx.toFixed(2)}" y="${(y - 4).toFixed(2)}" text-anchor="middle"
              style="font-family: var(--font-mono); font-size: 11px; fill: var(--text-secondary);">
          ${b.realised_pct.toFixed(0)}${b.thin ? "·" : ""}
        </text>
        <text x="${ciCx.toFixed(2)}" y="${(yFor(0) + 14).toFixed(2)}" text-anchor="middle"
              style="font-family: var(--font-mono); font-size: 10px; fill: var(--text-muted);">
          n=${b.n}
        </text>
      </g>`;
  }).join("");
  // Axis ticks (0/25/50/75/100 %)
  const ticks = [0, 25, 50, 75, 100];
  const yTicks = ticks.map((t) => `
    <line x1="${padL}" y1="${yFor(t)}" x2="${W - padR}" y2="${yFor(t)}" stroke="rgba(255,255,255,0.04)" />
    <text x="${padL - 6}" y="${(yFor(t) + 3).toFixed(2)}" text-anchor="end"
          style="font-family: var(--font-mono); font-size: 10px; fill: var(--text-muted);">${t}%</text>`).join("");
  const xTicks = ticks.map((t) => `
    <text x="${xFor(t).toFixed(2)}" y="${(H - 6).toFixed(2)}" text-anchor="middle"
          style="font-family: var(--font-mono); font-size: 10px; fill: var(--text-muted);">${t}%</text>`).join("");
  return `
    <svg id="trackCalibrationSvg" viewBox="0 0 ${W} ${H}" width="100%"
         style="display:block; max-width: 720px; height: auto;" role="img" aria-label="Calibration plot — predicted confidence vs realised hit-rate, 5 buckets">
      ${yTicks}
      <path d="${diag}" stroke="var(--text-muted)" stroke-dasharray="4 4" stroke-width="1" fill="none" />
      ${bars}
      ${xTicks}
      <text x="${(W / 2).toFixed(2)}" y="${(H - padB / 2 + 18).toFixed(2)}" text-anchor="middle"
            style="font-family: var(--font-sans); font-size: 11px; fill: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em;">
        Predicted confidence bucket
      </text>
      <text transform="translate(14 ${(H / 2).toFixed(2)}) rotate(-90)" text-anchor="middle"
            style="font-family: var(--font-sans); font-size: 11px; fill: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em;">
        Realised hit-rate
      </text>
    </svg>`;
}

async function loadTrackRecord(forceBust = false) {
  const filterEl = document.getElementById("trackFilter");
  const filterType = filterEl?.value && filterEl.value !== "all" ? filterEl.value : null;
  const url = `/api/track/history${filterType ? "?type=" + filterType : ""}${forceBust ? (filterType ? "&" : "?") + "bust=1" : ""}`;

  const tableEl = document.getElementById("trackHistoryTable");
  const updatedEl = document.getElementById("trackLastUpdated");

  // V2 — kick off the per-section scorecard fetch in parallel. It paints
  // independently of the headline metrics and trade list.
  loadTrackSections(forceBust);
  // PR T7 — calibration plot fetches in parallel; renders below the hero.
  loadTrackCalibration();
  // PR B8 — admin-only backtest card. Client-side gates the mount: if the
  // user is admin we call the loader (which itself bails on 403 just in
  // case); non-admin Track Record renders without the card entirely.
  if (window.__starbhai_isAdmin && typeof loadEarningsBacktestCard === "function") {
    loadEarningsBacktestCard("trackEarningsBacktestHost");
  } else {
    const host = document.getElementById("trackEarningsBacktestHost");
    if (host) host.innerHTML = "";
  }

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.message && (!data.trades || data.trades.length === 0)) {
      // Empty state — no snapshots yet
      document.getElementById("trackTotalPicks").textContent = "0";
      document.getElementById("trackWinRate").textContent = "—";
      document.getElementById("trackAvgReturn").textContent = "—";
      document.getElementById("trackBeatsNifty").textContent = "—";
      // PR T5 — new hero tiles in empty state
      const setHero = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
      setHero("trackHitRateValue", "—");
      setHero("trackAvgAlphaValue", "—");
      setHero("trackBeatNiftyValue", "—");
      setHero("trackBrierValue", "—");
      setHero("trackHeroSubline", data.message || "No picks recorded yet.");
      document.getElementById("trackHistoryCount").textContent = "0 PICKS";
      document.getElementById("trackByTypeSection").innerHTML = "";
      document.getElementById("trackByRegimeSection").innerHTML = "";
      tableEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#128202;</div>
          <div class="empty-text">${escapeHtml(data.message)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
            Snapshots are captured automatically when the SWS Picks pipeline runs.
          </div>
        </div>`;
      return;
    }

    // Headline metrics — legacy (hidden) IDs stay populated for downstream
    // hooks (signal-maturity banner reads trackTotalPicks).
    const perf = data.performance || {};
    document.getElementById("trackTotalPicks").textContent = perf.total ?? 0;
    document.getElementById("trackWinRate").innerHTML = perf.winRate != null
      ? `<span style="color:${perf.winRate >= 50 ? '#22c55e' : '#ef4444'};">${perf.winRate}%</span>`
      : "—";
    document.getElementById("trackAvgReturn").innerHTML = perf.avgReturn != null
      ? `<span class="${perf.avgReturn >= 0 ? 'positive' : 'negative'}">${perf.avgReturn >= 0 ? '+' : ''}${perf.avgReturn}%</span>`
      : "—";
    document.getElementById("trackBeatsNifty").innerHTML = perf.beatsNiftyRate != null
      ? `<span style="color:${perf.beatsNiftyRate >= 55 ? '#22c55e' : perf.beatsNiftyRate >= 45 ? '#eab308' : '#ef4444'};">${perf.beatsNiftyRate}%</span>`
      : "—";

    // PR T5 — new hero tile values. signedColorFor on alpha/beat-Nifty so
    // the visual weight scales with magnitude rather than shouting at 0.1 %.
    populateTrackHero(perf, data);

    document.getElementById("trackHistoryCount").textContent =
      `${data.totalCount} PICK${data.totalCount === 1 ? "" : "S"}`;

    // Signal maturity warning — shown when track record is too young for trust
    const maturityDiv = document.getElementById("trackMaturityWarning");
    if (maturityDiv) {
      if (perf.total < 100) {
        const betaBadge = perf.total < 50 ? '<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:rgba(251,191,36,0.15);color:var(--gold);font-size:10px;font-weight:800;margin-left:8px;">BETA</span>' : '';
        // Compute 95% confidence interval for beats-Nifty
        let ciText = "";
        if (perf.beatsNiftyRate != null && perf.total > 5) {
          const p = perf.beatsNiftyRate / 100;
          const n = perf.benchmarkSampleSize || perf.total;
          const se = Math.sqrt(p * (1 - p) / n);
          const lo = Math.max(0, (p - 1.96 * se) * 100).toFixed(0);
          const hi = Math.min(100, (p + 1.96 * se) * 100).toFixed(0);
          ciText = ` 95% confidence interval: ${lo}%–${hi}%.`;
        }
        maturityDiv.innerHTML = `
          <div style="padding:14px 16px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:10px;margin-bottom:20px;font-size:13px;color:var(--text-secondary);line-height:1.6;">
            <strong style="color:var(--gold);">Early Data${betaBadge}</strong><br>
            Only ${perf.total} picks recorded. Need ~100 for statistical significance — current metrics may shift substantially as more data accumulates.${ciText}
          </div>`;
        maturityDiv.style.display = "block";
      } else {
        maturityDiv.style.display = "none";
      }
    }

    // Per-type breakdown
    document.getElementById("trackByTypeSection").innerHTML = renderTrackBreakdown(
      data.byType,
      "Performance by Pick Type",
      "How each scanner is doing on its own merits",
      TRACK_TYPE_LABELS
    );

    // Per-regime breakdown — only show when more than 1 regime captured
    const regimeKeys = Object.keys(data.byRegime || {});
    if (regimeKeys.length > 1) {
      document.getElementById("trackByRegimeSection").innerHTML = renderTrackBreakdown(
        data.byRegime,
        "Performance by Macro Regime",
        "Did the regime tilts actually predict sector outperformance?"
      );
    } else {
      document.getElementById("trackByRegimeSection").innerHTML = "";
    }

    // Trade history table — cache trades so the misses-shown toggle can
    // re-render without re-fetching, then render once for the initial state.
    _trackLastTrades = data.trades;
    tableEl.innerHTML = renderTrackHistoryTable(data.trades);

    // Phase 8D: Portfolio vs Nifty line chart (uses full trade set
    // regardless of misses toggle — chart is the integrity record).
    renderTrackChart(data.trades);

    if (updatedEl && data.lastComputedAt) {
      updatedEl.textContent = `Updated: ${new Date(data.lastComputedAt).toLocaleTimeString("en-IN")}`;
    }

    // Subtitle with snapshot age
    const oldestEl = document.getElementById("trackOldestSnapshot");
    if (oldestEl && data.trades && data.trades.length > 0) {
      const oldest = data.trades[data.trades.length - 1];
      if (oldest?.snapshotAt) {
        const days = Math.floor((Date.now() - new Date(oldest.snapshotAt).getTime()) / 86400000);
        oldestEl.textContent = ` · ${days} day${days === 1 ? "" : "s"} of history`;
      }
    }
  } catch (err) {
    tableEl.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><div class="empty-text">Failed to load track record: ${escapeHtml(err.message)}</div></div>`;
  }
}

/**
 * Phase 8D: Render Portfolio vs Nifty forward-return line chart.
 *
 * Each trade has a forward return (snapshot price → today's price) and
 * a reference Nifty return over the same window. We bucket trades by
 * their snapshot month and plot the monthly average for each series.
 *
 * This gives a clear read of "picks from month X beat Nifty by Y pp"
 * across the deployment history — the single most persuasive visual
 * of whether the engine is earning its keep.
 *
 * Requires ≥ 2 distinct snapshot months to render — single-month data
 * shows as an empty-state message.
 */
function renderTrackChart(trades) {
  const section = document.getElementById("trackChartSection");
  const container = document.getElementById("trackChartContainer");
  if (!section || !container) return;

  if (!Array.isArray(trades) || trades.length === 0) {
    section.style.display = "none";
    return;
  }

  // Bucket by YYYY-MM of snapshotAt
  const buckets = new Map();
  for (const t of trades) {
    if (!t.snapshotAt || !t.returns) continue;
    // Backend uses returnPct / niftyReturnPct (from server's computeReturns)
    const pr = t.returns.returnPct;
    const nr = t.returns.niftyReturnPct;
    if (pr == null) continue;
    const key = new Date(t.snapshotAt).toISOString().slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, { picks: [], nifty: [], count: 0 });
    const b = buckets.get(key);
    b.picks.push(pr);
    if (nr != null) b.nifty.push(nr);
    b.count++;
  }

  const months = [...buckets.keys()].sort();
  if (months.length < 2) {
    section.style.display = "block";
    container.innerHTML = `
      <div class="track-chart-empty">
        Chart appears once picks span two or more months. Currently have data for
        ${months.length} month${months.length === 1 ? "" : "s"}.
      </div>`;
    return;
  }

  const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const pickSeries = months.map((m) => avg(buckets.get(m).picks));
  const niftySeries = months.map((m) => avg(buckets.get(m).nifty));
  const countSeries = months.map((m) => buckets.get(m).count);

  // SVG layout
  const W = 980, H = 320;
  const PAD = { top: 24, right: 24, bottom: 48, left: 56 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Y-axis range
  const allVals = [...pickSeries, ...niftySeries];
  const rawMin = Math.min(...allVals);
  const rawMax = Math.max(...allVals);
  const pad = Math.max(Math.abs(rawMax - rawMin) * 0.12, 2);
  const yMin = Math.floor((rawMin - pad) / 5) * 5;
  const yMax = Math.ceil((rawMax + pad) / 5) * 5;
  const yRange = yMax - yMin || 10;

  // Scales
  const xAt = (i) => PAD.left + (months.length === 1 ? plotW / 2 : (i / (months.length - 1)) * plotW);
  const yAt = (v) => PAD.top + plotH - ((v - yMin) / yRange) * plotH;
  const zeroY = yAt(0);

  // Tick values — 5 gridlines
  const tickCount = 5;
  const ticks = [];
  for (let i = 0; i <= tickCount; i++) {
    const v = yMin + (yRange * i) / tickCount;
    ticks.push(v);
  }

  // Path strings
  const pickPath = pickSeries.map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(" ");
  const niftyPath = niftySeries.map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(" ");

  // Gold (picks) vs Muted gray (Nifty)
  const colorPicks = "#E0B060";
  const colorNifty = "rgba(237, 237, 237, 0.45)";

  // Month labels — show every Nth to avoid overlap
  const labelEvery = Math.max(1, Math.ceil(months.length / 8));
  const monthLabels = months.map((m, i) => {
    if (i !== 0 && i !== months.length - 1 && i % labelEvery !== 0) return "";
    const d = new Date(m + "-01");
    return d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
  });

  // Headline: is the engine beating Nifty?
  const cumPick = pickSeries.reduce((s, v) => s + v, 0) / pickSeries.length;
  const cumNifty = niftySeries.reduce((s, v) => s + v, 0) / Math.max(niftySeries.length, 1);
  const edge = cumPick - cumNifty;
  const edgeLabel = `${edge >= 0 ? "+" : ""}${edge.toFixed(1)} pp avg edge vs Nifty`;
  const edgeColor = edge >= 0 ? "var(--green)" : "var(--red)";

  // Build SVG
  const gridLines = ticks.map((v) => {
    const y = yAt(v);
    const isZero = Math.abs(v) < 0.001;
    return `
      <line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}"
        stroke="${isZero ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)'}"
        stroke-width="${isZero ? 1 : 1}" stroke-dasharray="${isZero ? '0' : '2 3'}" />
      <text x="${PAD.left - 10}" y="${y + 4}" text-anchor="end">${v >= 0 ? "+" : ""}${v.toFixed(0)}%</text>`;
  }).join("");

  const xTicks = monthLabels.map((label, i) => {
    if (!label) return "";
    const x = xAt(i);
    return `<text x="${x}" y="${H - PAD.bottom + 18}" text-anchor="middle">${label}</text>`;
  }).join("");

  // Data points
  const pickDots = pickSeries.map((v, i) => `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="3.5" fill="${colorPicks}" />`).join("");
  const niftyDots = niftySeries.map((v, i) => `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="2.5" fill="${colorNifty}" />`).join("");

  section.style.display = "block";
  container.innerHTML = `
    <div class="track-chart-wrap">
      <div class="track-chart-legend">
        <span class="track-chart-legend-item">
          <span class="track-chart-legend-swatch" style="background:${colorPicks};"></span>
          Portfolio (avg forward return)
        </span>
        <span class="track-chart-legend-item">
          <span class="track-chart-legend-swatch" style="background:${colorNifty};"></span>
          Nifty 50 (same window)
        </span>
        <span class="track-chart-legend-item" style="margin-left:auto;color:${edgeColor};font-weight:500;">
          ${edgeLabel}
        </span>
      </div>
      <svg class="track-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Portfolio vs Nifty forward returns by pick month">
        ${gridLines}
        ${xTicks}
        <path d="${niftyPath}" fill="none" stroke="${colorNifty}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
        <path d="${pickPath}" fill="none" stroke="${colorPicks}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${niftyDots}
        ${pickDots}
      </svg>
      <div class="track-chart-note">
        Each dot = one month of snapshots. The gold line is the average forward return of all picks from that month;
        the faint line is Nifty 50 over the identical window. ${months.length} month${months.length === 1 ? "" : "s"} of data ·
        ${trades.length} pick${trades.length === 1 ? "" : "s"} · oldest ${months[0]}.
      </div>
    </div>
  `;
}

function renderTrackBreakdown(groupMap, title, subtitle, labelMap = null) {
  if (!groupMap || Object.keys(groupMap).length === 0) return "";
  const rows = Object.entries(groupMap)
    .filter(([_, perf]) => perf.total > 0)
    .sort(([, a], [, b]) => (b.beatsNiftyRate ?? 0) - (a.beatsNiftyRate ?? 0))
    .map(([key, perf]) => {
      const label = labelMap?.[key] || key;
      const isShort = TRACK_SHORT_TYPES.has(key);
      // For short types, "win" means avg return is NEGATIVE — flip the colour
      const winColor = perf.winRate >= 55 ? "#22c55e" : perf.winRate >= 45 ? "#eab308" : "#ef4444";
      const beatsColor = perf.beatsNiftyRate == null
        ? "var(--text-muted)"
        : perf.beatsNiftyRate >= 55 ? "#22c55e"
        : perf.beatsNiftyRate >= 45 ? "#eab308" : "#ef4444";
      const avgColor = isShort
        ? (perf.avgReturn <= 0 ? "#22c55e" : "#ef4444")
        : (perf.avgReturn >= 0 ? "#22c55e" : "#ef4444");
      const shortBadge = isShort
        ? `<span title="Sell signal — win = pick under-performed Nifty 50" style="display:inline-block;margin-left:8px;padding:1px 6px;border-radius:4px;background:rgba(239,68,68,0.15);color:#fca5a5;font-size:9px;font-weight:800;letter-spacing:0.4px;">SELL SIGNAL</span>`
        : "";
      return `
        <div style="display:grid;grid-template-columns:1fr auto auto auto auto;gap:14px;align-items:center;padding:10px 14px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);font-size:12px;">
          <div style="font-weight:700;">${escapeHtml(label)}${shortBadge}</div>
          <div style="font-family:'JetBrains Mono',monospace;color:var(--text-muted);">n=${perf.total}</div>
          <div style="font-family:'JetBrains Mono',monospace;color:${winColor};font-weight:700;min-width:60px;text-align:right;">Win ${perf.winRate}%</div>
          <div style="font-family:'JetBrains Mono',monospace;color:${avgColor};font-weight:700;min-width:80px;text-align:right;">${perf.avgReturn >= 0 ? '+' : ''}${perf.avgReturn}%</div>
          <div style="font-family:'JetBrains Mono',monospace;color:${beatsColor};font-weight:700;min-width:90px;text-align:right;">${perf.beatsNiftyRate != null ? perf.beatsNiftyRate + '% α' : '—'}</div>
        </div>`;
    }).join("");
  return `
    <div style="padding:18px 20px;background:rgba(0,0,0,0.2);border:1px solid var(--border);border-radius:12px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-muted);font-weight:700;margin-bottom:4px;">${escapeHtml(title)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:14px;">${escapeHtml(subtitle)}</div>
      <div style="display:flex;flex-direction:column;gap:6px;">${rows}</div>
    </div>`;
}

function renderTrackHistoryTable(trades) {
  if (!trades || trades.length === 0) {
    return `<div class="empty-state"><div class="empty-icon">&#128202;</div><div class="empty-text">No picks recorded yet for this filter.</div></div>`;
  }

  // PR T5 — misses-shown toggle. Default ON (sticky-ON) per locked decision.
  // When OFF, hide negative-return trades; the integrity-graded chart at
  // renderTrackChart still uses the full set so visual hiding here can't
  // mask the actual track record. A small inline note tells the reader.
  const showMisses = (typeof getMissesShown === "function") ? getMissesShown() : true;
  const totalCount = trades.length;
  const visible = showMisses
    ? trades
    : trades.filter((t) => {
        const r = t.returns || {};
        return !(r.returnPct != null && r.returnPct < 0);
      });
  const hiddenCount = totalCount - visible.length;
  const hiddenBanner = (!showMisses && hiddenCount > 0)
    ? `<div class="tx-meta" style="padding: 10px 14px; margin-bottom: 10px; background: rgba(224,176,96,0.08); border: 1px solid rgba(224,176,96,0.25); border-radius: var(--radius-200);">
        ${hiddenCount} losing pick${hiddenCount === 1 ? "" : "s"} hidden via the Misses toggle. <a href="#" onclick="event.preventDefault(); document.getElementById('trackMissesShownToggle').click();" style="color: var(--gold);">Show them</a> for the full record.
      </div>`
    : "";

  if (visible.length === 0) {
    return hiddenBanner + `<div class="empty-state"><div class="empty-icon">&#128202;</div><div class="empty-text">No picks visible under the current filters.</div></div>`;
  }

  const rows = visible.map((t) => {
    const r = t.returns || {};
    const isPos = r.returnPct != null && r.returnPct >= 0;
    const beatsClass = r.beatsNifty === true ? "positive" : r.beatsNifty === false ? "negative" : "";
    const beatsLabel = r.alpha == null ? "—" : (r.alpha >= 0 ? "+" : "") + r.alpha + "% α";
    const macroBadge = t.macroBoostAtSnapshot && Math.abs(t.macroBoostAtSnapshot) >= 0.5
      ? `<span class="macro-boost-badge ${t.macroBoostAtSnapshot > 0 ? 'pos' : 'neg'}" style="margin-left:0;">${t.macroBoostAtSnapshot > 0 ? '+' : ''}${t.macroBoostAtSnapshot.toFixed(1)} macro</span>`
      : "";
    const errorBadge = r.error
      ? `<span style="color:var(--text-muted);font-size:10px;">no live price</span>`
      : "";
    return `
      <div onclick="openStockDetailModal('${t.symbol.replace('.NS', '')}','analyzer')" style="display:grid;grid-template-columns:1fr 100px 90px 90px 90px 90px 70px;gap:12px;align-items:center;padding:10px 14px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);font-size:12px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.06)';" onmouseout="this.style.background='rgba(255,255,255,0.02)';">
        <div style="min-width:0;">
          <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.name || t.symbol)}</div>
          <div style="font-size:10px;color:var(--text-muted);font-family:'JetBrains Mono',monospace;">${t.symbol} ${t.sector ? '· ' + escapeHtml(t.sector.slice(0, 18)) : ''} ${macroBadge}</div>
        </div>
        <div style="font-size:10px;color:var(--text-muted);">
          <div style="font-weight:700;color:var(--text-secondary);">${escapeHtml(TRACK_TYPE_LABELS[t.type] || t.type)}</div>
          <div>${(t.regimeAtSnapshot || 'CALM').replace(/_/g, ' ').toLowerCase()}</div>
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:right;">
          <div style="color:var(--text-muted);">snap</div>
          <div>₹${formatNumber(t.priceAtSnapshot)}</div>
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:right;">
          <div style="color:var(--text-muted);">now</div>
          <div>${r.currentPrice ? '₹' + formatNumber(r.currentPrice) : errorBadge}</div>
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:800;text-align:right;" class="${isPos ? 'positive' : 'negative'}">
          ${r.returnPct != null ? (isPos ? '+' : '') + r.returnPct + '%' : '—'}
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;text-align:right;font-weight:700;" class="${beatsClass}">
          ${beatsLabel}
        </div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-muted);text-align:right;">
          ${r.daysHeld != null ? r.daysHeld + 'd' : '—'}
        </div>
      </div>`;
  }).join("");

  return hiddenBanner + `
    <div style="display:grid;grid-template-columns:1fr 100px 90px 90px 90px 90px 70px;gap:12px;padding:8px 14px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:700;">
      <div>Stock</div>
      <div>Type / Regime</div>
      <div style="text-align:right;">Snap Price</div>
      <div style="text-align:right;">Current</div>
      <div style="text-align:right;">Return</div>
      <div style="text-align:right;">vs Nifty</div>
      <div style="text-align:right;">Held</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:4px;">${rows}</div>`;
}

// ==================== STOCK VERDICT CARD ====================

function renderStockVerdictCard(sv) {
  if (!sv || !sv.signals) return "";

  const vc = sv.verdictColor === "green" ? "var(--green)" : sv.verdictColor === "red" ? "var(--red)" : "var(--yellow)";
  const vBg = sv.verdictColor === "green" ? "rgba(52,211,153,0.08)" : sv.verdictColor === "red" ? "rgba(248,113,113,0.08)" : "rgba(251,191,36,0.08)";
  const vBorder = sv.verdictColor === "green" ? "rgba(52,211,153,0.25)" : sv.verdictColor === "red" ? "rgba(248,113,113,0.25)" : "rgba(251,191,36,0.25)";
  const verdictIcon = sv.verdictColor === "green" ? "&#9650;" : sv.verdictColor === "red" ? "&#9660;" : "&#9679;";

  const signalRows = sv.signals.map((s) => {
    const sc = s.signal === "green" ? "var(--green)" : s.signal === "red" ? "var(--red)" : s.signal === "neutral" ? "var(--text-muted)" : "var(--yellow)";
    return `
      <div style="display:grid;grid-template-columns:24px 1fr auto;gap:10px;align-items:center;padding:6px 10px;border-radius:6px;background:rgba(255,255,255,0.02);">
        <span style="font-size:16px;">${s.icon}</span>
        <div>
          <span style="font-size:11px;font-weight:700;color:var(--text-primary);">${escapeHtml(s.name)}</span>
          <span style="font-size:11px;color:var(--text-muted);margin-left:6px;">${escapeHtml(s.action).slice(0, 65)}</span>
        </div>
        <span style="font-size:11px;font-family:'JetBrains Mono',monospace;color:${sc};font-weight:700;white-space:nowrap;">${escapeHtml(s.value)}</span>
      </div>`;
  }).join("");

  // Unique ID for this accordion instance
  const accordionId = "stockVerdictBody_" + Date.now();

  return `
    <div style="margin-top:16px;background:${vBg};border:1px solid ${vBorder};border-radius:10px;overflow:hidden;">
      <div onclick="(function(el){ var body=document.getElementById('${accordionId}'); var chev=el.querySelector('.sv-chevron'); if(body.style.maxHeight==='0px'){body.style.maxHeight='500px';body.style.opacity='1';body.style.padding='0 18px 14px';chev.textContent='▼';}else{body.style.maxHeight='0px';body.style.opacity='0';body.style.padding='0 18px';chev.textContent='▶';} })(this)" style="display:flex;align-items:center;gap:10px;padding:14px 18px;cursor:pointer;user-select:none;" title="Click to expand/collapse">
        <span style="font-size:18px;color:${vc};">${verdictIcon}</span>
        <span style="font-size:15px;font-weight:800;color:${vc};flex:1;">Today's Verdict: ${escapeHtml(sv.verdict)}</span>
        <span style="font-size:12px;color:var(--text-secondary);margin-right:8px;">${escapeHtml(sv.actionText).slice(0, 50)}</span>
        <span class="sv-chevron" style="font-size:12px;color:var(--text-muted);transition:transform 0.2s;">▶</span>
      </div>
      <div id="${accordionId}" style="max-height:0px;opacity:0;overflow:hidden;transition:max-height 0.3s ease,opacity 0.25s ease,padding 0.3s ease;padding:0 18px;">
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${signalRows}
        </div>
        <div style="margin-top:10px;font-size:9px;color:var(--text-muted);text-align:right;">Stock + market composite · Educational content only</div>
      </div>
    </div>`;
}

// ==================== TRACK RECORD — SECTION GRID (V2) ====================
//
// Renders one card per pick-producing section with side badge, latest top-10
// picks, and forward-return scorecard at the user-chosen horizon. Reads
// /api/track/sections once per loadTrackRecord call; the horizon selector
// only re-renders from the cached payload.

let _trackSectionsCache = null;

function _trackHorizonValue() {
  const sel = document.getElementById("trackHorizonSelector");
  return sel?.value || "3m";
}

function _trackSparkline(values, opts = {}) {
  if (!Array.isArray(values) || values.length < 2) return "";
  const w = opts.width || 80;
  const h = opts.height || 20;
  const stroke = opts.stroke || "#60a5fa";
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible;">
    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5"/>
  </svg>`;
}

function _scorecardCellsHTML(scorecardByHorizon, primaryHorizon) {
  const horizons = Object.keys(scorecardByHorizon || {});
  if (horizons.length === 0) return '<div style="font-size:11px; color:var(--text-muted); padding:6px 0;">No data yet</div>';
  // Earnings sections only have t1; render a single strip.
  if (horizons.length === 1 && horizons[0] === "t1") {
    const c = scorecardByHorizon.t1;
    const hr = c.hit_rate_pct;
    const colour = hr == null ? "var(--text-muted)" : hr >= 55 ? "#22c55e" : hr >= 45 ? "#eab308" : "#ef4444";
    return `<div style="display:flex; gap:8px; align-items:baseline; padding:6px 0; font-size:12px;">
      <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.06em;">T+1 Hit-Rate</span>
      <span style="color:${colour}; font-weight:700; font-size:16px;">${hr != null ? hr + "%" : "—"}</span>
      <span style="color:var(--text-muted); font-size:11px;">n=${c.n_resolved}/${c.n_resolved + c.n_open}</span>
    </div>`;
  }
  // Standard 1m/3m/6m/12m grid. Highlight the primary horizon.
  return `<div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; padding:6px 0;">
    ${["1m", "3m", "6m", "12m"].map((h) => {
      const c = scorecardByHorizon[h] || {};
      const isPrimary = h === primaryHorizon;
      const hr = c.hit_rate_pct;
      const ma = c.mean_alpha_pct;
      const hrColour = hr == null ? "var(--text-muted)" : hr >= 55 ? "#22c55e" : hr >= 45 ? "#eab308" : "#ef4444";
      const maColour = ma == null ? "var(--text-muted)" : ma > 0 ? "#22c55e" : "#ef4444";
      const bg = isPrimary ? "rgba(96,165,250,0.08)" : "transparent";
      const border = isPrimary ? "1px solid rgba(96,165,250,0.3)" : "1px solid #1a2233";
      return `<div style="background:${bg}; border:${border}; border-radius:6px; padding:6px 4px; text-align:center;">
        <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.06em;">${h}</div>
        <div style="color:${hrColour}; font-weight:700; font-size:14px; margin-top:2px;">${hr != null ? hr + "%" : "—"}</div>
        <div style="color:${maColour}; font-size:10px; margin-top:1px;">${ma != null ? (ma > 0 ? "+" : "") + ma + "%" : "—"}</div>
        <div style="color:var(--text-muted); font-size:9px; margin-top:2px;">n=${c.n_resolved ?? 0}</div>
      </div>`;
    }).join("")}
  </div>`;
}

function _sectionCardHTML(section, primaryHorizon) {
  const sideColour = section.side === "SHORT" ? "#ef4444" : "#22c55e";
  const sideBg = section.side === "SHORT" ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)";
  // The horizon picked for the sparkline matches the user-selected horizon
  // for stock sections; earnings sections fall back to t1.
  const sparkHorizon = primaryHorizon in (section.scorecard_by_horizon || {}) ? primaryHorizon : "t1";
  const sparkSlot = section.scorecard_by_horizon?.[sparkHorizon];
  const cumPct = sparkSlot?.since_inception_cum_pct;
  // Top-10 chips
  const chips = (section.latest_top10 || []).slice(0, 10).map((p) => {
    const sym = (p.symbol || "").replace(/\.NS$/, "");
    return `<span onclick="openStockDetail('${escapeHtml(p.symbol)}')" style="display:inline-block; padding:2px 7px; background:rgba(96,165,250,0.08); border:1px solid rgba(96,165,250,0.25); border-radius:4px; color:#93c5fd; font-size:11px; font-weight:600; cursor:pointer; margin:2px 3px 2px 0;">${escapeHtml(sym)}</span>`;
  }).join("");
  return `<div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:8px;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
      <div style="font-size:12px; font-weight:700; color:var(--text-primary); line-height:1.3;">${escapeHtml(section.label)}</div>
      <span style="display:inline-block; padding:2px 7px; border-radius:4px; background:${sideBg}; color:${sideColour}; font-size:9px; font-weight:800; letter-spacing:0.06em;">${section.side}</span>
    </div>
    <div style="font-size:10px; color:var(--text-muted);">
      ${section.n_total} total snapshots · cum α (${sparkHorizon}): ${cumPct != null ? `<span style="color:${cumPct >= 0 ? '#22c55e' : '#ef4444'}; font-weight:600;">${cumPct >= 0 ? '+' : ''}${cumPct}%</span>` : "—"}
    </div>
    <div style="border-top:1px solid #1a2233; padding-top:6px; min-height:44px;">${chips || '<span style="font-size:11px; color:var(--text-muted);">No latest snapshot</span>'}</div>
    ${_scorecardCellsHTML(section.scorecard_by_horizon, primaryHorizon)}
  </div>`;
}

window.__trackRenderSectionGrid = function() {
  const grid = document.getElementById("trackSectionGrid");
  if (!grid) return;
  if (!_trackSectionsCache || !Array.isArray(_trackSectionsCache.sections)) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-text">No section data yet — run the daily snapshot cron or trigger /api/cron/snapshot-track-record manually.</div></div>`;
    return;
  }
  const horizon = _trackHorizonValue();
  grid.innerHTML = _trackSectionsCache.sections.map((s) => _sectionCardHTML(s, horizon)).join("");
};

async function loadTrackSections(forceBust = false) {
  try {
    const url = `/api/track/sections${forceBust ? "?bust=1" : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _trackSectionsCache = await res.json();
    window.__trackRenderSectionGrid();
  } catch (err) {
    const grid = document.getElementById("trackSectionGrid");
    if (grid) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><div class="empty-text">Section scorecard load failed: ${escapeHtml(err.message)}</div></div>`;
    }
  }
}

// ==================== NEWS HEADLINE RENDERER ====================

function renderNewsHeadline(h) {
  const sc = h.sentiment || "neutral";
  const badgeColor =
    sc.includes("bullish") ? "var(--green)" :
    sc.includes("bearish") ? "var(--red)" : "var(--text-muted)";
  const badgeBg =
    sc.includes("bullish") ? "rgba(16,185,129,0.1)" :
    sc.includes("bearish") ? "rgba(239,68,68,0.1)" : "rgba(100,116,139,0.08)";
  return `
    <a class="news-item" href="${h.link || '#'}" target="_blank" rel="noopener">
      ${h.thumbnail ? '<img class="news-thumb" src="' + h.thumbnail + '" alt="" loading="lazy">' : ''}
      <div style="flex:1;">
        <div class="news-title">${escapeHtml(h.title)}</div>
        <div class="news-meta">
          <span style="display:inline-block;padding:1px 7px;border-radius:4px;background:${badgeBg};color:${badgeColor};font-size:10px;font-weight:600;text-transform:uppercase;">${sc.replace('_', ' ')}</span>
          <span>${escapeHtml(h.publisher || h.source || '')}</span>
          <span>${h.publishedAt ? timeAgo(h.publishedAt) : ''}</span>
        </div>
      </div>
    </a>`;
}


// ==================== WATCHLIST ====================

async function toggleWatchlist(symbol, name, sector) {
  const action = watchlist.has(symbol) ? "remove" : "add";
  try {
    try { telemetry.emit("watchlist_" + action, { symbol, sector: sector || null }); } catch {}
    await fetch(`/api/watchlist/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, name, sector }),
    });
    if (action === "add") watchlist.add(symbol);
    else watchlist.delete(symbol);
    // PR P9 — update every star button for this symbol. Same ticker may
    // appear in multiple surfaces simultaneously: the modal title and the
    // pick-card inline star, the SWS-picks card and a search-result row,
    // etc. Without updating all of them, only one flips state and the
    // others lie about whether the stock is starred.
    const buttons = document.querySelectorAll(`[data-watchlist-symbol="${symbol}"]`);
    if (buttons.length > 0) {
      const saved = watchlist.has(symbol);
      buttons.forEach((btn) => {
        btn.textContent = saved ? "★" : "☆";
        btn.setAttribute("aria-pressed", String(saved));
        btn.style.color = saved ? "var(--gold)" : "var(--text-muted)";
      });
    }
  } catch { /* silent */ }
}

function watchlistButton(symbol, name, sector) {
  const isSaved = watchlist.has(symbol);
  // A11y: changed from <span> to <button> so keyboard users can reach it via
  // Tab and activate with Space/Enter. aria-pressed toggles between saved
  // and unsaved states; aria-label gives screen readers a proper verb.
  const label = isSaved ? `Remove ${name || symbol} from watchlist` : `Add ${name || symbol} to watchlist`;
  return `<button type="button" class="watchlist-btn" data-watchlist-symbol="${symbol}" aria-pressed="${isSaved}" aria-label="${label}" onclick="event.stopPropagation(); toggleWatchlist('${symbol}', '${escapeHtml(name || '')}', '${escapeHtml(sector || '')}')" title="${isSaved ? 'Remove from watchlist' : 'Add to watchlist'}" style="cursor:pointer;background:transparent;border:none;padding:2px 4px;font-size:18px;color:${isSaved ? 'var(--gold)' : 'var(--text-muted)'};transition:color 0.15s;">${isSaved ? "★" : "☆"}</button>`;
}

// PR W3 — chevron-driven inline row details. Swaps the sibling tr.hidden
// state and rotates the chevron. Stops propagation upstream so the
// containing row's onclick (open stock detail modal) doesn't fire.
window.toggleWatchlistRow = function toggleWatchlistRow(sym, btn) {
  const detailsRow = document.querySelector(`tr.wl-details-row[data-wl-details="${CSS.escape(sym)}"]`);
  if (!detailsRow) return;
  const isOpen = !detailsRow.hidden;
  detailsRow.hidden = isOpen;
  if (btn) {
    btn.setAttribute("aria-expanded", String(!isOpen));
    btn.style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)";
  }
};

async function loadWatchlist() {
  const container = document.getElementById("watchlistContainer");
  const meta = document.getElementById("watchlistMeta");
  if (!container) return;

  container.innerHTML = `
    <div class="loading">
      <div class="loading-spinner"></div>
      <div class="loading-text">Loading watchlist…</div>
    </div>`;

  try {
    // PR W3 — load watchlist + picks-by-ticker map in parallel so the
    // verdict pill paints in the same render pass (no flash of "—").
    const [watchRes, picksMap] = await Promise.all([
      fetch("/api/watchlist"),
      loadPicksByTicker(),
    ]);
    const data = await watchRes.json();
    const stocks = Array.isArray(data.stocks) ? data.stocks : [];

    // Keep the in-memory Set in sync so star toggles elsewhere stay accurate
    watchlist = new Set(stocks.map((s) => s.symbol));

    if (meta) {
      meta.textContent = stocks.length === 0
        ? "No saved stocks yet."
        : `${stocks.length} stock${stocks.length === 1 ? "" : "s"} on watch · live prices`;
    }

    if (stocks.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#9734;</div>
          <div class="empty-text">Your watchlist is empty.</div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:8px;">
            Tap the ☆ icon on any stock card (SWS Picks, scanners, or detail pages) to start tracking it here.
          </div>
        </div>`;
      return;
    }

    // Sort by most-recently added first
    const sorted = [...stocks].sort((a, b) => {
      const ta = a.addedAt ? new Date(a.addedAt).getTime() : 0;
      const tb = b.addedAt ? new Date(b.addedAt).getTime() : 0;
      return tb - ta;
    });

    const rows = sorted.map((s, i) => {
      const sym = s.symbol;
      const name = s.name || sym;
      const sector = s.sector || "";
      const price = s.price;
      const chg = s.change;
      const chgPct = s.changePercent;
      const hasPrice = price !== null && price !== undefined && !Number.isNaN(price);
      const priceCell = hasPrice
        ? `<span class="tx-num" style="font-weight:600;">&#8377;${formatNumber(price)}</span>`
        : `<span style="color:var(--text-muted);font-size:12px;">—</span>`;

      // PR W3 — Day Change % only, magnitude-keyed via signedColorFor.
      // Drops the raw-₹ change column per the plan; surface is decongested.
      let dayChgCell;
      if (chgPct === null || chgPct === undefined || Number.isNaN(chgPct)) {
        dayChgCell = `<span style="color:var(--text-muted);font-size:12px;">—</span>`;
      } else {
        const sc = signedColorFor(chgPct);
        dayChgCell = `<span class="tx-num" style="color:${sc.color}; background:${sc.bg}; padding:2px 6px; border-radius:var(--radius-100); font-size:12px;" aria-label="${sc.srLabel}"><span aria-hidden="true">${sc.glyph}</span> ${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}%</span>`;
      }

      // Entry price + Since Added — derived locally; only render when both
      // entry and live are present.
      const addedPrice = s.addedPrice;
      const hasAddedPrice = addedPrice !== null && addedPrice !== undefined && !Number.isNaN(addedPrice);
      let sinceAddedCell = `<span style="color:var(--text-muted);font-size:12px;">—</span>`;
      if (hasAddedPrice && hasPrice && addedPrice > 0) {
        const sincePct = ((price - addedPrice) / addedPrice) * 100;
        const sc = signedColorFor(sincePct);
        sinceAddedCell = `<span class="tx-num" style="color:${sc.color}; background:${sc.bg}; padding:2px 6px; border-radius:var(--radius-100); font-size:12px;" aria-label="${sc.srLabel} since added"><span aria-hidden="true">${sc.glyph}</span> ${sincePct >= 0 ? "+" : ""}${sincePct.toFixed(2)}%</span>`;
      }

      // PR W3 — SWS verdict pill from picks-latest (picks-only — locked
      // decision). Symbols outside the ~120-name curated set render as
      // muted "—" so the absence of curation is honestly surfaced.
      const tickerKey = normalizeTickerKey(sym);
      const meta = picksMap && picksMap.get ? picksMap.get(tickerKey) : null;
      const verdictCell = renderVerdictPill(meta && meta.verdict);
      const sectorForDetails = sector || (meta && meta.sector) || "—";
      const swsReason = (meta && meta.one_line) ? escapeHtml(meta.one_line) : "";
      const addedLabel = s.addedAt
        ? new Date(s.addedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "2-digit" })
        : "—";
      const addedPriceLabel = hasAddedPrice
        ? `&#8377;${formatNumber(addedPrice)}`
        : "—";

      // PR W3 — Tier 2 details row. Lazy content is fine because <details>
      // doesn't render hidden children to the accessibility tree until open.
      const detailsRow = `
        <tr class="wl-details-row" data-wl-details="${sym}" hidden>
          <td colspan="6" style="padding:0;">
            <div style="padding:8px 14px 12px 52px; background:rgba(255,255,255,0.015); border-top:1px solid var(--border); font-size:12px; color:var(--text-secondary); display:flex; flex-direction:column; gap:6px;">
              <div><span class="tx-micro">Sector</span> &nbsp; ${escapeHtml(sectorForDetails)}</div>
              <div><span class="tx-micro">Added on</span> &nbsp; ${addedLabel} &nbsp;·&nbsp; entry ${addedPriceLabel}</div>
              ${swsReason ? `<div><span class="tx-micro">SWS take</span> &nbsp; ${swsReason}</div>` : ""}
            </div>
          </td>
        </tr>`;

      // Row chevron — toggles the sibling details row. Plain JS toggle so
      // we stay inside the static-SPA model.
      return `
        <tr style="cursor:pointer;" onclick="openStockDetailModal('${sym}','watchlist')">
          <td style="padding:6px 4px; width:36px;">${watchlistButton(sym, name, sector)}</td>
          <td class="wl-col-stock">
            <div style="font-weight:600;">${escapeHtml(sym)}</div>
            <div style="font-size:11px;color:var(--text-muted);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</div>
          </td>
          <td class="wl-col-verdict">${verdictCell}</td>
          <td class="wl-col-price" style="text-align:right;">${priceCell}</td>
          <td class="wl-col-day" style="text-align:right;">${dayChgCell}</td>
          <td class="wl-col-since" style="text-align:right;">${sinceAddedCell}</td>
          <td class="wl-col-chev" style="text-align:right; width:36px;">
            <button type="button" class="wl-chevron" data-wl-toggle="${sym}" aria-expanded="false" aria-label="Show row details for ${escapeHtml(sym)}" onclick="event.stopPropagation(); window.toggleWatchlistRow('${sym}', this);" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; padding:4px 8px; font-size:14px; line-height:1; transition: transform var(--dur-quick) var(--ease-standard);">▶</button>
          </td>
        </tr>
        ${detailsRow}`;
    }).join("");

    container.innerHTML = `
      <div style="overflow-x:auto;">
        <table class="signals-table watchlist-table" style="min-width:780px; width:100%;">
          <thead>
            <tr>
              <th style="width:36px;"></th>
              <th>Stock</th>
              <th>Verdict</th>
              <th style="text-align:right;">Price</th>
              <th style="text-align:right;">Day Change</th>
              <th style="text-align:right;">Since Added</th>
              <th style="width:36px;"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">&#9888;</div>
        <div class="empty-text">Failed to load watchlist.</div>
      </div>`;
    if (meta) meta.textContent = "Error loading watchlist.";
  }
}

// ==================== STOCK COMPARISON ====================

let compareStocks = []; // array of symbol strings, max 2

function addToCompare(symbol) {
  if (compareStocks.includes(symbol)) return;
  if (compareStocks.length >= 2) compareStocks.shift(); // keep max 2
  compareStocks.push(symbol);
  if (compareStocks.length === 2) showComparison();
}

async function showComparison() {
  if (compareStocks.length < 2) return;
  const [sym1, sym2] = compareStocks;
  try {
    const [d1, d2] = await Promise.all([
      fetch(`/api/stock/${sym1}`).then((r) => r.json()),
      fetch(`/api/stock/${sym2}`).then((r) => r.json()),
    ]);
    const a1 = d1.analysis || {};
    const a2 = d2.analysis || {};
    const q1 = d1.quote || {};
    const q2 = d2.quote || {};
    const f1 = d1.fundamentals || {};
    const f2 = d2.fundamentals || {};

    const row = (label, v1, v2, higherBetter = true) => {
      const n1 = parseFloat(v1);
      const n2 = parseFloat(v2);
      const c1 = !isNaN(n1) && !isNaN(n2) ? (higherBetter ? (n1 >= n2 ? "var(--green)" : "var(--red)") : (n1 <= n2 ? "var(--green)" : "var(--red)")) : "inherit";
      const c2 = !isNaN(n1) && !isNaN(n2) ? (higherBetter ? (n2 >= n1 ? "var(--green)" : "var(--red)") : (n2 <= n1 ? "var(--green)" : "var(--red)")) : "inherit";
      return `<div style="display:grid;grid-template-columns:1fr 120px 120px;gap:8px;padding:6px 12px;border-radius:6px;background:rgba(255,255,255,0.02);font-size:12px;">
        <div style="color:var(--text-muted);font-weight:600;">${label}</div>
        <div style="text-align:right;font-family:'JetBrains Mono',monospace;font-weight:700;color:${c1};">${v1 ?? '—'}</div>
        <div style="text-align:right;font-family:'JetBrains Mono',monospace;font-weight:700;color:${c2};">${v2 ?? '—'}</div>
      </div>`;
    };

    const html = `
      <div style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px;" onclick="this.remove(); compareStocks=[];">
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:24px;max-width:500px;width:100%;max-height:80vh;overflow-y:auto;" onclick="event.stopPropagation();">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="font-size:16px;font-weight:800;">Stock Comparison</h3>
            <span style="cursor:pointer;font-size:20px;color:var(--text-muted);" onclick="this.closest('[style*=fixed]').remove(); compareStocks=[];">&times;</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 120px 120px;gap:8px;padding:6px 12px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:700;">
            <div>Metric</div>
            <div style="text-align:right;">${escapeHtml(q1.name?.slice(0, 14) || sym1)}</div>
            <div style="text-align:right;">${escapeHtml(q2.name?.slice(0, 14) || sym2)}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:3px;margin-top:8px;">
            ${row("Price", "₹" + formatNumber(q1.price), "₹" + formatNumber(q2.price))}
            ${row("Change %", (q1.changePercent || 0).toFixed(2) + "%", (q2.changePercent || 0).toFixed(2) + "%")}
            ${row("Combined Score", a1.combinedScore, a2.combinedScore)}
            ${row("Technical", a1.technicalScore, a2.technicalScore)}
            ${row("Sentiment", a1.sentimentScore ?? "—", a2.sentimentScore ?? "—")}
            ${row("Fundamental", a1.fundamentalScore ?? "—", a2.fundamentalScore ?? "—")}
            ${row("Recommendation", a1.combinedRecommendation, a2.combinedRecommendation)}
            ${row("P/E Ratio", f1.snapshot?.pe?.toFixed(1), f2.snapshot?.pe?.toFixed(1), false)}
            ${row("Sector P/E", f1.snapshot?.sectorPe?.toFixed(1), f2.snapshot?.sectorPe?.toFixed(1))}
            ${row("Verdict", f1.verdict, f2.verdict)}
            ${row("52W High", "₹" + formatNumber(q1.fiftyTwoWeekHigh), "₹" + formatNumber(q2.fiftyTwoWeekHigh))}
            ${row("52W Low", "₹" + formatNumber(q1.fiftyTwoWeekLow), "₹" + formatNumber(q2.fiftyTwoWeekLow))}
            ${row("Macro Boost", a1.macroBoost, a2.macroBoost)}
          </div>
          <div style="margin-top:16px;font-size:11px;color:var(--text-muted);text-align:center;">
            Green = better on this metric. Click outside to close.
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
  } catch (err) {
    alert("Comparison failed: " + err.message);
  }
}

// ==================== HISTORICAL PRICE CHART ====================

/**
 * Render a simple sparkline / bar chart using the stock's historical data.
 * Uses the existing /api/stock/:symbol endpoint which returns historical
 * data via the analysis object. We generate a pure-CSS chart — no external
 * charting library needed.
 *
 * Called from renderStockDetail when the quote and analysis data is available.
 */
function renderPriceChart(historical, quote) {
  if (!historical || historical.length < 10) return "";
  // Use the last 90 days of close prices
  const closes = historical.slice(-90).map((d) => d.close).filter(Boolean);
  if (closes.length < 10) return "";

  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;

  // Generate SVG sparkline
  const width = 600;
  const height = 120;
  const points = closes.map((c, i) => {
    const x = (i / (closes.length - 1)) * width;
    const y = height - ((c - min) / range) * (height - 10) - 5;
    return `${x},${y}`;
  }).join(" ");

  const lastPrice = closes[closes.length - 1];
  const firstPrice = closes[0];
  const isUp = lastPrice >= firstPrice;
  const lineColor = isUp ? "var(--green)" : "var(--red)";
  const fillColor = isUp ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)";

  // Volume bars (last 90 days)
  const volumes = historical.slice(-90).map((d) => d.volume || 0);
  const maxVol = Math.max(...volumes) || 1;
  const volBars = volumes.map((v, i) => {
    const x = (i / (volumes.length - 1)) * width;
    const h = (v / maxVol) * 25;
    return `<rect x="${x - 2}" y="${height - h}" width="4" height="${h}" fill="rgba(96,165,250,0.2)" rx="1"/>`;
  }).join("");

  return `
    <div style="margin:20px 0;padding:16px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--card-radius);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:700;">Price Chart (${closes.length} days)</div>
        <div style="font-size:11px;color:var(--text-muted);">
          Low: ₹${formatNumber(min)} · High: ₹${formatNumber(max)}
        </div>
      </div>
      <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:${height}px;" preserveAspectRatio="none">
        ${volBars}
        <polygon points="${points} ${width},${height} 0,${height}" fill="${fillColor}" />
        <polyline points="${points}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" />
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:6px;">
        <span>${closes.length}d ago</span>
        <span>Today</span>
      </div>
    </div>`;
}


// ═══════════════════════════════════════════════════════════════════════════
// Portfolio Analyzer (Phase 5) — upload + analyze + render
// ═══════════════════════════════════════════════════════════════════════════

let _analyzerWired = false;

// XIRR Optimizer state — keeps the latest analyze session so preset / tax-slab
// chips can re-run the optimizer instantly via /api/portfolio/optimize without
// re-uploading the file. taxSlabPct persists across sessions in localStorage
// so the user only picks it once.
const _optimizerState = {
  sessionId: null,
  preset: "balanced",
  taxSlabPct: (() => {
    const saved = parseInt(localStorage.getItem("starbhai.taxSlabPct") || "30", 10);
    return [5, 20, 30].includes(saved) ? saved : 30;
  })(),
  assumedHoldingMonths: 24,
  optimizer: null, // last full optimizer block (for re-render without server roundtrip)
};

function initPortfolioAnalyzer() {
  if (_analyzerWired) return;
  _analyzerWired = true;

  const input = document.getElementById("analyzerFileInput");
  const browseBtn = document.getElementById("analyzerBrowseBtn");
  const dropArea = document.getElementById("analyzerDropArea");
  const freshCapitalWrap = document.getElementById("analyzerEngineFreshCapital");

  // SWS is the only engine — always show fresh-capital input.
  if (freshCapitalWrap) freshCapitalWrap.style.display = "flex";

  browseBtn.addEventListener("click", () => input.click());
  input.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) analyzePortfolioFile(f);
  });

  // Drag & drop
  ["dragenter", "dragover"].forEach((ev) =>
    dropArea.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropArea.style.borderColor = "var(--accent)";
      dropArea.style.background = "rgba(59,130,246,0.05)";
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropArea.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropArea.style.borderColor = "#2a3349";
      dropArea.style.background = "var(--panel)";
    }),
  );
  dropArea.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f) analyzePortfolioFile(f);
  });
}

function setAnalyzerState(state) {
  const upload = document.getElementById("analyzerUploadZone");
  const analyzing = document.getElementById("analyzerAnalyzing");
  const report = document.getElementById("analyzerReport");
  upload.style.display = state === "upload" ? "block" : "none";
  analyzing.style.display = state === "analyzing" ? "block" : "none";
  report.style.display = state === "report" ? "block" : "none";
}

function resetAnalyzer() {
  setAnalyzerState("upload");
  const errEl = document.getElementById("analyzerUploadError");
  if (errEl) errEl.style.display = "none";
  const input = document.getElementById("analyzerFileInput");
  if (input) input.value = "";
  // Drop the in-memory analyzer cache so a tab-switch before a new file is
  // picked can't re-render the pre-reset report from loadAnalyzerOnTabOpen's
  // 60s cache window.
  _analyzerCache = null;
}

async function analyzePortfolioFile(file) {
  const errEl = document.getElementById("analyzerUploadError");
  errEl.style.display = "none";

  if (file.size > 2 * 1024 * 1024) {
    errEl.textContent = "File is larger than 2 MB. Groww/Zerodha exports are usually <100 KB — please check this is the right file.";
    errEl.style.display = "block";
    return;
  }

  setAnalyzerState("analyzing");
  document.getElementById("analyzerProgressText").textContent = `Scoring ${file.name} via SWS Engine…`;

  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("taxSlabPct", String(_optimizerState.taxSlabPct));
    fd.append("preset", _optimizerState.preset);
    const fresh = Number(document.getElementById("analyzerFreshCapital")?.value || 0);
    if (Number.isFinite(fresh) && fresh > 0) fd.append("freshCapitalInr", String(fresh));
    const res = await fetch("/api/portfolio/analyze", { method: "POST", body: fd });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error + (data.hint ? `\n\nHint: ${data.hint}` : ""));
    }
    _optimizerState.sessionId = data.sessionId || data.report?.optimizer?.sessionId || null;
    _optimizerState.optimizer = data.report?.optimizer || null;
    renderSWSAnalyzerReport(data.report, data.elapsedMs);
    setAnalyzerState("report");
    // Cache the freshly-computed report so a tab-switch within 60s
    // skips the rerun API call (frontend rate-limit per the plan).
    _analyzerCache = {
      report: data.report,
      elapsedMs: data.elapsedMs,
      uploadedAt: data.savable?.parsedAt || new Date().toISOString(),
      sourceFile: file.name,
      cachedAt: Date.now(),
    };
  } catch (err) {
    setAnalyzerState("upload");
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

// In-memory cache of the most recent rerun result. The plan calls for
// auto-rerun on every analyzer tab open, but flipping between tabs in
// rapid succession would hammer the 5–10s endpoint — so we render from
// this cache when it's fresh (<60s) and only hit the API otherwise.
let _analyzerCache = null;
const ANALYZER_CACHE_TTL_MS = 60_000;

// Called on every analyzer tab open. Always tries to render a fresh
// report against the user's last-uploaded holdings; falls back to the
// upload zone when the user has no stored portfolio (404).
async function loadAnalyzerOnTabOpen() {
  // Cache hit (<60s old) — re-render instantly without an API call.
  if (_analyzerCache && (Date.now() - _analyzerCache.cachedAt) < ANALYZER_CACHE_TTL_MS) {
    renderSWSAnalyzerReport(_analyzerCache.report, _analyzerCache.elapsedMs);
    setAnalyzerState("report");
    return;
  }

  setAnalyzerState("analyzing");
  const progressEl = document.getElementById("analyzerProgressText");
  if (progressEl) progressEl.textContent = "Analyzing your portfolio with fresh SWS data…";

  try {
    const res = await fetch("/api/portfolio/analyze/rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        taxSlabPct: _optimizerState.taxSlabPct,
        preset: _optimizerState.preset,
      }),
    });

    if (res.status === 404) {
      // No stored portfolio yet — show the upload zone as today.
      _analyzerCache = null;
      setAnalyzerState("upload");
      return;
    }
    if (res.status === 401) {
      _analyzerCache = null;
      setAnalyzerState("upload");
      const errEl = document.getElementById("analyzerUploadError");
      if (errEl) {
        errEl.textContent = "Please sign in to view your portfolio analysis.";
        errEl.style.display = "block";
      }
      return;
    }

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error + (data.hint ? `\n\nHint: ${data.hint}` : ""));
    }

    _optimizerState.sessionId = data.sessionId || data.report?.optimizer?.sessionId || null;
    _optimizerState.optimizer = data.report?.optimizer || null;
    renderSWSAnalyzerReport(data.report, data.elapsedMs);
    setAnalyzerState("report");
    _analyzerCache = {
      report: data.report,
      elapsedMs: data.elapsedMs,
      uploadedAt: data.uploadedAt || null,
      sourceFile: data.sourceFile || null,
      cachedAt: Date.now(),
    };
  } catch (err) {
    setAnalyzerState("upload");
    const errEl = document.getElementById("analyzerUploadError");
    if (errEl) {
      errEl.textContent = `Couldn't load your portfolio: ${err.message}. Try uploading it again.`;
      errEl.style.display = "block";
    }
  }
}

// ──────────────────── Rendering ────────────────────

function inr(n) {
  if (n == null || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return "₹" + (n / 1e7).toFixed(2) + " Cr";
  if (abs >= 1e5) return "₹" + (n / 1e5).toFixed(2) + " L";
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

function pctColor(n) {
  if (n == null) return "var(--text-muted)";
  return n >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)";
}

// PR F1 — magnitude-keyed colour + glyph + screen-reader label.
// New code paths use this instead of pctColor() so |Δ|<0.5 reads as muted ◆,
// |Δ|<2 as soft, |Δ|<5 as normal, |Δ|≥5 as deep + ▲/▼. Pair every coloured
// value with srLabel for a11y — decorative glyphs get aria-hidden.
function signedColorFor(value) {
  if (value == null || !Number.isFinite(value)) {
    return { color: "var(--text-muted)", bg: "transparent", glyph: "·", srLabel: "no data" };
  }
  const abs = Math.abs(value);
  const pos = value >= 0;
  const sr = (verb) => `${verb} ${abs.toFixed(abs < 10 ? 2 : 1)} percent`;
  if (abs < 0.5) {
    return { color: "var(--text-muted)", bg: "transparent", glyph: "◆", srLabel: "unchanged" };
  }
  if (abs < 2) {
    return pos
      ? { color: "var(--positive-soft)", bg: "var(--positive-bg-soft)", glyph: "▲", srLabel: sr("up") }
      : { color: "var(--negative-soft)", bg: "var(--negative-bg-soft)", glyph: "▼", srLabel: sr("down") };
  }
  if (abs < 5) {
    return pos
      ? { color: "var(--positive)", bg: "var(--positive-bg-soft)", glyph: "▲", srLabel: sr("up") }
      : { color: "var(--negative)", bg: "var(--negative-bg-soft)", glyph: "▼", srLabel: sr("down") };
  }
  return pos
    ? { color: "var(--positive-strong)", bg: "var(--positive-bg-strong)", glyph: "▲", srLabel: sr("up") }
    : { color: "var(--negative-strong)", bg: "var(--negative-bg-strong)", glyph: "▼", srLabel: sr("down") };
}

// PR F1 — INR formatter with Indian numbering (2:2:3 grouping → ₹1,23,456)
// and an opt-in compact mode for headline numbers (₹1.23 Cr, ₹4.5 L).
// Falls back gracefully on older Chromium where notation:'compact' isn't
// supported. Pair with { signed: true } to render explicit en-dash sign.
const _INR_FULL = new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", maximumFractionDigits: 0,
});
let _inrCompactNumber = null;
try {
  _inrCompactNumber = new Intl.NumberFormat("en-IN", {
    notation: "compact",
    maximumFractionDigits: 2,
  });
} catch { /* old Chromium → fallback below */ }
function formatINR(value, opts) {
  if (value == null || !Number.isFinite(value)) return "—";
  const o = opts || {};
  const abs = Math.abs(value);
  const signed = !!o.signed;
  const compact = !!o.compact;
  let out;
  if (compact && abs >= 1e7) {
    out = "₹" + (value / 1e7).toFixed(2) + " Cr";
  } else if (compact && abs >= 1e5) {
    out = "₹" + (value / 1e5).toFixed(2) + " L";
  } else if (compact && _inrCompactNumber) {
    out = "₹" + _inrCompactNumber.format(value);
  } else {
    out = _INR_FULL.format(value);
  }
  if (signed && value < 0) {
    // Replace the leading "-₹" with "−₹" (en-dash, typographically correct)
    out = out.replace(/^-/, "−");
  } else if (signed && value > 0) {
    out = "+" + out;
  }
  return out;
}
window.signedColorFor = signedColorFor;
window.formatINR = formatINR;

// PR W3 — picksByTicker lookup. Build once on first use from /api/sws-picks
// so the Watchlist's verdict pill resolves in O(1) per row. Returns null when
// the ticker is outside the curated set (renders as muted "—" in the UI).
//
// Schema (verified by direct jq on data/sws/picks-latest.json):
//   .sections.<section_key>[] → { ticker, name, sector, composite_verdict, v3_verdict, v3_score_100, snowflake, sws_url, ... }
//
// Ticker is bare (no .NS suffix). Watchlist stores symbols like "RELIANCE.NS",
// so we normalise via normalizeTickerKey() on every lookup.
let _picksByTicker = null;
let _picksByTickerPromise = null;
function normalizeTickerKey(sym) {
  if (!sym) return "";
  return String(sym)
    .toUpperCase()
    .replace(/^(BSE|NSE):/, "")
    .replace(/\.(NS|BO)$/, "")
    .trim();
}
async function loadPicksByTicker() {
  if (_picksByTicker) return _picksByTicker;
  if (_picksByTickerPromise) return _picksByTickerPromise;
  _picksByTickerPromise = (async () => {
    try {
      const res = await fetch("/api/sws-picks");
      if (!res.ok) return new Map();
      const data = await res.json();
      const map = new Map();
      const sections = data && data.sections;
      if (sections && typeof sections === "object") {
        for (const section of Object.values(sections)) {
          if (!Array.isArray(section)) continue;
          for (const stock of section) {
            if (!stock || !stock.ticker) continue;
            const key = normalizeTickerKey(stock.ticker);
            if (!map.has(key)) {
              map.set(key, {
                verdict: stock.composite_verdict || stock.v3_verdict || stock.verdict || null,
                v3_score: stock.v3_score_100 || stock.v3_score || null,
                upside: stock.upside_pct || null,
                snowflake: stock.snowflake_total || stock.snowflake || null,
                sector: stock.sector || null,
                one_line: stock.one_line || null,
              });
            }
          }
        }
      }
      _picksByTicker = map;
      return map;
    } catch {
      return new Map();
    } finally {
      _picksByTickerPromise = null;
    }
  })();
  return _picksByTickerPromise;
}

// PR W3 — verdict → palette mapping for pill colours.
// TOP_PICK stays gold (locked decision); STRONG green; WATCH muted;
// AVOID red; ACCEPTABLE / FAIR_VALUE cyan (info-tone).
const VERDICT_PALETTE = {
  TOP_PICK:     { color: "var(--gold)",        bg: "rgba(224,176,96,0.10)", border: "rgba(224,176,96,0.35)" },
  STRONG:       { color: "var(--positive)",    bg: "var(--positive-bg-soft)", border: "rgba(46,204,113,0.32)" },
  ACCEPTABLE:   { color: "var(--cyan)",        bg: "rgba(111,195,216,0.08)", border: "rgba(111,195,216,0.28)" },
  FAIR_VALUE:   { color: "var(--cyan)",        bg: "rgba(111,195,216,0.08)", border: "rgba(111,195,216,0.28)" },
  DEEP_VALUE:   { color: "var(--gold)",        bg: "rgba(224,176,96,0.10)", border: "rgba(224,176,96,0.35)" },
  QUALITY_GROWTH: { color: "var(--positive)",  bg: "var(--positive-bg-soft)", border: "rgba(46,204,113,0.32)" },
  WATCH:        { color: "var(--text-muted)",  bg: "rgba(237,237,237,0.04)", border: "rgba(237,237,237,0.10)" },
  FULLY_VALUED: { color: "var(--text-muted)",  bg: "rgba(237,237,237,0.04)", border: "rgba(237,237,237,0.10)" },
  AVOID:        { color: "var(--negative)",    bg: "var(--negative-bg-soft)", border: "rgba(214,69,69,0.32)" },
  OVERVALUED:   { color: "var(--negative)",    bg: "var(--negative-bg-soft)", border: "rgba(214,69,69,0.32)" },
};
function renderVerdictPill(verdict) {
  if (!verdict) {
    return `<span class="tx-meta" style="color:var(--text-muted); font-family:var(--font-mono); letter-spacing:0.02em;" aria-label="not curated">—</span>`;
  }
  const palette = VERDICT_PALETTE[verdict] || { color: "var(--text-muted)", bg: "rgba(237,237,237,0.04)", border: "rgba(237,237,237,0.10)" };
  const label = String(verdict).replace(/_/g, " ");
  return `<span class="tx-micro" style="display:inline-block; padding:3px 8px; border-radius:var(--radius-100); color:${palette.color}; background:${palette.bg}; border:1px solid ${palette.border}; font-weight:700;">${label}</span>`;
}

const ANALYZER_ACTION_COLORS = {
  CUT_LOSS:     { bg: "rgba(220,38,38,0.15)",  border: "rgba(220,38,38,0.5)",  text: "#fca5a5" },
  // REVIEW_GOVERNANCE shares the dark-red palette with CUT_LOSS but uses a
  // slightly deeper border so a "Review — governance red flag" badge stays
  // visually distinct from a drawdown-driven review. Fires when the daily
  // governance refresh detects pledge ≥25% or pledge QoQ Δ > 5pp on a
  // holding — see portfolioIntelligence.js Priority 0.
  REVIEW_GOVERNANCE: { bg: "rgba(180,30,30,0.18)", border: "rgba(180,30,30,0.7)", text: "#fecaca" },
  SELL:         { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.4)",  text: "#f87171" },
  BOOK_PROFIT:  { bg: "rgba(250,204,21,0.12)", border: "rgba(250,204,21,0.4)", text: "#fde047" },
  TRIM:         { bg: "rgba(250,204,21,0.12)", border: "rgba(250,204,21,0.4)", text: "#fde047" },
  HOLD:         { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.3)", text: "#93c5fd" },
  ADD:          { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.4)",  text: "#86efac" },
  STRONG_ADD:   { bg: "rgba(34,197,94,0.18)",  border: "rgba(34,197,94,0.6)",  text: "#bbf7d0" },
  AVERAGE_DOWN: { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.4)",  text: "#86efac" },
  NO_DATA:      { bg: "rgba(107,114,128,0.12)", border: "rgba(107,114,128,0.4)", text: "#9ca3af" },
};

function actionBadge(action, displayAction) {
  const c = ANALYZER_ACTION_COLORS[action] || ANALYZER_ACTION_COLORS.HOLD;
  return `<span style="display:inline-block; padding:3px 10px; border-radius:4px; background:${c.bg}; border:1px solid ${c.border}; color:${c.text}; font-size:11px; font-weight:700; letter-spacing:0.3px;">${displayAction || action}</span>`;
}

// ──────────────────── SWS Engine renderer (Beta) ────────────────────
//
// The SWS engine replaces the per-stock urgent-actions/holdings cards with
// a Tier A/B/C/D action grid driven by the SWS deep snapshot. This
// renderer overrides the entire #analyzerReport container.

// Action color map keyed by both legacy labels (EXIT, Reduction-50%, …) and
// ladder-v2 labels (EXIT-now, EXIT-staged, Reduction-66/50/33/25%,
// Top-up-25/33/50/100%). Trim severity scales with the trim percentage —
// deeper red for bigger reductions, deeper green for bigger top-ups.
const SWS_ACTION_COLORS = {
  // Legacy labels (kept for v1 compatibility + when SWS_LADDER_V2=0)
  "EXIT":              { bg: "rgba(220,38,38,0.18)", border: "rgba(220,38,38,0.55)", text: "#fca5a5" },
  "Reduction-50%":     { bg: "rgba(239,68,68,0.14)", border: "rgba(239,68,68,0.45)", text: "#f87171" },
  "Reduction-25-33%":  { bg: "rgba(250,204,21,0.14)", border: "rgba(250,204,21,0.4)", text: "#fde047" },
  "HOLD":              { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.35)", text: "#93c5fd" },
  "Top-up-modest":     { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.4)",   text: "#86efac" },
  "Top-up":            { bg: "rgba(34,197,94,0.18)",  border: "rgba(34,197,94,0.6)",   text: "#86efac" },
  "STRONG Top-up":     { bg: "rgba(34,197,94,0.25)",  border: "rgba(34,197,94,0.7)",   text: "#bbf7d0" },
  // Ladder-v2 reductions (deeper red as trim % rises; staged exit is amber)
  "EXIT-now":          { bg: "rgba(220,38,38,0.22)", border: "rgba(220,38,38,0.65)", text: "#fca5a5" },
  "EXIT-staged":       { bg: "rgba(234,88,12,0.16)", border: "rgba(234,88,12,0.5)",  text: "#fdba74" },
  "Reduction-66%":     { bg: "rgba(220,38,38,0.16)", border: "rgba(220,38,38,0.55)", text: "#fca5a5" },
  "Reduction-33%":     { bg: "rgba(250,204,21,0.14)", border: "rgba(250,204,21,0.4)", text: "#fde047" },
  "Reduction-25%":     { bg: "rgba(250,204,21,0.10)", border: "rgba(250,204,21,0.35)", text: "#fde68a" },
  // Ladder-v2 top-ups (deeper green as add % rises)
  "Top-up-25%":        { bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.35)", text: "#86efac" },
  "Top-up-33%":        { bg: "rgba(34,197,94,0.14)",  border: "rgba(34,197,94,0.45)", text: "#86efac" },
  "Top-up-50%":        { bg: "rgba(34,197,94,0.18)",  border: "rgba(34,197,94,0.6)",  text: "#86efac" },
  "Top-up-100%":       { bg: "rgba(34,197,94,0.28)",  border: "rgba(34,197,94,0.75)", text: "#bbf7d0" },
  "n/a":               { bg: "rgba(107,114,128,0.12)", border: "rgba(107,114,128,0.4)", text: "#9ca3af" },
};

function swsActionBadge(action) {
  const c = SWS_ACTION_COLORS[action] || SWS_ACTION_COLORS["HOLD"];
  return `<span style="display:inline-block; padding:4px 10px; border-radius:5px; background:${c.bg}; border:1px solid ${c.border}; color:${c.text}; font-size:11px; font-weight:700; letter-spacing:0.3px; white-space:nowrap;">${action || "—"}</span>`;
}

function swsTimingBadge(timing) {
  if (!timing || timing.verdict === "n/a") return "";
  const colors = {
    "Yes":            { bg: "rgba(34,197,94,0.10)",  text: "#86efac" },
    "Yes-not-urgent": { bg: "rgba(59,130,246,0.10)", text: "#93c5fd" },
    "Soft-no":        { bg: "rgba(250,204,21,0.10)", text: "#fde047" },
    "No":             { bg: "rgba(239,68,68,0.10)",  text: "#f87171" },
    // PR-3 — additional verdict from the timingObservation module:
    // "Wait-for-open" fires when NSE is closed / pre-open / post-close
    // and any non-HOLD action is queued. Coloured neutral (slate) so it
    // reads "informational" rather than red/green.
    "Wait-for-open":  { bg: "rgba(148,163,184,0.10)", text: "#cbd5e1" },
  };
  const c = colors[timing.verdict] || colors["Yes-not-urgent"];
  const window = timing.window ? ` · ${timing.window}` : "";
  return `<span title="${swsEscapeAttr(timing.reason || "")}" style="display:inline-block; padding:2px 8px; border-radius:3px; background:${c.bg}; color:${c.text}; font-size:10px; font-weight:600; letter-spacing:0.2px;">${timing.verdict}${window}</span>`;
}

function swsEscapeAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Banner timestamp formatter — shared by v1 + v2 renderers so the two
// "Snapshot" / "SWS data" labels stay in sync.
function swsFormatBannerTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

// Broker-reconciliation chip — surfaces the broker statement's own
// invested / current / unrealised P&L next to the SWS-derived hero trio
// so the user can reconcile to their broker app. Pure read of the
// banner.broker_summary block; renders nothing when absent (e.g. on
// rerun before the next upload restamps it).
function swsRenderBrokerReconciliationChip(banner) {
  const brokerSummary = banner && banner.broker_summary;
  if (!brokerSummary) return "";
  const invested = Number(brokerSummary.invested);
  const current = Number(brokerSummary.current);
  const pnl = Number(brokerSummary.unrealisedPL);
  const haveAny = Number.isFinite(invested) || Number.isFinite(current) || Number.isFinite(pnl);
  if (!haveAny) return "";
  const asOfIso = brokerSummary.asOfDate;
  const asOfLabel = asOfIso
    ? new Date(asOfIso).toLocaleDateString("en-IN", { dateStyle: "medium" })
    : null;
  const pnlPct = (Number.isFinite(pnl) && Number.isFinite(invested) && invested > 0)
    ? (pnl / invested) * 100
    : null;
  const pnlColor = Number.isFinite(pnl)
    ? (pnl >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)")
    : "var(--text-muted)";
  const parts = [];
  if (Number.isFinite(invested)) parts.push(`Invested <strong>${inr(invested)}</strong>`);
  if (Number.isFinite(current)) parts.push(`Current <strong>${inr(current)}</strong>`);
  if (Number.isFinite(pnl)) {
    const pnlSign = pnl >= 0 ? "+" : "−";
    const pnlAmt = inr(Math.abs(pnl));
    const pctStr = pnlPct != null
      ? ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`
      : "";
    parts.push(`P&L <strong style="color:${pnlColor};">${pnlSign}${pnlAmt}${pctStr}</strong>`);
  }
  const heading = asOfLabel
    ? `Per your broker statement (${swsEscapeAttr(asOfLabel)})`
    : "Per your broker statement";
  return `
    <div style="margin: -6px 0 18px; padding: 10px 14px; background: rgba(148,163,184,0.06); border: 1px dashed rgba(148,163,184,0.25); border-radius: 8px; font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
      <span style="font-weight: 600; color: var(--text);">${heading}:</span>
      <span style="display:inline-flex; gap: 14px; flex-wrap: wrap;">${parts.join("<span style=\"color:#3a4358;\">·</span>")}</span>
      <span style="margin-left:auto; font-size:11px; color:var(--text-muted); font-style:italic;">SWS hero trio above uses live prices, so totals can differ.</span>
    </div>
  `;
}

function swsSnowflakeMini(snow) {
  if (!snow) return "—";
  const cells = [
    { k: "Val", v: snow.valuation },
    { k: "Fut", v: snow.future_growth },
    { k: "Past", v: snow.past_performance },
    { k: "Hlth", v: snow.financial_health },
    { k: "Div", v: snow.dividends },
  ];
  return `<div style="display:inline-flex; gap:4px; align-items:center;">
    ${cells.map(c => `<span title="${c.k} ${c.v}/6" style="display:inline-block; min-width:18px; padding:1px 4px; background:rgba(59,130,246,${0.05 + (c.v || 0) * 0.04}); border:1px solid rgba(59,130,246,${0.15 + (c.v || 0) * 0.05}); border-radius:3px; font-size:10px; font-weight:700; text-align:center; color:#93c5fd;">${c.v ?? "—"}</span>`).join("")}
    <span style="margin-left:6px; font-size:11px; color:var(--text-muted);">${snow.total ?? "—"}/30</span>
  </div>`;
}

// PR A10 — Portfolio Analyzer Tier-1 hero trio.
// Three big numbers — Invested / What it's worth today / Net P&L — read
// first, with P&L as the dominant element. Uses formatINR(v, compact)
// for headline-grade digit density (₹1.23 Cr / ₹45.6 L) and
// signedColorFor for the P&L direction so a 0.3 % swing renders pale
// and a 12 % swing reads deep + ▲/▼.
function renderAnalyzerHeroTrio(snap) {
  if (!snap) return "";
  const inv = snap.totalInvested;
  const cur = snap.totalCurrent;
  const pnl = snap.totalPnL;
  const pnlPct = snap.totalPnLPct;
  const sc = (typeof signedColorFor === "function" && Number.isFinite(pnlPct))
    ? signedColorFor(pnlPct)
    : { color: "var(--text-muted)", glyph: "·", srLabel: "" };
  const pnlValue = (Number.isFinite(pnl) && typeof formatINR === "function")
    ? formatINR(pnl, { compact: true, signed: true })
    : (Number.isFinite(pnl) ? `₹${Math.round(pnl).toLocaleString("en-IN")}` : "—");
  const pnlPctTxt = Number.isFinite(pnlPct) ? `${pnlPct >= 0 ? "+" : ""}${pnlPct}%` : "—";
  const invValue = (Number.isFinite(inv) && typeof formatINR === "function")
    ? formatINR(inv, { compact: true })
    : (Number.isFinite(inv) ? `₹${Math.round(inv).toLocaleString("en-IN")}` : "—");
  const curValue = (Number.isFinite(cur) && typeof formatINR === "function")
    ? formatINR(cur, { compact: true })
    : (Number.isFinite(cur) ? `₹${Math.round(cur).toLocaleString("en-IN")}` : "—");
  return `
    <div class="analyzer-hero-trio l-grid" style="--min: 200px; --gap: var(--space-200); margin-bottom: var(--space-200);">
      <div class="l-box" style="--pad: var(--space-300);">
        <div class="tx-micro">Money put in</div>
        <div class="tx-display tx-num" style="font-size: 32px; line-height: 1.1;">${invValue}</div>
      </div>
      <div class="l-box" style="--pad: var(--space-300);">
        <div class="tx-micro">What it's worth today</div>
        <div class="tx-display tx-num" style="font-size: 32px; line-height: 1.1;">${curValue}</div>
      </div>
      <div class="l-box" style="--pad: var(--space-300); border-color: ${sc.color === "var(--text-muted)" ? "var(--border)" : sc.color}; box-shadow: var(--elev-2);">
        <div class="tx-micro">Net P&L</div>
        <div class="tx-display tx-num" style="font-size: 40px; line-height: 1.05; color: ${sc.color};" aria-label="${sc.srLabel || (Number.isFinite(pnlPct) ? `P&L ${pnlPct} percent` : "P&L")}">
          <span aria-hidden="true">${sc.glyph}</span> ${pnlValue}
        </div>
        <div class="tx-meta" style="color: ${sc.color};">${pnlPctTxt}</div>
      </div>
    </div>`;
}

// PR A10 — Action-mix as a 100 %-width stacked bar.
// The chip row sums to a count but the bar makes the distribution visible
// at a glance ("most are HOLD; 2 to top up; 1 to trim"). Each segment is
// click-through to the same openActionListModal that the chips used.
function renderAnalyzerActionMixBar(snap) {
  const mix = snap && snap.actionMix ? snap.actionMix : {};
  const entries = Object.entries(mix).filter(([, n]) => Number(n) > 0);
  if (entries.length === 0) return "";
  const total = entries.reduce((acc, [, n]) => acc + Number(n), 0) || 1;

  // Group into Reduce / Hold / Top-up / Exit. Anything that doesn't match
  // bucks the bar and stays as a residual chip beneath.
  const buckets = { Reduce: 0, Hold: 0, "Top-up": 0, Exit: 0 };
  const colours = {
    Reduce:   "var(--negative-soft)",
    Hold:     "var(--info)",
    "Top-up": "var(--positive-soft)",
    Exit:     "var(--negative)",
  };
  const fallback = [];
  for (const [action, n] of entries) {
    if (action.startsWith("Reduction-")) buckets.Reduce += Number(n);
    else if (action.startsWith("Top-up-")) buckets["Top-up"] += Number(n);
    else if (action === "HOLD") buckets.Hold += Number(n);
    else if (action === "EXIT" || action.startsWith("EXIT-")) buckets.Exit += Number(n);
    else fallback.push([action, Number(n)]);
  }
  const segments = Object.entries(buckets)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => {
      const pct = (n / total) * 100;
      const slug = label.replace(/[^A-Za-z0-9]/g, "");
      return `
        <button type="button"
                class="analyzer-actionmix-segment"
                title="${n} ${label} stock${n === 1 ? "" : "s"} — click for details"
                aria-label="${n} ${label} stocks (${pct.toFixed(0)} percent)"
                onclick="window.openActionListModalForBucket && window.openActionListModalForBucket('${slug}')"
                style="flex: ${n.toFixed(2)}; min-width: ${Math.max(pct, 8).toFixed(2)}%; background: ${colours[label]}; border: 0; padding: 0; cursor: pointer; height: 100%; position: relative;">
          <span class="tx-micro" style="position:absolute; left:8px; top:4px; color: var(--bg-primary); font-weight:700;">${label}</span>
          <span class="tx-num" style="position:absolute; right:8px; bottom:4px; color: var(--bg-primary); font-weight:700;">${n}</span>
        </button>`;
    }).join("");

  const residual = fallback.map(([action, n]) => `
    <button type="button" class="analyzer-actionmix-residual"
            onclick="openActionListModal('${swsEscapeAttr(action)}')"
            style="background:transparent; border:1px solid var(--border); padding:4px 10px; border-radius:var(--radius-full); cursor:pointer; font-size:12px; color:var(--text-muted);">
      ${swsActionBadge(action)}<span style="margin-left:6px;">×${n}</span>
    </button>`).join("");

  return `
    <div class="l-box" style="--pad: var(--space-200); margin-bottom: var(--space-200);">
      <div class="tx-micro" style="margin-bottom: 8px;">Action mix · ${total} holding${total === 1 ? "" : "s"}</div>
      <div class="analyzer-actionmix-bar" style="display:flex; gap:2px; height:36px; border-radius: var(--radius-100); overflow:hidden; background: rgba(255,255,255,0.04);">
        ${segments}
      </div>
      ${residual ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">${residual}</div>` : ""}
    </div>`;
}

// PR A10 — bucket-level openActionListModal. Bridges the bar segments
// (Reduce/Hold/Top-up/Exit) into the existing per-action modal by picking
// a representative member action — openActionListModal pre-filters by
// action so the modal still surfaces the right rows.
window.openActionListModalForBucket = function openActionListModalForBucket(slug) {
  const REPRESENTATIVE = {
    Reduce: "Reduction-33%",
    Hold:   "HOLD",
    Topup:  "Top-up-33%",
    Exit:   "EXIT",
  };
  const action = REPRESENTATIVE[slug];
  if (action && typeof openActionListModal === "function") openActionListModal(action);
};

function swsKpiCard(label, valueHtml) {
  return `<div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; padding:12px 14px;">
    <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px;">${label}</div>
    <div style="font-size:18px; font-weight:700;">${valueHtml}</div>
  </div>`;
}

const HEALTH_VERDICT_PALETTE = {
  HEALTHY:         { color: "#22c55e", label: "HEALTHY" },
  GOOD:            { color: "#60a5fa", label: "GOOD" },
  NEEDS_ATTENTION: { color: "#fbbf24", label: "NEEDS ATTENTION" },
  AT_RISK:         { color: "#fb923c", label: "AT RISK" },
  CRITICAL:        { color: "#ef4444", label: "CRITICAL" },
};

function renderPortfolioHealthHero(ph) {
  if (!ph || !Number.isFinite(ph.score)) return "";
  const color = ph.color || "#60a5fa";
  const score = ph.score;
  const grade = ph.grade || "—";
  const band = ph.band || "";
  const verdict = ph.verdict || null;
  const verdictMeta = verdict ? HEALTH_VERDICT_PALETTE[verdict] : null;
  const note = swsEscapeAttr(ph.methodologyNote || "");
  const C = 238.76;
  const offset = +(C * (1 - score / 100)).toFixed(2);
  // The score number uses var(--text-primary) explicitly. The undefined
  // var(--text) it used to reference fell through to the SVG default
  // (black) and rendered invisibly on the dark page background.
  const ring = `<svg viewBox="0 0 92 92" width="92" height="92" style="display:block;">
    <circle cx="46" cy="46" r="38" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"></circle>
    <circle cx="46" cy="46" r="38" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${C}" stroke-dashoffset="${offset}"
      transform="rotate(-90 46 46)"></circle>
    <text x="46" y="49" text-anchor="middle" dominant-baseline="middle" style="font-size:24px; font-weight:700; fill:var(--text-primary, #EDEDED);">${score}</text>
    <text x="46" y="68" text-anchor="middle" dominant-baseline="middle" style="font-size:10px; fill:var(--text-muted); letter-spacing:0.5px;">/ 100</text>
  </svg>`;

  const driverItem = (d) =>
    `<div style="display:flex; align-items:center; gap:6px; font-size:12px; line-height:1.6;">
      <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#22c55e;"></span>
      <span style="color:var(--text-primary, #EDEDED); flex:1;">${swsEscapeAttr(d.label)}</span>
      <span style="color:#86efac; font-weight:700; font-size:11px;">+${(+d.delta).toFixed(1)}</span>
    </div>`;
  const dragItem = (d) =>
    `<div style="display:flex; align-items:center; gap:6px; font-size:12px; line-height:1.6;">
      <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#ef4444;"></span>
      <span style="color:var(--text-primary, #EDEDED); flex:1;">${swsEscapeAttr(d.label)}</span>
      <span style="color:#fca5a5; font-weight:700; font-size:11px;">${(+d.delta).toFixed(1)}</span>
    </div>`;

  const driversHtml = (ph.topDrivers || []).length
    ? (ph.topDrivers || []).map(driverItem).join("")
    : `<div style="font-size:12px; color:var(--text-muted);">No material drivers</div>`;
  const dragsHtml = (ph.topDrags || []).length
    ? (ph.topDrags || []).map(dragItem).join("")
    : `<div style="font-size:12px; color:var(--text-muted);">No material drags</div>`;

  const notesHtml = (ph.notes && ph.notes.length)
    ? `<div style="font-size:11px; color:var(--text-muted); margin-top:8px; line-height:1.5; font-style:italic;">${(ph.notes || []).map((n) => swsEscapeAttr(n)).join(" · ")}</div>`
    : "";

  // Verdict pill — sits next to the grade letter so the user reads the
  // word ("AT RISK") instead of guessing what "D" maps to.
  const verdictPill = verdictMeta
    ? `<span style="display:inline-block; padding:3px 9px; border-radius:4px; background:${verdictMeta.color}22; color:${verdictMeta.color}; font-size:11px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase;">${verdictMeta.label}</span>`
    : "";

  // Caps caution chip — surfaces when one or more hard caps clamped the
  // score below the additive sum. We show the most-binding cap; the rest
  // are listed in `notes`.
  let capsHtml = "";
  if (Array.isArray(ph.caps) && ph.caps.length > 0) {
    const lowest = ph.caps.slice().sort((a, b) => a.capValue - b.capValue)[0];
    const reasonText = swsEscapeAttr(lowest.reason || "Hard cap applied");
    capsHtml = `<div style="margin-top:6px; padding:4px 9px; border-radius:4px; background:rgba(251,146,60,0.10); color:#fb923c; font-size:10px; font-weight:600; letter-spacing:0.3px; max-width:180px; line-height:1.35;" title="${reasonText}">Capped at ${lowest.capValue}: ${reasonText}</div>`;
  }

  // Component breakdown — single-line monospace audit trail so users can
  // see all 7 contributions, not only the top-3 drivers/drags.
  let breakdownHtml = "";
  const cmp = ph.components;
  if (cmp) {
    const fmt = (v) => Math.round(+v ?? 0);
    breakdownHtml = `<div style="flex:1 1 100%; padding-top:8px; border-top:1px solid rgba(255,255,255,0.04); margin-top:4px; font-size:11px; color:var(--text-muted); font-family:'JetBrains Mono', monospace; letter-spacing:0.3px;">
      Q ${fmt(cmp.quality)}/25 · Val ${fmt(cmp.valuation)}/15 · Div ${fmt(cmp.diversification)}/15 · Conc ${fmt(cmp.concentration)}/10 · Risk ${fmt(cmp.risk)}/15 · Loss ${fmt(cmp.lossControl)}/10 · Macro ${fmt(cmp.macro)}/10
    </div>`;
  }

  return `<div class="ph-hero" style="background:linear-gradient(135deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); border:1px solid #2a3349; border-radius:10px; padding:16px 20px; margin-bottom:18px; display:flex; gap:20px; align-items:center; flex-wrap:wrap;">
    <div title="${note}" style="display:flex; flex-direction:column; align-items:center; min-width:120px; cursor:help;">
      ${ring}
      <div style="margin-top:8px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:center;">
        <span style="display:inline-block; padding:3px 9px; border-radius:4px; background:${color}22; color:${color}; font-size:13px; font-weight:700; letter-spacing:0.3px;">${grade}</span>
        ${verdictPill}
      </div>
      <div style="margin-top:4px; font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px;">${swsEscapeAttr(band)}</div>
      ${capsHtml}
    </div>
    <div style="flex:1; min-width:280px; display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:18px;">
      <div>
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Portfolio Health · What's helping</div>
        ${driversHtml}
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">What's hurting</div>
        ${dragsHtml}
      </div>
    </div>
    ${breakdownHtml}
    ${notesHtml ? `<div style="flex:1 1 100%;">${notesHtml}</div>` : ""}
  </div>`;
}

function swsHoldingRow(h) {
  const sws = h.sws || {};
  const tk = sws.ticker || h.symbol || "—";
  const name = sws.name || h.name || "";
  const v3 = sws.v3_score != null ? sws.v3_score : "—";
  const verdict = sws.verdict || "—";
  const cv = h.currentValue;
  const pos = h.positionWeight != null ? h.positionWeight + "%" : "—";
  const pnlPct = h.pnlPercent;
  // Inline ₹ pill — shows the rupee size of the chosen rung next to the
  // action badge so the user sees "Reduction-33% · ₹12,400" at a glance.
  // Pulls from V3-emitted trimRupees / topUpRupees on the holding object.
  const rupeesInline = (() => {
    const r = h.trimRupees ?? h.topUpRupees ?? null;
    if (!Number.isFinite(r) || r <= 0) return "";
    return `<div style="font-size:10px; color:var(--text-muted); margin-top:3px;">${inr(r)}</div>`;
  })();
  return `<tr style="border-top:1px solid #2a3349; cursor:pointer;" onclick="openStockDetailModal('${tk}','mf-overlap')">
    <td style="padding:10px 12px;">
      <div style="font-weight:600;">${tk} ${swsSurveillanceChip(sws.surveillance)}</div>
      <div style="font-size:11px; color:var(--text-muted);">${swsEscapeAttr(name)}${sws.sector ? " · " + swsEscapeAttr(sws.sector) : ""}</div>
    </td>
    <td style="padding:10px 12px;">${swsActionBadge(h.action)}${rupeesInline}</td>
    <td style="padding:10px 12px;">
      <div style="font-weight:600;">${v3}</div>
      <div style="font-size:10px; color:var(--text-muted);">${verdict}</div>
    </td>
    <td style="padding:10px 12px;">${swsSnowflakeMini(sws.snowflake)}</td>
    <td style="padding:10px 12px;">
      <div>${inr(cv)}</div>
      <div style="font-size:10px; color:var(--text-muted);">${pos} of book</div>
    </td>
    <td style="padding:10px 12px; text-align:right; color:${pctColor(pnlPct)}; font-weight:600;">${pnlPct != null ? (pnlPct >= 0 ? "+" : "") + pnlPct + "%" : "—"}</td>
    <td style="padding:10px 12px; text-align:right; color:#86efac; font-weight:600;">${h.freedRupees != null ? inr(h.freedRupees) : "—"}</td>
    <td style="padding:10px 12px;">${swsTimingBadge(h.timing)}</td>
  </tr>`;
}

// Conviction colors for the v2 conviction engine — used by both the
// row dot and the expanded card badge. HIGH/LOW edges are green/red,
// MEDIUM is muted; MEDIUM-HIGH/MEDIUM-LOW lean toward their endpoints.
const SWS_CONVICTION_COLORS = {
  HIGH:          { bg: "rgba(34,197,94,0.18)",   border: "rgba(34,197,94,0.6)",   text: "#86efac" },
  "MEDIUM-HIGH": { bg: "rgba(34,197,94,0.10)",   border: "rgba(34,197,94,0.4)",   text: "#86efac" },
  MEDIUM:        { bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.4)", text: "#cbd5e1" },
  "MEDIUM-LOW":  { bg: "rgba(250,204,21,0.10)",  border: "rgba(250,204,21,0.4)",  text: "#fde047" },
  LOW:           { bg: "rgba(239,68,68,0.10)",   border: "rgba(239,68,68,0.4)",   text: "#fca5a5" },
};

// Conviction badge with net layer delta. Pulls from v2_recommendation
// when present, falls back to convictionProxy from the ladder promotion.
function swsConvictionBadge(rec, fallbackProxy) {
  const conviction = rec?.conviction || fallbackProxy || null;
  if (!conviction) return "";
  const c = SWS_CONVICTION_COLORS[conviction] || SWS_CONVICTION_COLORS.MEDIUM;
  const layerCount = rec?.net_delta != null
    ? `Δ${rec.net_delta > 0 ? "+" : ""}${rec.net_delta}`
    : "";
  return `<span title="Net layer delta — positive escalates SWS action in its direction (1 rung max); for HOLD, the sign of layer-vote consensus picks bullish/bearish promotion. Negative softens by 1 rung." style="display:inline-block; padding:2px 7px; border-radius:4px; background:${c.bg}; border:1px solid ${c.border}; color:${c.text}; font-size:10px; font-weight:700; letter-spacing:0.3px;">${conviction}${layerCount ? " · " + layerCount : ""}</span>`;
}

// Peer-rotation chip — clickable, opens stock detail modal for the peer.
// Uses the top_peer field from peer_substitute.
function swsTopPeerChip(holding) {
  const peer = holding?.sws?.peer_substitute;
  if (!peer || !peer.top_peer) return "";
  const top = peer.top_peer;
  const tk = swsEscapeAttr(top.ticker);
  const why = swsEscapeAttr(top.why || "");
  return `<div style="margin-top:8px; padding:6px 10px; background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.25); border-radius:5px; font-size:11px; cursor:pointer;" onclick="openStockDetailModal('${tk}','peer-rotation')" title="Same-sector peer with higher v3 — consider as rotation candidate">
    <strong style="color:#93c5fd;">↻ Peer: ${tk}</strong> <span style="color:var(--text-muted);">— ${why}</span>
  </div>`;
}

// Surveillance chip — red for GSM (severe), amber for ASM (lighter).
// Pure rendering helper consumed by both the table row and the expanded
// reason panel.
function swsSurveillanceChip(surv) {
  if (!surv || !surv.list) return "";
  const isGsm = surv.list === "GSM";
  const bg = isGsm ? "rgba(220,38,38,0.18)" : "rgba(234,88,12,0.16)";
  const border = isGsm ? "rgba(220,38,38,0.5)" : "rgba(234,88,12,0.5)";
  const color = isGsm ? "#fca5a5" : "#fdba74";
  const label = `${surv.list}${surv.stage ? `-${surv.stage}` : ""}${surv.timeframe ? ` · ${surv.timeframe}` : ""}`;
  const tooltip = isGsm
    ? "NSE Graded Surveillance Measure — regulatory caution / restricted trading"
    : "NSE Additional Surveillance Measure — heightened monitoring";
  return `<span title="${swsEscapeAttr(tooltip)}" style="display:inline-block; padding:2px 8px; border-radius:4px; background:${bg}; border:1px solid ${border}; color:${color}; font-size:10px; font-weight:700; letter-spacing:0.4px; vertical-align:middle;">⚠ ${label}</span>`;
}

// Larger snowflake hex display for the expanded card. Each axis is
// labeled, scored 0-6, and tinted by score so the strong/weak axes are
// visually obvious.
function swsSnowflakeFull(snow) {
  if (!snow) return "";
  const axes = [
    { k: "Valuation",      v: snow.valuation },
    { k: "Future Growth",  v: snow.future_growth },
    { k: "Past Perf.",     v: snow.past_performance },
    { k: "Health",         v: snow.financial_health },
    { k: "Dividends",      v: snow.dividends },
  ];
  return `<div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:6px;">
    ${axes.map((a) => {
      const score = a.v ?? 0;
      const intensity = score / 6;
      const bg = `rgba(59,130,246,${0.08 + intensity * 0.18})`;
      const border = `rgba(59,130,246,${0.2 + intensity * 0.35})`;
      const color = score >= 4 ? "#bfdbfe" : score >= 2 ? "#93c5fd" : "#64748b";
      return `<div style="background:${bg}; border:1px solid ${border}; border-radius:6px; padding:8px 6px; text-align:center;">
        <div style="font-size:9px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px; margin-bottom:2px;">${a.k}</div>
        <div style="font-size:18px; font-weight:700; color:${color}; line-height:1.1;">${a.v ?? "—"}<span style="font-size:10px; color:var(--text-muted); font-weight:500;">/6</span></div>
      </div>`;
    }).join("")}
  </div>
  <div style="text-align:center; margin-top:6px; font-size:11px; color:var(--text-muted);">Snowflake total <strong style="color:#93c5fd;">${snow.total ?? "—"}/30</strong></div>`;
}

// Catalyst calendar — renders pending earnings + analyst PT actions +
// insider buys as a stacked list. Empty state is handled by the caller.
function swsCatalystCalendar(catalyst) {
  if (!catalyst || !catalyst.available) return "";
  const items = [];
  if (catalyst.next_earnings_days != null && catalyst.next_earnings_days >= 0) {
    items.push(`<div>📅 Earnings in <strong>${catalyst.next_earnings_days}d</strong></div>`);
  }
  if (Array.isArray(catalyst.recent_pt_actions) && catalyst.recent_pt_actions.length > 0) {
    items.push(`<div>📊 ${catalyst.recent_pt_actions.length} recent analyst PT action(s)</div>`);
  }
  if (catalyst.insider_buys_count > 0) {
    items.push(`<div>🟢 ${catalyst.insider_buys_count} insider buy(s)</div>`);
  }
  if (Array.isArray(catalyst.pending_catalysts) && catalyst.pending_catalysts.length > 0) {
    for (const c of catalyst.pending_catalysts.slice(0, 3)) {
      const urgencyDot = c.urgency === "high" ? "🔴" : c.urgency === "medium" ? "🟡" : "⚪";
      items.push(`<div>${urgencyDot} ${swsEscapeAttr(c.text || c.kind || "")}</div>`);
    }
  }
  if (items.length === 0) return "";
  return `<div style="margin-top:10px; padding:8px 10px; background:rgba(59,130,246,0.05); border:1px solid rgba(59,130,246,0.15); border-radius:5px; font-size:11px;">
    <div style="font-weight:700; color:#93c5fd; margin-bottom:4px; letter-spacing:0.3px;">Catalysts</div>
    <div style="display:flex; flex-direction:column; gap:3px; line-height:1.5;">${items.join("")}</div>
  </div>`;
}

// Peer-substitute card — shows up to 2 same-sector higher-v3 alternatives
// with one-line "why this peer beats yours" reasoning.
function swsPeerSubstitutes(peer) {
  if (!peer || !peer.available || !Array.isArray(peer.peers) || peer.peers.length === 0) return "";
  const peers = peer.peers.slice(0, 2);
  return `<div style="margin-top:10px; padding:8px 10px; background:rgba(34,197,94,0.05); border:1px solid rgba(34,197,94,0.15); border-radius:5px; font-size:11px;">
    <div style="font-weight:700; color:#86efac; margin-bottom:4px; letter-spacing:0.3px;">Peer substitutes (same sector, higher v3)</div>
    <div style="display:flex; flex-direction:column; gap:4px;">
      ${peers.map((p) => `<div>
        <strong>${swsEscapeAttr(p.ticker)}</strong>
        <span style="color:var(--text-muted);"> v3 ${p.v3_score ?? "—"}, snow ${p.snowflake_total ?? "—"}/30</span>
        ${p.why ? `<div style="color:var(--text-muted); margin-top:2px; line-height:1.4;">${swsEscapeAttr(p.why)}</div>` : ""}
      </div>`).join("")}
    </div>
  </div>`;
}

// Audit-trail nested details — decision path + citations + version refs
// for SEBI-RA compliance reproducibility. Collapsed by default.
function swsAuditTrailDetails(audit) {
  if (!audit || !audit.decision_path) return "";
  const versions = audit.versions || {};
  const versionLine = Object.entries(versions).map(([k, v]) => `${k}=${v}`).join(" · ");
  const citations = Array.isArray(audit.citations) ? audit.citations : [];
  return `<details style="margin-top:10px; padding:8px 10px; background:rgba(0,0,0,0.2); border:1px solid #1f2937; border-radius:5px; font-size:11px;">
    <summary style="cursor:pointer; font-weight:700; color:var(--text-muted); letter-spacing:0.3px;">Audit trail (decision reproducibility)</summary>
    <div style="margin-top:6px;">
      <div style="font-weight:700; color:var(--text-muted); margin-bottom:3px; font-size:10px; text-transform:uppercase; letter-spacing:0.4px;">Decision path</div>
      <ol style="margin:0; padding-left:16px; line-height:1.5;">
        ${(audit.decision_path || []).map((s) => `<li>${swsEscapeAttr(typeof s === "string" ? s : s.step || JSON.stringify(s))}</li>`).join("")}
      </ol>
      ${citations.length > 0 ? `<div style="margin-top:8px; color:var(--text-muted);"><strong style="color:var(--text);">Citations:</strong> ${citations.length} source(s)</div>` : ""}
      ${versionLine ? `<div style="margin-top:6px; font-size:10px; color:var(--text-muted); font-family:monospace;">${swsEscapeAttr(versionLine)}</div>` : ""}
    </div>
  </details>`;
}

function swsReasonRow(h) {
  if (!h.reasons || h.reasons.length === 0) return "";
  const tk = h.sws?.ticker || h.symbol || "—";
  const sws = h.sws || {};
  const rec = sws.v2_recommendation || null;
  const ov = sws;
  const fvLine = (ov.fair_value_inr != null && ov.current_price_inr != null)
    ? `<div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">
        AnalystConsensus FV <strong style="color:var(--text);">₹${Number(ov.fair_value_inr).toFixed(0)}</strong> vs current
        <strong style="color:var(--text);">₹${Number(ov.current_price_inr).toFixed(0)}</strong>
        ${ov.upside_pct != null ? `<span style="color:${ov.upside_pct >= 0 ? '#86efac' : '#f87171'};"> · ${ov.upside_pct >= 0 ? '+' : ''}${ov.upside_pct.toFixed(1)}% to FV</span>` : ""}
      </div>`
    : "";

  const timingBox = h.timing && h.timing.reason
    ? `<div style="font-size:11px; color:var(--text-muted); padding:6px 10px; background:rgba(0,0,0,0.2); border-radius:4px;"><strong style="color:var(--text);">Timing:</strong> ${swsEscapeAttr(h.timing.reason)}</div>`
    : "";

  return `<details style="margin-top:8px; background:rgba(255,255,255,0.02); border:1px solid #1f2937; border-radius:6px; padding:10px 14px;">
    <summary style="cursor:pointer; font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
      <strong style="color:var(--text);">${tk}</strong>
      <span>· why this action</span>
      ${swsSurveillanceChip(sws.surveillance)}
      ${swsConvictionBadge(rec, h.convictionProxy)}
    </summary>
    <div style="margin-top:12px;">
      ${fvLine}
      ${swsSnowflakeFull(sws.snowflake)}
    </div>
    <div style="margin-top:12px; display:flex; flex-direction:column; gap:10px;">
      ${timingBox}
      ${swsCatalystCalendar(sws.catalyst)}
      ${swsTopPeerChip(h)}
      ${swsPeerSubstitutes(sws.peer_substitute)}
    </div>
    ${swsAuditTrailDetails(h.audit)}
  </details>`;
}

function renderSWSTierA(tier) {
  if (!tier || !tier.rows || tier.rows.length === 0) {
    return `<div style="margin-bottom:18px;">
      <div style="font-size:13px; font-weight:700; margin-bottom:8px; color:var(--text-muted);">Tier A · Reductions</div>
      <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; padding:14px; font-size:12px; color:var(--text-muted);">No reductions flagged — every covered holding scored ≥ FAIR_VALUE.</div>
    </div>`;
  }
  return `<div style="margin-bottom:22px;">
    <div style="display:flex; align-items:baseline; justify-content:space-between; margin-bottom:10px; gap:12px; flex-wrap:wrap;">
      <div style="font-size:14px; font-weight:700;">Tier A · Reductions <span style="color:var(--text-muted); font-weight:500; font-size:12px;">(${tier.rows.length})</span></div>
      <div style="font-size:12px; color:var(--text-muted);">Frees up <strong style="color:#86efac;">${inr(tier.freedRupees || 0)}</strong> for Tier B deployment</div>
    </div>
    <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <thead>
          <tr style="background:rgba(0,0,0,0.2); text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted);">
            <th style="padding:10px 12px;">Stock</th>
            <th style="padding:10px 12px;">Action</th>
            <th style="padding:10px 12px;">v3 score</th>
            <th style="padding:10px 12px;">Snowflake</th>
            <th style="padding:10px 12px;">Position</th>
            <th style="padding:10px 12px; text-align:right;">P&amp;L</th>
            <th style="padding:10px 12px; text-align:right;">Freed ₹</th>
            <th style="padding:10px 12px;">Timing</th>
          </tr>
        </thead>
        <tbody>
          ${tier.rows.map(swsHoldingRow).join("")}
        </tbody>
      </table>
    </div>
    ${tier.rows.map(swsReasonRow).filter(Boolean).join("")}
  </div>`;
}

// Upcoming results calendar — every held equity sorted by its next
// quarterly/annual result date. Three blocks rendered in order:
//   1. Future + today        — ascending by date (soonest first)
//   2. Past (stale)          — most-recently-past first; date rendered with
//                              "(past)" suffix and days-ago marker. Useful
//                              while the data source catches up post-result.
//   3. Truly unknown         — "—" / "—". Bottom of table.
// Sort encoding packs the three blocks into a single comparator key:
//   future → ms (small ~1.78e12 range)
//   past   → 1e15 + (nowMs - ms), so newer past < older past
//   unknown→ Infinity
// Data source: report.holdingsByAction (one entry per scored holding, Tier
// A∪C∪D), each h carries h.sws.next_earnings_date populated by
// services/swsPortfolioAggregate.js:253 from the SWS deep file's overview.
// Date math mirrors the catalyst layer pattern at swsCatalystLayer.js:31
// (UTC midnight + Math.ceil) so an IST user sees days=0 ("today") for the
// whole IST day on a same-date stock, not negative-seconds at midnight.
function renderSWSEarningsCalendar(report) {
  const all = Object.values(report?.holdingsByAction || {}).flat();
  const seen = new Set();
  const equity = [];
  for (const h of all) {
    const key = h?.sws?.ticker || h?.symbol;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    equity.push(h);
  }
  if (equity.length === 0) return "";

  const PAST_BLOCK = 1e15;
  const UNKNOWN_KEY = Number.POSITIVE_INFINITY;
  const nowMs = Date.now();
  const keyOf = (h) => {
    const d = h?.sws?.next_earnings_date;
    if (!d) return UNKNOWN_KEY;
    const ms = Date.parse(d + "T00:00:00Z");
    if (!Number.isFinite(ms)) return UNKNOWN_KEY;
    const days = Math.ceil((ms - nowMs) / 86_400_000);
    if (days >= 0) return ms;
    return PAST_BLOCK + (nowMs - ms);
  };
  const rows = equity.slice().sort((a, b) => {
    const ka = keyOf(a), kb = keyOf(b);
    if (ka !== kb) return ka - kb;
    return String(a?.symbol || "").localeCompare(String(b?.symbol || ""));
  });

  const stripSuffix = (s) => String(s || "").replace(/\.(NS|BO|BSE)$/i, "");

  const rowHtml = rows.map((h, i) => {
    const d = h?.sws?.next_earnings_date;
    const ms = d ? Date.parse(d + "T00:00:00Z") : NaN;
    const days = Number.isFinite(ms) ? Math.ceil((ms - nowMs) / 86_400_000) : null;
    const isFuture = Number.isFinite(ms) && days != null && days >= 0;
    const isPast = Number.isFinite(ms) && days != null && days < 0;
    let showDate, showDays, daysColor;
    if (isFuture) {
      showDate = new Date(ms).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      showDays = days === 0 ? "today" : `${days}d`;
      daysColor = days <= 7 ? "#fbbf24" : "var(--text-muted)";
    } else if (isPast) {
      const iso = new Date(ms).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      showDate = `${iso} <span style="color:var(--text-muted); font-size:11px;">(past)</span>`;
      showDays = `${Math.abs(days)}d ago`;
      daysColor = "var(--text-muted)";
    } else {
      showDate = "—";
      showDays = "—";
      daysColor = "var(--text-muted)";
    }
    const rowOpacity = isPast ? "0.7" : "1";
    const tickerCell = stripSuffix(h?.sws?.ticker || h?.symbol || "");
    const position = (typeof formatINR === "function")
      ? formatINR(h?.currentValue ?? h?.invested ?? 0, { compact: true })
      : "—";
    return `<tr style="border-bottom:1px solid #1a2238; opacity:${rowOpacity};">
      <td style="padding:10px 12px; color:var(--text-muted);">${i + 1}</td>
      <td style="padding:10px 12px;">
        <strong style="font-size:13px;">${swsEscapeAttr(tickerCell)}</strong>
        <div style="font-size:11px; color:var(--text-muted);">${swsEscapeAttr(h?.name || "")}</div>
      </td>
      <td style="padding:10px 12px; font-size:12px; color:var(--text-muted);">${swsEscapeAttr(h?.sector || "—")}</td>
      <td style="padding:10px 12px; text-align:right; font-variant-numeric:tabular-nums;">${position}</td>
      <td style="padding:10px 12px; font-variant-numeric:tabular-nums;">${showDate}</td>
      <td style="padding:10px 12px; font-variant-numeric:tabular-nums; color:${daysColor};">${showDays}</td>
    </tr>`;
  }).join("");

  return `<details class="analyzer-tier-details" style="margin-top: var(--space-200);">
    <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Upcoming results calendar <span style="color:var(--text-muted); font-weight:500; font-size:12px;">(${rows.length})</span></summary>
    <div style="padding-top: var(--space-200);">
      <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;" aria-label="Holdings sorted ascending by next result date">
          <thead>
            <tr style="background:rgba(0,0,0,0.2); text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted);">
              <th style="padding:10px 12px;">#</th>
              <th style="padding:10px 12px;">Stock</th>
              <th style="padding:10px 12px;">Sector</th>
              <th style="padding:10px 12px; text-align:right;">Position</th>
              <th style="padding:10px 12px;">Result date</th>
              <th style="padding:10px 12px;">Days until</th>
            </tr>
          </thead>
          <tbody>${rowHtml}</tbody>
        </table>
      </div>
    </div>
  </details>`;
}

function swsBasketRow(r) {
  // PR P9 — replace hard-coded green/red with magnitude-keyed signedColorFor.
  // A 0.3 % upside renders pale; a 12 % upside reads deep + ▲. Glyph
  // aria-hidden; srLabel carries "up X percent" for VoiceOver.
  let upside;
  if (r.upside_pct == null) {
    upside = "—";
  } else {
    const sc = signedColorFor(r.upside_pct);
    upside = `<span class="tx-num" style="color:${sc.color};" aria-label="${sc.srLabel} to fair value"><span aria-hidden="true">${sc.glyph}</span> ${r.upside_pct >= 0 ? "+" : ""}${r.upside_pct.toFixed(1)}%</span>`;
  }
  const sourceTag = r.source === "holding"
    ? `<span title="In-portfolio top-up" style="font-size:9px; padding:1px 6px; background:rgba(34,197,94,0.12); color:#86efac; border-radius:3px; letter-spacing:0.3px;">HELD</span>`
    : `<span title="Outside-portfolio fresh pick" style="font-size:9px; padding:1px 6px; background:rgba(59,130,246,0.12); color:#93c5fd; border-radius:3px; letter-spacing:0.3px;">FRESH</span>`;
  const gapTag = r.gapType === "missing"
    ? `<span title="Fills missing sector exposure" style="font-size:9px; padding:1px 6px; background:rgba(251,191,36,0.14); color:#fbbf24; border-radius:3px; letter-spacing:0.3px;">GAP</span>`
    : r.gapType === "underweight"
    ? `<span title="Underweight sector — room to add" style="font-size:9px; padding:1px 6px; background:rgba(167,139,250,0.14); color:#a78bfa; border-radius:3px; letter-spacing:0.3px;">UNDER</span>`
    : "";
  const suggested = r.suggested_inr ? `<div style="font-size:10px; color:var(--text-muted);">Suggested ${inr(r.suggested_inr)}</div>` : "";
  const whyFit = r.whyFit ? `<div style="margin-top:3px; font-size:11px; color:#a5b4fc; font-style:italic; line-height:1.35;">${swsEscapeAttr(r.whyFit)}</div>` : "";
  return `<div style="padding:10px 14px; border-bottom:1px solid #1a2238; cursor:pointer;" onclick="openStockDetailModal('${r.ticker}','mf-overlap')">
    <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <strong style="font-size:13px;">${r.ticker}</strong>
        ${sourceTag}
        ${gapTag}
      </div>
      <div style="font-size:11px; color:var(--text-muted); font-weight:600;">v3 ${r.v3_score ?? "—"}</div>
    </div>
    <div style="margin-top:4px; font-size:11px; color:var(--text-muted); display:flex; gap:10px; flex-wrap:wrap;">
      <span>${swsEscapeAttr(r.sector || "—")}</span>
      <span>${swsSnowflakeMini(r.snowflake)}</span>
    </div>
    <div style="margin-top:4px; display:flex; justify-content:space-between; gap:8px; font-size:11px;">
      <span>FV: ${upside}</span>
      <span style="color:var(--text-muted);">P/E ${r.multiples?.pe?.toFixed?.(1) ?? "—"}x · Yield ${r.dividend_yield_pct?.toFixed?.(1) ?? "—"}%</span>
    </div>
    ${whyFit}
    ${suggested}
  </div>`;
}

function swsBasketCard(title, criteria, rows, accentColor) {
  return `<div style="background:var(--panel); border:1px solid #2a3349; border-radius:10px; overflow:hidden;">
    <div style="padding:12px 14px; border-bottom:1px solid #2a3349; background:rgba(0,0,0,0.15);">
      <div style="font-size:13px; font-weight:700; color:${accentColor};">${title} <span style="color:var(--text-muted); font-weight:500;">(${rows.length})</span></div>
      <div style="font-size:10px; color:var(--text-muted); margin-top:3px; letter-spacing:0.2px;">${criteria}</div>
    </div>
    <div style="max-height:380px; overflow-y:auto;">
      ${rows.length === 0
        ? `<div style="padding:14px; font-size:12px; color:var(--text-muted);">No qualifying picks in current snapshot.</div>`
        : rows.map(swsBasketRow).join("")}
    </div>
  </div>`;
}

function renderSWSSectorGapSpotlight(gaps, tailwindSummary) {
  // Always render — even with zero gaps we want the "sector mix is healthy"
  // confirmation, and the tailwind summary stays useful as context.
  const rows = gaps && gaps.length ? gaps : [];
  const tw = (tailwindSummary || []).slice(0, 3);
  const subtitle = rows.length > 0
    ? `Filling missing/underweight sectors with structural tailwinds · sorted by perfect-fit score`
    : `Your sector mix is healthy — no structural gap to fill right now.`;

  // Tailwind sector chips (top 3 missing-or-underweight + tailwind sectors).
  const twChips = tw.length === 0 ? "" : `<div style="padding:10px 14px; border-bottom:1px solid #1a2238; display:flex; flex-wrap:wrap; gap:6px; align-items:center; background:rgba(251,191,36,0.04);">
    <span style="font-size:10px; color:var(--text-muted); letter-spacing:0.4px; text-transform:uppercase; font-weight:700; margin-right:4px;">Tailwind sectors</span>
    ${tw.map((t) => {
      const cls = t.gapType === "missing" ? "background:rgba(251,191,36,0.15); color:#fbbf24;" : t.gapType === "underweight" ? "background:rgba(167,139,250,0.15); color:#a78bfa;" : "background:rgba(34,197,94,0.12); color:#86efac;";
      const tip = (t.evidence || []).map((e) => e.reason).join(" · ");
      return `<span title="${swsEscapeAttr(tip)}" style="font-size:10px; padding:2px 8px; border-radius:4px; ${cls}">${swsEscapeAttr(t.sector)} · ${t.gapType === "missing" ? "0%" : t.currentPct + "%"}</span>`;
    }).join("")}
  </div>`;

  const body = rows.length === 0
    ? `<div style="padding:14px; font-size:12px; color:var(--text-muted);">No qualifying sector-gap candidates in current snapshot.</div>`
    : rows.map(swsBasketRow).join("");

  return `<div style="background:var(--panel); border:1px solid rgba(251,191,36,0.35); border-radius:10px; overflow:hidden; box-shadow:0 0 0 1px rgba(251,191,36,0.08); margin-bottom:14px;">
    <div style="padding:12px 14px; border-bottom:1px solid #2a3349; background:rgba(251,191,36,0.06);">
      <div style="font-size:13px; font-weight:700; color:#fbbf24;">★ Sector Gap Spotlight <span style="color:var(--text-muted); font-weight:500;">(${rows.length})</span></div>
      <div style="font-size:10px; color:var(--text-muted); margin-top:3px; letter-spacing:0.2px;">${subtitle}</div>
    </div>
    ${twChips}
    <div style="max-height:380px; overflow-y:auto;">
      ${body}
    </div>
  </div>`;
}

function renderSWSTierB(baskets) {
  const def = baskets.defensive || [];
  const grw = baskets.growth || [];
  const core = baskets.core || [];
  const gaps = baskets.sectorGaps || [];
  const tw = baskets.tailwindSummary || [];
  if (def.length === 0 && grw.length === 0 && core.length === 0 && gaps.length === 0) {
    return `<div style="margin-bottom:22px;">
      <div style="font-size:13px; font-weight:700; margin-bottom:8px; color:var(--text-muted);">Tier B · Top-ups</div>
      <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; padding:14px; font-size:12px; color:var(--text-muted);">No qualifying top-ups in current snapshot. Picks-latest may need refresh.</div>
    </div>`;
  }
  const perfectFitFloorCopy = "v3 ≥45 · Snowflake ≥16 · Upside ≥8% · sector-fit gated";
  return `<div style="margin-bottom:24px;">
    <div style="display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px;">
      <div style="font-size:14px; font-weight:700;">Tier B · Top-ups <span style="color:var(--text-muted); font-size:12px; font-weight:500;">(Perfect-fit, sector-aware)</span></div>
      <div style="font-size:11px; color:var(--text-muted);">${perfectFitFloorCopy}</div>
    </div>
    ${renderSWSSectorGapSpotlight(gaps, tw)}
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:14px;">
      ${swsBasketCard("Defensive", "Health ≥4 · Div ≥2 · Beta &lt;0.9 · perfect-fit floor", def, "#86efac")}
      ${swsBasketCard("Growth", "v3 verdict STRONG/TOP_PICK or Future ≥4 · perfect-fit floor", grw, "#93c5fd")}
      ${swsBasketCard("Shared Core", "Passes both filters · top 3", core, "#fde047")}
    </div>
  </div>`;
}

function renderSWSTierC(tier) {
  const rows = tier?.rows || [];
  if (rows.length === 0) return "";
  return `<div style="margin-bottom:22px;">
    <div style="font-size:14px; font-weight:700; margin-bottom:10px;">Tier C · Hold as-is <span style="color:var(--text-muted); font-size:12px; font-weight:500;">(${rows.length})</span></div>
    <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; padding:6px 0;">
      ${rows.map((h, i) => {
        const sws = h.sws || {};
        return `<div style="padding:8px 14px; border-top:${i > 0 ? '1px solid #1a2238' : 'none'}; display:flex; justify-content:space-between; align-items:center; gap:10px; cursor:pointer;" onclick="openStockDetailModal('${sws.ticker}','mf-overlap')">
          <div>
            <strong style="font-size:13px;">${sws.ticker}</strong>
            <span style="font-size:11px; color:var(--text-muted); margin-left:8px;">${swsEscapeAttr(sws.name || "")} · ${swsEscapeAttr(sws.sector || "—")}</span>
          </div>
          <div style="display:flex; align-items:center; gap:10px; font-size:11px;">
            <span>v3 <strong>${sws.v3_score ?? "—"}</strong></span>
            ${swsSnowflakeMini(sws.snowflake)}
            <span style="color:${pctColor(h.pnlPercent)};">${h.pnlPercent != null ? (h.pnlPercent >= 0 ? "+" : "") + h.pnlPercent + "%" : "—"}</span>
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function renderSWSTierD(tier) {
  const rows = tier?.rows || [];
  if (rows.length === 0) return "";
  return `<div style="margin-bottom:22px;">
    <div style="font-size:14px; font-weight:700; margin-bottom:10px;">Tier D · Watch <span style="color:var(--text-muted); font-size:12px; font-weight:500;">(${rows.length})</span></div>
    <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; padding:6px 0;">
      ${rows.map((h, i) => {
        const sws = h.sws || {};
        const tk = sws.ticker || h.symbol || "—";
        return `<div style="padding:10px 14px; border-top:${i > 0 ? '1px solid #1a2238' : 'none'};">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
            <div>
              <strong style="font-size:13px;">${tk}</strong>
              <span style="font-size:11px; color:var(--text-muted); margin-left:8px;">${swsEscapeAttr(sws.name || h.name || "")}${sws.sector ? " · " + swsEscapeAttr(sws.sector) : ""}</span>
            </div>
            <div style="font-size:11px; color:var(--text-muted);">${h.swsCovered === false ? '<span style="padding:2px 6px; background:rgba(107,114,128,0.15); border-radius:3px;">No SWS data</span>' : `v3 ${sws.v3_score ?? "—"}`}</div>
          </div>
          <div style="margin-top:4px; font-size:11px; color:#fde047;">${swsEscapeAttr(h.watchReason || "")}</div>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function renderSWSSectorOverlay(rows) {
  if (!rows || rows.length === 0) return "";
  return `<div style="margin-bottom:22px;">
    <div style="font-size:14px; font-weight:700; margin-bottom:10px;">Sector overlay</div>
    <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead>
          <tr style="background:rgba(0,0,0,0.2); text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted);">
            <th style="padding:8px 12px;">Sector</th>
            <th style="padding:8px 12px; text-align:right;">Weight</th>
            <th style="padding:8px 12px; text-align:right;">Avg Snowflake</th>
            <th style="padding:8px 12px; text-align:right;">Avg v3</th>
            <th style="padding:8px 12px;">Holdings</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(s => `<tr style="border-top:1px solid #1a2238;">
            <td style="padding:8px 12px; font-weight:600;">${swsEscapeAttr(s.sector)}</td>
            <td style="padding:8px 12px; text-align:right; font-weight:600;">${s.pct}%</td>
            <td style="padding:8px 12px; text-align:right; color:var(--text-muted);">${s.avgSnowflake ?? "—"}</td>
            <td style="padding:8px 12px; text-align:right; color:var(--text-muted);">${s.avgV3 ?? "—"}</td>
            <td style="padding:8px 12px; font-size:11px; color:var(--text-muted);">${s.holdings.slice(0, 6).map(t => t.replace(/\.NS$/, "")).join(", ")}${s.holdings.length > 6 ? " +" + (s.holdings.length - 6) : ""}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderSWSMfSection(mfPositions) {
  if (!mfPositions) return "";
  if (mfPositions.source === "saved-portfolio" && !mfPositions.enriched) {
    return `<div style="margin-bottom:22px;">
      <div style="font-size:14px; font-weight:700; margin-bottom:10px;">Mutual funds <span style="color:var(--text-muted); font-size:12px; font-weight:500;">(saved-portfolio reference)</span></div>
      <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; padding:6px 0;">
        ${(mfPositions.holdings || []).map((m, i) => `<div style="padding:8px 14px; border-top:${i > 0 ? '1px solid #1a2238' : 'none'}; display:flex; justify-content:space-between; gap:10px; font-size:12px;">
          <div>
            <strong>${swsEscapeAttr(m.name || "—")}</strong>
            <span style="color:var(--text-muted); margin-left:8px;">${swsEscapeAttr(m.category || "")}</span>
          </div>
          <div style="display:flex; gap:14px; color:var(--text-muted);">
            <span>${inr(m.invested)} → ${inr(m.currentValue)}</span>
            <span style="color:${pctColor(m.pnlPercent)};">${m.pnlPercent != null ? (m.pnlPercent >= 0 ? "+" : "") + m.pnlPercent.toFixed(1) + "%" : "—"}</span>
          </div>
        </div>`).join("")}
        <div style="padding:10px 14px; border-top:1px solid #1a2238; font-size:11px; color:var(--text-muted); font-style:italic;">${swsEscapeAttr(mfPositions.note || "")}</div>
      </div>
    </div>`;
  }
  return "";
}

// PR-4: outside-portfolio fresh picks block. Two columns (defensive +
// growth) with the per-pick suggested ₹ and concentration-aware alloc%.
function renderSWSOutsidePicks(picks) {
  if (!picks || !picks.available) return "";
  const total = (picks.growth?.length || 0) + (picks.defensive?.length || 0);
  if (total === 0) return "";
  const triggerLine = (picks.triggerReasons || []).join(" · ");
  const renderColumn = (rows, title, color) => `<div style="background:rgba(0,0,0,0.18); border:1px solid #2a3349; border-radius:8px; padding:12px 14px;">
    <div style="font-size:12px; font-weight:700; color:${color}; margin-bottom:8px; letter-spacing:0.3px;">${title} (${rows.length})</div>
    ${rows.length === 0
      ? `<div style="font-size:11px; color:var(--text-muted);">No qualifying picks in current snapshot.</div>`
      : rows.map((r) => `<div style="padding:8px 0; border-top:1px solid #1a2238; cursor:pointer;" onclick="openStockDetailModal('${swsEscapeAttr(r.ticker)}','outside-pick')">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:baseline;">
          <strong style="font-size:13px;">${swsEscapeAttr(r.ticker)}</strong>
          <span style="font-size:11px; color:var(--text-muted);">v3 ${r.v3_score ?? "—"}</span>
        </div>
        <div style="margin-top:4px; font-size:11px; color:var(--text-muted); display:flex; gap:10px; flex-wrap:wrap;">
          <span>${swsEscapeAttr(r.sector || "—")}</span>
          ${r.upside_pct != null ? `<span style="color:${r.upside_pct >= 0 ? '#86efac' : '#f87171'};">FV ${r.upside_pct >= 0 ? '+' : ''}${r.upside_pct.toFixed(1)}%</span>` : ""}
          ${r.suggested_inr > 0 ? `<span style="color:#fde047;">${inr(r.suggested_inr)}</span>` : ""}
        </div>
      </div>`).join("")
    }
  </div>`;

  return `<div style="margin-bottom:22px;">
    <div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:10px; flex-wrap:wrap;">
      <div>
        <div style="font-size:14px; font-weight:700;">Outside-portfolio fresh picks <span style="font-size:12px; font-weight:500; color:var(--text-muted);">(${total})</span></div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${swsEscapeAttr(triggerLine)} · ${picks.allocPct}% of fresh capital allocated${picks.allocInr > 0 ? ` (${inr(picks.allocInr)})` : ""}</div>
      </div>
      <div title="${swsEscapeAttr(picks.methodology)}" style="font-size:11px; color:var(--text-muted); font-style:italic; cursor:help;">methodology ⓘ</div>
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:14px;">
      ${renderColumn(picks.defensive || [], "Defensive (quality_growth + deep_value)", "#86efac")}
      ${renderColumn(picks.growth || [], "Growth (top_ranked_v3 + smallcap_gems)", "#93c5fd")}
    </div>
  </div>`;
}

function swsFormatDateShort(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return swsEscapeAttr(String(iso));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mi = parseInt(m[2], 10) - 1;
  return `${months[mi] || m[2]} ${parseInt(m[3], 10)}`;
}

function swsRenderBackdatedNotice(report) {
  if (!report?.backdated) return "";
  const backAs = report.backdatedAsOf || "—";
  const latestAs = report.latestKnownAsOf || "—";
  return `
    <div style="background:rgba(250,204,21,0.06); border:1px solid rgba(250,204,21,0.30); border-radius:10px; padding:14px 18px; margin-bottom:18px; display:flex; align-items:flex-start; gap:12px;">
      <div style="font-size:18px; line-height:1;">⏪</div>
      <div>
        <div style="font-size:13px; font-weight:700; color:#fde047;">Backdated upload</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:4px; line-height:1.55;">
          This statement is dated <strong>${swsEscapeAttr(backAs)}</strong>, before your last review on <strong>${swsEscapeAttr(latestAs)}</strong>.
          Showing analysis only — your recommendation history was <em>not</em> updated.
        </div>
      </div>
    </div>
  `;
}

function swsRenderMemoryHeader(report) {
  const acks = Array.isArray(report?.executionAcks) ? report.executionAcks : [];
  const registry = report?.recRegistry || {};
  const pendingEntries = Object.values(registry).filter((r) => r && r.isPending && !r.isSuperseded);
  const cooldownRows = Array.isArray(report?.cooldownPanel?.rows) ? report.cooldownPanel.rows : [];
  if (acks.length === 0 && pendingEntries.length === 0 && cooldownRows.length === 0) return "";

  const memSt = report?.memoryStatus || {};
  const sinceLabel = memSt.prevAsOfDateIso ? `since your last review (${swsEscapeAttr(memSt.prevAsOfDateIso)})` : "since your last review";

  const ackCards = acks.map((a) => {
    const isPartial = a.type === "EXECUTED_PARTIAL";
    const isOver = a.type === "EXECUTED_OVER";
    const tone = isPartial ? "yellow" : "green";
    const bg = tone === "green" ? "rgba(34,197,94,0.06)" : "rgba(250,204,21,0.05)";
    const border = tone === "green" ? "rgba(34,197,94,0.35)" : "rgba(250,204,21,0.30)";
    const accent = tone === "green" ? "#86efac" : "#fde047";
    const glyph = isPartial ? "◑" : (isOver ? "✓✓" : "✓");
    const rawSym = a.symbol || a.isin || "—";
    const sym = swsEscapeAttr(rawSym.replace?.(/\.NS$/, "") || rawSym);
    const action = swsEscapeAttr(a.action || "");
    const flaggedHuman = swsFormatDateShort(a.issuedAsOf);
    const freedRupees = Number.isFinite(a.rupeesFreed) && a.rupeesFreed > 0 ? `<strong style="color:${accent};">${inr(a.rupeesFreed)}</strong> freed.` : "";
    const headline = isPartial
      ? `<strong>${sym}</strong> — partial action against the <em>${action}</em> flag from ${flaggedHuman}.`
      : (isOver
          ? `<strong>${sym}</strong> — went beyond the <em>${action}</em> flag from ${flaggedHuman}. ${freedRupees}`
          : `<strong>${sym}</strong> — closed the <em>${action}</em> flag from ${flaggedHuman}. ${freedRupees}`);
    const remainingNote = (isPartial && Number.isFinite(a.remainingPct) && a.remainingPct > 0)
      ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Residual ~${(a.remainingPct * 100).toFixed(0)}% may re-emerge in this review's action list.</div>`
      : "";
    return `
      <div style="background:${bg}; border:1px solid ${border}; border-radius:8px; padding:10px 14px; display:flex; gap:10px; align-items:flex-start;">
        <div style="font-size:18px; line-height:1; color:${accent};">${glyph}</div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:13px; line-height:1.5; color:var(--text);">${headline}</div>
          ${remainingNote}
        </div>
      </div>
    `;
  }).join("");

  const pendingChips = pendingEntries.map((r) => {
    const orig = swsEscapeAttr(r.originalAction || "");
    const rawTicker = r.symbol || (r.isin || "").replace(/^SYM:/, "") || "";
    const sym = swsEscapeAttr(rawTicker.replace(/\.NS$/, "") || "—");
    const reviews = r.escalationCount > 1 ? ` · ${r.escalationCount} reviews` : "";
    const flaggedHuman = swsFormatDateShort(r.originalAsOf);
    return `
      <span title="First flagged on ${swsEscapeAttr(r.originalAsOf || "")}. Condition still triggers."
            style="display:inline-flex; align-items:center; gap:6px; background:rgba(96,165,250,0.06); border:1px solid rgba(96,165,250,0.30); border-radius:14px; padding:4px 10px; font-size:11px; color:#bfdbfe; line-height:1.3;">
        <strong>${sym}</strong>
        <span style="color:var(--text-muted);">${orig}</span>
        <span style="color:var(--text-muted);">· flagged ${flaggedHuman}${reviews}</span>
      </span>
    `;
  }).join("");

  const ackBlock = acks.length > 0 ? `
    <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">
      Since your last review${memSt.prevAsOfDateIso ? ` <span style="color:var(--text);">(${swsEscapeAttr(memSt.prevAsOfDateIso)})</span>` : ""}
    </div>
    <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:${pendingEntries.length > 0 ? "14px" : "0"};">
      ${ackCards}
    </div>
  ` : "";

  const pendingCount = pendingEntries.length;
  const pendingBlock = pendingCount > 0 ? `
    <details style="margin-top:${acks.length > 0 ? "14px" : "0"};">
      <summary style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; cursor:pointer; user-select:none; list-style:none; display:flex; align-items:center; gap:8px; padding:4px 0;">
        <span class="sws-pending-chevron" style="font-size:10px; display:inline-block; transition:transform 0.2s;">▶</span>
        Still pending from earlier reviews
        <span style="color:var(--text); font-weight:600;">(${pendingCount})</span>
      </summary>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">
        ${pendingChips}
      </div>
      <div style="font-size:11px; color:var(--text-muted); margin-top:8px; line-height:1.5;">
        These flags are repeated in this review's action list because the underlying condition still trips. Acting on them ${sinceLabel} would close them.
      </div>
    </details>
  ` : "";

  const cooldownChips = cooldownRows.map((r) => {
    const rawTicker = r.symbol || (r.isin || "").replace(/^SYM:/, "") || "";
    const sym = swsEscapeAttr(rawTicker.replace(/\.NS$/, "") || "—");
    const execAction = swsEscapeAttr(r.executedAction || "");
    const execDate = swsFormatDateShort(r.executedOn);
    const untilMs = r.cooldownUntil ? Date.parse(r.cooldownUntil) : NaN;
    const daysRemaining = Number.isFinite(untilMs)
      ? Math.max(0, Math.ceil((untilMs - Date.now()) / 86_400_000))
      : null;
    const remainLabel = daysRemaining != null ? ` · ${daysRemaining}d remaining` : "";
    return `
      <span title="Executed ${swsEscapeAttr(r.executedAction || "")} on ${swsEscapeAttr(r.executedOn || "")}. Cooldown until ${swsEscapeAttr(r.cooldownUntil || "")}. Re-fires only if V3 drops ≥5pts, severity rises ≥10pp, or new surveillance."
            style="display:inline-flex; align-items:center; gap:6px; background:rgba(34,197,94,0.06); border:1px solid rgba(34,197,94,0.30); border-radius:14px; padding:4px 10px; font-size:11px; color:#bbf7d0; line-height:1.3;">
        <strong>${sym}</strong>
        <span style="color:var(--text-muted);">${execAction}</span>
        <span style="color:var(--text-muted);">· executed ${execDate}${remainLabel}</span>
      </span>
    `;
  }).join("");

  const cooldownCount = cooldownRows.length;
  const cooldownBlock = cooldownCount > 0 ? `
    <details style="margin-top:${(acks.length > 0 || pendingCount > 0) ? "14px" : "0"};">
      <summary style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; cursor:pointer; user-select:none; list-style:none; display:flex; align-items:center; gap:8px; padding:4px 0;">
        <span class="sws-pending-chevron" style="font-size:10px; display:inline-block; transition:transform 0.2s;">▶</span>
        Recently actioned · cooldown active
        <span style="color:var(--text); font-weight:600;">(${cooldownCount})</span>
      </summary>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">
        ${cooldownChips}
      </div>
      <div style="font-size:11px; color:var(--text-muted); margin-top:8px; line-height:1.5;">
        These names were trimmed or added to recently. The SEBI-RA policy is to let the action settle and re-evaluate only on a material change (V3 −5pts, severity +10pp, or new surveillance) — so they're held back from Tier A until the cooldown expires.
      </div>
    </details>
  ` : "";

  return `
    <style>
      details[open] > summary .sws-pending-chevron { transform: rotate(90deg); }
      summary::-webkit-details-marker { display: none; }
    </style>
    <div style="background:var(--panel); border:1px solid #2a3349; border-radius:10px; padding:14px 18px; margin-bottom:18px;">
      ${ackBlock}
      ${pendingBlock}
      ${cooldownBlock}
    </div>
  `;
}

function swsRenderFreedCapitalBanner(report) {
  const fc = report?.freedCapital;
  if (!fc || !fc.significant) return "";
  const picks = report?.freedCapitalPicks;
  const total = inr(fc.totalRupeesFreed || 0);
  const count = fc.count || 0;
  const picksAvailable = picks && picks.available !== false && Array.isArray(picks.picks);
  const picksList = picksAvailable ? picks.picks.slice(0, 6) : [];

  const pickCards = picksList.map((p) => {
    const ticker = swsEscapeAttr(p.ticker || p.symbol || "—");
    const name = swsEscapeAttr(p.name || p.companyName || "");
    const score = Number.isFinite(p.v3_score_100) ? p.v3_score_100
                : Number.isFinite(p.score) ? p.score : null;
    const allocation = Number.isFinite(p.suggestedAllocationInr) ? inr(p.suggestedAllocationInr) : null;
    const reason = swsEscapeAttr(p.reason || p.section || "");
    return `
      <div style="background:var(--bg); border:1px solid #2a3349; border-radius:8px; padding:10px 12px; min-width:190px; flex:1 1 190px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <div style="font-size:13px; font-weight:700; color:var(--text);">${ticker}</div>
          ${score != null ? `<div style="font-size:11px; color:#86efac;">${score}/100</div>` : ""}
        </div>
        ${name ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</div>` : ""}
        ${reason ? `<div style="font-size:10px; color:var(--text-muted); margin-top:6px; text-transform:uppercase; letter-spacing:0.4px;">${reason}</div>` : ""}
        ${allocation ? `<div style="font-size:11px; color:#bbf7d0; margin-top:6px;">Sized: ${allocation}</div>` : ""}
      </div>
    `;
  }).join("");

  const picksSection = picksAvailable && picksList.length > 0 ? `
    <div style="margin-top:14px;">
      <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">
        Top deployment candidates ${notAdviceChip("inline")}
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:10px;">
        ${pickCards}
      </div>
    </div>
  ` : (picks && picks.reason ? `
    <div style="font-size:11px; color:var(--text-muted); margin-top:8px;">${swsEscapeAttr(picks.reason)}</div>
  ` : "");

  return `
    <div style="background:linear-gradient(135deg, rgba(34,197,94,0.10), rgba(96,165,250,0.04)); border:1px solid rgba(34,197,94,0.30); border-radius:10px; padding:14px 18px; margin-bottom:18px;">
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <div style="font-size:22px;">💸</div>
        <div style="flex:1; min-width:200px;">
          <div style="font-size:14px; font-weight:700; color:#86efac;">${total} freed since your last review</div>
          <div style="font-size:12px; color:var(--text-muted); margin-top:3px;">
            From ${count} executed action${count === 1 ? "" : "s"}. Educational picks below — sizing and ordering are personal decisions.
          </div>
        </div>
      </div>
      ${picksSection}
    </div>
  `;
}

function renderSWSAnalyzerReport(report, elapsedMs) {
  // ANALYZER_UI_V2 dispatcher for the SWS path — the only path now.
  // Adds a hero card + glossary chips on technical KPI labels when V2
  // is on. Sub-renderers (TierA/B/C/D, MfSection, etc.) are unchanged
  // because they're already progressively disclosed.
  if (report?.ui?.v2) return renderSWSAnalyzerReportV2(report, elapsedMs);

  const root = document.getElementById("analyzerReport");
  if (!root) return;

  const snap = report.snapshot || {};
  const banner = report.banner || {};
  const tiers = report.tiers || {};
  const baskets = tiers.B?.baskets || {};
  const sectorOverlay = report.sectorOverlay || [];
  const outsidePicks = report.outsidePicks || null;

  const yourPortfolioAt = swsFormatBannerTs(banner.snapshot_at);
  const swsScannedAt = swsFormatBannerTs(banner.sws_scanned_at);
  const elapsed = elapsedMs != null ? `${elapsedMs}ms` : "—";

  root.innerHTML = `
    <div style="background:linear-gradient(135deg, rgba(59,130,246,0.08), rgba(34,197,94,0.04)); border:1px solid rgba(59,130,246,0.25); border-radius:10px; padding:14px 18px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
      <div>
        <div style="font-size:14px; font-weight:700; color:#93c5fd;">${banner.engine || "SWS Engine (Beta)"}</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
          Your portfolio: <span title="When you uploaded this holdings statement">${yourPortfolioAt}</span> · SWS data: <span title="When the SWS universe scan last refreshed">${swsScannedAt}</span> · ${swsEscapeAttr(banner.coverage_text || "")} · scored in ${elapsed}
        </div>
      </div>
      <button onclick="resetAnalyzer()" style="background:transparent; border:1px solid #2a3349; color:var(--text); padding:6px 14px; border-radius:6px; cursor:pointer; font-size:12px;">Re-upload</button>
    </div>

    ${swsRenderBackdatedNotice(report)}
    ${swsRenderBrokerReconciliationChip(banner)}
    ${swsRenderMemoryHeader(report)}
    ${swsRenderFreedCapitalBanner(report)}

    ${/* PR A10 — Tier 1 hero trio above the Health ring. */ ""}
    ${renderAnalyzerHeroTrio(snap)}

    ${renderPortfolioHealthHero(snap.portfolioHealth)}

    ${/* PR A10 — Action mix as a 100 %-width stacked bar. */ ""}
    ${renderAnalyzerActionMixBar(snap)}

    ${/* Secondary KPIs — collapsed by default. */ ""}
    <details class="analyzer-secondary-kpis" style="margin-bottom: var(--space-200);">
      <summary class="tx-meta" style="cursor:pointer; padding: 6px 0; color: var(--text-muted);">Secondary KPIs (snowflake, v3, holdings count)</summary>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-top:8px;">
        ${swsKpiCard("Avg Snowflake", `${snap.avgSnowflake ?? "—"}<span style="color:var(--text-muted); font-size:12px;">/30</span>`)}
        ${swsKpiCard("Avg v3 score", `${snap.avgV3Score ?? "—"}<span style="color:var(--text-muted); font-size:12px;">/100</span>`)}
        ${swsKpiCard("Holdings", `${snap.holdingsCount} <span style="color:var(--text-muted); font-size:12px;">(${snap.coveredCount} SWS-covered)</span>`)}
      </div>
    </details>

    ${/* PR A10 — Tier 2 disclosures. Tier A auto-opens when freed > 0. */ ""}
    <details class="analyzer-tier-details" ${snap.totalFreedCapital > 0 ? "open" : ""}>
      <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Reductions &amp; freed capital ${snap.totalFreedCapital > 0 ? `<span style="color: var(--warn); margin-left: 8px;">(${formatINR(snap.totalFreedCapital || 0, { compact: true })} freed)</span>` : ""}</summary>
      <div style="padding-top: var(--space-200);">${renderSWSTierA(tiers.A)}</div>
    </details>

    <details class="analyzer-tier-details" style="margin-top: var(--space-200);">
      <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Top-up candidates</summary>
      <div style="padding-top: var(--space-200);">
        ${renderSWSTierB(baskets)}
        ${renderSWSOutsidePicks(outsidePicks)}
      </div>
    </details>

    <details class="analyzer-tier-details" style="margin-top: var(--space-200);">
      <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Holdings — quality groups (hold, watch, exit)</summary>
      <div style="padding-top: var(--space-200);">
        ${renderSWSTierC(tiers.C)}
        ${renderSWSTierD(tiers.D)}
      </div>
    </details>

    <details class="analyzer-tier-details" style="margin-top: var(--space-200);">
      <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Diagnostic views (sector mix, mutual funds)</summary>
      <div style="padding-top: var(--space-200);">
        ${renderSWSSectorOverlay(sectorOverlay)}
        ${renderSWSMfSection(report.mfPositions)}
      </div>
    </details>

    ${renderSWSEarningsCalendar(report)}

    <div style="background:rgba(250,204,21,0.05); border:1px solid rgba(250,204,21,0.15); border-radius:8px; padding:12px 16px; margin-top:24px; font-size:11px; color:#fde047; line-height:1.6;">
      ${swsEscapeAttr(report.disclaimer || "")}
    </div>
  `;
}

// V2 of the SWS analyzer report. Adds a plain-English hero card at the top
// (1–2 sentences answering "what does this report say in 10 seconds?") and
// glossary chips next to the technical KPI labels. The Tier A/B/C/D sub-
// renderers are unchanged — they're already progressively disclosed.
function renderSWSAnalyzerReportV2(report, elapsedMs) {
  const root = document.getElementById("analyzerReport");
  if (!root) return;

  const snap = report.snapshot || {};
  const banner = report.banner || {};
  const tiers = report.tiers || {};
  const baskets = tiers.B?.baskets || {};
  const sectorOverlay = report.sectorOverlay || [];
  const outsidePicks = report.outsidePicks || null;

  const yourPortfolioAt = swsFormatBannerTs(banner.snapshot_at);
  const swsScannedAt = swsFormatBannerTs(banner.sws_scanned_at);
  const elapsed = elapsedMs != null ? `${elapsedMs}ms` : "—";

  // Hero copy — 1–2 sentences derived deterministically from snap.* fields.
  // Guard every numeric so an empty book renders cleanly.
  const heroSentences = [];
  if (Number.isFinite(snap.holdingsCount)) {
    const cv = Number.isFinite(snap.totalCurrent) ? inr(snap.totalCurrent) : "—";
    heroSentences.push(`Your book has <strong>${snap.holdingsCount}</strong> holdings worth <strong>${cv}</strong>.`);
  }
  if (Number.isFinite(snap.totalPnL) && Number.isFinite(snap.totalPnLPct)) {
    const pnlSign = snap.totalPnL >= 0 ? "up" : "down";
    const pnlAbs = inr(Math.abs(snap.totalPnL));
    heroSentences.push(`Net P&L is <strong>${pnlSign} ${pnlAbs}</strong> (${snap.totalPnLPct >= 0 ? "+" : ""}${snap.totalPnLPct}%).`);
  }
  // Surface action-mix counts in plain English (e.g. "5 names look like good
  // holds; 2 need attention.")
  const mix = snap.actionMix || {};
  const exitCount = (mix.EXIT || 0) + (mix["EXIT-now"] || 0) + (mix["EXIT-staged"] || 0);
  const trimCount = Object.entries(mix).filter(([k]) => k.startsWith("Reduction-")).reduce((a, [, v]) => a + v, 0);
  const topUpCount = Object.entries(mix).filter(([k]) => k.startsWith("Top-up-")).reduce((a, [, v]) => a + v, 0);
  const holdCount = mix.HOLD || 0;
  const actionParts = [];
  if (holdCount > 0) actionParts.push(`<strong>${holdCount}</strong> to hold`);
  if (topUpCount > 0) actionParts.push(`<strong>${topUpCount}</strong> to top up`);
  if (trimCount > 0) actionParts.push(`<strong>${trimCount}</strong> to trim`);
  if (exitCount > 0) actionParts.push(`<strong>${exitCount}</strong> to exit`);
  if (actionParts.length > 0) {
    heroSentences.push(`The engine reads ${actionParts.join(", ")}.`);
  }
  // V3 ladder breakdown — show per-rung distribution so the user sees the
  // engine isn't piling everything onto one rung. e.g. "Trim breakdown:
  // 3 by 50%, 6 by 33%, 2 by 25%". Surfaces only the non-zero rungs.
  const trimByRung = [
    ["Reduction-66%", "66%", mix["Reduction-66%"] || 0],
    ["Reduction-50%", "50%", mix["Reduction-50%"] || 0],
    ["Reduction-33%", "33%", mix["Reduction-33%"] || 0],
    ["Reduction-25%", "25%", mix["Reduction-25%"] || 0],
    ["Reduction-25-33%", "25–33%", mix["Reduction-25-33%"] || 0],
  ].filter(([, , n]) => n > 0);
  const topUpByRung = [
    ["Top-up-100%", "100%", mix["Top-up-100%"] || 0],
    ["Top-up-50%", "50%", mix["Top-up-50%"] || 0],
    ["Top-up-33%", "33%", mix["Top-up-33%"] || 0],
    ["Top-up-25%", "25%", mix["Top-up-25%"] || 0],
  ].filter(([, , n]) => n > 0);
  const exitByRung = [
    ["EXIT-now", "now", (mix["EXIT-now"] || 0) + (mix.EXIT || 0)],
    ["EXIT-staged", "staged", mix["EXIT-staged"] || 0],
  ].filter(([, , n]) => n > 0);
  const breakdownParts = [];
  if (trimByRung.length > 0) {
    breakdownParts.push(`Trim: ${trimByRung.map(([, l, n]) => `<strong>${n}</strong> by ${l}`).join(", ")}`);
  }
  if (topUpByRung.length > 0) {
    breakdownParts.push(`Top-up: ${topUpByRung.map(([, l, n]) => `<strong>${n}</strong> by ${l}`).join(", ")}`);
  }
  if (exitByRung.length > 0) {
    breakdownParts.push(`Exit: ${exitByRung.map(([, l, n]) => `<strong>${n}</strong> ${l}`).join(", ")}`);
  }
  if (breakdownParts.length > 0) {
    heroSentences.push(`<span style="color:var(--text-muted); font-size:12px;">${breakdownParts.join(" · ")}.</span>`);
  }
  const heroBlock = heroSentences.length > 0
    ? `<div style="margin-bottom:18px; padding:14px 16px; background:rgba(96,165,250,0.05); border-left:3px solid #60a5fa; border-radius:0 8px 8px 0; font-size:14px; line-height:1.6; color:var(--text);">
        ${heroSentences.map((s) => `<div style="margin-bottom:4px;">${s}</div>`).join("")}
        <div style="font-size:11px; color:var(--text-muted); margin-top:6px;">Click any section below for the detailed evidence.</div>
       </div>`
    : "";

  root.innerHTML = `
    <div style="background:linear-gradient(135deg, rgba(59,130,246,0.08), rgba(34,197,94,0.04)); border:1px solid rgba(59,130,246,0.25); border-radius:10px; padding:14px 18px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
      <div>
        <div style="font-size:14px; font-weight:700; color:#93c5fd;">${banner.engine || "SWS Engine (Beta)"}</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
          Your portfolio: <span title="When you uploaded this holdings statement">${yourPortfolioAt}</span> · SWS data: <span title="When the SWS universe scan last refreshed">${swsScannedAt}</span> · ${swsEscapeAttr(banner.coverage_text || "")} · scored in ${elapsed}
        </div>
      </div>
      <button onclick="resetAnalyzer()" style="background:transparent; border:1px solid #2a3349; color:var(--text); padding:6px 14px; border-radius:6px; cursor:pointer; font-size:12px;">Re-upload</button>
    </div>

    ${swsRenderBackdatedNotice(report)}
    ${swsRenderBrokerReconciliationChip(banner)}
    ${swsRenderMemoryHeader(report)}
    ${swsRenderFreedCapitalBanner(report)}

    ${/* PR A10 — Tier 1 hero. Invested / Today / Net P&L read first,
        Net P&L dominant + signed-coloured. Hoists ABOVE the engine hero
        block so the reader sees portfolio reality before the narrative. */ ""}
    ${renderAnalyzerHeroTrio(snap)}

    ${heroBlock}

    ${renderPortfolioHealthHero(snap.portfolioHealth)}

    ${/* PR A10 — Action mix is now a 100 %-width stacked bar. Click-through
        to openActionListModal still works via the bucket bridge. */ ""}
    ${renderAnalyzerActionMixBar(snap)}

    ${/* Secondary KPIs — kept visible but de-emphasised below the Tier 1
        hero. Useful for power users but no longer the first read. */ ""}
    <details class="analyzer-secondary-kpis" style="margin-bottom: var(--space-200);">
      <summary class="tx-meta" style="cursor:pointer; padding: 6px 0; color: var(--text-muted);">Secondary KPIs (snowflake, v3, holdings count)</summary>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-top:8px;">
        ${swsKpiCard(`Avg quality score ${infoIcon("snowflake_score")}`, `${snap.avgSnowflake ?? "—"}<span style="color:var(--text-muted); font-size:12px;">/30</span>`)}
        ${swsKpiCard(`Avg overall score ${infoIcon("combined_score")}`, `${snap.avgV3Score ?? "—"}<span style="color:var(--text-muted); font-size:12px;">/100</span>`)}
        ${swsKpiCard("Holdings", `${snap.holdingsCount} <span style="color:var(--text-muted); font-size:12px;">(${snap.coveredCount} covered)</span>`)}
      </div>
    </details>

    ${/* PR A10 — Tier 2 disclosures.
        Tier A is auto-open whenever there's freed-capital >0 because
        reductions are the highest-attention rows; everything else opens
        only when explicitly expanded. */ ""}
    <details class="analyzer-tier-details" ${snap.totalFreedCapital > 0 ? "open" : ""}>
      <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Reductions &amp; freed capital ${snap.totalFreedCapital > 0 ? `<span style="color: var(--warn); margin-left: 8px;">(${formatINR(snap.totalFreedCapital || 0, { compact: true })} freed)</span>` : ""}</summary>
      <div style="padding-top: var(--space-200);">${renderSWSTierA(tiers.A)}</div>
    </details>

    <details class="analyzer-tier-details" style="margin-top: var(--space-200);">
      <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Top-up candidates</summary>
      <div style="padding-top: var(--space-200);">
        ${renderSWSTierB(baskets)}
        ${renderSWSOutsidePicks(outsidePicks)}
      </div>
    </details>

    <details class="analyzer-tier-details" style="margin-top: var(--space-200);">
      <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Holdings — quality groups (hold, watch, exit)</summary>
      <div style="padding-top: var(--space-200);">
        ${renderSWSTierC(tiers.C)}
        ${renderSWSTierD(tiers.D)}
      </div>
    </details>

    <details class="analyzer-tier-details" style="margin-top: var(--space-200);">
      <summary class="tx-title" style="cursor:pointer; padding: 10px 0; border-bottom: 1px solid var(--border); list-style: none;">Diagnostic views (sector mix, mutual funds)</summary>
      <div style="padding-top: var(--space-200);">
        ${renderSWSSectorOverlay(sectorOverlay)}
        ${renderSWSMfSection(report.mfPositions)}
      </div>
    </details>

    ${renderSWSEarningsCalendar(report)}

    <div style="background:rgba(250,204,21,0.05); border:1px solid rgba(250,204,21,0.15); border-radius:8px; padding:12px 16px; margin-top:24px; font-size:11px; color:#fde047; line-height:1.6;">
      ${swsEscapeAttr(report.disclaimer || "")}
    </div>
  `;
}

// Small reusable "Not SEBI advice" chip for every decision surface. Keeps
// the compliance reminder visible at the point of recommendation rather
// than only in the footer.
function notAdviceChip(mode = "default") {
  // "Educational research — not advice" chip. Rendered inline next to any
  // analytical label, action, or signal. SEBI IA Regulations 2013 require
  // that non-registered entities clearly distinguish research/education
  // from investment advice; this chip is the per-card enforcement of that
  // distinction so the disclaimer isn't just footer-only.
  const text = "Educational only";
  const style = mode === "inline"
    ? "display:inline-block; font-size:9px; font-weight:700; padding:2px 6px; margin-left:8px; border-radius:3px; background:rgba(250,204,21,0.10); color:#fde047; letter-spacing:0.4px; border:1px solid rgba(250,204,21,0.25); text-transform:uppercase; vertical-align:middle;"
    : "display:inline-block; font-size:10px; font-weight:700; padding:3px 8px; border-radius:4px; background:rgba(250,204,21,0.08); color:#fde047; letter-spacing:0.4px; border:1px solid rgba(250,204,21,0.2); text-transform:uppercase;";
  return `<span style="${style}" title="Educational content only.">${text}</span>`;
}

// Data-freshness badge. `ageSec` is how old the quote cache might be;
// we show a human-readable string.
function freshnessBadge(report) {
  const now = new Date();
  const gen = report.generatedAt ? new Date(report.generatedAt) : now;
  const ageMs = now - gen;
  const ageMin = Math.floor(ageMs / 60000);
  const label = ageMin < 1 ? "just now"
    : ageMin < 60 ? `${ageMin}m ago`
    : `${Math.floor(ageMin / 60)}h ago`;
  const asOf = report.asOfDate ? ` · statement as of ${report.asOfDate}` : "";
  const bench = report.benchmark ? ` · benchmark ${report.benchmark.replace("^NSEI", "Nifty 50")}` : "";
  return `<span style="display:inline-flex; gap:6px; align-items:center; font-size:11px; color:var(--text-muted); padding:3px 8px; border-radius:4px; background:#111827; border:1px solid #1a2233;">
    <span style="width:6px; height:6px; background:#86efac; border-radius:50%; box-shadow:0 0 6px #86efac;"></span>
    Quotes ${label}${asOf}${bench}
  </span>`;
}

function renderAnalyzerSummary(report, elapsedMs) {
  const el = document.getElementById("analyzerSummary");
  const s = report.summary;
  const h = report.health;
  const sectors = report.sectorAllocation.slice(0, 6);

  const pnlColor = pctColor(s.totalPnLPct);
  const hasHealth = h && h.score != null;
  const healthColor = !hasHealth ? "var(--text-muted)"
    : h.score >= 70 ? "var(--green, #22c55e)"
    : h.score >= 50 ? "#fde047" : "#fca5a5";

  const sectorBars = sectors.map((s) =>
    `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0; font-size:12px;">
      <span style="color:var(--text-muted);">${s.sector}</span>
      <span style="font-weight:600;">${s.pct.toFixed(1)}%</span>
    </div>
    <div style="height:6px; background:#1a2233; border-radius:3px; overflow:hidden; margin-bottom:6px;">
      <div style="width:${Math.min(100, s.pct)}%; height:100%; background:var(--accent);"></div>
    </div>`,
  ).join("");

  el.innerHTML = `
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:16px; margin-bottom:16px;">
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Invested</div>
        <div style="font-size:22px; font-weight:700;">${inr(s.totalInvested)}</div>
      </div>
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Current Value</div>
        <div style="font-size:22px; font-weight:700;">${inr(s.totalCurrent)}</div>
      </div>
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">P&amp;L${s.xirrAnnualPct != null ? ` · XIRR ${s.xirrAnnualPct >= 0 ? "+" : ""}${s.xirrAnnualPct.toFixed(1)}%/yr` : ""}</div>
        <div style="font-size:22px; font-weight:700; color:${pnlColor};">
          ${s.totalPnL >= 0 ? "+" : ""}${inr(s.totalPnL)}
          <span style="font-size:14px; font-weight:500; margin-left:6px;">(${s.totalPnLPct >= 0 ? "+" : ""}${s.totalPnLPct.toFixed(2)}%)</span>
        </div>
        ${s.xirrAnnualPct != null
          ? `<div style="font-size:10px; color:var(--text-muted); margin-top:4px;" title="${s.xirrBasis || ''}">Annualised via XIRR over actual purchase dates</div>`
          : `<div style="font-size:10px; color:var(--text-muted); margin-top:4px;">Upload includes purchase dates → XIRR annualised return</div>`}
      </div>
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Portfolio Health</div>
        <div style="font-size:22px; font-weight:700; color:${healthColor};">${hasHealth ? h.score : "—"}<span style="font-size:14px; color:var(--text-muted);">/100</span></div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
          ${hasHealth ? `Avg score ${h.components.avgScore} · Diversity ${h.components.diversity}pts` : "No equity holdings to score"}
        </div>
      </div>
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:13px; font-weight:700; margin-bottom:12px;">Sector allocation</div>
        ${sectorBars || '<div style="font-size:12px; color:var(--text-muted);">No sector data.</div>'}
      </div>
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:13px; font-weight:700; margin-bottom:12px;">Quality mix (by value)</div>
        ${Object.entries(report.verdictMix.value)
          .filter(([, v]) => v > 0)
          .sort(([, a], [, b]) => b - a)
          .map(([k, v]) => {
            const pct = s.totalCurrent > 0 ? (v / s.totalCurrent) * 100 : 0;
            const color = { DEEP_VALUE: "#22c55e", QUALITY_GROWTH: "#86efac", FAIR_VALUE: "#93c5fd", FULLY_VALUED: "#fde047", OVERVALUED: "#fca5a5", UNRATED: "#9ca3af" }[k] || "#9ca3af";
            return `<div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:4px 0;">
              <span style="color:${color};">${k.replace("_", " ")}</span>
              <span style="font-weight:600;">${pct.toFixed(1)}%</span>
            </div>`;
          }).join("")}
      </div>
    </div>

    ${renderRebalanceTable(report)}

    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; font-size:11px; color:var(--text-muted); gap:10px; flex-wrap:wrap;">
      <div>${freshnessBadge(report)}</div>
      <div>Analyzed ${s.holdingsCount} holdings${s.unmatchedCount > 0 ? ` · ${s.unmatchedCount} not analysed` : ""} · ${elapsedMs}ms</div>
    </div>
  `;
}

/**
 * Rebalance-suggestion table.
 *
 * Shows the user's actual portfolio weights side-by-side with an
 * equal-risk-contribution target (risk-parity, ∝ 1/vol, capped at 12%
 * per stock). Delta in both percentage points and ₹ so the user sees
 * exactly how much of each name would need to move to arrive at a
 * mathematically diversified book.
 *
 * We framework this as a DIAGNOSTIC VIEW — "here's what equal-risk-
 * contribution would look like" — not an instruction. Per-row deltas
 * make it clear WHERE the imbalance sits, without ever saying "sell".
 */
function renderRebalanceTable(report) {
  const targets = report.rebalanceTargets;
  if (!Array.isArray(targets) || targets.length === 0) return "";

  // Sort by absolute delta (biggest mismatches first)
  const sorted = [...targets].sort(
    (a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct),
  );
  const maxAbsDelta = Math.max(...sorted.map((t) => Math.abs(t.deltaPct)));

  return `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-top:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:10px; flex-wrap:wrap;">
        <div>
          <div style="font-size:14px; font-weight:700;">Rebalance diagnostic — equal-risk-contribution target</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Target weight ∝ 1/volatility, capped at 12%/stock. This is the "mathematically diversified" distribution — not a trade instruction.</div>
        </div>
        ${notAdviceChip()}
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="color:var(--text-muted); font-size:10px; text-transform:uppercase; letter-spacing:0.5px; border-bottom:1px solid #1a2233;">
              <th style="text-align:left; padding:8px 4px;">Symbol</th>
              <th style="text-align:right; padding:8px 4px;">Current %</th>
              <th style="text-align:right; padding:8px 4px;">Target %</th>
              <th style="text-align:right; padding:8px 4px;">Δ %pts</th>
              <th style="text-align:right; padding:8px 4px;">Δ ₹</th>
              <th style="padding:8px 4px; width:35%;">Deviation</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map((t) => {
              const isOver = t.deltaPct < 0; // over-weight → negative delta
              const color = Math.abs(t.deltaPct) < 2 ? "var(--text-muted)"
                : isOver ? "#fca5a5" : "#86efac";
              const barPct = maxAbsDelta > 0 ? (Math.abs(t.deltaPct) / maxAbsDelta) * 100 : 0;
              return `<tr style="border-bottom:1px solid #111827;">
                <td style="padding:8px 4px; font-family:'JetBrains Mono',monospace; font-weight:600;">${t.symbol.replace(".NS", "")}</td>
                <td style="padding:8px 4px; text-align:right; font-family:'JetBrains Mono',monospace;">${t.currentWeight.toFixed(1)}%</td>
                <td style="padding:8px 4px; text-align:right; font-family:'JetBrains Mono',monospace; color:var(--text-muted);">${t.targetWeight.toFixed(1)}%</td>
                <td style="padding:8px 4px; text-align:right; font-family:'JetBrains Mono',monospace; color:${color}; font-weight:600;">${isOver ? "" : "+"}${t.deltaPct.toFixed(1)}</td>
                <td style="padding:8px 4px; text-align:right; font-family:'JetBrains Mono',monospace; color:${color};">${isOver ? "" : "+"}${inr(t.deltaValue)}</td>
                <td style="padding:8px 4px;">
                  <div style="display:flex; align-items:center; gap:4px;">
                    <div style="flex:1; background:#0b1220; height:6px; border-radius:3px; overflow:hidden; position:relative;">
                      <div style="position:absolute; left:${isOver ? `${50 - barPct / 2}%` : "50%"}; width:${barPct / 2}%; height:100%; background:${color}; border-radius:3px;"></div>
                      <div style="position:absolute; left:50%; top:0; bottom:0; width:1px; background:#1a2233;"></div>
                    </div>
                  </div>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAnalyzerRiskBlock(report) {
  const el = document.getElementById("analyzerRisk");
  if (!el) return;
  const r = report.risk;
  const tests = report.stressTests || [];

  // If neither risk nor stress could be computed, render nothing
  if (!r && tests.length === 0) { el.innerHTML = ""; return; }

  const beta = r?.weightedBeta;
  const vol = r?.portfolioVolatilityPct;
  const benchVol = r?.benchVolatilityPct;
  const sharpe = r?.portfolioSharpe;
  const benchSharpe = r?.benchSharpe;
  const maxDD = r?.maxDrawdownPct;
  const var95 = r?.var95DailyPct;
  const benchVar95 = r?.benchVar95DailyPct;
  const avgCorr = r?.avgCorrelation;

  // Color helpers
  const betaColor = beta == null ? "var(--text-muted)"
    : beta > 1.25 ? "#fca5a5"
    : beta > 1.0  ? "#fde047"
    : "#86efac";
  const volColor = (vol == null || benchVol == null) ? "var(--text-muted)"
    : vol > benchVol * 1.2 ? "#fca5a5"
    : vol < benchVol * 0.8 ? "#86efac"
    : "#fde047";
  const sharpeColor = sharpe == null ? "var(--text-muted)"
    : sharpe > 1 ? "#86efac"
    : sharpe > 0 ? "#fde047"
    : "#fca5a5";

  const fmtPct = (v, withSign = false) => v == null ? "—" : `${withSign && v >= 0 ? "+" : ""}${v.toFixed(v >= 10 || v <= -10 ? 0 : 1)}%`;
  const fmtNum = (v) => v == null ? "—" : v.toFixed(2);

  // Confidence chip — surfaces when n is small so the user knows to discount
  const confBand = r?.confidence || (r?.sampleDays >= 252 ? "high" : r?.sampleDays >= 126 ? "medium" : "low");
  const confColor = { high: "#86efac", medium: "#fde047", low: "#fca5a5" }[confBand] || "var(--text-muted)";
  const confChip = r?.sampleDays != null
    ? `<span style="font-size:10px; color:${confColor}; background:${confColor}22; padding:3px 8px; border-radius:4px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase;" title="Confidence level for beta/Sharpe/VaR estimates based on ${r.sampleDays} daily observations. Below 252 days (1 trading year), standard errors widen.">Confidence: ${confBand}</span>`
    : "";
  const betaBand = r?.weightedBetaSE != null
    ? `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">±${r.weightedBetaSE} (1σ)</div>`
    : `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${r.betaCoverage}/${r.betaTotal} holdings priced</div>`;
  const sharpeBand = r?.portfolioSharpeSE != null
    ? `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">±${r.portfolioSharpeSE} (1σ) · Nifty: ${fmtNum(benchSharpe)}</div>`
    : `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Nifty: ${fmtNum(benchSharpe)}</div>`;

  // Risk card
  const riskCard = r ? `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">Risk profile (vs. Nifty 50, last ${r.sampleDays} trading days)</div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">${confChip}${notAdviceChip()}</div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px;">
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Weighted beta</div>
          <div style="font-size:20px; font-weight:700; color:${betaColor};">${fmtNum(beta)}</div>
          ${betaBand}
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Annualised volatility</div>
          <div style="font-size:20px; font-weight:700; color:${volColor};">${fmtPct(vol)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Nifty: ${fmtPct(benchVol)}</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Sharpe (rf=6.5%)</div>
          <div style="font-size:20px; font-weight:700; color:${sharpeColor};">${fmtNum(sharpe)}</div>
          ${sharpeBand}
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Max drawdown (1y)</div>
          <div style="font-size:20px; font-weight:700; color:#fca5a5;">${fmtPct(maxDD)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Peak-to-trough</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">95% daily VaR</div>
          <div style="font-size:20px; font-weight:700; color:#fca5a5;">${fmtPct(var95)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Nifty: ${fmtPct(benchVar95)}</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Avg pairwise corr.</div>
          <div style="font-size:20px; font-weight:700;">${fmtNum(avgCorr)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">1 = all move together</div>
        </div>
      </div>
      ${r.interpretation ? `
        <div style="margin-top:12px; padding:10px 12px; background:rgba(147,197,253,0.05); border-left:2px solid #60a5fa; border-radius:3px; font-size:12px; line-height:1.55;">
          ${r.interpretation}
        </div>` : ""}
    </div>` : "";

  // Stress-test card — shows BOTH sector-adjusted (default) and pure-β
  // numbers so the investor sees how much sector dispersion adds to the
  // tail estimate. Real crises (2008, 2020) punished NBFC + Metals far
  // more than β alone would predict; cushioned IT + Pharma more.
  const rows = tests.map((t) => {
    const pct = t.projectedLossPct;
    const amt = t.projectedLossAmount;
    const purePct = t.projectedLossPctPureBeta;
    const color = pct < -25 ? "#fca5a5" : pct < -15 ? "#fde047" : "#93c5fd";
    const dispersionDelta = purePct != null && pct != null
      ? `<div style="color:var(--text-muted); font-size:10px;">Pure-β: ${fmtPct(purePct, true)} (sector adds ${(pct - purePct).toFixed(1)}pp)</div>`
      : "";
    return `
      <div style="display:grid; grid-template-columns: 1fr 120px 140px 140px; gap:12px; align-items:center; padding:10px 0; border-bottom:1px solid #1a2233; font-size:13px;">
        <div>${t.name}</div>
        <div style="color:var(--text-muted); font-size:12px;">Nifty ${fmtPct(t.marketShockPct, true)}</div>
        <div>
          <div style="color:${color}; font-weight:700;">${fmtPct(pct, true)}</div>
          ${dispersionDelta}
        </div>
        <div style="color:${color}; font-weight:600; text-align:right;">${amt >= 0 ? "+" : ""}${inr(amt)}</div>
      </div>`;
  }).join("");

  const stressCard = tests.length ? `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">Stress tests (β × sector-dispersion multiplier)</div>
        ${notAdviceChip()}
      </div>
      <div style="display:grid; grid-template-columns: 1fr 120px 140px 140px; gap:12px; font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; padding-bottom:4px;">
        <div>Scenario</div><div>Market shock</div><div>Projected Δ</div><div style="text-align:right;">Δ in ₹</div>
      </div>
      ${rows}
      <div style="margin-top:10px; font-size:11px; color:var(--text-muted); line-height:1.55;">
        Two models side-by-side: (1) pure β × market shock, (2) β × sector-dispersion multiplier. Multipliers calibrated from 2008 GFC + 2020 COVID drawdowns on NSE sectorals: NBFC 1.6×, Metals 1.5×, Banking 1.4×, Auto 1.3×, IT 0.8×, Pharma 0.7×, FMCG 0.7×. Sector-adjusted model matches historical drawdowns more closely; pure-β typically underestimates tail risk for small/mid-caps.
      </div>
    </div>` : "";

  // Currency exposure card
  const cx = report.currencyExposure;
  const currencyCard = cx ? `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-top:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">Currency exposure</div>
        ${notAdviceChip()}
      </div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:12px;">
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">INR-exposed</div>
          <div style="font-size:20px; font-weight:700;">${cx.inrExposurePct.toFixed(1)}%</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Full INR-denominated earnings</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">USD-earning hedge</div>
          <div style="font-size:20px; font-weight:700; color:#86efac;">${cx.usdEarningPct.toFixed(1)}%</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">IT Services + Pharma (${inr(cx.usdEarningValue)})</div>
        </div>
      </div>
      <div style="font-size:12px; color:var(--text-secondary); line-height:1.6; margin-bottom:8px;">${cx.narrative}</div>
      <div style="font-size:10px; color:var(--text-muted); font-style:italic;">Methodology: ${cx.methodology}</div>
    </div>` : "";

  el.innerHTML = riskCard + stressCard + currencyCard;
}

function renderAnalyzerPortfolioActions(report) {
  const el = document.getElementById("analyzerPortfolioActions");
  if (!report.portfolioLevelActions || report.portfolioLevelActions.length === 0) {
    el.innerHTML = "";
    return;
  }
  const sevColor = { high: "#fca5a5", medium: "#fde047", low: "#93c5fd" };
  const items = report.portfolioLevelActions.map((a) => `
    <div style="padding:10px 14px; margin-bottom:8px; background:rgba(${a.severity === 'high' ? '239,68,68' : a.severity === 'medium' ? '250,204,21' : '59,130,246'},0.08); border-left:3px solid ${sevColor[a.severity]}; border-radius:4px;">
      <div style="font-size:12px; color:${sevColor[a.severity]}; font-weight:600; margin-bottom:2px; text-transform:uppercase; letter-spacing:0.4px;">${a.type.replace(/-/g, " ")}</div>
      <div style="font-size:13px;">${a.message}</div>
    </div>
  `).join("");
  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">Portfolio-level recommendations</div>
        ${notAdviceChip()}
      </div>
      ${items}
    </div>
  `;
}

// ──────────────────── Per-MF position recommendations ────────────────────
//
// Phase 1 of the SEBI-RA recommendation engine. Each MF in the user's book
// gets a dedicated card with: HOLD/EXIT/SWITCH/ADD/CONSOLIDATE action,
// confidence band, evidence trail (reason chips), peer alternatives, and
// (Phase 3) per-fund news. Verbs stay observational ("Candidate switch")
// per SEBI IA Reg 2013 framing — the audience is a SEBI-RA reviewing the
// signal before deciding what to relay to clients.

const MF_ACTION_PALETTE = {
  EXIT:        { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.5)",  text: "#fca5a5", verb: "Candidate exit" },
  SWITCH:      { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.5)", text: "#93c5fd", verb: "Candidate switch" },
  CONSOLIDATE: { bg: "rgba(168,85,247,0.12)", border: "rgba(168,85,247,0.5)", text: "#d8b4fe", verb: "Candidate consolidate" },
  ADD:         { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.5)",  text: "#86efac", verb: "Candidate add" },
  HOLD:        { bg: "rgba(107,114,128,0.10)",border: "rgba(107,114,128,0.35)",text: "#cbd5e1", verb: "Hold" },
};

const MF_CONFIDENCE_PALETTE = {
  HIGH:   { bg: "rgba(34,197,94,0.10)", text: "#86efac" },
  MEDIUM: { bg: "rgba(250,204,21,0.10)", text: "#fde047" },
  LOW:    { bg: "rgba(107,114,128,0.10)", text: "#cbd5e1" },
};

// Priority 3: tiny chip rendered next to the action badge when a position
// is misaligned with the user's risk profile. Returns "" when ALIGNED or
// when no profile is set (so the card stays clean for the common case).
function riskAlignmentChip(alignment) {
  if (!alignment || alignment === "ALIGNED") return "";
  if (alignment === "TOO_AGGRESSIVE") {
    return `<span title="More aggressive than your risk profile" style="display:inline-block; padding:3px 10px; border-radius:4px; background:rgba(239,68,68,0.10); border:1px solid rgba(239,68,68,0.35); color:#fca5a5; font-size:10px; font-weight:700; letter-spacing:0.4px;">TOO AGGRESSIVE FOR PROFILE</span>`;
  }
  if (alignment === "TOO_CONSERVATIVE") {
    return `<span title="More conservative than your risk profile" style="display:inline-block; padding:3px 10px; border-radius:4px; background:rgba(59,130,246,0.10); border:1px solid rgba(59,130,246,0.35); color:#93c5fd; font-size:10px; font-weight:700; letter-spacing:0.4px;">CONSERVATIVE FOR PROFILE</span>`;
  }
  return "";
}

function mfActionBadge(action) {
  const p = MF_ACTION_PALETTE[action] || MF_ACTION_PALETTE.HOLD;
  return `<span style="display:inline-block; padding:4px 12px; border-radius:4px; background:${p.bg}; border:1px solid ${p.border}; color:${p.text}; font-size:11px; font-weight:700; letter-spacing:0.4px;">${p.verb}</span>`;
}

function mfConfidencePill(conf) {
  const p = MF_CONFIDENCE_PALETTE[conf] || MF_CONFIDENCE_PALETTE.LOW;
  return `<span style="display:inline-block; padding:2px 8px; border-radius:3px; background:${p.bg}; color:${p.text}; font-size:10px; font-weight:600; letter-spacing:0.3px;">CONF: ${conf}</span>`;
}

// ──────────────────── Priority 3: Risk profile card ────────────────────
//
// Soft-gated. If the user has no profile, renders a single-card CTA with
// the 3 questions inline; submitting POSTs to /api/risk-profile and then
// re-runs renderSWSAnalyzerReport with the latest report.
//
// If the user HAS a profile, renders a compact bucket chip + edit link.
// The per-fund cards downstream consume `factors.riskAlignment` to chip
// misalignment (TOO_AGGRESSIVE / TOO_CONSERVATIVE).
async function renderAnalyzerRiskProfile(rpBlock) {
  const el = document.getElementById("analyzerRiskProfile");
  if (!el) return;

  // Pull the question schema lazily (cached after first call). Falls back
  // to the rpBlock's data if the standalone fetch fails — keeps the card
  // alive in offline / failure modes.
  let questions = window.__rpQuestionsCache;
  if (!questions) {
    try {
      const r = await fetch("/api/risk-profile");
      const j = await r.json();
      questions = j.questions || [];
      window.__rpQuestionsCache = questions;
    } catch {
      questions = [];
    }
  }

  const present = !!(rpBlock && rpBlock.present);

  if (present) {
    const bucketColor = {
      CONSERVATIVE: "#60a5fa",
      MODERATE:     "#a78bfa",
      AGGRESSIVE:   "#f97316",
    }[rpBlock.bucket] || "#94a3b8";
    el.innerHTML = `
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:14px 18px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div>
          <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted); margin-bottom:4px;">Risk Profile</div>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <span style="display:inline-flex; align-items:center; gap:6px; padding:5px 12px; background:${bucketColor}22; border:1px solid ${bucketColor}55; border-radius:6px; color:${bucketColor}; font-weight:700; font-size:13px;">
              ${rpBlock.bucket}
            </span>
            <span style="font-size:11px; color:var(--text-muted);">
              Score ${rpBlock.score}/9 · target allocation tuned to this profile
            </span>
          </div>
        </div>
        <button id="analyzerRiskProfileEdit" type="button" style="background:transparent; border:1px solid #1a2233; color:var(--text-muted); border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer;">Retake survey</button>
      </div>`;
    document.getElementById("analyzerRiskProfileEdit")?.addEventListener("click", async () => {
      // Soft-clear and re-render the survey form
      try { await fetch("/api/risk-profile", { method: "DELETE" }); } catch {}
      renderAnalyzerRiskProfile({ present: false });
    });
    return;
  }

  // No profile yet → render the inline survey form
  if (!Array.isArray(questions) || questions.length === 0) {
    el.innerHTML = `
      <div style="background:var(--panel); border:1px solid rgba(245,158,11,0.4); border-radius:10px; padding:14px 18px; color:#fde68a; font-size:13px;">
        Risk-profile questionnaire unavailable. Recommendations will use the default MODERATE profile.
      </div>`;
    return;
  }

  const questionsHtml = questions.map((q) => `
    <div style="margin-bottom:14px;">
      <div style="font-size:13px; color:var(--text); font-weight:600; margin-bottom:6px;">${q.label}</div>
      ${q.helper ? `<div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">${q.helper}</div>` : ""}
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${q.options.map((o) => `
          <label style="display:inline-flex; align-items:center; gap:6px; padding:6px 12px; background:#0f172a; border:1px solid #1a2233; border-radius:6px; cursor:pointer; font-size:12px; color:var(--text);">
            <input type="radio" name="rp_${q.id}" value="${o.value}" style="margin:0;" />
            ${o.label}
          </label>
        `).join("")}
      </div>
    </div>
  `).join("");

  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid rgba(245,158,11,0.35); border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:14px;">
        <div>
          <div style="font-size:14px; font-weight:700; color:var(--text); display:flex; align-items:center; gap:10px;">
            Complete your risk profile <span style="font-size:10px; padding:2px 8px; background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.4); border-radius:6px; color:#fde68a; text-transform:uppercase; letter-spacing:0.4px;">recommended</span>
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
            SEBI IA-Reg 2013 requires risk profiling before any portfolio recommendation. Without it, the analyser uses default MODERATE assumptions.
          </div>
        </div>
      </div>
      <div id="analyzerRiskProfileForm">${questionsHtml}</div>
      <div style="display:flex; gap:10px; align-items:center; margin-top:14px;">
        <button id="analyzerRiskProfileSubmit" type="button" style="background:#16a34a; color:white; border:none; border-radius:6px; padding:8px 16px; font-weight:600; font-size:13px; cursor:pointer;">Save profile &amp; re-run</button>
        <span id="analyzerRiskProfileStatus" style="font-size:11px; color:var(--text-muted);"></span>
      </div>
    </div>`;

  document.getElementById("analyzerRiskProfileSubmit")?.addEventListener("click", async () => {
    const status = document.getElementById("analyzerRiskProfileStatus");
    const answers = {};
    let missing = 0;
    for (const q of questions) {
      const checked = document.querySelector(`input[name="rp_${q.id}"]:checked`);
      if (!checked) { missing += 1; continue; }
      answers[q.id] = checked.value;
    }
    if (missing > 0) {
      status.textContent = `Please answer all ${questions.length} questions (${missing} remaining).`;
      status.style.color = "#fca5a5";
      return;
    }
    status.textContent = "Saving…";
    status.style.color = "var(--text-muted)";
    try {
      const r = await fetch("/api/risk-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "save failed");
      status.textContent = `Saved → ${j.riskProfile.bucket}. Re-running analysis…`;
      status.style.color = "#86efac";
      // Re-render this card immediately so the user sees the bucket chip
      renderAnalyzerRiskProfile({ present: true, bucket: j.riskProfile.bucket, score: j.riskProfile.score });
      // And tell the user to re-upload to get fully personalised analysis.
      // (We can't re-run the analyzer without the file — it lives in
      // multipart memory only. Surface a clear CTA instead.)
      const allocEl = document.getElementById("analyzerAssetAllocation");
      if (allocEl) {
        allocEl.insertAdjacentHTML("afterbegin", `
          <div style="background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.4); border-radius:8px; padding:10px 14px; margin-bottom:12px; font-size:12px; color:#86efac;">
            ✓ Profile saved. Re-upload your holdings file (or re-run the analyser) to refresh allocation targets and per-fund alignment chips.
          </div>`);
      }
    } catch (err) {
      status.textContent = `Save failed: ${err.message}`;
      status.style.color = "#fca5a5";
    }
  });
}

// ──────────────────── Priority 2: Asset allocation gap card ────────────────────
//
// Shows current vs target allocation per asset class, plus the structural
// concentration flags from assetAllocation.computeAllocationGap. This is
// the headline a SEBI-RA reads first — bigger structural issues dominate
// any single-fund SWITCH.
function renderAnalyzerAssetAllocation(alloc, rpBlock) {
  const el = document.getElementById("analyzerAssetAllocation");
  if (!el) return;
  if (!alloc || !Array.isArray(alloc.buckets) || alloc.buckets.length === 0) {
    el.innerHTML = "";
    return;
  }

  const profileLabel = alloc.targetSource === "user_profile"
    ? `your ${alloc.riskProfileBucket} profile`
    : `default MODERATE profile (complete the survey above for personalised targets)`;

  const VERDICT_PALETTE = {
    OK:       { bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.35)",  text: "#86efac", label: "On target" },
    REDUCE:   { bg: "rgba(239,68,68,0.10)",  border: "rgba(239,68,68,0.35)",  text: "#fca5a5", label: "Reduce" },
    INCREASE: { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.35)", text: "#93c5fd", label: "Increase" },
    ADD_NEW:  { bg: "rgba(168,85,247,0.10)", border: "rgba(168,85,247,0.35)", text: "#d8b4fe", label: "Add new" },
  };

  // Stacked bar — % of book per bucket, ordered by current weight desc
  const barSegments = alloc.buckets
    .filter((b) => b.currentPct > 0)
    .map((b, i) => {
      const colors = ["#3b82f6", "#a78bfa", "#f97316", "#10b981", "#f59e0b", "#ec4899", "#06b6d4", "#84cc16"];
      const c = colors[i % colors.length];
      return `<div title="${b.label} ${b.currentPct}%" style="flex:0 0 ${b.currentPct}%; background:${c}; height:100%;"></div>`;
    }).join("");

  const bucketRows = alloc.buckets.map((b) => {
    const pal = VERDICT_PALETTE[b.verdict] || VERDICT_PALETTE.OK;
    const gapStr = b.gapPp >= 0 ? `+${b.gapPp}pp` : `${b.gapPp}pp`;
    const gapColor = b.verdict === "OK" ? "var(--text-muted)" : pal.text;
    return `
      <div style="display:grid; grid-template-columns:1.6fr 90px 90px 100px 100px; gap:12px; align-items:center; padding:10px 12px; background:#0f172a; border:1px solid #1a2233; border-radius:6px; margin-top:6px;">
        <div>
          <div style="font-size:13px; color:var(--text); font-weight:600;">${b.label}</div>
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px;">${b.risk} risk</div>
        </div>
        <div style="font-size:13px; color:var(--text); font-weight:700;">${b.currentPct}%</div>
        <div style="font-size:11px; color:var(--text-muted);">target ${b.targetPct}%</div>
        <div style="font-size:13px; color:${gapColor}; font-weight:600;">${gapStr}</div>
        <div>
          <span style="display:inline-block; padding:3px 10px; background:${pal.bg}; border:1px solid ${pal.border}; border-radius:4px; color:${pal.text}; font-size:11px; font-weight:600;">${pal.label}</span>
        </div>
      </div>`;
  }).join("");

  const flagsHtml = (alloc.summary?.concentrationFlags || []).map((f) => `
    <div style="display:flex; gap:8px; align-items:flex-start; padding:8px 12px; background:rgba(239,68,68,0.08); border-left:3px solid rgba(239,68,68,0.5); border-radius:0 6px 6px 0; margin-top:6px;">
      <span style="color:#fca5a5; font-weight:700; flex-shrink:0;">!</span>
      <span style="font-size:12px; color:var(--text); line-height:1.5;">${f}</span>
    </div>`).join("");

  const summary = alloc.summary || {};
  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
        <div>
          <div style="font-size:14px; font-weight:700; color:var(--text); display:flex; align-items:center; gap:10px;">
            Asset allocation gap
            ${notAdviceChip("inline")}
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
            Current allocation vs ${profileLabel} · book ₹${(alloc.totalCurrent / 1e5).toFixed(2)}L
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${summary.equityPct ? `<span style="font-size:11px; padding:4px 10px; background:#0f172a; border:1px solid #1a2233; border-radius:4px;"><strong>${summary.equityPct}%</strong> equity</span>` : ""}
          ${summary.debtPct ? `<span style="font-size:11px; padding:4px 10px; background:#0f172a; border:1px solid #1a2233; border-radius:4px;"><strong>${summary.debtPct}%</strong> debt</span>` : `<span style="font-size:11px; padding:4px 10px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.35); border-radius:4px; color:#fca5a5;"><strong>0%</strong> debt</span>`}
          ${summary.hybridPct ? `<span style="font-size:11px; padding:4px 10px; background:#0f172a; border:1px solid #1a2233; border-radius:4px;"><strong>${summary.hybridPct}%</strong> hybrid</span>` : ""}
          ${summary.commodityPct ? `<span style="font-size:11px; padding:4px 10px; background:#0f172a; border:1px solid #1a2233; border-radius:4px;"><strong>${summary.commodityPct}%</strong> gold</span>` : ""}
        </div>
      </div>

      <div style="display:flex; height:14px; border-radius:4px; overflow:hidden; background:#0f172a; margin-top:14px; border:1px solid #1a2233;">
        ${barSegments || '<div style="flex:1;"></div>'}
      </div>

      <div style="margin-top:14px;">
        <div style="display:grid; grid-template-columns:1.6fr 90px 90px 100px 100px; gap:12px; padding:0 12px; font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted);">
          <div>Asset class</div><div>Current</div><div>Target</div><div>Gap</div><div>Verdict</div>
        </div>
        ${bucketRows}
      </div>

      ${flagsHtml ? `
        <div style="margin-top:14px;">
          <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:#fca5a5; margin-bottom:6px;">Concentration flags</div>
          ${flagsHtml}
        </div>` : ""}
    </div>`;
}

function renderAnalyzerMfPositions(block) {
  const el = document.getElementById("analyzerMfPositions");
  if (!el) return;
  if (!block || !Array.isArray(block.positions) || block.positions.length === 0) {
    el.innerHTML = "";
    return;
  }

  const positions = block.positions;
  const mix = block.actionMix || {};
  const totalInvested = positions.reduce((s, p) => s + (p.invested || 0), 0);
  const totalCurrent = positions.reduce((s, p) => s + (p.currentValue || 0), 0);
  const actionableCount = (mix.EXIT || 0) + (mix.SWITCH || 0) + (mix.CONSOLIDATE || 0) + (mix.ADD || 0);

  // ── Action-mix header card ──
  const ORDER = ["EXIT", "SWITCH", "CONSOLIDATE", "ADD", "HOLD"];
  const mixChips = ORDER
    .filter((a) => (mix[a] || 0) > 0)
    .map((a) => {
      const p = MF_ACTION_PALETTE[a];
      return `<span style="display:inline-flex; align-items:center; gap:6px; padding:6px 12px; background:${p.bg}; border:1px solid ${p.border}; border-radius:6px; color:${p.text}; font-size:13px; font-weight:600;">
        <strong style="font-size:16px;">${mix[a]}</strong> ${a.toLowerCase()}
      </span>`;
    })
    .join("");

  const overlap = block.overlap || {};
  const overlapNote = overlap.duplicateFolioCount > 0 || (overlap.overweightCategories || []).length > 0
    ? `<div style="font-size:11px; color:var(--text-muted); margin-top:8px;">
         Book hygiene: ${overlap.duplicateFolioCount > 0 ? `<strong style="color:#d8b4fe;">${overlap.duplicateFolioCount} duplicate folio(s)</strong>` : ""}${overlap.duplicateFolioCount > 0 && overlap.overweightCategories.length > 0 ? " · " : ""}${overlap.overweightCategories.length > 0 ? `<strong style="color:#fde047;">${overlap.overweightCategories.length} category(s) with 2+ funds</strong>` : ""}.
       </div>`
    : "";

  // Phase 5: portfolio-level concerns + opportunities summary
  const summary = block.summary || {};
  const concerns = summary.concerns || [];
  const opportunities = summary.opportunities || [];
  const summaryRow = (concerns.length > 0 || opportunities.length > 0) ? `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px;">
      <div style="background:#0f172a; border:1px solid rgba(239,68,68,0.25); border-radius:6px; padding:10px 12px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:#fca5a5; margin-bottom:6px;">Top concerns</div>
        ${concerns.length === 0 ? '<div style="font-size:11px; color:var(--text-muted); font-style:italic;">No material concerns flagged.</div>'
          : concerns.map((c) => `<div style="font-size:11px; color:var(--text); margin-bottom:3px;">• ${c.detail}</div>`).join("")}
      </div>
      <div style="background:#0f172a; border:1px solid rgba(34,197,94,0.25); border-radius:6px; padding:10px 12px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:#86efac; margin-bottom:6px;">Top switch opportunities</div>
        ${opportunities.length === 0 ? '<div style="font-size:11px; color:var(--text-muted); font-style:italic;">No SWITCH candidates above the noise floor.</div>'
          : opportunities.map((o) => `<div style="font-size:11px; color:var(--text); margin-bottom:3px;">• ${o.from.name?.slice(0,32)} → ${o.to?.slice(0,32)} <strong style="color:#86efac;">+${o.deltaPp}pp</strong></div>`).join("")}
      </div>
    </div>` : "";

  const header = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
        <div>
          <div style="font-size:14px; font-weight:700; display:flex; align-items:center; gap:10px;">
            Per-position recommendations
            ${notAdviceChip("inline")}
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
            ${positions.length} MF position(s) · ${actionableCount} actionable · book ₹${(totalCurrent/1e5).toFixed(2)}L (cost ₹${(totalInvested/1e5).toFixed(2)}L)
          </div>
        </div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">${mixChips || '<span style="font-size:12px; color:var(--text-muted);">No actionable positions.</span>'}</div>
      ${overlapNote}
      ${summaryRow}
    </div>`;

  // ── Per-position cards ──
  const cards = positions.map((p, idx) => renderMfPositionCard(p, idx)).join("");

  el.innerHTML = `
    ${header}
    ${cards}
  `;
}

function renderMfPositionCard(position, idx) {
  const rec = position.rec || {};
  const action = rec.action || "HOLD";
  const palette = MF_ACTION_PALETTE[action] || MF_ACTION_PALETTE.HOLD;
  const perf = rec.performance || {};
  const factors = rec.factors || {};

  const pnlPctVal = position.pnlPercent;
  const pnlColor = pctColor(pnlPctVal);
  const pnlText = Number.isFinite(pnlPctVal) ? `${pnlPctVal >= 0 ? "+" : ""}${pnlPctVal.toFixed(2)}%` : "—";

  // Performance line: trailing return vs category benchmark + Phase 2
  // multi-window metrics (1y/3y/5y CAGR + Sharpe + maxDD) when AMFI
  // ingestion succeeded.
  const sourceLabel = factors.trailingXirrSource === "amfi_3y" ? "AMFI 3y CAGR"
    : factors.trailingXirrSource === "amfi_1y" ? "AMFI 1y CAGR"
    : factors.trailingXirrSource === "groww_xirr" ? "Groww trailing XIRR"
    : "—";
  const perfLine = Number.isFinite(perf.trailingXirrPct)
    ? `<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">
         <span style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px;">${sourceLabel}:</span>
         <strong style="color:${perf.vsCategoryPp >= 0 ? '#86efac' : '#fca5a5'};">${perf.trailingXirrPct.toFixed(2)}%</strong>
         ${Number.isFinite(perf.vsCategoryPp) ? `· vs ${perf.categoryKey || 'category'} benchmark ${perf.categoryBenchmarkPct}% <strong style="color:${perf.vsCategoryPp >= 0 ? '#86efac' : '#fca5a5'};">(${perf.vsCategoryPp >= 0 ? "+" : ""}${perf.vsCategoryPp}pp)</strong>` : ""}
       </div>`
    : `<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">No published XIRR or AMFI match available.</div>`;

  // Multi-window metrics row — appears when AMFI ingestion produced metrics
  const m = factors.metrics;
  const multiWindowLine = m ? `
    <div style="display:flex; flex-wrap:wrap; gap:14px; font-size:11px; color:var(--text-muted); margin-top:8px; padding:8px 12px; background:#0f172a; border-radius:6px; border:1px solid #1a2233;">
      ${Number.isFinite(m.cagr1yPct) ? `<span>1y <strong style="color:${m.cagr1yPct >= 0 ? '#86efac' : '#fca5a5'};">${m.cagr1yPct}%</strong></span>` : ""}
      ${Number.isFinite(m.cagr3yPct) ? `<span>3y <strong style="color:${m.cagr3yPct >= 0 ? '#86efac' : '#fca5a5'};">${m.cagr3yPct}%</strong></span>` : ""}
      ${Number.isFinite(m.cagr5yPct) ? `<span>5y <strong style="color:${m.cagr5yPct >= 0 ? '#86efac' : '#fca5a5'};">${m.cagr5yPct}%</strong></span>` : ""}
      ${Number.isFinite(m.sharpe3y) ? `<span>Sharpe(3y) <strong style="color:var(--text);">${m.sharpe3y}</strong></span>` : ""}
      ${Number.isFinite(m.annualVolPct) ? `<span>Vol <strong style="color:var(--text);">${m.annualVolPct}%</strong></span>` : ""}
      ${Number.isFinite(m.maxDrawdownPct) ? `<span>Max DD <strong style="color:#fca5a5;">${m.maxDrawdownPct}%</strong></span>` : ""}
      ${factors.amfi?.schemeCode ? `<span style="opacity:0.6;">AMFI #${factors.amfi.schemeCode}${factors.amfi.matchType === "isin" ? " · ISIN match" : factors.amfi.score ? ` · name match ${factors.amfi.score}` : ""}</span>` : ""}
    </div>` : "";

  // Reason chips
  const reasonsHtml = (rec.reasons || []).map((r) => `
    <div style="background:#0f172a; border-left:3px solid ${palette.border}; padding:8px 12px; margin-top:6px; border-radius:0 6px 6px 0;">
      <div style="font-size:11px; font-weight:700; color:${palette.text}; letter-spacing:0.3px; text-transform:uppercase; margin-bottom:2px;">${r.label}</div>
      <div style="font-size:12px; color:var(--text-muted); line-height:1.45;">${r.detail}</div>
    </div>
  `).join("");

  // Peer compare (top 3)
  const peers = rec.peerCandidates || [];
  const peersHtml = peers.length > 0 ? `
    <div style="margin-top:12px; padding-top:12px; border-top:1px solid #1a2233;">
      <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted); margin-bottom:6px;">Peer compare (same SEBI category)</div>
      ${peers.map((c, i) => {
        // Live AMFI peers carry richer metrics (3y CAGR + Sharpe) but no
        // TER/rank; curated peers carry TER/rank but no Sharpe. Render
        // each variant honestly.
        const meta = c.source === "amfi_live"
          ? `5y ${c.approxXirr5yPct}%${Number.isFinite(c.cagr3yPct) ? ` · 3y ${c.cagr3yPct}%` : ""}${Number.isFinite(c.sharpe3y) ? ` · Sharpe ${c.sharpe3y}` : ""} · ${c.amc || "AMC"}`
          : `5y ${c.approxXirr5yPct}%${c.expenseRatioPct ? ` · TER ${c.expenseRatioPct}%` : ""}${c.categoryRank5y ? ` · rank #${c.categoryRank5y}` : ""}${c.lockInMonths ? ` · ${c.lockInMonths}mo lock` : ""}`;
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:6px 0; border-bottom:${i < peers.length-1 ? '1px solid #1a2233' : '0'};">
          <div style="flex:1; min-width:0;">
            <div style="font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.name}</div>
            <div style="font-size:10px; color:var(--text-muted); margin-top:1px;">${meta}</div>
          </div>
          ${Number.isFinite(c.deltaPp) ? `<div style="font-size:13px; font-weight:700; color:${c.deltaPp > 0 ? '#86efac' : '#fca5a5'};">${c.deltaPp > 0 ? "+" : ""}${c.deltaPp}pp</div>` : ""}
        </div>
      `;}).join("")}
    </div>
  ` : "";

  // Consolidate target
  const consolidateNote = rec.consolidateTo ? `
    <div style="margin-top:10px; padding:8px 12px; background:rgba(168,85,247,0.08); border:1px solid rgba(168,85,247,0.3); border-radius:6px; font-size:12px; color:#d8b4fe;">
      Consolidate into folio <strong>${rec.consolidateTo.folio}</strong> (largest sibling holding the same scheme).
    </div>` : "";

  // Phase 3: per-fund news with GPT-5 materiality classification.
  // Shows MATERIAL items first (manager change, regulatory action, etc.)
  // then CONTEXT items. NOISE filtered server-side.
  const news = position.news;
  const newsHtml = renderMfNewsBlock(news);

  return `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:16px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:10px;">
        <div style="flex:1; min-width:240px;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <span style="font-size:11px; font-weight:700; color:var(--text-muted);">#${idx + 1}</span>
            ${mfActionBadge(action)}
            ${mfConfidencePill(rec.confidence || "LOW")}
            ${riskAlignmentChip(factors.riskAlignment)}
          </div>
          <div style="font-weight:700; font-size:14px; margin-top:8px;">${position.name || "—"}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            ${position.category || ""}${position.subCategory ? ` · ${position.subCategory}` : ""}${position.folio ? ` · folio ${position.folio}` : ""}
          </div>
        </div>
        <div style="text-align:right; min-width:160px;">
          <div style="font-size:11px; color:var(--text-muted);">Invested → Current</div>
          <div style="font-size:14px; font-weight:700; margin-top:2px;">${inr(position.invested)} → ${inr(position.currentValue)}</div>
          <div style="font-size:13px; font-weight:600; color:${pnlColor}; margin-top:2px;">${pnlText}</div>
        </div>
      </div>
      ${perfLine}
      ${multiWindowLine}
      <div style="margin-top:12px;">
        ${reasonsHtml}
      </div>
      ${consolidateNote}
      ${peersHtml}
      ${newsHtml}
    </div>
  `;
}

// Phase 3: per-fund news block. Shows MATERIAL events as red-tinted
// rows (decision-changing — manager change, regulatory action, etc.)
// and CONTEXT items as muted grey. Each item links to the source so
// the SEBI-RA can verify before relaying anything to a client.
const NEWS_MATERIALITY_PALETTE = {
  MATERIAL: { dot: "#fca5a5", label: "Material" },
  CONTEXT:  { dot: "#94a3b8", label: "Context" },
};
const NEWS_SENTIMENT_TEXT = {
  POSITIVE: { color: "#86efac", icon: "▲" },
  NEGATIVE: { color: "#fca5a5", icon: "▼" },
  NEUTRAL:  { color: "var(--text-muted)", icon: "·" },
};
function fmtNewsDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  const now = Date.now();
  const ageDays = Math.floor((now - d.getTime()) / 86400000);
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "1d ago";
  if (ageDays < 30) return `${ageDays}d ago`;
  return d.toISOString().slice(0, 10);
}
function renderMfNewsBlock(news) {
  const header = `<div style="margin-top:12px; padding-top:12px; border-top:1px solid #1a2233;">
    <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted);">News (last 30d) · classified by GPT-5</div>`;
  if (!news || !Array.isArray(news.items) || news.items.length === 0) {
    const note = news?.note || "no recent material news";
    return `${header}<div style="font-size:11px; color:var(--text-muted); margin-top:4px; font-style:italic;">${note}</div></div>`;
  }
  const counts = news.counts ? `<span style="opacity:0.6;">· ${news.counts.material} material, ${news.counts.context} context, ${news.counts.noise} noise filtered</span>` : "";
  const rows = news.items.map((it) => {
    const mat = NEWS_MATERIALITY_PALETTE[it.materiality] || NEWS_MATERIALITY_PALETTE.CONTEXT;
    const sent = NEWS_SENTIMENT_TEXT[it.sentiment] || NEWS_SENTIMENT_TEXT.NEUTRAL;
    const eventLabel = it.eventKind && it.eventKind !== "OTHER" ? `<span style="font-size:9px; padding:1px 6px; background:rgba(168,85,247,0.10); border:1px solid rgba(168,85,247,0.25); border-radius:3px; color:#d8b4fe; letter-spacing:0.3px; text-transform:uppercase;">${it.eventKind.replace(/_/g," ")}</span>` : "";
    return `
      <div style="display:flex; gap:10px; align-items:flex-start; padding:6px 0; border-bottom:1px solid #1a2233;">
        <span style="color:${mat.dot}; font-size:14px; line-height:1.3;">●</span>
        <div style="flex:1; min-width:0;">
          <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:2px;">
            <a href="${it.link}" target="_blank" rel="noopener" style="font-size:12px; font-weight:600; color:var(--text); text-decoration:none; line-height:1.4;">${it.title}</a>
            ${eventLabel}
          </div>
          ${it.summary ? `<div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${it.summary}</div>` : ""}
          <div style="font-size:10px; color:var(--text-muted); margin-top:3px;">
            <span style="color:${sent.color};">${sent.icon} ${it.sentiment?.toLowerCase() || "neutral"}</span>
            · ${it.source || "source"} · ${fmtNewsDate(it.pubDate)}
          </div>
        </div>
      </div>`;
  }).join("");
  return `${header}
    <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">${counts}</div>
    ${rows}
    </div>`;
}

// ──────────────────── XIRR Optimizer renderer ────────────────────
//
// NOTE (Phase 1 reposition): the XIRR optimizer is now SUPPORTING context,
// not the headline. Per-position MF recommendations above are the primary
// surface for SEBI-RA review. The optimizer's value is the book-wide
// projection if all candidate moves were executed — useful, but secondary
// to the per-position evidence trail.
//
// Renders the analytical (NOT advisory) optimization block. SEBI compliance:
// every move uses observational verbs ("Candidate exit", "Candidate switch")
// and surfaces the math (drag reasons, tax cost, projected uplift, conservative
// band). Preset and tax-slab chips re-run the optimizer in <500ms via the
// cached /api/portfolio/optimize endpoint — no full re-analyze needed.

const OPTIMIZER_PRESET_LABELS = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
  "tax-loss-harvest": "Tax-loss harvest",
  "lock-in-aware": "Lock-in aware",
};

const OPTIMIZER_PRESET_TOOLTIPS = {
  conservative: "50bps noise floor · no FY-budget bypass · no ELSS exits.",
  balanced: "25bps floor · splits exits across FY boundary · ELSS switches when lock-in expired.",
  aggressive: "10bps floor · permits weight breaches up to 12% if uplift >100bps · LTCG harvest mid-FY.",
  "tax-loss-harvest": "Only surfaces moves with a realised loss (set off against gains).",
  "lock-in-aware": "Filters every move where any instrument has remaining lock-in >6 months.",
};

function moveTypeBadge(type) {
  const palette = {
    EXIT:        { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.4)", text: "#fca5a5" },
    TRIM:        { bg: "rgba(250,204,21,0.12)", border: "rgba(250,204,21,0.4)", text: "#fde047" },
    SWITCH:      { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.4)", text: "#93c5fd" },
    ADD:         { bg: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.4)", text: "#86efac" },
    CONSOLIDATE: { bg: "rgba(168,85,247,0.12)", border: "rgba(168,85,247,0.4)", text: "#d8b4fe" },
  };
  const c = palette[type] || palette.SWITCH;
  // Observational labels only — never imperative ("Sell", "Buy").
  const labels = {
    EXIT: "Candidate exit",
    TRIM: "Candidate trim",
    SWITCH: "Candidate switch",
    ADD: "Candidate add",
    CONSOLIDATE: "Candidate consolidate",
  };
  return `<span style="display:inline-block; padding:3px 10px; border-radius:4px; background:${c.bg}; border:1px solid ${c.border}; color:${c.text}; font-size:11px; font-weight:700; letter-spacing:0.3px;">${labels[type] || type}</span>`;
}

function renderAnalyzerOptimizer(optimizer) {
  const el = document.getElementById("analyzerOptimizer");
  if (!el) return;

  if (!optimizer) {
    el.innerHTML = `
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:14px; font-weight:700; margin-bottom:8px;">XIRR Optimizer</div>
        <div style="font-size:12px; color:var(--text-muted);">
          Optimizer block unavailable for this portfolio (likely an empty book or no investible holdings).
        </div>
      </div>`;
    return;
  }

  // Cache the latest block so preset/tax chips can call /api/portfolio/optimize
  _optimizerState.optimizer = optimizer;
  if (optimizer.sessionId) _optimizerState.sessionId = optimizer.sessionId;
  if (optimizer.preset) _optimizerState.preset = optimizer.preset;
  if (Number.isFinite(optimizer.taxSlabPct)) _optimizerState.taxSlabPct = optimizer.taxSlabPct;

  const currentPct = optimizer.currentXirrPct;
  const projectedPct = optimizer.projectedXirrPct;
  const conservativePct = optimizer.projectedXirrConservativePct;
  const upliftBps = optimizer.projectedUpliftBps;
  const upliftBpsConservative = optimizer.projectedUpliftBpsConservative;

  const presetChips = Object.keys(OPTIMIZER_PRESET_LABELS).map((key) => {
    const active = key === _optimizerState.preset;
    const bg = active ? "var(--accent)" : "transparent";
    const color = active ? "#fff" : "var(--text)";
    const border = active ? "var(--accent)" : "#2a3349";
    return `<button type="button"
      onclick="applyOptimizerPreset('${key}')"
      title="${OPTIMIZER_PRESET_TOOLTIPS[key]}"
      style="background:${bg}; color:${color}; border:1px solid ${border}; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; transition:all 0.15s;">
      ${OPTIMIZER_PRESET_LABELS[key]}
    </button>`;
  }).join("");

  const slabChips = [5, 20, 30].map((s) => {
    const active = s === _optimizerState.taxSlabPct;
    const bg = active ? "var(--accent)" : "transparent";
    const color = active ? "#fff" : "var(--text)";
    const border = active ? "var(--accent)" : "#2a3349";
    return `<button type="button"
      onclick="applyOptimizerTaxSlab(${s})"
      style="background:${bg}; color:${color}; border:1px solid ${border}; padding:5px 10px; border-radius:6px; font-size:11px; font-weight:600; cursor:pointer;">
      ${s}%
    </button>`;
  }).join("");

  const moves = Array.isArray(optimizer.moves) ? optimizer.moves : [];
  const moveCards = moves.length === 0
    ? `<div style="background:rgba(34,197,94,0.08); border:1px solid rgba(34,197,94,0.2); border-radius:8px; padding:14px 18px; font-size:12px; color:#86efac;">
        No positive-uplift moves at the current preset / noise floor — your book is at or near its mathematically-derived optimum given the constraints.
      </div>`
    : moves.map((m, idx) => {
        const upliftColor = (m.estUpliftBps || 0) >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)";
        const conservativeNote = Number.isFinite(m.estUpliftBpsConservative)
          ? `<span style="color:var(--text-muted); font-weight:500; margin-left:8px;">(conservative band: ${m.estUpliftBpsConservative >= 0 ? "+" : ""}${m.estUpliftBpsConservative.toFixed(0)} bps)</span>`
          : "";
        const switchTo = Array.isArray(m.redeployTo) && m.redeployTo.length > 0
          ? `<div style="font-size:11px; color:var(--text-muted); margin-top:6px;">
               Redeploy to: ${m.redeployTo.map((c) => `<strong style="color:var(--text);">${c.name}</strong>${c.allocPct != null ? ` (${c.allocPct}%)` : ""}`).join(" · ")}
             </div>`
          : "";
        const blocked = m.blocking
          ? `<div style="font-size:11px; color:#fca5a5; margin-top:6px; padding:4px 8px; background:rgba(239,68,68,0.08); border-radius:4px; display:inline-block;">
               Blocked: ${m.blocking.reason || m.blocking.type || "constraint"}
             </div>`
          : "";
        return `
          <div style="background:#0f172a; border:1px solid #1a2233; border-radius:8px; padding:14px 16px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:8px;">
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <span style="font-size:12px; font-weight:700; color:var(--text-muted);">#${idx + 1}</span>
                ${moveTypeBadge(m.type)}
                <span style="font-weight:700; font-size:13px;">${m.instrument?.name || m.instrument?.symbol || "—"}</span>
              </div>
              <div style="text-align:right;">
                <div style="font-weight:700; color:${upliftColor}; font-size:14px;">
                  ${(m.estUpliftBps || 0) >= 0 ? "+" : ""}${(m.estUpliftBps || 0).toFixed(0)} bps
                </div>
                ${conservativeNote}
              </div>
            </div>
            <div style="font-size:12px; color:var(--text-muted); line-height:1.5;">
              ${m.rationale || "—"}
            </div>
            ${switchTo}
            <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:var(--text-muted); margin-top:8px; padding-top:8px; border-top:1px solid #1a2233;">
              <span>Gross proceeds: <strong style="color:var(--text);">${inr(m.grossProceedsRupees)}</strong></span>
              <span>Tax cost: <strong style="color:#fca5a5;">${inr(m.taxCostRupees)}</strong></span>
              <span>Net redeployable: <strong style="color:#86efac;">${inr(m.netRedeployableRupees)}</strong></span>
            </div>
            ${blocked}
            ${m.compliance ? `<div style="font-size:10px; color:var(--text-muted); margin-top:6px; font-style:italic;">${m.compliance}</div>` : ""}
          </div>`;
      }).join("");

  const constraints = Array.isArray(optimizer.constraintsBinding) ? optimizer.constraintsBinding : [];
  const constraintPills = constraints.length === 0 ? "" : `
    <div style="margin-top:14px;">
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted); margin-bottom:6px;">Constraints binding</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${constraints.map((c) => `
          <span style="display:inline-block; font-size:11px; padding:4px 10px; background:rgba(250,204,21,0.10); border:1px solid rgba(250,204,21,0.3); border-radius:4px; color:#fde047;">
            ${c.type === "ELSS_LOCK_IN"
              ? `ELSS lock-in: ${c.instrument || ""}${c.until ? " until " + c.until : ""}`
              : c.type === "FY_LTCG_BUDGET"
              ? `FY LTCG budget remaining: ${inr(c.remaining)}${c.fyEndsOn ? " (FY ends " + c.fyEndsOn + ")" : ""}`
              : c.type === "SECTOR_CAP"
              ? `Sector cap: ${c.sector || ""} at ${(c.pct || 0).toFixed(1)}%`
              : c.type === "SINGLE_STOCK_CAP"
              ? `Single-stock cap: ${c.instrument || ""} at ${(c.pct || 0).toFixed(1)}%`
              : c.type}
          </span>
        `).join("")}
      </div>
    </div>`;

  const assumptions = Array.isArray(optimizer.assumptions) ? optimizer.assumptions : [];
  const assumptionsBlock = assumptions.length === 0 ? "" : `
    <div style="margin-top:14px; font-size:11px; color:var(--text-muted); line-height:1.6;">
      <div style="text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px;">Assumptions</div>
      ${assumptions.map((a) => `<div style="margin-bottom:2px;">• ${a}</div>`).join("")}
    </div>`;

  // Header tooltip — surfaces the SEBI-compliance copy at the point of use.
  const header = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; margin-bottom:14px;">
      <div>
        <div style="font-size:14px; font-weight:700; display:flex; align-items:center; gap:10px;">
          XIRR Optimizer
          ${notAdviceChip("inline")}
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;" title="Optimization is analytical, not advisory. Moves shown are mathematically-derived candidates for review with your IA/RA.">
          Mathematical candidates · review with your registered adviser before acting
        </div>
      </div>
      <div id="analyzerOptimizerStatus" style="font-size:11px; color:var(--text-muted);"></div>
    </div>`;

  // Hero numbers card
  const conservativeText = Number.isFinite(conservativePct)
    ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
         Conservative band: ${conservativePct.toFixed(2)}% (${upliftBpsConservative >= 0 ? "+" : ""}${(upliftBpsConservative || 0).toFixed(0)} bps)
       </div>`
    : "";

  const heroCard = `
    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-bottom:18px;">
      <div style="background:#0f172a; border:1px solid #1a2233; border-radius:8px; padding:14px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted);">Current XIRR</div>
        <div style="font-size:24px; font-weight:700; margin-top:4px;">${Number.isFinite(currentPct) ? currentPct.toFixed(2) + "%" : "—"}</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Confidence: ${optimizer.currentXirrConfidence || "—"}</div>
      </div>
      <div style="background:#0f172a; border:1px solid rgba(34,197,94,0.3); border-radius:8px; padding:14px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#86efac;">Projected XIRR</div>
        <div style="font-size:24px; font-weight:700; margin-top:4px; color:#bbf7d0;">${Number.isFinite(projectedPct) ? projectedPct.toFixed(2) + "%" : "—"}</div>
        ${conservativeText}
      </div>
      <div style="background:#0f172a; border:1px solid #1a2233; border-radius:8px; padding:14px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted);">Uplift</div>
        <div style="font-size:24px; font-weight:700; margin-top:4px; color:${(upliftBps || 0) >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)"};">
          ${(upliftBps || 0) >= 0 ? "+" : ""}${(upliftBps || 0).toFixed(0)} bps
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${moves.length} candidate move${moves.length === 1 ? "" : "s"}</div>
      </div>
    </div>`;

  const controls = `
    <div style="display:grid; grid-template-columns:1fr auto; gap:14px; align-items:start; margin-bottom:18px; padding:14px; background:#0f172a; border:1px solid #1a2233; border-radius:8px;">
      <div>
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-bottom:6px;">Preset</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">${presetChips}</div>
      </div>
      <div>
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-bottom:6px;">Tax slab</div>
        <div style="display:flex; gap:6px;">${slabChips}</div>
      </div>
    </div>`;

  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      ${header}
      ${heroCard}
      ${controls}
      <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted); margin-bottom:8px;">
        Ranked moves (${moves.length})
      </div>
      ${moveCards}
      ${constraintPills}
      ${assumptionsBlock}
    </div>`;
}

// Re-runs the optimizer against the cached session under a new preset.
// Falls back gracefully when the session has expired (server returns 410).
async function applyOptimizerPreset(preset) {
  if (!_optimizerState.sessionId) return;
  _optimizerState.preset = preset;
  await _refreshOptimizer("Reapplying preset…");
}

async function applyOptimizerTaxSlab(slabPct) {
  if (!_optimizerState.sessionId) return;
  _optimizerState.taxSlabPct = slabPct;
  // Persist so the user only picks once across sessions.
  try { localStorage.setItem("starbhai.taxSlabPct", String(slabPct)); } catch {}
  await _refreshOptimizer("Recomputing tax cost…");
}

async function _refreshOptimizer(statusText) {
  const status = document.getElementById("analyzerOptimizerStatus");
  if (status) status.textContent = statusText || "Re-running optimizer…";
  try {
    const res = await fetch("/api/portfolio/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: _optimizerState.sessionId,
        preset: _optimizerState.preset,
        taxSlabPct: _optimizerState.taxSlabPct,
        assumedHoldingMonths: _optimizerState.assumedHoldingMonths,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (status) status.textContent = data.error || "Optimize failed";
      return;
    }
    renderAnalyzerOptimizer(data.optimizer);
  } catch (err) {
    if (status) status.textContent = "Network error: " + err.message;
  }
}

function renderAnalyzerUrgent(report) {
  const el = document.getElementById("analyzerUrgent");
  if (!report.urgentActions || report.urgentActions.length === 0) {
    el.innerHTML = `<div style="background:rgba(34,197,94,0.08); border:1px solid rgba(34,197,94,0.2); border-radius:8px; padding:14px 18px; font-size:13px; color:#86efac;">
      No urgent per-stock actions flagged. Every holding is in HOLD range.
    </div>`;
    return;
  }
  const rows = report.urgentActions.slice(0, 10).map((h) => `
    <div style="display:grid; grid-template-columns: 120px 1fr 160px 100px 120px; gap:12px; align-items:center; padding:10px 14px; border-bottom:1px solid #1a2233; font-size:13px;">
      <div style="font-weight:700;">${h.symbol.replace(".NS", "")}</div>
      <div style="color:var(--text-muted); font-size:12px;">${h.name}</div>
      <div>${actionBadge(h.action, h.displayAction)}</div>
      <div style="color:${pctColor(h.pnlPercent)}; font-weight:600;">${h.pnlPercent >= 0 ? "+" : ""}${(h.pnlPercent || 0).toFixed(1)}%</div>
      <div style="font-size:11px; color:var(--text-muted);">${h.actionUrgency} urgency</div>
    </div>
  `).join("");
  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">Urgent actions (top ${Math.min(10, report.urgentActions.length)})</div>
        ${notAdviceChip()}
      </div>
      <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px; padding:0 14px 8px; display:grid; grid-template-columns: 120px 1fr 160px 100px 120px; gap:12px;">
        <div>Symbol</div><div>Name</div><div>Action</div><div>P&amp;L %</div><div>Urgency</div>
      </div>
      ${rows}
    </div>
  `;
}

function renderAnalyzerHoldings(report) {
  const el = document.getElementById("analyzerHoldings");
  const cards = report.holdings.map((h, idx) => renderHoldingCard(h, idx === 0)).join("");
  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:10px; flex-wrap:wrap;">
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="font-size:14px; font-weight:700;">Per-holding deep dive (${report.holdings.length})</div>
          ${notAdviceChip()}
        </div>
        <div style="font-size:11px; color:var(--text-muted);">Click any row to expand</div>
      </div>
      ${cards}
    </div>
  `;
}

function renderHoldingCard(h, defaultOpen) {
  const openAttr = defaultOpen ? " open" : "";
  const pnlC = pctColor(h.pnlPercent);
  const pnlStr = `${h.pnlPercent >= 0 ? "+" : ""}${(h.pnlPercent || 0).toFixed(1)}%`;
  const flagsSection = h.redFlags && h.redFlags.length
    ? `<div style="margin:14px 0;">
        <div style="font-size:12px; font-weight:700; color:#fca5a5; margin-bottom:6px;">&#9888; Red flags</div>
        ${h.redFlags.map((f) => `<div style="font-size:12px; padding:6px 10px; margin-bottom:4px; background:rgba(${f.severity === 'high' ? '239,68,68' : '250,204,21'},0.08); border-left:2px solid ${f.severity === 'high' ? '#fca5a5' : '#fde047'}; border-radius:3px;">${f.message}</div>`).join("")}
      </div>` : "";
  const ep = h.exitPlan || {};
  // Renamed section from "Exit plan" → "Technical levels" with an explicit
  // "analytical reference — not trade instructions" sub-label. This keeps
  // the level numbers visible (useful for the investor's own analysis) but
  // frames them as market-structure observations, not commands.
  const exitSection = (ep.supportLevel || ep.stopLoss || ep.target || ep.upsideBand || ep.trailingStop)
    ? `<div style="margin:14px 0; padding:12px 14px; background:#111827; border-radius:6px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap;">
          <div style="font-size:12px; font-weight:700; color:#93c5fd;">Technical levels</div>
          <div style="font-size:10px; color:var(--text-muted); font-style:italic;">analytical reference — not trade instructions</div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; font-size:12px;">
          ${(ep.supportLevel ?? ep.stopLoss) != null ? `<div><span style="color:var(--text-muted);">Support:</span> <strong>₹${ep.supportLevel ?? ep.stopLoss}</strong></div>` : ""}
          ${(ep.upsideBand ?? ep.target) != null ? `<div><span style="color:var(--text-muted);">Upside band:</span> <strong>₹${ep.upsideBand ?? ep.target}</strong></div>` : ""}
          ${ep.trailingStop ? `<div><span style="color:var(--text-muted);">Trailing support:</span> ${ep.trailingStop.activated ? `<strong style="color:#86efac;">active @ ₹${ep.trailingStop.currentLevel}</strong>` : `<span>engages above ₹${ep.trailingStop.activationLevel}</span>`}</div>` : ""}
          ${(h.longTermReference ?? h.longTermTarget) ? `<div><span style="color:var(--text-muted);">52W high reference:</span> <strong>₹${h.longTermReference ?? h.longTermTarget}</strong></div>` : ""}
        </div>
        ${ep.slConfirmationRule ? `<div style="font-size:11px; color:var(--text-muted); margin-top:6px;">${ep.slConfirmationRule}</div>` : ""}
        ${ep.rationale && ep.rationale.length ? `<div style="font-size:11px; color:var(--text-muted); margin-top:8px; line-height:1.5;">${ep.rationale.map((r) => "• " + r).join("<br>")}</div>` : ""}
      </div>` : "";

  const outlookSection = h.outlook
    ? `<div style="margin:14px 0; padding:12px 14px; background:#111827; border-radius:6px;">
        <div style="font-size:12px; font-weight:700; margin-bottom:8px;">Outlook</div>
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; font-size:12px;">
          ${["shortTerm", "midTerm", "longTerm"].map((k) => {
            const o = h.outlook[k];
            const arrow = o.direction === "up" ? "↑" : o.direction === "down" ? "↓" : "→";
            const color = o.direction === "up" ? "#86efac" : o.direction === "down" ? "#fca5a5" : "#9ca3af";
            return `<div>
              <div style="color:var(--text-muted); font-size:10px; text-transform:uppercase;">${o.horizon}</div>
              <div style="color:${color}; font-weight:700; font-size:13px;">${arrow} ${o.direction.toUpperCase()}</div>
              <div style="font-size:10px; color:var(--text-muted);">${o.confidence} confidence</div>
            </div>`;
          }).join("")}
        </div>
      </div>` : "";

  const taxSection = h.taxNote
    ? `<div style="margin:14px 0; padding:10px 14px; background:rgba(250,204,21,0.05); border:1px solid rgba(250,204,21,0.2); border-radius:6px; font-size:12px;">
        <div style="font-weight:700; color:#fde047; margin-bottom:4px;">Tax note${h.purchaseDate ? ` <span style="font-weight:500; color:var(--text-muted);">· purchased ${h.purchaseDate}</span>` : ""}</div>
        <div>${h.taxNote.summary}</div>
        ${h.taxNote.holdingPeriod ? `<div style="color:var(--text-muted); font-size:11px; margin-top:4px;">${h.taxNote.holdingPeriod}</div>` : ""}
        <div style="color:var(--text-muted); font-size:11px; margin-top:4px;">${h.taxNote.detail}</div>
      </div>` : "";

  const riskSection = h.risk && (h.risk.beta != null || h.risk.annualizedVolatility != null || h.risk.maxDrawdown1y != null)
    ? (() => {
        // Liquidity badge: tells the investor at a glance how long a full
        // position unwind would take at 20% of median daily value.
        const liqColor = {
          good:  "#86efac",
          fair:  "#a7f3d0",
          watch: "#fde047",
          poor:  "#fca5a5",
        }[h.risk.liquidityBand] || "var(--text-muted)";
        const liqLabel = h.risk.daysToExit != null
          ? `<div><span style="color:var(--text-muted);">Days to exit:</span> <strong style="color:${liqColor};">${h.risk.daysToExit}</strong><span style="color:var(--text-muted);font-size:10px;"> (20% ADV rule)</span></div>`
          : "";
        const sampleChip = h.risk.sampleSize != null
          ? (() => {
              const n = h.risk.sampleSize;
              const band = n >= 252 ? "high" : n >= 126 ? "medium" : "low";
              const c = { high: "#86efac", medium: "#fde047", low: "#fca5a5" }[band];
              return `<span style="font-size:10px; color:${c}; background:${c}22; padding:2px 6px; border-radius:3px; font-weight:700; letter-spacing:0.3px; text-transform:uppercase;" title="${n} daily observations used — beta/vol/VaR estimates carry wider error bands with fewer samples.">conf: ${band}</span>`;
            })()
          : "";
        return `<div style="margin:14px 0; padding:12px 14px; background:#111827; border-radius:6px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px;">
            <div style="font-size:12px; font-weight:700;">Risk profile</div>
            ${sampleChip}
          </div>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap:10px; font-size:12px;">
            ${h.risk.beta != null ? `<div><span style="color:var(--text-muted);">Beta:</span> <strong>${h.risk.beta.toFixed(2)}</strong></div>` : ""}
            ${h.risk.annualizedVolatility != null ? `<div><span style="color:var(--text-muted);">Vol (ann.):</span> <strong>${h.risk.annualizedVolatility.toFixed(1)}%</strong></div>` : ""}
            ${h.risk.maxDrawdown1y != null ? `<div><span style="color:var(--text-muted);">Max DD (1y):</span> <strong style="color:#fca5a5;">${h.risk.maxDrawdown1y.toFixed(1)}%</strong></div>` : ""}
            ${h.risk.var95Daily != null ? `<div><span style="color:var(--text-muted);">95% daily VaR:</span> <strong style="color:#fca5a5;">${h.risk.var95Daily.toFixed(2)}%</strong></div>` : ""}
            ${liqLabel}
          </div>
        </div>`;
      })()
    : "";

  return `<details${openAttr} style="border:1px solid #1a2233; border-radius:8px; margin-bottom:8px; background:#0b1220;">
    <summary style="cursor:pointer; padding:12px 16px; list-style:none; display:grid; grid-template-columns: 140px 1fr 130px 120px 110px 60px; gap:12px; align-items:center; font-size:13px;">
      <div style="font-weight:700;">${h.symbol.replace(".NS", "")}</div>
      <div style="color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${h.name}</div>
      <div>${actionBadge(h.action, h.displayAction)}</div>
      <div style="color:${pnlC}; font-weight:600;">${pnlStr}</div>
      <div style="font-size:11px; color:var(--text-muted);">${(h.positionWeight || 0).toFixed(1)}% wt</div>
      <div style="font-size:11px; text-align:right;">${h.combinedScore != null ? h.combinedScore + "/100" : "—"}</div>
    </summary>
    <div style="padding:4px 16px 16px; border-top:1px solid #1a2233;">
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; padding:10px 0; font-size:12px;">
        <div><span style="color:var(--text-muted);">Qty:</span> ${h.quantity}</div>
        <div><span style="color:var(--text-muted);">Avg:</span> ₹${h.avgPrice}</div>
        <div><span style="color:var(--text-muted);">Current:</span> ${h.currentPrice != null ? "₹" + h.currentPrice : "—"}</div>
        <div><span style="color:var(--text-muted);">Invested:</span> ${inr(h.invested)}</div>
        <div><span style="color:var(--text-muted);">Value:</span> ${inr(h.currentValue)}</div>
        <div><span style="color:var(--text-muted);">P&amp;L:</span> <span style="color:${pnlC};">${h.pnlAmount >= 0 ? "+" : ""}${inr(h.pnlAmount)}</span></div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; padding:4px 0 10px; font-size:12px; border-top:1px solid #1a2233;">
        <div><span style="color:var(--text-muted);">Tech:</span> ${h.technicalScore ?? "—"}</div>
        <div><span style="color:var(--text-muted);">Fund:</span> ${h.fundamentalScore ?? "—"}</div>
        <div><span style="color:var(--text-muted);">Verdict:</span> ${h.fundamentalVerdict ? h.fundamentalVerdict.replace("_", " ") : "—"}</div>
        <div><span style="color:var(--text-muted);">Signal:</span> ${h.recommendation || "—"}</div>
        <div><span style="color:var(--text-muted);">Sector:</span> ${h.sector}</div>
      </div>
      <div style="margin:12px 0; padding:12px 14px; background:#111827; border-radius:6px; font-size:13px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
          <div style="font-weight:700;">Why ${h.displayAction || h.action}</div>
          ${notAdviceChip("inline")}
        </div>
        <div style="line-height:1.6; color:var(--text);">${h.actionReasoning || ""}</div>
        ${renderLongTermNarrative(h.longTerm)}
      </div>
      ${flagsSection}
      ${outlookSection}
      ${riskSection}
      ${exitSection}
      ${taxSection}
      ${h.earningsNearby ? `<div style="font-size:12px; padding:8px 12px; background:rgba(59,130,246,0.08); border-radius:4px; margin-top:8px;">&#128197; <strong>Upcoming earnings:</strong> ${h.earningsNearby.date}</div>` : ""}
    </div>
  </details>`;
}

function renderAnalyzerUnmatched(report) {
  const el = document.getElementById("analyzerUnmatched");
  if (!report.unmatched || report.unmatched.length === 0) {
    el.innerHTML = "";
    return;
  }
  // Bucket by instrument type so MF / ETF / F&O / unresolved are each
  // listed with the reason we didn't score them.
  const typePill = (t) => {
    const map = {
      mf:      { label: "MF",     bg: "rgba(168,85,247,0.10)", border: "rgba(168,85,247,0.3)", color: "#d8b4fe" },
      etf:     { label: "ETF",    bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.3)", color: "#93c5fd" },
      bond:    { label: "BOND",   bg: "rgba(250,204,21,0.10)", border: "rgba(250,204,21,0.3)", color: "#fde047" },
      fno:     { label: "F&O",    bg: "rgba(239,68,68,0.10)",  border: "rgba(239,68,68,0.3)",  color: "#fca5a5" },
      unknown: { label: "UNKNOWN",bg: "rgba(107,114,128,0.10)",border: "rgba(107,114,128,0.3)",color: "#9ca3af" },
      equity:  { label: "EQUITY", bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.3)",  color: "#86efac" },
    };
    const s = map[t] || map.unknown;
    return `<span style="display:inline-block; font-size:9px; font-weight:700; padding:2px 6px; border-radius:3px; background:${s.bg}; color:${s.color}; border:1px solid ${s.border}; letter-spacing:0.4px;">${s.label}</span>`;
  };

  const rows = report.unmatched.map((u) => {
    const qty = Number.isFinite(u.quantity) ? u.quantity : "—";
    const avg = Number.isFinite(u.avgPrice) ? `₹${u.avgPrice}` : "—";
    const val = Number.isFinite(u.quantity) && Number.isFinite(u.avgPrice) ? inr(u.quantity * u.avgPrice) : "—";
    return `
      <div style="display:grid; grid-template-columns: 80px 1fr 140px 100px 100px 100px; gap:12px; padding:10px 14px; border-bottom:1px solid #1a2233; font-size:12px; align-items:center;">
        <div>${typePill(u.instrumentType || "unknown")}</div>
        <div>
          <div>${u.rawName}</div>
          ${u.reason ? `<div style="color:var(--text-muted); font-size:11px; margin-top:2px; line-height:1.4;">${u.reason}</div>` : ""}
        </div>
        <div style="color:var(--text-muted); font-family:monospace; font-size:11px;">${u.isin || "no ISIN"}</div>
        <div style="text-align:right; color:var(--text-muted);">${qty}</div>
        <div style="text-align:right; color:var(--text-muted);">${avg}</div>
        <div style="text-align:right; color:var(--text-muted);">${val}</div>
      </div>`;
  }).join("");

  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="font-size:14px; font-weight:700; margin-bottom:6px;">Not analysed (${report.unmatched.length})</div>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:10px; line-height:1.5;">
        These rows are in your book but out of scope for the equity scoring engine. Each one shows why — mutual funds and ETFs need a different model, F&O is a trading vehicle, and some equities fall outside the Nifty 500 universe we track.
      </div>
      <div style="display:grid; grid-template-columns: 80px 1fr 140px 100px 100px 100px; gap:12px; font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; padding:0 14px 6px;">
        <div>Type</div><div>Name / reason</div><div>ISIN</div><div style="text-align:right;">Qty</div><div style="text-align:right;">Avg</div><div style="text-align:right;">Value</div>
      </div>
      ${rows}
    </div>
  `;
}

function renderAnalyzerDisclaimer(report) {
  const el = document.getElementById("analyzerDisclaimer");
  const generated = report.generatedAt ? new Date(report.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
  el.innerHTML = `
    <div style="font-size:11px; color:var(--text-muted); padding:14px 16px; background:rgba(239,68,68,0.03); border:1px solid rgba(239,68,68,0.15); border-radius:6px; line-height:1.6;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px;">
        <strong style="color:#fca5a5; font-size:12px;">Disclaimer &amp; data limitations</strong>
        <span style="font-size:10px; color:var(--text-muted);">Generated ${generated}</span>
      </div>
      <div style="margin-bottom:8px;">${report.disclaimer}</div>
      <div style="font-size:11px; color:var(--text-muted); line-height:1.6;">
        <strong>Data sources:</strong> Prices from Yahoo Finance (delayed up to 15 min during market hours; previous-day close when market is closed). Fundamentals from pre-cached Nifty 500 snapshots — verify current values on the issuer's exchange filings before acting.
        &nbsp;&nbsp;<strong>Risk metrics</strong> use 1y daily history and a CAPM-style beta projection — real tail events are non-linear and sector-specific.
        &nbsp;&nbsp;<strong>Tax note</strong> reflects Budget 2024 rates (20% STCG / 12.5% LTCG with ₹1.25L exemption) and assumes equity-oriented listed securities; consult a CA for your specific slab, set-off, and carry-forward situation.
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════════
// V2 ANALYZER UI — simplified hero/summary/advanced layers, gated by
// ANALYZER_UI_V2=1 (server side; client dispatches on report.ui.v2).
// Engine math is bit-for-bit identical (same `report` object). Each V2
// function lives next to its V1 counterpart so a follow-up PR can delete
// the V1 path cleanly after a 2-week soak.
// ════════════════════════════════════════════════════════════════════════

// Hero copy helpers — guarded against null/NaN inputs so V2 never renders
// "NaN%" or "undefined" on edge cases (empty book, missing risk block).
function _v2HealthVerdict(score) {
  if (!Number.isFinite(score)) return { word: "—", lead: "Live data is still arriving — score and breakdown will populate shortly." };
  if (score >= 70) return { word: "Healthy",          lead: "Your book looks healthy overall." };
  if (score >= 50) return { word: "OK",               lead: "Your book is in OK shape with a few rough edges." };
  return            { word: "Needs attention",        lead: "There are a couple of things worth fixing here." };
}
function _v2BetaSentence(b) {
  if (!Number.isFinite(b)) return null;
  if (b > 1.25) return `Your book moves about <strong>${b.toFixed(2)}×</strong> as much as the Nifty — when the index falls 10%, expect roughly ${(b * 10).toFixed(0)}% drop here.`;
  if (b > 1.05) return `Your book moves about <strong>${b.toFixed(2)}×</strong> the Nifty — slightly more volatile than the index.`;
  if (b > 0.9)  return `Your book moves roughly in lockstep with the Nifty (β ${b.toFixed(2)}).`;
  return `Your book moves about <strong>${b.toFixed(2)}×</strong> the Nifty — defensive, less volatile than the index.`;
}
function _v2VarSentence(varPct) {
  if (!Number.isFinite(varPct)) return null;
  return `On a typical bad day (worst 1-in-20), expect a <strong>~${Math.abs(varPct).toFixed(1)}%</strong> drop.`;
}

function renderAnalyzerSummaryV2(report, elapsedMs) {
  const el = document.getElementById("analyzerSummary");
  const s = report.summary;
  const h = report.health;
  const sectors = report.sectorAllocation.slice(0, 6);

  const pnlColor = pctColor(s.totalPnLPct);
  const hasHealth = h && h.score != null;
  const healthColor = !hasHealth ? "var(--text-muted)"
    : h.score >= 70 ? "var(--green, #22c55e)"
    : h.score >= 50 ? "#fde047" : "#fca5a5";
  const verdict = _v2HealthVerdict(hasHealth ? h.score : null);

  const sectorBars = sectors.map((s) =>
    `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0; font-size:12px;">
      <span style="color:var(--text-muted);">${s.sector}</span>
      <span style="font-weight:600;">${s.pct.toFixed(1)}%</span>
    </div>
    <div style="height:6px; background:#1a2233; border-radius:3px; overflow:hidden; margin-bottom:6px;">
      <div style="width:${Math.min(100, s.pct)}%; height:100%; background:var(--accent);"></div>
    </div>`,
  ).join("");

  const heroLine = hasHealth
    ? `<div style="font-size:14px; font-weight:600; color:var(--text); margin-bottom:14px; padding:10px 14px; background:rgba(96,165,250,0.05); border-left:3px solid #60a5fa; border-radius:0 6px 6px 0; line-height:1.5;">
        ${verdict.lead}
       </div>`
    : "";

  el.innerHTML = `
    ${heroLine}
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:16px; margin-bottom:16px;">
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Money put in</div>
        <div style="font-size:22px; font-weight:700;">${inr(s.totalInvested)}</div>
      </div>
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">What it's worth today</div>
        <div style="font-size:22px; font-weight:700;">${inr(s.totalCurrent)}</div>
      </div>
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">P&amp;L${s.xirrAnnualPct != null ? ` · XIRR ${s.xirrAnnualPct >= 0 ? "+" : ""}${s.xirrAnnualPct.toFixed(1)}%/yr` : ""}</div>
        <div style="font-size:22px; font-weight:700; color:${pnlColor};">
          ${s.totalPnL >= 0 ? "+" : ""}${inr(s.totalPnL)}
          <span style="font-size:14px; font-weight:500; margin-left:6px;">(${s.totalPnLPct >= 0 ? "+" : ""}${s.totalPnLPct.toFixed(2)}%)</span>
        </div>
        ${s.xirrAnnualPct != null
          ? `<div style="font-size:10px; color:var(--text-muted); margin-top:4px;" title="${s.xirrBasis || ''}">Annualised via XIRR over actual purchase dates</div>`
          : `<div style="font-size:10px; color:var(--text-muted); margin-top:4px;">Upload includes purchase dates → XIRR annualised return</div>`}
      </div>
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Portfolio Health ${infoIcon("health_score")}</div>
        <div style="font-size:22px; font-weight:700; color:${healthColor};">${hasHealth ? h.score : "—"}<span style="font-size:14px; color:var(--text-muted);">/100</span> <span style="font-size:13px; color:${healthColor}; font-weight:600;">· ${verdict.word}</span></div>
        ${hasHealth ? `
          <details style="margin-top:6px;">
            <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">Score breakdown ▾</summary>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px; padding-left:6px;">
              Avg score ${h.components.avgScore} · Diversity ${h.components.diversity}pts
            </div>
          </details>` : `<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">No equity holdings to score</div>`}
      </div>
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:13px; font-weight:700; margin-bottom:12px;">Sector allocation</div>
        ${sectorBars || '<div style="font-size:12px; color:var(--text-muted);">No sector data.</div>'}
      </div>
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:13px; font-weight:700; margin-bottom:12px;">Quality mix (by value)</div>
        ${Object.entries(report.verdictMix.value)
          .filter(([, v]) => v > 0)
          .sort(([, a], [, b]) => b - a)
          .map(([k, v]) => {
            const pct = s.totalCurrent > 0 ? (v / s.totalCurrent) * 100 : 0;
            const color = { DEEP_VALUE: "#22c55e", QUALITY_GROWTH: "#86efac", FAIR_VALUE: "#93c5fd", FULLY_VALUED: "#fde047", OVERVALUED: "#fca5a5", UNRATED: "#9ca3af" }[k] || "#9ca3af";
            return `<div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:4px 0;">
              <span style="color:${color};">${k.replace("_", " ")}</span>
              <span style="font-weight:600;">${pct.toFixed(1)}%</span>
            </div>`;
          }).join("")}
      </div>
    </div>

    ${renderRebalanceTableV2(report)}

    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; font-size:11px; color:var(--text-muted); gap:10px; flex-wrap:wrap;">
      <div>${freshnessBadge(report)}</div>
      <div>Analyzed ${s.holdingsCount} holdings${s.unmatchedCount > 0 ? ` · ${s.unmatchedCount} not analysed` : ""} · ${elapsedMs}ms</div>
    </div>
  `;
}

function renderRebalanceTableV2(report) {
  const targets = report.rebalanceTargets;
  if (!Array.isArray(targets) || targets.length === 0) return "";

  const sorted = [...targets].sort(
    (a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct),
  );
  const maxAbsDelta = Math.max(...sorted.map((t) => Math.abs(t.deltaPct)));

  return `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-top:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:10px; flex-wrap:wrap;">
        <div style="flex:1; min-width:240px;">
          <div style="font-size:14px; font-weight:700;">Rebalance preview</div>
          <div style="font-size:12px; color:var(--text); margin-top:6px; line-height:1.5;">
            Here's what your portfolio would look like if every stock pulled equal weight on risk. <strong>This is a diagnostic view — not a trade instruction.</strong>
          </div>
        </div>
        ${notAdviceChip()}
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr style="color:var(--text-muted); font-size:10px; text-transform:uppercase; letter-spacing:0.5px; border-bottom:1px solid #1a2233;">
              <th style="text-align:left; padding:8px 4px;">Symbol</th>
              <th style="text-align:right; padding:8px 4px;">Current %</th>
              <th style="text-align:right; padding:8px 4px;">Target %</th>
              <th style="text-align:right; padding:8px 4px;">Change %</th>
              <th style="text-align:right; padding:8px 4px;">Change ₹</th>
              <th style="padding:8px 4px; width:35%;">Deviation</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map((t) => {
              const isOver = t.deltaPct < 0;
              const color = Math.abs(t.deltaPct) < 2 ? "var(--text-muted)"
                : isOver ? "#fca5a5" : "#86efac";
              const barPct = maxAbsDelta > 0 ? (Math.abs(t.deltaPct) / maxAbsDelta) * 100 : 0;
              return `<tr style="border-bottom:1px solid #111827;">
                <td style="padding:8px 4px; font-family:'JetBrains Mono',monospace; font-weight:600;">${t.symbol.replace(".NS", "")}</td>
                <td style="padding:8px 4px; text-align:right; font-family:'JetBrains Mono',monospace;">${t.currentWeight.toFixed(1)}%</td>
                <td style="padding:8px 4px; text-align:right; font-family:'JetBrains Mono',monospace; color:var(--text-muted);">${t.targetWeight.toFixed(1)}%</td>
                <td style="padding:8px 4px; text-align:right; font-family:'JetBrains Mono',monospace; color:${color}; font-weight:600;">${isOver ? "" : "+"}${t.deltaPct.toFixed(1)}</td>
                <td style="padding:8px 4px; text-align:right; font-family:'JetBrains Mono',monospace; color:${color};">${isOver ? "" : "+"}${inr(t.deltaValue)}</td>
                <td style="padding:8px 4px;">
                  <div style="display:flex; align-items:center; gap:4px;">
                    <div style="flex:1; background:#0b1220; height:6px; border-radius:3px; overflow:hidden; position:relative;">
                      <div style="position:absolute; left:${isOver ? `${50 - barPct / 2}%` : "50%"}; width:${barPct / 2}%; height:100%; background:${color}; border-radius:3px;"></div>
                      <div style="position:absolute; left:50%; top:0; bottom:0; width:1px; background:#1a2233;"></div>
                    </div>
                  </div>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <details style="margin-top:10px;">
        <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">How is the target calculated? ▾</summary>
        <div style="font-size:11px; color:var(--text-muted); margin-top:6px; line-height:1.5; padding-left:6px;">
          Target weight ∝ 1/volatility, capped at 12%/stock. This is the "mathematically diversified" distribution where each stock contributes equal risk to the book — not a trade instruction.
        </div>
      </details>
    </div>
  `;
}

function renderAnalyzerRiskBlockV2(report) {
  const el = document.getElementById("analyzerRisk");
  if (!el) return;
  const r = report.risk;
  const tests = report.stressTests || [];

  if (!r && tests.length === 0) { el.innerHTML = ""; return; }

  const beta = r?.weightedBeta;
  const vol = r?.portfolioVolatilityPct;
  const benchVol = r?.benchVolatilityPct;
  const sharpe = r?.portfolioSharpe;
  const benchSharpe = r?.benchSharpe;
  const maxDD = r?.maxDrawdownPct;
  const var95 = r?.var95DailyPct;
  const benchVar95 = r?.benchVar95DailyPct;
  const avgCorr = r?.avgCorrelation;

  const betaColor = beta == null ? "var(--text-muted)"
    : beta > 1.25 ? "#fca5a5"
    : beta > 1.0  ? "#fde047"
    : "#86efac";
  const volColor = (vol == null || benchVol == null) ? "var(--text-muted)"
    : vol > benchVol * 1.2 ? "#fca5a5"
    : vol < benchVol * 0.8 ? "#86efac"
    : "#fde047";
  const sharpeColor = sharpe == null ? "var(--text-muted)"
    : sharpe > 1 ? "#86efac"
    : sharpe > 0 ? "#fde047"
    : "#fca5a5";

  const fmtPct = (v, withSign = false) => v == null ? "—" : `${withSign && v >= 0 ? "+" : ""}${v.toFixed(v >= 10 || v <= -10 ? 0 : 1)}%`;
  const fmtNum = (v) => v == null ? "—" : v.toFixed(2);

  const confBand = r?.confidence || (r?.sampleDays >= 252 ? "high" : r?.sampleDays >= 126 ? "medium" : "low");
  const confColor = { high: "#86efac", medium: "#fde047", low: "#fca5a5" }[confBand] || "var(--text-muted)";
  const confChip = r?.sampleDays != null
    ? `<span style="font-size:10px; color:${confColor}; background:${confColor}22; padding:3px 8px; border-radius:4px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase;" title="Confidence based on ${r.sampleDays} daily observations.">Confidence: ${confBand}</span>`
    : "";
  const betaBand = r?.weightedBetaSE != null
    ? `±${r.weightedBetaSE} (1σ)`
    : `${r?.betaCoverage ?? 0}/${r?.betaTotal ?? 0} holdings priced`;
  const sharpeBand = r?.portfolioSharpeSE != null
    ? `±${r.portfolioSharpeSE} (1σ) · Nifty: ${fmtNum(benchSharpe)}`
    : `Nifty: ${fmtNum(benchSharpe)}`;

  // Hero copy guarded against null
  const heroLines = [];
  const betaLine = _v2BetaSentence(beta);
  const varLine = _v2VarSentence(var95);
  if (betaLine) heroLines.push(betaLine);
  if (varLine) heroLines.push(varLine);
  const heroBlock = heroLines.length
    ? `<div style="margin-bottom:14px; padding:10px 14px; background:rgba(96,165,250,0.05); border-left:3px solid #60a5fa; border-radius:0 6px 6px 0; font-size:13px; line-height:1.6;">
        ${heroLines.map((l) => `<div>${l}</div>`).join("")}
       </div>` : "";

  const riskCard = r ? `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">How risky is your book?</div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">${notAdviceChip()}</div>
      </div>
      ${heroBlock}
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px;">
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Market sensitivity (beta) ${infoIcon("beta_metric")}</div>
          <div style="font-size:20px; font-weight:700; color:${betaColor};">${fmtNum(beta)}</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">How much it swings (volatility) ${infoIcon("volatility")}</div>
          <div style="font-size:20px; font-weight:700; color:${volColor};">${fmtPct(vol)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Nifty: ${fmtPct(benchVol)}</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Return per unit of risk (Sharpe) ${infoIcon("sharpe")}</div>
          <div style="font-size:20px; font-weight:700; color:${sharpeColor};">${fmtNum(sharpe)}</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Worst peak-to-trough drop (1y) ${infoIcon("max_drawdown")}</div>
          <div style="font-size:20px; font-weight:700; color:#fca5a5;">${fmtPct(maxDD)}</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Worst-day loss (1-in-20) ${infoIcon("var95")}</div>
          <div style="font-size:20px; font-weight:700; color:#fca5a5;">${fmtPct(var95)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Nifty: ${fmtPct(benchVar95)}</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">How together your stocks move ${infoIcon("pairwise_correlation")}</div>
          <div style="font-size:20px; font-weight:700;">${fmtNum(avgCorr)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">1 = all move together</div>
        </div>
      </div>
      <details style="margin-top:12px;">
        <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">Methodology &amp; confidence ▾</summary>
        <div style="font-size:11px; color:var(--text-muted); margin-top:6px; line-height:1.6; padding-left:6px;">
          ${confChip}
          <div style="margin-top:6px;">Beta band: ${betaBand}</div>
          <div style="margin-top:2px;">Sharpe band: ${sharpeBand}</div>
          <div style="margin-top:2px;">Vs. Nifty 50, last ${r.sampleDays} trading days. ${r.methodology || ""}</div>
          ${r.interpretation ? `<div style="margin-top:6px; padding:8px 10px; background:rgba(147,197,253,0.05); border-left:2px solid #60a5fa; border-radius:3px; color:var(--text);">${r.interpretation}</div>` : ""}
        </div>
      </details>
    </div>` : "";

  // Stress hero — find the most-severe scenario for the lead line
  const largest = tests.reduce((a, b) => (Math.abs(b.projectedLossPct ?? 0) > Math.abs(a?.projectedLossPct ?? 0) ? b : a), null);
  const stressHero = largest && Number.isFinite(largest.marketShockPct) && Number.isFinite(largest.projectedLossAmount)
    ? `<div style="margin-bottom:14px; padding:10px 14px; background:rgba(252,165,165,0.05); border-left:3px solid #fca5a5; border-radius:0 6px 6px 0; font-size:13px; line-height:1.6;">
        If the Nifty drops <strong>${Math.abs(largest.marketShockPct).toFixed(0)}%</strong>, you'd likely lose around <strong>${inr(Math.abs(largest.projectedLossAmount))}</strong> (${largest.projectedLossPct.toFixed(1)}% of book).
       </div>` : "";

  const rows = tests.map((t) => {
    const pct = t.projectedLossPct;
    const amt = t.projectedLossAmount;
    const color = pct < -25 ? "#fca5a5" : pct < -15 ? "#fde047" : "#93c5fd";
    return `
      <div style="display:grid; grid-template-columns: 1fr 120px 100px 140px; gap:12px; align-items:center; padding:10px 0; border-bottom:1px solid #1a2233; font-size:13px;">
        <div>${t.name}</div>
        <div style="color:var(--text-muted); font-size:12px;">Nifty ${fmtPct(t.marketShockPct, true)}</div>
        <div style="color:${color}; font-weight:700;">${fmtPct(pct, true)}</div>
        <div style="color:${color}; font-weight:600; text-align:right;">${amt >= 0 ? "+" : ""}${inr(amt)}</div>
      </div>`;
  }).join("");

  const pureBetaRows = tests.map((t) => {
    const pure = t.projectedLossPctPureBeta;
    const adj = t.projectedLossPct;
    if (pure == null || adj == null) return "";
    return `
      <div style="display:grid; grid-template-columns: 1fr 120px 120px; gap:12px; padding:6px 0; font-size:12px; color:var(--text-muted);">
        <div>${t.name}</div>
        <div>Pure-β: ${fmtPct(pure, true)}</div>
        <div>Sector adds ${(adj - pure).toFixed(1)}pp</div>
      </div>`;
  }).join("");

  const stressCard = tests.length ? `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">What happens if the market crashes?</div>
        ${notAdviceChip()}
      </div>
      ${stressHero}
      <div style="display:grid; grid-template-columns: 1fr 120px 100px 140px; gap:12px; font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; padding-bottom:4px;">
        <div>Scenario</div><div>Market shock</div><div>Projected Δ</div><div style="text-align:right;">Δ in ₹</div>
      </div>
      ${rows}
      <details style="margin-top:10px;">
        <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">How are these calculated? ▾</summary>
        <div style="margin-top:8px;">
          ${pureBetaRows ? `<div style="margin-bottom:8px;">${pureBetaRows}</div>` : ""}
          <div style="font-size:11px; color:var(--text-muted); line-height:1.55;">
            Two models side-by-side: (1) pure β × market shock, (2) β × sector-dispersion multiplier. Multipliers calibrated from 2008 GFC + 2020 COVID drawdowns on NSE sectorals: NBFC 1.6×, Metals 1.5×, Banking 1.4×, Auto 1.3×, IT 0.8×, Pharma 0.7×, FMCG 0.7×. Sector-adjusted model matches historical drawdowns more closely; pure-β typically underestimates tail risk for small/mid-caps.
          </div>
        </div>
      </details>
    </div>` : "";

  // Currency
  const cx = report.currencyExposure;
  const currencyHero = cx
    ? `<div style="margin-bottom:14px; padding:10px 14px; background:rgba(134,239,172,0.05); border-left:3px solid #86efac; border-radius:0 6px 6px 0; font-size:13px; line-height:1.6;">
        About <strong>${cx.usdEarningPct.toFixed(1)}%</strong> of your earnings are USD-linked (IT + Pharma) — that's a natural hedge if the rupee weakens.
       </div>` : "";

  const currencyCard = cx ? `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-top:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">Rupee vs dollar split</div>
        ${notAdviceChip()}
      </div>
      ${currencyHero}
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Rupee earners</div>
          <div style="font-size:20px; font-weight:700;">${cx.inrExposurePct.toFixed(1)}%</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Full INR-denominated earnings</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Dollar earners</div>
          <div style="font-size:20px; font-weight:700; color:#86efac;">${cx.usdEarningPct.toFixed(1)}%</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">IT Services + Pharma (${inr(cx.usdEarningValue)})</div>
        </div>
      </div>
      <details style="margin-top:10px;">
        <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">Why this matters ▾</summary>
        <div style="margin-top:8px;">
          <div style="font-size:12px; color:var(--text-secondary); line-height:1.6; margin-bottom:8px;">${cx.narrative}</div>
          <div style="font-size:10px; color:var(--text-muted); font-style:italic;">Methodology: ${cx.methodology}</div>
        </div>
      </details>
    </div>` : "";

  el.innerHTML = riskCard + stressCard + currencyCard;
}

async function renderAnalyzerRiskProfileV2(rpBlock) {
  // V2 differs from V1 only when bucket is set — wraps the cryptic "Score X/9
  // · target allocation tuned to this profile" sub-line in <details>, and
  // leads with a plain-English sentence. Survey path is byte-identical.
  const el = document.getElementById("analyzerRiskProfile");
  if (!el) return;

  let questions = window.__rpQuestionsCache;
  if (!questions) {
    try {
      const r = await fetch("/api/risk-profile");
      const j = await r.json();
      questions = j.questions || [];
      window.__rpQuestionsCache = questions;
    } catch {
      questions = [];
    }
  }

  const present = !!(rpBlock && rpBlock.present);

  if (present) {
    const bucketColor = {
      CONSERVATIVE: "#60a5fa",
      MODERATE:     "#a78bfa",
      AGGRESSIVE:   "#f97316",
    }[rpBlock.bucket] || "#94a3b8";
    el.innerHTML = `
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:14px 18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <div>
            <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted); margin-bottom:4px;">Risk Profile</div>
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
              <span style="display:inline-flex; align-items:center; gap:6px; padding:5px 12px; background:${bucketColor}22; border:1px solid ${bucketColor}55; border-radius:6px; color:${bucketColor}; font-weight:700; font-size:13px;">
                ${rpBlock.bucket}
              </span>
            </div>
            <div style="font-size:13px; color:var(--text); margin-top:8px; line-height:1.5;">
              You're a <strong>${rpBlock.bucket}</strong> investor. Your portfolio is being measured against ${rpBlock.bucket.toLowerCase()}-aligned targets.
            </div>
          </div>
          <button id="analyzerRiskProfileEdit" type="button" style="background:transparent; border:1px solid #1a2233; color:var(--text-muted); border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer;">Retake survey</button>
        </div>
        <details style="margin-top:10px;">
          <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">Methodology ▾</summary>
          <div style="font-size:11px; color:var(--text-muted); margin-top:6px; padding-left:6px; line-height:1.6;">
            Score ${rpBlock.score}/9 · target allocation tuned to this profile. SEBI IA-Reg 2013 requires risk profiling before any portfolio recommendation; this 3-question survey is the minimum suitability assessment.
          </div>
        </details>
      </div>`;
    document.getElementById("analyzerRiskProfileEdit")?.addEventListener("click", async () => {
      try { await fetch("/api/risk-profile", { method: "DELETE" }); } catch {}
      renderAnalyzerRiskProfileV2({ present: false });
    });
    return;
  }

  // Unset path — identical to V1
  if (!Array.isArray(questions) || questions.length === 0) {
    el.innerHTML = `
      <div style="background:var(--panel); border:1px solid rgba(245,158,11,0.4); border-radius:10px; padding:14px 18px; color:#fde68a; font-size:13px;">
        Risk-profile questionnaire unavailable. Recommendations will use the default MODERATE profile.
      </div>`;
    return;
  }

  const questionsHtml = questions.map((q) => `
    <div style="margin-bottom:14px;">
      <div style="font-size:13px; color:var(--text); font-weight:600; margin-bottom:6px;">${q.label}</div>
      ${q.helper ? `<div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">${q.helper}</div>` : ""}
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${q.options.map((o) => `
          <label style="display:inline-flex; align-items:center; gap:6px; padding:6px 12px; background:#0f172a; border:1px solid #1a2233; border-radius:6px; cursor:pointer; font-size:12px; color:var(--text);">
            <input type="radio" name="rp_${q.id}" value="${o.value}" style="margin:0;" />
            ${o.label}
          </label>
        `).join("")}
      </div>
    </div>
  `).join("");

  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid rgba(245,158,11,0.35); border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:14px;">
        <div>
          <div style="font-size:14px; font-weight:700; color:var(--text); display:flex; align-items:center; gap:10px;">
            Complete your risk profile <span style="font-size:10px; padding:2px 8px; background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.4); border-radius:6px; color:#fde68a; text-transform:uppercase; letter-spacing:0.4px;">recommended</span>
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
            SEBI IA-Reg 2013 requires risk profiling before any portfolio recommendation. Without it, the analyser uses default MODERATE assumptions.
          </div>
        </div>
      </div>
      <div id="analyzerRiskProfileForm">${questionsHtml}</div>
      <div style="display:flex; gap:10px; align-items:center; margin-top:14px;">
        <button id="analyzerRiskProfileSubmit" type="button" style="background:#16a34a; color:white; border:none; border-radius:6px; padding:8px 16px; font-weight:600; font-size:13px; cursor:pointer;">Save profile &amp; re-run</button>
        <span id="analyzerRiskProfileStatus" style="font-size:11px; color:var(--text-muted);"></span>
      </div>
    </div>`;

  document.getElementById("analyzerRiskProfileSubmit")?.addEventListener("click", async () => {
    const status = document.getElementById("analyzerRiskProfileStatus");
    const answers = {};
    let missing = 0;
    for (const q of questions) {
      const checked = document.querySelector(`input[name="rp_${q.id}"]:checked`);
      if (!checked) { missing += 1; continue; }
      answers[q.id] = checked.value;
    }
    if (missing > 0) {
      status.textContent = `Please answer all ${questions.length} questions (${missing} remaining).`;
      status.style.color = "#fca5a5";
      return;
    }
    status.textContent = "Saving…";
    status.style.color = "var(--text-muted)";
    try {
      const r = await fetch("/api/risk-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "save failed");
      status.textContent = `Saved → ${j.riskProfile.bucket}. Re-running analysis…`;
      status.style.color = "#86efac";
      renderAnalyzerRiskProfileV2({ present: true, bucket: j.riskProfile.bucket, score: j.riskProfile.score });
      const allocEl = document.getElementById("analyzerAssetAllocation");
      if (allocEl) {
        allocEl.insertAdjacentHTML("afterbegin", `
          <div style="background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.4); border-radius:8px; padding:10px 14px; margin-bottom:12px; font-size:12px; color:#86efac;">
            ✓ Profile saved. Re-upload your holdings file (or re-run the analyser) to refresh allocation targets and per-fund alignment chips.
          </div>`);
      }
    } catch (err) {
      status.textContent = `Save failed: ${err.message}`;
      status.style.color = "#fca5a5";
    }
  });
}

function renderAnalyzerAssetAllocationV2(alloc, rpBlock) {
  const el = document.getElementById("analyzerAssetAllocation");
  if (!el) return;
  if (!alloc || !Array.isArray(alloc.buckets) || alloc.buckets.length === 0) {
    el.innerHTML = "";
    return;
  }

  const profileLabel = alloc.targetSource === "user_profile"
    ? `your ${alloc.riskProfileBucket} profile`
    : `default MODERATE profile (complete the survey above for personalised targets)`;

  const VERDICT_PALETTE = {
    OK:       { bg: "rgba(34,197,94,0.10)",  border: "rgba(34,197,94,0.35)",  text: "#86efac", label: "On target" },
    REDUCE:   { bg: "rgba(239,68,68,0.10)",  border: "rgba(239,68,68,0.35)",  text: "#fca5a5", label: "Reduce" },
    INCREASE: { bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.35)", text: "#93c5fd", label: "Increase" },
    ADD_NEW:  { bg: "rgba(168,85,247,0.10)", border: "rgba(168,85,247,0.35)", text: "#d8b4fe", label: "Add new" },
  };

  // Hero copy
  const offTargetBuckets = alloc.buckets.filter((b) => b.verdict !== "OK");
  let heroLine;
  if (offTargetBuckets.length === 0) {
    const bucketName = (rpBlock?.bucket || alloc.riskProfileBucket || "MODERATE").toLowerCase();
    heroLine = `Your asset mix matches the target for your <strong>${bucketName}</strong> profile.`;
  } else {
    const worst = offTargetBuckets.reduce((a, b) => Math.abs(b.gapPp || 0) > Math.abs(a.gapPp || 0) ? b : a);
    const direction = worst.verdict === "REDUCE" ? "over-weight" : "under-weight";
    heroLine = `You're <strong>${direction}</strong> in <strong>${worst.label}</strong> — target is ${worst.targetPct}%, you have ${worst.currentPct}%.`;
  }
  const heroBlock = `<div style="margin-top:8px; padding:10px 14px; background:rgba(96,165,250,0.05); border-left:3px solid #60a5fa; border-radius:0 6px 6px 0; font-size:13px; line-height:1.6;">${heroLine}</div>`;

  const barSegments = alloc.buckets
    .filter((b) => b.currentPct > 0)
    .map((b, i) => {
      const colors = ["#3b82f6", "#a78bfa", "#f97316", "#10b981", "#f59e0b", "#ec4899", "#06b6d4", "#84cc16"];
      const c = colors[i % colors.length];
      return `<div title="${b.label} ${b.currentPct}%" style="flex:0 0 ${b.currentPct}%; background:${c}; height:100%;"></div>`;
    }).join("");

  const bucketRows = alloc.buckets.map((b) => {
    const pal = VERDICT_PALETTE[b.verdict] || VERDICT_PALETTE.OK;
    const gapStr = b.gapPp >= 0 ? `+${b.gapPp}pp` : `${b.gapPp}pp`;
    const gapColor = b.verdict === "OK" ? "var(--text-muted)" : pal.text;
    return `
      <div style="display:grid; grid-template-columns:1.6fr 90px 90px 100px 100px; gap:12px; align-items:center; padding:10px 12px; background:#0f172a; border:1px solid #1a2233; border-radius:6px; margin-top:6px;">
        <div>
          <div style="font-size:13px; color:var(--text); font-weight:600;">${b.label}</div>
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px;">${b.risk} risk</div>
        </div>
        <div style="font-size:13px; color:var(--text); font-weight:700;">${b.currentPct}%</div>
        <div style="font-size:11px; color:var(--text-muted);">target ${b.targetPct}%</div>
        <div style="font-size:13px; color:${gapColor}; font-weight:600;">${gapStr}</div>
        <div>
          <span style="display:inline-block; padding:3px 10px; background:${pal.bg}; border:1px solid ${pal.border}; border-radius:4px; color:${pal.text}; font-size:11px; font-weight:600;">${pal.label}</span>
        </div>
      </div>`;
  }).join("");

  const flagsHtml = (alloc.summary?.concentrationFlags || []).map((f) => `
    <div style="display:flex; gap:8px; align-items:flex-start; padding:8px 12px; background:rgba(239,68,68,0.08); border-left:3px solid rgba(239,68,68,0.5); border-radius:0 6px 6px 0; margin-top:6px;">
      <span style="color:#fca5a5; font-weight:700; flex-shrink:0;">!</span>
      <span style="font-size:12px; color:var(--text); line-height:1.5;">${f}</span>
    </div>`).join("");

  const summary = alloc.summary || {};
  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
        <div style="flex:1; min-width:240px;">
          <div style="font-size:14px; font-weight:700; color:var(--text); display:flex; align-items:center; gap:10px;">
            Are you spread across the right assets?
            ${notAdviceChip("inline")}
          </div>
          ${heroBlock}
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${summary.equityPct ? `<span style="font-size:11px; padding:4px 10px; background:#0f172a; border:1px solid #1a2233; border-radius:4px;"><strong>${summary.equityPct}%</strong> equity</span>` : ""}
          ${summary.debtPct ? `<span style="font-size:11px; padding:4px 10px; background:#0f172a; border:1px solid #1a2233; border-radius:4px;"><strong>${summary.debtPct}%</strong> debt</span>` : `<span style="font-size:11px; padding:4px 10px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.35); border-radius:4px; color:#fca5a5;"><strong>0%</strong> debt</span>`}
          ${summary.hybridPct ? `<span style="font-size:11px; padding:4px 10px; background:#0f172a; border:1px solid #1a2233; border-radius:4px;"><strong>${summary.hybridPct}%</strong> hybrid</span>` : ""}
          ${summary.commodityPct ? `<span style="font-size:11px; padding:4px 10px; background:#0f172a; border:1px solid #1a2233; border-radius:4px;"><strong>${summary.commodityPct}%</strong> gold</span>` : ""}
        </div>
      </div>

      <div style="display:flex; height:14px; border-radius:4px; overflow:hidden; background:#0f172a; margin-top:14px; border:1px solid #1a2233;">
        ${barSegments || '<div style="flex:1;"></div>'}
      </div>

      <div style="margin-top:14px;">
        <div style="display:grid; grid-template-columns:1.6fr 90px 90px 100px 100px; gap:12px; padding:0 12px; font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted);">
          <div>Asset class</div><div>Current</div><div>Target</div><div>Gap</div><div>Verdict</div>
        </div>
        ${bucketRows}
      </div>

      ${flagsHtml ? `
        <div style="margin-top:14px;">
          <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:#fca5a5; margin-bottom:6px;">Concentration flags</div>
          ${flagsHtml}
        </div>` : ""}

      <details style="margin-top:14px;">
        <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">Methodology ▾</summary>
        <div style="font-size:11px; color:var(--text-muted); margin-top:6px; padding-left:6px; line-height:1.6;">
          Current allocation vs ${profileLabel} · book ₹${(alloc.totalCurrent / 1e5).toFixed(2)}L
        </div>
      </details>
    </div>`;
}

const MF_ACTION_PALETTE_V2 = {
  EXIT:        { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.5)",  text: "#fca5a5", verb: "Consider exiting" },
  SWITCH:      { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.5)", text: "#93c5fd", verb: "Consider switching" },
  CONSOLIDATE: { bg: "rgba(168,85,247,0.12)", border: "rgba(168,85,247,0.5)", text: "#d8b4fe", verb: "Consider consolidating" },
  ADD:         { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.5)",  text: "#86efac", verb: "Consider adding" },
  HOLD:        { bg: "rgba(107,114,128,0.10)",border: "rgba(107,114,128,0.35)",text: "#cbd5e1", verb: "Hold" },
};

function mfActionBadgeV2(action) {
  const p = MF_ACTION_PALETTE_V2[action] || MF_ACTION_PALETTE_V2.HOLD;
  return `<span style="display:inline-block; padding:4px 12px; border-radius:4px; background:${p.bg}; border:1px solid ${p.border}; color:${p.text}; font-size:11px; font-weight:700; letter-spacing:0.4px;">${p.verb}</span>`;
}

function renderAnalyzerMfPositionsV2(block) {
  const el = document.getElementById("analyzerMfPositions");
  if (!el) return;
  if (!block || !Array.isArray(block.positions) || block.positions.length === 0) {
    el.innerHTML = "";
    return;
  }

  const positions = block.positions;
  const mix = block.actionMix || {};
  const totalInvested = positions.reduce((s, p) => s + (p.invested || 0), 0);
  const totalCurrent = positions.reduce((s, p) => s + (p.currentValue || 0), 0);
  const actionableCount = (mix.EXIT || 0) + (mix.SWITCH || 0) + (mix.CONSOLIDATE || 0) + (mix.ADD || 0);

  const heroLine = actionableCount === 0
    ? `<div style="font-size:13px; color:var(--text); margin-top:6px; line-height:1.5;">All ${positions.length} of your funds are in HOLD range — no actionable recommendations right now.</div>`
    : `<div style="font-size:13px; color:var(--text); margin-top:6px; line-height:1.5;">
         <strong>${actionableCount}</strong> of your <strong>${positions.length}</strong> funds need attention.
         ${(mix.EXIT || 0) > 0 ? `<strong>${mix.EXIT}</strong> look like exit candidates. ` : ""}
         ${(mix.SWITCH || 0) > 0 ? `<strong>${mix.SWITCH}</strong> have stronger peers in the same category. ` : ""}
         ${(mix.CONSOLIDATE || 0) > 0 ? `<strong>${mix.CONSOLIDATE}</strong> can be consolidated. ` : ""}
       </div>`;

  const ORDER = ["EXIT", "SWITCH", "CONSOLIDATE", "ADD", "HOLD"];
  const mixChips = ORDER
    .filter((a) => (mix[a] || 0) > 0)
    .map((a) => {
      const p = MF_ACTION_PALETTE_V2[a];
      return `<span style="display:inline-flex; align-items:center; gap:6px; padding:6px 12px; background:${p.bg}; border:1px solid ${p.border}; border-radius:6px; color:${p.text}; font-size:13px; font-weight:600;">
        <strong style="font-size:16px;">${mix[a]}</strong> ${a.toLowerCase()}
      </span>`;
    })
    .join("");

  const overlap = block.overlap || {};
  const hasOverlap = overlap.duplicateFolioCount > 0 || (overlap.overweightCategories || []).length > 0;
  const overlapNote = hasOverlap
    ? `<details style="margin-top:10px;">
        <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">Book hygiene details ▾</summary>
        <div style="font-size:11px; color:var(--text-muted); margin-top:6px; padding-left:6px; line-height:1.6;">
          ${overlap.duplicateFolioCount > 0 ? `<div><strong style="color:#d8b4fe;">${overlap.duplicateFolioCount} duplicate folio(s)</strong> — same scheme split across multiple folios; consolidating reduces tracking overhead.</div>` : ""}
          ${(overlap.overweightCategories || []).length > 0 ? `<div><strong style="color:#fde047;">${overlap.overweightCategories.length} category(s) with 2+ funds</strong> — overlap of holdings expected; check the per-fund peer compare to spot the weakest of each set.</div>` : ""}
        </div>
       </details>`
    : "";

  const summary = block.summary || {};
  const concerns = summary.concerns || [];
  const opportunities = summary.opportunities || [];
  const summaryRow = (concerns.length > 0 || opportunities.length > 0) ? `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px;">
      <div style="background:#0f172a; border:1px solid rgba(239,68,68,0.25); border-radius:6px; padding:10px 12px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:#fca5a5; margin-bottom:6px;">Top concerns</div>
        ${concerns.length === 0 ? '<div style="font-size:11px; color:var(--text-muted); font-style:italic;">No material concerns flagged.</div>'
          : concerns.map((c) => `<div style="font-size:11px; color:var(--text); margin-bottom:3px;">• ${c.detail}</div>`).join("")}
      </div>
      <div style="background:#0f172a; border:1px solid rgba(34,197,94,0.25); border-radius:6px; padding:10px 12px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:#86efac; margin-bottom:6px;">Top switch opportunities</div>
        ${opportunities.length === 0 ? '<div style="font-size:11px; color:var(--text-muted); font-style:italic;">No SWITCH candidates above the noise floor.</div>'
          : opportunities.map((o) => `<div style="font-size:11px; color:var(--text); margin-bottom:3px;">• ${o.from.name?.slice(0,32)} → ${o.to?.slice(0,32)} <strong style="color:#86efac;">+${o.deltaPp}pp</strong></div>`).join("")}
      </div>
    </div>` : "";

  const header = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
        <div>
          <div style="font-size:14px; font-weight:700; display:flex; align-items:center; gap:10px;">
            What to do with your mutual funds
            ${notAdviceChip("inline")}
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
            ${positions.length} MF position(s) · ${actionableCount} actionable · book ₹${(totalCurrent/1e5).toFixed(2)}L (cost ₹${(totalInvested/1e5).toFixed(2)}L)
          </div>
          ${heroLine}
        </div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">${mixChips || '<span style="font-size:12px; color:var(--text-muted);">No actionable positions.</span>'}</div>
      ${overlapNote}
      ${summaryRow}
    </div>`;

  const cards = positions.map((p, idx) => renderMfPositionCardV2(p, idx)).join("");

  el.innerHTML = `
    ${header}
    ${cards}
  `;
}

function renderMfPositionCardV2(position, idx) {
  const rec = position.rec || {};
  const action = rec.action || "HOLD";
  const palette = MF_ACTION_PALETTE_V2[action] || MF_ACTION_PALETTE_V2.HOLD;
  const perf = rec.performance || {};
  const factors = rec.factors || {};

  const pnlPctVal = position.pnlPercent;
  const pnlColor = pctColor(pnlPctVal);
  const pnlText = Number.isFinite(pnlPctVal) ? `${pnlPctVal >= 0 ? "+" : ""}${pnlPctVal.toFixed(2)}%` : "—";

  const sourceLabel = factors.trailingXirrSource === "amfi_3y" ? "AMFI 3y CAGR"
    : factors.trailingXirrSource === "amfi_1y" ? "AMFI 1y CAGR"
    : factors.trailingXirrSource === "groww_xirr" ? "Groww trailing XIRR"
    : "—";
  const perfLine = Number.isFinite(perf.trailingXirrPct)
    ? `<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">
         <span style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px;">${sourceLabel}:</span>
         <strong style="color:${perf.vsCategoryPp >= 0 ? '#86efac' : '#fca5a5'};">${perf.trailingXirrPct.toFixed(2)}%</strong>
         ${Number.isFinite(perf.vsCategoryPp) ? `· vs ${perf.categoryKey || 'category'} benchmark ${perf.categoryBenchmarkPct}% <strong style="color:${perf.vsCategoryPp >= 0 ? '#86efac' : '#fca5a5'};">(${perf.vsCategoryPp >= 0 ? "+" : ""}${perf.vsCategoryPp}pp)</strong>` : ""}
       </div>`
    : `<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">No published XIRR or AMFI match available.</div>`;

  const m = factors.metrics;
  const hasMultiWindow = m && (Number.isFinite(m.cagr1yPct) || Number.isFinite(m.cagr3yPct) || Number.isFinite(m.cagr5yPct) || Number.isFinite(m.sharpe3y) || Number.isFinite(m.annualVolPct) || Number.isFinite(m.maxDrawdownPct));
  const multiWindowDetails = hasMultiWindow ? `
    <details style="margin-top:8px;">
      <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">Show metrics ▾</summary>
      <div style="display:flex; flex-wrap:wrap; gap:14px; font-size:11px; color:var(--text-muted); margin-top:6px; padding:8px 12px; background:#0f172a; border-radius:6px; border:1px solid #1a2233;">
        ${Number.isFinite(m.cagr1yPct) ? `<span>1y <strong style="color:${m.cagr1yPct >= 0 ? '#86efac' : '#fca5a5'};">${m.cagr1yPct}%</strong></span>` : ""}
        ${Number.isFinite(m.cagr3yPct) ? `<span>3y <strong style="color:${m.cagr3yPct >= 0 ? '#86efac' : '#fca5a5'};">${m.cagr3yPct}%</strong></span>` : ""}
        ${Number.isFinite(m.cagr5yPct) ? `<span>5y <strong style="color:${m.cagr5yPct >= 0 ? '#86efac' : '#fca5a5'};">${m.cagr5yPct}%</strong></span>` : ""}
        ${Number.isFinite(m.sharpe3y) ? `<span>Sharpe(3y) ${infoIcon("sharpe")} <strong style="color:var(--text);">${m.sharpe3y}</strong></span>` : ""}
        ${Number.isFinite(m.annualVolPct) ? `<span>Vol <strong style="color:var(--text);">${m.annualVolPct}%</strong></span>` : ""}
        ${Number.isFinite(m.maxDrawdownPct) ? `<span>Max DD <strong style="color:#fca5a5;">${m.maxDrawdownPct}%</strong></span>` : ""}
        ${factors.amfi?.schemeCode ? `<span style="opacity:0.6;">AMFI #${factors.amfi.schemeCode}${factors.amfi.matchType === "isin" ? " · ISIN match" : factors.amfi.score ? ` · name match ${factors.amfi.score}` : ""}</span>` : ""}
      </div>
    </details>` : "";

  const reasons = rec.reasons || [];
  const leadReason = reasons.length > 0
    ? `<div style="font-size:13px; color:var(--text); margin-top:10px; padding:10px 12px; background:rgba(96,165,250,0.04); border-left:3px solid #60a5fa; border-radius:0 6px 6px 0;">
        <strong style="color:${palette.text}; text-transform:uppercase; letter-spacing:0.3px; font-size:11px;">${reasons[0].label}:</strong>
        <span style="line-height:1.5;"> ${reasons[0].detail}</span>
       </div>`
    : "";
  const remainingReasons = reasons.slice(1);
  const reasonsHtml = remainingReasons.map((r) => `
    <div style="background:#0f172a; border-left:3px solid ${palette.border}; padding:8px 12px; margin-top:6px; border-radius:0 6px 6px 0;">
      <div style="font-size:11px; font-weight:700; color:${palette.text}; letter-spacing:0.3px; text-transform:uppercase; margin-bottom:2px;">${r.label}</div>
      <div style="font-size:12px; color:var(--text-muted); line-height:1.45;">${r.detail}</div>
    </div>
  `).join("");

  const peers = rec.peerCandidates || [];
  const peersHtml = peers.length > 0 ? `
    <div style="margin-top:12px; padding-top:12px; border-top:1px solid #1a2233;">
      <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted); margin-bottom:6px;">Peer compare (same SEBI category)</div>
      ${peers.map((c, i) => {
        const meta = c.source === "amfi_live"
          ? `5y ${c.approxXirr5yPct}%${Number.isFinite(c.cagr3yPct) ? ` · 3y ${c.cagr3yPct}%` : ""}${Number.isFinite(c.sharpe3y) ? ` · Sharpe ${c.sharpe3y}` : ""} · ${c.amc || "AMC"}`
          : `5y ${c.approxXirr5yPct}%${c.expenseRatioPct ? ` · TER ${c.expenseRatioPct}%` : ""}${c.categoryRank5y ? ` · rank #${c.categoryRank5y}` : ""}${c.lockInMonths ? ` · ${c.lockInMonths}mo lock` : ""}`;
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:6px 0; border-bottom:${i < peers.length-1 ? '1px solid #1a2233' : '0'};">
          <div style="flex:1; min-width:0;">
            <div style="font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.name}</div>
            <div style="font-size:10px; color:var(--text-muted); margin-top:1px;">${meta}</div>
          </div>
          ${Number.isFinite(c.deltaPp) ? `<div style="font-size:13px; font-weight:700; color:${c.deltaPp > 0 ? '#86efac' : '#fca5a5'};">${c.deltaPp > 0 ? "+" : ""}${c.deltaPp}pp</div>` : ""}
        </div>
      `;}).join("")}
    </div>
  ` : "";

  const consolidateNote = rec.consolidateTo ? `
    <div style="margin-top:10px; padding:8px 12px; background:rgba(168,85,247,0.08); border:1px solid rgba(168,85,247,0.3); border-radius:6px; font-size:12px; color:#d8b4fe;">
      Consolidate into folio <strong>${rec.consolidateTo.folio}</strong> (largest sibling holding the same scheme).
    </div>` : "";

  const news = position.news;
  const newsHtml = renderMfNewsBlock(news);

  return `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:16px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:10px;">
        <div style="flex:1; min-width:240px;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <span style="font-size:11px; font-weight:700; color:var(--text-muted);">#${idx + 1}</span>
            ${mfActionBadgeV2(action)}
            ${mfConfidencePill(rec.confidence || "LOW")}
            ${riskAlignmentChip(factors.riskAlignment)}
          </div>
          <div style="font-weight:700; font-size:14px; margin-top:8px;">${position.name || "—"}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            ${position.category || ""}${position.subCategory ? ` · ${position.subCategory}` : ""}${position.folio ? ` · folio ${position.folio}` : ""}
          </div>
        </div>
        <div style="text-align:right; min-width:160px;">
          <div style="font-size:11px; color:var(--text-muted);">Invested → Current</div>
          <div style="font-size:14px; font-weight:700; margin-top:2px;">${inr(position.invested)} → ${inr(position.currentValue)}</div>
          <div style="font-size:13px; font-weight:600; color:${pnlColor}; margin-top:2px;">${pnlText}</div>
        </div>
      </div>
      ${leadReason}
      ${perfLine}
      ${multiWindowDetails}
      ${remainingReasons.length ? `<div style="margin-top:12px;">${reasonsHtml}</div>` : ""}
      ${consolidateNote}
      ${peersHtml}
      ${newsHtml}
    </div>
  `;
}

function renderAnalyzerOptimizerV2(optimizer) {
  const el = document.getElementById("analyzerOptimizer");
  if (!el) return;

  if (!optimizer) {
    el.innerHTML = `
      <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
        <div style="font-size:14px; font-weight:700; margin-bottom:8px;">Where could your returns improve?</div>
        <div style="font-size:12px; color:var(--text-muted);">
          Optimizer block unavailable for this portfolio (likely an empty book or no investible holdings).
        </div>
      </div>`;
    return;
  }

  _optimizerState.optimizer = optimizer;
  if (optimizer.sessionId) _optimizerState.sessionId = optimizer.sessionId;
  if (optimizer.preset) _optimizerState.preset = optimizer.preset;
  if (Number.isFinite(optimizer.taxSlabPct)) _optimizerState.taxSlabPct = optimizer.taxSlabPct;

  const currentPct = optimizer.currentXirrPct;
  const projectedPct = optimizer.projectedXirrPct;
  const conservativePct = optimizer.projectedXirrConservativePct;
  const upliftBps = optimizer.projectedUpliftBps;
  const upliftBpsConservative = optimizer.projectedUpliftBpsConservative;
  const moves = Array.isArray(optimizer.moves) ? optimizer.moves : [];

  const heroLine = (() => {
    if (moves.length === 0) {
      return `Your book is at or near its mathematically-derived optimum — no positive-uplift switches at the current preset.`;
    }
    if (!Number.isFinite(currentPct) || !Number.isFinite(projectedPct)) {
      return `${moves.length} candidate switch${moves.length === 1 ? "" : "es"} below — review with your registered adviser before acting.`;
    }
    const sign = (upliftBps || 0) >= 0 ? "+" : "";
    return `Switching the <strong>${moves.length}</strong> position${moves.length === 1 ? "" : "s"} below could lift your annualised return from <strong>${currentPct.toFixed(2)}%</strong> to <strong>${projectedPct.toFixed(2)}%</strong> — about <strong>${sign}${(upliftBps || 0).toFixed(0)} basis points</strong> more per year.`;
  })();
  const heroBlock = `<div style="margin-top:6px; padding:10px 14px; background:rgba(96,165,250,0.05); border-left:3px solid #60a5fa; border-radius:0 6px 6px 0; font-size:13px; line-height:1.6;">${heroLine}</div>`;

  const presetChips = Object.keys(OPTIMIZER_PRESET_LABELS).map((key) => {
    const active = key === _optimizerState.preset;
    const bg = active ? "var(--accent)" : "transparent";
    const color = active ? "#fff" : "var(--text)";
    const border = active ? "var(--accent)" : "#2a3349";
    return `<button type="button"
      onclick="applyOptimizerPreset('${key}')"
      title="${OPTIMIZER_PRESET_TOOLTIPS[key]}"
      style="background:${bg}; color:${color}; border:1px solid ${border}; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; transition:all 0.15s;">
      ${OPTIMIZER_PRESET_LABELS[key]}
    </button>`;
  }).join("");

  const slabChips = [5, 20, 30].map((s) => {
    const active = s === _optimizerState.taxSlabPct;
    const bg = active ? "var(--accent)" : "transparent";
    const color = active ? "#fff" : "var(--text)";
    const border = active ? "var(--accent)" : "#2a3349";
    return `<button type="button"
      onclick="applyOptimizerTaxSlab(${s})"
      style="background:${bg}; color:${color}; border:1px solid ${border}; padding:5px 10px; border-radius:6px; font-size:11px; font-weight:600; cursor:pointer;">
      ${s}%
    </button>`;
  }).join("");

  const moveCards = moves.length === 0
    ? `<div style="background:rgba(34,197,94,0.08); border:1px solid rgba(34,197,94,0.2); border-radius:8px; padding:14px 18px; font-size:12px; color:#86efac;">
        No positive-uplift moves at the current preset / noise floor — your book is at or near its mathematically-derived optimum given the constraints.
      </div>`
    : moves.map((m, idx) => {
        const upliftColor = (m.estUpliftBps || 0) >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)";
        const switchTo = Array.isArray(m.redeployTo) && m.redeployTo.length > 0
          ? `<div style="font-size:11px; color:var(--text-muted); margin-top:6px;">
               Redeploy to: ${m.redeployTo.map((c) => `<strong style="color:var(--text);">${c.name}</strong>${c.allocPct != null ? ` (${c.allocPct}%)` : ""}`).join(" · ")}
             </div>`
          : "";
        const blocked = m.blocking
          ? `<div style="font-size:11px; color:#fca5a5; margin-top:6px; padding:4px 8px; background:rgba(239,68,68,0.08); border-radius:4px; display:inline-block;">
               Blocked: ${m.blocking.reason || m.blocking.type || "constraint"}
             </div>`
          : "";
        return `
          <div style="background:#0f172a; border:1px solid #1a2233; border-radius:8px; padding:14px 16px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:8px;">
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                <span style="font-size:12px; font-weight:700; color:var(--text-muted);">#${idx + 1}</span>
                ${moveTypeBadge(m.type)}
                <span style="font-weight:700; font-size:13px;">${m.instrument?.name || m.instrument?.symbol || "—"}</span>
              </div>
              <div style="text-align:right;">
                <div style="font-weight:700; color:${upliftColor}; font-size:14px;">
                  ${(m.estUpliftBps || 0) >= 0 ? "+" : ""}${(m.estUpliftBps || 0).toFixed(0)} bps
                </div>
              </div>
            </div>
            <div style="font-size:12px; color:var(--text-muted); line-height:1.5;">
              ${m.rationale || "—"}
            </div>
            ${switchTo}
            <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:var(--text-muted); margin-top:8px; padding-top:8px; border-top:1px solid #1a2233;">
              <span>Cash from selling: <strong style="color:var(--text);">${inr(m.grossProceedsRupees)}</strong></span>
              <span>Tax owed: <strong style="color:#fca5a5;">${inr(m.taxCostRupees)}</strong></span>
              <span>Cash to reinvest: <strong style="color:#86efac;">${inr(m.netRedeployableRupees)}</strong></span>
            </div>
            ${blocked}
            ${m.compliance ? `<div style="font-size:10px; color:var(--text-muted); margin-top:6px; font-style:italic;">${m.compliance}</div>` : ""}
          </div>`;
      }).join("");

  const constraints = Array.isArray(optimizer.constraintsBinding) ? optimizer.constraintsBinding : [];
  const assumptions = Array.isArray(optimizer.assumptions) ? optimizer.assumptions : [];
  const hasAdvanced = constraints.length > 0 || assumptions.length > 0 || Number.isFinite(conservativePct);

  const constraintPills = constraints.length === 0 ? "" : `
    <div style="margin-bottom:10px;">
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted); margin-bottom:6px;">Constraints binding</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${constraints.map((c) => `
          <span style="display:inline-block; font-size:11px; padding:4px 10px; background:rgba(250,204,21,0.10); border:1px solid rgba(250,204,21,0.3); border-radius:4px; color:#fde047;">
            ${c.type === "ELSS_LOCK_IN"
              ? `ELSS lock-in: ${c.instrument || ""}${c.until ? " until " + c.until : ""}`
              : c.type === "FY_LTCG_BUDGET"
              ? `FY LTCG budget remaining: ${inr(c.remaining)}${c.fyEndsOn ? " (FY ends " + c.fyEndsOn + ")" : ""}`
              : c.type === "SECTOR_CAP"
              ? `Sector cap: ${c.sector || ""} at ${(c.pct || 0).toFixed(1)}%`
              : c.type === "SINGLE_STOCK_CAP"
              ? `Single-stock cap: ${c.instrument || ""} at ${(c.pct || 0).toFixed(1)}%`
              : c.type}
          </span>
        `).join("")}
      </div>
    </div>`;

  const assumptionsBlock = assumptions.length === 0 ? "" : `
    <div style="font-size:11px; color:var(--text-muted); line-height:1.6; margin-bottom:8px;">
      <div style="text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px;">Assumptions</div>
      ${assumptions.map((a) => `<div style="margin-bottom:2px;">• ${a}</div>`).join("")}
    </div>`;

  const conservativeText = Number.isFinite(conservativePct)
    ? `<div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">Conservative band: projected ${conservativePct.toFixed(2)}% (${upliftBpsConservative >= 0 ? "+" : ""}${(upliftBpsConservative || 0).toFixed(0)} bps).</div>`
    : "";

  const advancedDetails = hasAdvanced ? `
    <details style="margin-top:14px;">
      <summary style="font-size:11px; color:var(--text-muted); cursor:pointer; list-style:none;">Why these moves &amp; assumptions ▾</summary>
      <div style="margin-top:10px;">
        ${conservativeText}
        ${constraintPills}
        ${assumptionsBlock}
      </div>
    </details>` : "";

  const header = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px; margin-bottom:14px;">
      <div style="flex:1; min-width:240px;">
        <div style="font-size:14px; font-weight:700; display:flex; align-items:center; gap:10px;">
          Where could your returns improve?
          ${notAdviceChip("inline")}
        </div>
        ${heroBlock}
      </div>
      <div id="analyzerOptimizerStatus" style="font-size:11px; color:var(--text-muted);"></div>
    </div>`;

  const heroCard = `
    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-bottom:18px;">
      <div style="background:#0f172a; border:1px solid #1a2233; border-radius:8px; padding:14px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted);">Current XIRR</div>
        <div style="font-size:24px; font-weight:700; margin-top:4px;">${Number.isFinite(currentPct) ? currentPct.toFixed(2) + "%" : "—"}</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Confidence: ${optimizer.currentXirrConfidence || "—"} ${infoIcon("data_confidence")}</div>
      </div>
      <div style="background:#0f172a; border:1px solid rgba(34,197,94,0.3); border-radius:8px; padding:14px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#86efac;">Projected XIRR</div>
        <div style="font-size:24px; font-weight:700; margin-top:4px; color:#bbf7d0;">${Number.isFinite(projectedPct) ? projectedPct.toFixed(2) + "%" : "—"}</div>
      </div>
      <div style="background:#0f172a; border:1px solid #1a2233; border-radius:8px; padding:14px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted);">Uplift</div>
        <div style="font-size:24px; font-weight:700; margin-top:4px; color:${(upliftBps || 0) >= 0 ? "var(--green, #22c55e)" : "var(--red, #ef4444)"};">
          ${(upliftBps || 0) >= 0 ? "+" : ""}${(upliftBps || 0).toFixed(0)} bps
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${moves.length} candidate move${moves.length === 1 ? "" : "s"}</div>
      </div>
    </div>`;

  const controls = `
    <div style="display:grid; grid-template-columns:1fr auto; gap:14px; align-items:start; margin-bottom:18px; padding:14px; background:#0f172a; border:1px solid #1a2233; border-radius:8px;">
      <div>
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-bottom:6px;">Preset</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">${presetChips}</div>
      </div>
      <div>
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-bottom:6px;">Tax slab</div>
        <div style="display:flex; gap:6px;">${slabChips}</div>
      </div>
    </div>`;

  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      ${header}
      ${heroCard}
      ${controls}
      <div style="font-size:12px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted); margin-bottom:8px;">
        Ranked moves (${moves.length})
      </div>
      ${moveCards}
      ${advancedDetails}
    </div>`;
}

function renderAnalyzerHoldingsV2(report) {
  const el = document.getElementById("analyzerHoldings");
  const cards = report.holdings.map((h, idx) => renderHoldingCardV2(h, idx === 0)).join("");
  el.innerHTML = `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:10px; flex-wrap:wrap;">
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="font-size:14px; font-weight:700;">Per-holding deep dive (${report.holdings.length})</div>
          ${notAdviceChip()}
        </div>
        <div style="font-size:11px; color:var(--text-muted);">Click any row to expand</div>
      </div>
      ${cards}
    </div>
  `;
}

function renderHoldingCardV2(h, defaultOpen) {
  const openAttr = defaultOpen ? " open" : "";
  const pnlC = pctColor(h.pnlPercent);
  const pnlStr = `${h.pnlPercent >= 0 ? "+" : ""}${(h.pnlPercent || 0).toFixed(1)}%`;
  const flagsSection = h.redFlags && h.redFlags.length
    ? `<div style="margin:14px 0;">
        <div style="font-size:12px; font-weight:700; color:#fca5a5; margin-bottom:6px;">&#9888; Red flags</div>
        ${h.redFlags.map((f) => `<div style="font-size:12px; padding:6px 10px; margin-bottom:4px; background:rgba(${f.severity === 'high' ? '239,68,68' : '250,204,21'},0.08); border-left:2px solid ${f.severity === 'high' ? '#fca5a5' : '#fde047'}; border-radius:3px;">${f.message}</div>`).join("")}
      </div>` : "";

  const ep = h.exitPlan || {};
  const hasTechnicalLevels = ep.supportLevel || ep.stopLoss || ep.target || ep.upsideBand || ep.trailingStop;
  const exitDetails = hasTechnicalLevels
    ? `<details style="margin:14px 0;">
        <summary style="cursor:pointer; list-style:none; padding:10px 14px; background:#111827; border-radius:6px; font-size:13px; font-weight:700; color:#93c5fd; display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
          <span>Technical levels ▾</span>
          <span style="font-size:10px; color:var(--text-muted); font-style:italic; font-weight:400;">analytical reference — not trade instructions</span>
        </summary>
        <div style="padding:12px 14px; background:#111827; border-top:1px solid #1a2233; border-radius:0 0 6px 6px; margin-top:-2px;">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; font-size:12px;">
            ${(ep.supportLevel ?? ep.stopLoss) != null ? `<div><span style="color:var(--text-muted);">Support:</span> <strong>₹${ep.supportLevel ?? ep.stopLoss}</strong></div>` : ""}
            ${(ep.upsideBand ?? ep.target) != null ? `<div><span style="color:var(--text-muted);">Upside band:</span> <strong>₹${ep.upsideBand ?? ep.target}</strong></div>` : ""}
            ${ep.trailingStop ? `<div><span style="color:var(--text-muted);">Trailing support:</span> ${ep.trailingStop.activated ? `<strong style="color:#86efac;">active @ ₹${ep.trailingStop.currentLevel}</strong>` : `<span>engages above ₹${ep.trailingStop.activationLevel}</span>`}</div>` : ""}
            ${(h.longTermReference ?? h.longTermTarget) ? `<div><span style="color:var(--text-muted);">52W high reference:</span> <strong>₹${h.longTermReference ?? h.longTermTarget}</strong></div>` : ""}
          </div>
          ${ep.slConfirmationRule ? `<div style="font-size:11px; color:var(--text-muted); margin-top:6px;">${ep.slConfirmationRule}</div>` : ""}
          ${ep.rationale && ep.rationale.length ? `<div style="font-size:11px; color:var(--text-muted); margin-top:8px; line-height:1.5;">${ep.rationale.map((r) => "• " + r).join("<br>")}</div>` : ""}
        </div>
      </details>` : "";

  const outlookSection = h.outlook
    ? `<div style="margin:14px 0; padding:12px 14px; background:#111827; border-radius:6px;">
        <div style="font-size:12px; font-weight:700; margin-bottom:8px;">Outlook</div>
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; font-size:12px;">
          ${["shortTerm", "midTerm", "longTerm"].map((k) => {
            const o = h.outlook[k];
            const arrow = o.direction === "up" ? "↑" : o.direction === "down" ? "↓" : "→";
            const color = o.direction === "up" ? "#86efac" : o.direction === "down" ? "#fca5a5" : "#9ca3af";
            return `<div>
              <div style="color:var(--text-muted); font-size:10px; text-transform:uppercase;">${o.horizon}</div>
              <div style="color:${color}; font-weight:700; font-size:13px;">${arrow} ${o.direction.toUpperCase()}</div>
              <div style="font-size:10px; color:var(--text-muted);">${o.confidence} confidence</div>
            </div>`;
          }).join("")}
        </div>
      </div>` : "";

  const taxSection = h.taxNote
    ? `<div style="margin:14px 0; padding:10px 14px; background:rgba(250,204,21,0.05); border:1px solid rgba(250,204,21,0.2); border-radius:6px; font-size:12px;">
        <div style="font-weight:700; color:#fde047; margin-bottom:4px;">Tax note${h.purchaseDate ? ` <span style="font-weight:500; color:var(--text-muted);">· purchased ${h.purchaseDate}</span>` : ""}</div>
        <div>${h.taxNote.summary}</div>
        ${h.taxNote.holdingPeriod ? `<div style="color:var(--text-muted); font-size:11px; margin-top:4px;">${h.taxNote.holdingPeriod}</div>` : ""}
        <div style="color:var(--text-muted); font-size:11px; margin-top:4px;">${h.taxNote.detail}</div>
      </div>` : "";

  const hasRiskMetrics = h.risk && (h.risk.beta != null || h.risk.annualizedVolatility != null || h.risk.maxDrawdown1y != null);
  const riskDetails = hasRiskMetrics
    ? (() => {
        const liqColor = {
          good:  "#86efac",
          fair:  "#a7f3d0",
          watch: "#fde047",
          poor:  "#fca5a5",
        }[h.risk.liquidityBand] || "var(--text-muted)";
        const liqLabel = h.risk.daysToExit != null
          ? `<div><span style="color:var(--text-muted);">Days to exit:</span> <strong style="color:${liqColor};">${h.risk.daysToExit}</strong><span style="color:var(--text-muted);font-size:10px;"> (20% ADV rule)</span></div>`
          : "";
        const sampleChip = h.risk.sampleSize != null
          ? (() => {
              const n = h.risk.sampleSize;
              const band = n >= 252 ? "high" : n >= 126 ? "medium" : "low";
              const c = { high: "#86efac", medium: "#fde047", low: "#fca5a5" }[band];
              return `<span style="font-size:10px; color:${c}; background:${c}22; padding:2px 6px; border-radius:3px; font-weight:700; letter-spacing:0.3px; text-transform:uppercase;" title="${n} daily observations used.">conf: ${band}</span>`;
            })()
          : "";
        return `<details style="margin:14px 0;">
          <summary style="cursor:pointer; list-style:none; padding:10px 14px; background:#111827; border-radius:6px; font-size:13px; font-weight:700; display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
            <span>Risk numbers ▾</span>
            ${sampleChip}
          </summary>
          <div style="padding:12px 14px; background:#111827; border-top:1px solid #1a2233; border-radius:0 0 6px 6px; margin-top:-2px;">
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; font-size:12px;">
              ${h.risk.beta != null ? `<div><span style="color:var(--text-muted);">Beta ${infoIcon("beta_metric")}:</span> <strong>${h.risk.beta.toFixed(2)}</strong></div>` : ""}
              ${h.risk.annualizedVolatility != null ? `<div><span style="color:var(--text-muted);">Vol (ann.) ${infoIcon("volatility")}:</span> <strong>${h.risk.annualizedVolatility.toFixed(1)}%</strong></div>` : ""}
              ${h.risk.maxDrawdown1y != null ? `<div><span style="color:var(--text-muted);">Max DD (1y) ${infoIcon("max_drawdown")}:</span> <strong style="color:#fca5a5;">${h.risk.maxDrawdown1y.toFixed(1)}%</strong></div>` : ""}
              ${h.risk.var95Daily != null ? `<div><span style="color:var(--text-muted);">95% daily VaR ${infoIcon("var95")}:</span> <strong style="color:#fca5a5;">${h.risk.var95Daily.toFixed(2)}%</strong></div>` : ""}
              ${liqLabel}
              <div style="grid-column:1/-1; padding-top:8px; margin-top:6px; border-top:1px solid #1a2233; display:flex; gap:14px; flex-wrap:wrap; font-size:12px;">
                <div><span style="color:var(--text-muted);">Tech:</span> ${h.technicalScore ?? "—"}</div>
                <div><span style="color:var(--text-muted);">Combined ${infoIcon("combined_score")}:</span> ${h.combinedScore != null ? h.combinedScore + "/100" : "—"}</div>
              </div>
            </div>
          </div>
        </details>`;
      })()
    : "";

  return `<details${openAttr} style="border:1px solid #1a2233; border-radius:8px; margin-bottom:8px; background:#0b1220;">
    <summary style="cursor:pointer; padding:12px 16px; list-style:none; display:grid; grid-template-columns: 140px 1fr 130px 120px 110px 60px; gap:12px; align-items:center; font-size:13px;">
      <div style="font-weight:700;">${h.symbol.replace(".NS", "")}</div>
      <div style="color:var(--text-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${h.name}</div>
      <div>${actionBadge(h.action, h.displayAction)}</div>
      <div style="color:${pnlC}; font-weight:600;">${pnlStr}</div>
      <div style="font-size:11px; color:var(--text-muted);">${(h.positionWeight || 0).toFixed(1)}% wt</div>
      <div style="font-size:11px; text-align:right;">${h.combinedScore != null ? h.combinedScore + "/100" : "—"}</div>
    </summary>
    <div style="padding:4px 16px 16px; border-top:1px solid #1a2233;">
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; padding:10px 0; font-size:12px;">
        <div><span style="color:var(--text-muted);">Qty:</span> ${h.quantity}</div>
        <div><span style="color:var(--text-muted);">Avg:</span> ₹${h.avgPrice}</div>
        <div><span style="color:var(--text-muted);">Current:</span> ${h.currentPrice != null ? "₹" + h.currentPrice : "—"}</div>
        <div><span style="color:var(--text-muted);">Invested:</span> ${inr(h.invested)}</div>
        <div><span style="color:var(--text-muted);">Value:</span> ${inr(h.currentValue)}</div>
        <div><span style="color:var(--text-muted);">P&amp;L:</span> <span style="color:${pnlC};">${h.pnlAmount >= 0 ? "+" : ""}${inr(h.pnlAmount)}</span></div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:10px; padding:4px 0 10px; font-size:12px; border-top:1px solid #1a2233;">
        <div><span style="color:var(--text-muted);">Fund:</span> ${h.fundamentalScore ?? "—"}</div>
        <div><span style="color:var(--text-muted);">Verdict:</span> ${h.fundamentalVerdict ? h.fundamentalVerdict.replace("_", " ") : "—"}</div>
        <div><span style="color:var(--text-muted);">Signal:</span> ${h.recommendation || "—"}</div>
        <div><span style="color:var(--text-muted);">Sector:</span> ${h.sector}</div>
      </div>
      <div style="margin:12px 0; padding:12px 14px; background:#111827; border-radius:6px; font-size:13px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
          <div style="font-weight:700;">Why ${h.displayAction || h.action}</div>
          ${notAdviceChip("inline")}
        </div>
        <div style="line-height:1.6; color:var(--text);">${h.actionReasoning || ""}</div>
        ${renderLongTermNarrative(h.longTerm)}
      </div>
      ${flagsSection}
      ${outlookSection}
      ${riskDetails}
      ${exitDetails}
      ${taxSection}
      ${h.earningsNearby ? `<div style="font-size:12px; padding:8px 12px; background:rgba(59,130,246,0.08); border-radius:4px; margin-top:8px;">&#128197; <strong>Upcoming earnings:</strong> ${h.earningsNearby.date}</div>` : ""}
    </div>
  </details>`;
}

// ==================== SWS PICKS ====================

// Section order. top_ranked_30 leads (multi-factor score, broadest universe);
// best_to_buy_now follows (legacy curated cut). Per-category sections after.
// Sections with zero items hide automatically — see renderPicks.
//
// term_id wires each section header to a glossary tooltip explaining the
// inclusion criteria in plain English (replaces the cryptic threshold-spec
// subtitles that used to live here). emoji + chip_label feed the chip-nav.
const PICKS_SECTIONS = [
  { key: "top_ranked_30_v3", term_id: "section_top_ranked_30", emoji: "⭐", label: "⭐ Top 30 — Multi-Factor Score", chip_label: "Top 30", subtitle: "Universe-wide top 30 by v3 composite — start every session here." },
  { key: "best_to_buy_now", term_id: "section_best_to_buy_now", emoji: "🎯", label: "🎯 Best Stocks to Buy Now", chip_label: "Buy Now", subtitle: "Tighter cut: high score + Snowflake ≥ 18 + clean of major risks. Use for fresh capital today." },
  { key: "deep_value", term_id: "section_deep_value", emoji: "💎", label: "💎 Deep Value", chip_label: "Deep Value", subtitle: "Quality + cheap. TOP_PICK names trading at ≥ 20% discount to consensus FV." },
  { key: "quality_growth", term_id: "section_quality_growth", emoji: "🌱", label: "🌱 Quality Growth", chip_label: "Quality Growth", subtitle: "Compounders: fortress balance sheet + visible forward growth runway." },
  { key: "best_fundamentals", term_id: "section_best_fundamentals", emoji: "🧱", label: "🧱 Best Fundamentals", chip_label: "Fundamentals", subtitle: "Ranked by the score-breakdown modal's 'Fundamentals 74' line — 5 SWS pillars (Health + Future + Valuation + Past + Dividends) + AnalystConsensus FV upside, rescaled to 0–100 for the card badge. Ignores momentum and safety overlay. Same hygiene gate as Top 30 (mcap ≥ ₹500cr, no GSM)." },
  { key: "midterm", term_id: "section_midterm", emoji: "⚡", label: "⚡ Midterm Picks (3-12 months)", chip_label: "Midterm", subtitle: "Trend-following — momentum already on side, with FV upside ≥ 15% remaining." },
  { key: "dividend_aristocrats", term_id: "section_dividend_aristocrats", emoji: "💰", label: "💰 Dividend Aristocrats", chip_label: "Dividend", subtitle: "Sustainable payers: Dividend pillar ≥ 5, payout < 70%, yield ≥ 1.5%." },
  { key: "smallcap_gems", term_id: "section_smallcap_gems", emoji: "🔍", label: "🔍 Smallcap Hidden Gems", chip_label: "Smallcap Gems", subtitle: "True smallcap quality: mcap < ₹15,000cr (NSE rank 251+) + Snowflake ≥ 22 + upside ≥ 15%." },
  { key: "insider_buying", term_id: "section_insider_buying", emoji: "👁", label: "👁 Insider Buying", chip_label: "Insider", subtitle: "Material insider / MD buys in last 90 days. Data field not yet captured." },
  { key: "upcoming_earnings", term_id: "section_upcoming_earnings", emoji: "📅", label: "📅 Upcoming Earnings (next 75 days)", chip_label: "Earnings", subtitle: "Catalyst calendar — sorted by results date. Avoid initiating right before; useful pre-results setups for holdings." },
  { key: "avoid", term_id: "section_avoid", emoji: "⚠", label: "⚠ Avoid List", chip_label: "Avoid", subtitle: "v3 AVOID — cross-check against your portfolio every refresh." },
];

// Per-section soft cap on cards displayed inline. The Top-30 section gets
// its full 30; everything else stays at 12 (with a "more" hint). Upcoming
// earnings is the worst offender today (156 entries) — capping at 30 keeps
// the page actionable.
const PICKS_INLINE_CAP = {
  top_ranked_30_v3: 30,
  upcoming_earnings: 30,
  // Best Fundamentals ships 100 server-side; show 30 inline, expand for full 100.
  best_fundamentals: 30,
  // Off-section search bumps the cap to 24 — global search is the only path
  // to find these stocks, so 12 feels too tight; 24 still keeps render fast.
  off_section_search: 24,
};
const PICKS_INLINE_DEFAULT_CAP = 12;

// Synthetic section prepended above curated sections when the user's search
// matches scored stocks that didn't land in any of the 11 curated picks
// buckets. Reuses the same section-header / chip / card pipeline so chip-nav,
// force-expand, and overflow logic apply automatically.
const PICKS_OFF_SECTION_DEF = {
  key: "off_section_search",
  term_id: null,
  emoji: "🌐",
  label: "🌐 All SWS stocks (off-section matches)",
  chip_label: "Off-section",
  subtitle: "Scored stocks that match your search but didn't make any curated section. Capped at 24 inline — refine your query or click through to SWS for the full pic.",
};

let picksStatusPollTimer = null;

// Cached payload from /api/sws-picks so the radio filter can re-render
// without re-fetching. Set on every successful loadPicks().
let currentPicksData = null;

// Per-section "Show all" override (in-memory only — resets on reload, matching
// picksSearchQuery's ephemeral convention). Holds section.key strings whose
// soft cap is currently bypassed.
const picksExpandedSections = new Set();

// Universe filter for the picks tab. "all" (default) shows everything;
// "nifty500" hides any item whose ticker isn't in the Nifty 500 list
// (server tags each item with `nifty500: boolean` at request time).
const PICKS_INDEX_FILTER_LS_KEY = "swsPicksIndexFilter_v1";
let picksIndexFilter = (() => {
  try { return localStorage.getItem(PICKS_INDEX_FILTER_LS_KEY) || "all"; }
  catch { return "all"; }
})();

function setPicksLoadingBanner(visible) {
  const banner = document.getElementById("picksLoadingBanner");
  if (banner) banner.hidden = !visible;
}

// Hydrate the radio's checked state from localStorage. Called once when
// the SWS Picks tab is shown; safe to re-call (idempotent).
function hydratePicksIndexFilterRadio() {
  const radios = document.querySelectorAll('input[name="picksIndex"]');
  radios.forEach((r) => { r.checked = (r.value === picksIndexFilter); });
}

// Radio change handler — wired via inline onchange in index.html.
function onPicksIndexFilterChange(value) {
  picksIndexFilter = value === "nifty500" ? "nifty500" : "all";
  try { localStorage.setItem(PICKS_INDEX_FILTER_LS_KEY, picksIndexFilter); } catch {}
  if (currentPicksData) renderPicks(currentPicksData);
}

// Picks-tab search. Ephemeral by design — search is exploratory; resetting on
// reload is the right default (unlike the universe radio, which is a saved
// preference). 200 ms debounce so a fast typist doesn't trigger a re-render
// per keystroke.
let picksSearchQuery = "";
let picksSearchTimer = null;

// Scored-universe (~5,439 stocks) lazy-loaded on first non-empty search query
// so the picks tab itself stays snappy for users who never search. Cached for
// the session; re-fetched on next page load. `loadFailed` short-circuits
// retries when /api/sws-universe is missing (e.g. before backfill runs).
let swsScoredUniverse = null;
let swsUniverseLoadPromise = null;
let swsUniverseLoadFailed = false;

async function ensureUniverseLoaded() {
  if (swsScoredUniverse || swsUniverseLoadFailed) return swsScoredUniverse;
  if (!swsUniverseLoadPromise) {
    swsUniverseLoadPromise = (async () => {
      try {
        const res = await fetch("/api/sws-universe");
        if (!res.ok) { swsUniverseLoadFailed = true; return null; }
        const data = await res.json();
        swsScoredUniverse = Array.isArray(data?.stocks) ? data.stocks : null;
        if (!swsScoredUniverse) swsUniverseLoadFailed = true;
        return swsScoredUniverse;
      } catch {
        swsUniverseLoadFailed = true;
        return null;
      }
    })();
  }
  return swsUniverseLoadPromise;
}

function onPicksSearchInput(value) {
  if (picksSearchTimer) clearTimeout(picksSearchTimer);
  picksSearchTimer = setTimeout(async () => {
    picksSearchQuery = (value || "").trim().toLowerCase();
    togglePicksSearchClearBtn();
    if (currentPicksData) renderPicks(currentPicksData);
    // First non-empty query kicks off the universe fetch (lazy). Re-render
    // when it lands so off-section matches appear without another keystroke.
    // Re-render on failure too — moves the status from "Loading…" to
    // "Universe unavailable…" rather than leaving a stuck spinner.
    if (picksSearchQuery && !swsScoredUniverse && !swsUniverseLoadFailed) {
      await ensureUniverseLoaded();
      if (currentPicksData && picksSearchQuery) renderPicks(currentPicksData);
    }
  }, 200);
}

function onPicksSearchClear() {
  if (picksSearchTimer) { clearTimeout(picksSearchTimer); picksSearchTimer = null; }
  const inp = document.getElementById("picksSearchInput");
  if (inp) inp.value = "";
  picksSearchQuery = "";
  togglePicksSearchClearBtn();
  if (currentPicksData) renderPicks(currentPicksData);
}

function togglePicksSearchClearBtn() {
  const btn = document.getElementById("picksSearchClear");
  if (btn) btn.hidden = !picksSearchQuery;
}

// Substring match across ticker, name, sector, and (when present on universe
// entries) the SWS slug — so a query like "adani-enterprises" still resolves.
// Lower-cased once at input time so the per-card check is just string.includes.
function pickMatchesSearch(it, q) {
  if (!q) return true;
  if (!it) return false;
  const slug = it.sws_url ? (it.sws_url.match(/\/([a-z0-9-]+)-shares?$/)?.[1] || "") : "";
  const hay = `${it.ticker || ""} ${it.name || ""} ${it.sector || ""} ${slug}`.toLowerCase();
  return hay.includes(q);
}

// Builds the freshness banner shown under the SWS Picks header. Surfaces
// (a) the last full-pipeline-finish stamp from last-refresh.json,
// (b) live "refresh in progress" indicator if any shard last_run_at is recent,
// (c) a stale warning when the data is older than 3 days (the user's target
// cadence is every 2-3 days).
function renderPicksMetaBanner(data) {
  const lr = data.last_refresh || {};
  const finishedAt = lr.finished_at || null;
  const shards = data.shard_progress_api || [];
  const latestShardRun = shards.reduce((max, s) => {
    if (!s.last_run_at) return max;
    return (!max || new Date(s.last_run_at) > new Date(max)) ? s.last_run_at : max;
  }, null);
  // Prefer the more recent of the two stamps so an in-flight scrape pushes
  // the displayed freshness forward in real time.
  const dataStamp = (finishedAt && (!latestShardRun || new Date(finishedAt) >= new Date(latestShardRun)))
    ? finishedAt
    : latestShardRun;
  const ageMs = dataStamp ? Date.now() - new Date(dataStamp).getTime() : null;
  const stale = ageMs != null && ageMs > 3 * 24 * 3600 * 1000;
  const fresh = ageMs != null && ageMs < 6 * 3600 * 1000;
  const inFlight = shards.some((s) => s.last_run_at && (Date.now() - new Date(s.last_run_at).getTime()) < 5 * 60 * 1000);
  const color = stale ? "var(--red)" : (fresh ? "var(--green)" : "var(--text-secondary)");

  const totals = `${data.scored_count} scored · ${data.failed_count} failed`;
  const refreshLine = dataStamp
    ? `Last data refresh: <strong style="color:${color};">${timeAgo(dataStamp)}</strong> · ${new Date(dataStamp).toLocaleString()}${stale ? ' · <span style="color:var(--red);">stale, run /sws-refresh-api</span>' : ""}`
    : "Refresh time unknown";
  const inFlightLine = inFlight
    ? `<br><span style="color:var(--accent, #4a90e2);">⟳ Refresh in progress — shard 1: ${shards[0]?.today_count || 0} · shard 2: ${shards[1]?.today_count || 0} · shard 3: ${shards[2]?.today_count || 0} stocks today</span>`
    : "";
  // Stamping-failure banner — last-refresh.json carries `stamping_status` from
  // scripts/sws-refresh-api.sh. When set to "failed", the section_status field
  // didn't land on picks-latest.json, so the New / ↑N / Newly Flagged badges
  // on every per-section card will be silently absent until the next run.
  // Surface that loudly here so the user notices within seconds of opening the
  // tab — without this line, the May-11 incident (silent SyntaxError swallowed
  // by `|| true`) went unnoticed for two days.
  const stampWarn = lr.stamping_status === "failed"
    ? `<br><span style="color:var(--red);">⚠ Stamping failed last run — "New" / "↑N" / "Newly Flagged" badges will not render until the next successful refresh.</span>`
    : "";

  return `${refreshLine} · ${totals}${inFlightLine}${stampWarn}`;
}

async function loadPicks() {
  const containerEl = document.getElementById("picksContainer");
  const metaEl = document.getElementById("picksMeta");
  hydratePicksIndexFilterRadio();
  setPicksLoadingBanner(true);
  containerEl.innerHTML = `<div class="loading"><div class="loading-spinner"></div><div class="loading-text">Loading picks…</div></div>`;

  try {
    const res = await fetch("/api/sws-picks");
    if (res.status === 404) {
      currentPicksData = null;
      containerEl.innerHTML = renderPicksEmptyState();
      metaEl.textContent = "No scan run yet";
      pollPicksStatus(); // still useful — show scan progress if a scan is currently running
      return;
    }
    const data = await res.json();
    currentPicksData = data;
    renderPicks(data);
    metaEl.innerHTML = renderPicksMetaBanner(data);
    pollPicksStatus();
  } catch (e) {
    containerEl.innerHTML = `<div style="padding:24px;color:var(--red);">Failed to load picks: ${e.message}</div>`;
  } finally {
    setPicksLoadingBanner(false);
  }
}

function renderPicksEmptyState() {
  return `
    <div style="padding:32px; border:1px dashed #2a3550; border-radius:8px; text-align:center;">
      <h3 style="margin-top:0;color:var(--text-primary);">No SWS scan data available</h3>
      <p style="color:var(--text-muted); margin:12px 0 20px 0; max-width:680px; margin-left:auto; margin-right:auto;">
        Run the SWS refresh pipeline from the CLI to populate this tab.
        The data file lives at <code>data/sws/picks-latest.json</code>.
      </p>
    </div>
  `;
}

// Persisted accordion state. Top-30 stays expanded by default (it's the
// hero); user choices for other sections survive across reloads in
// localStorage. Capped at 5 expanded sections to stop a misclick from
// resurrecting the wall-of-cards problem on next load.
const PICKS_COLLAPSED_LS_KEY = "swsPicksCollapsed_v1";
const PICKS_EXPANDED_CAP = 5;

function loadPicksCollapsedState() {
  try {
    const raw = localStorage.getItem(PICKS_COLLAPSED_LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePicksCollapsedState(state) {
  try { localStorage.setItem(PICKS_COLLAPSED_LS_KEY, JSON.stringify(state)); } catch {}
}

// Default: only the hero (Top-30) is expanded; everything else collapses.
// Returns true (collapsed) unless localStorage says otherwise OR this is the
// hero section.
function isPicksSectionCollapsed(state, sectionKey) {
  if (Object.prototype.hasOwnProperty.call(state, sectionKey)) return state[sectionKey];
  return sectionKey !== "top_ranked_30_v3";
}

// Sync chip-nav .active classes from current section collapsed-state. Called
// after every toggle so the chip indicator stays truthful (chips are
// rendered once at load; without this they go stale).
function syncPicksChipActiveStates() {
  document.querySelectorAll(".sws-pick-chip[data-section-key]").forEach((chip) => {
    const key = chip.getAttribute("data-section-key");
    const sec = document.querySelector(`.sws-pick-section[data-section-key="${key}"]`);
    if (!sec) return;
    chip.classList.toggle("active", !sec.classList.contains("collapsed"));
  });
}

// Flip the "show all rows" override for one section. Stops propagation so the
// click doesn't also fire the section-header collapse handler. Triggers a
// full re-render via renderPicks(currentPicksData) — render is fast and the
// alternative (DOM mutation) would duplicate the rendering logic.
function togglePicksExpandAll(sectionKey, ev) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  if (picksExpandedSections.has(sectionKey)) picksExpandedSections.delete(sectionKey);
  else picksExpandedSections.add(sectionKey);
  if (currentPicksData) renderPicks(currentPicksData);
}

// Click handler for a section header in the SWS Picks tab. Toggles the
// .collapsed class and persists.
function togglePicksSection(headerEl, ev) {
  if (ev) {
    // Don't fire when the click landed on the info icon — that opens the tooltip.
    if (ev.target.closest("[data-term-id]")) return;
  }
  const section = headerEl.closest(".dashboard-section");
  if (!section) return;
  section.classList.toggle("collapsed");
  const key = section.getAttribute("data-section-key");
  if (!key) return;
  const state = loadPicksCollapsedState();
  state[key] = section.classList.contains("collapsed");
  savePicksCollapsedState(state);
  syncPicksChipActiveStates();
}

// Chip click: scroll to + expand the section. If already expanded, just scroll.
function jumpToPicksSection(sectionKey) {
  const section = document.querySelector(`.sws-pick-section[data-section-key="${sectionKey}"]`);
  if (!section) return;
  if (section.classList.contains("collapsed")) {
    section.classList.remove("collapsed");
    const state = loadPicksCollapsedState();
    state[sectionKey] = false;
    savePicksCollapsedState(state);
  }
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  syncPicksChipActiveStates();
}

// Expand-all / collapse-all controls in the chip-nav. Expand-all is capped
// to PICKS_EXPANDED_CAP so we don't load 150+ cards and tank scroll perf.
function setAllPicksCollapsed(collapsed) {
  const sections = document.querySelectorAll(".sws-pick-section");
  const state = loadPicksCollapsedState();
  let expandedCount = 0;
  sections.forEach((sec) => {
    const key = sec.getAttribute("data-section-key");
    if (!key) return;
    if (collapsed) {
      sec.classList.add("collapsed");
      state[key] = true;
    } else if (expandedCount < PICKS_EXPANDED_CAP) {
      sec.classList.remove("collapsed");
      state[key] = false;
      expandedCount++;
    }
  });
  savePicksCollapsedState(state);
  syncPicksChipActiveStates();
}

// Write the running totals next to each radio label so the user can see
// how many stocks each filter would yield (e.g. "All 412" / "Nifty 500 only 287").
function updatePicksFilterCounts(totalAll, totalN500) {
  const a = document.querySelector('[data-count-for="all"]');
  const n = document.querySelector('[data-count-for="nifty500"]');
  if (a) a.textContent = totalAll;
  if (n) n.textContent = totalN500;
}

function renderPicksChipNav(visibleSections, collapsedState) {
  // While a search query is active, force-expand every visible section so the
  // user sees matches immediately rather than having to click each accordion.
  // Persistent collapse state is preserved — when the search clears, the
  // user's saved expand/collapse choices return.
  const forceExpand = !!picksSearchQuery;
  const chips = visibleSections.map(({ section, items }) => {
    const isCollapsed = !forceExpand && isPicksSectionCollapsed(collapsedState, section.key);
    return `<button type="button" class="sws-pick-chip${isCollapsed ? "" : " active"}" data-section-key="${section.key}" onclick="jumpToPicksSection('${section.key}')" title="${escapeHtml(section.subtitle)}">
      <span class="sws-pick-chip-emoji">${section.emoji}</span><span class="sws-pick-chip-label">${escapeHtml(section.chip_label)}</span><span class="sws-pick-chip-count">${items.length}</span>
    </button>`;
  }).join("");
  return `
    <div class="sws-pick-chipnav" role="navigation" aria-label="Jump to section">
      <div class="sws-pick-chipnav-scroll">${chips}</div>
      <div class="sws-pick-chipnav-actions">
        <button type="button" class="sws-pick-chip-action" onclick="setAllPicksCollapsed(false)" title="Expand up to ${PICKS_EXPANDED_CAP} sections">Expand all</button>
        <button type="button" class="sws-pick-chip-action" onclick="setAllPicksCollapsed(true)" title="Collapse every section">Collapse all</button>
      </div>
    </div>`;
}

function renderPicks(data) {
  const containerEl = document.getElementById("picksContainer");
  const collapsedState = loadPicksCollapsedState();

  // Filter once so chip-nav and the section list stay in sync. The Nifty 500
  // toggle drops items the server tagged with nifty500=false; section/chip
  // counts and overflow text all derive from `visibleSections` so they
  // update automatically.
  const visibleSections = [];
  let totalShown = 0;
  let totalAll = 0;
  let totalN500 = 0;
  for (const section of PICKS_SECTIONS) {
    const rawItems = (data.sections && data.sections[section.key]) || [];
    totalAll += rawItems.length;
    totalN500 += rawItems.filter((it) => it && it.nifty500).length;
    // Universe filter (Nifty 500) AND ephemeral search — both narrow the same
    // items array so chip counts, overflow, and section visibility update
    // together. Order: universe first (fewer items to scan for search).
    const items = rawItems
      .filter((it) => picksIndexFilter !== "nifty500" || (it && it.nifty500))
      .filter((it) => pickMatchesSearch(it, picksSearchQuery));
    if (items.length === 0) continue;
    visibleSections.push({ section, items });
    totalShown += items.length;
  }

  updatePicksFilterCounts(totalAll, totalN500);

  // Off-section matches: when search is active and the scored-universe index
  // has loaded, surface any matching stock that ISN'T already shown above.
  // Prepended so users see global hits before the curated buckets.
  let offSectionCount = 0;
  if (picksSearchQuery && Array.isArray(swsScoredUniverse) && swsScoredUniverse.length) {
    const shown = new Set();
    for (const v of visibleSections) {
      for (const it of v.items) if (it && it.ticker) shown.add(it.ticker);
    }
    const offSection = swsScoredUniverse.filter((it) => {
      if (!it || !it.ticker) return false;
      if (shown.has(it.ticker)) return false;
      if (picksIndexFilter === "nifty500" && !it.nifty500) return false;
      return pickMatchesSearch(it, picksSearchQuery);
    });
    if (offSection.length > 0) {
      offSectionCount = offSection.length;
      visibleSections.unshift({ section: PICKS_OFF_SECTION_DEF, items: offSection });
      totalShown += offSection.length;
    }
  }

  if (!totalShown) {
    let msg;
    if (picksSearchQuery) {
      msg = `No picks match "<strong>${escapeHtml(picksSearchQuery)}</strong>". Try a different ticker, name, or sector — or clear the search.`;
    } else if (picksIndexFilter === "nifty500") {
      msg = `No Nifty 500 stocks in the current scan. Switch back to <strong>All</strong> above to see the full universe.`;
    } else {
      msg = `Scan completed but no stocks matched any section filters. Check thresholds in scripts/sws-scoring.mjs.`;
    }
    containerEl.innerHTML = renderPicksSearchStatus(0, 0) + `<div style="padding:24px;color:var(--text-muted);">${msg}</div>`;
    return;
  }

  const statusHtml = renderPicksSearchStatus(totalShown, offSectionCount);
  const chipNav = renderPicksChipNav(visibleSections, collapsedState);

  // Same force-expand logic as the chip-nav: an active search query overrides
  // persistent collapse state so matches are immediately visible.
  const forceExpand = !!picksSearchQuery;
  const sectionsHtml = visibleSections.map(({ section, items }) => {
    const defaultCap = PICKS_INLINE_CAP[section.key] ?? PICKS_INLINE_DEFAULT_CAP;
    const expanded = picksExpandedSections.has(section.key);
    const cap = expanded ? items.length : defaultCap;
    const sliced = items.slice(0, cap);
    // hidden = how many would be hidden under the default cap. Drives whether
    // the toggle is meaningful at all — and stays > 0 even after expansion so
    // the user can collapse back.
    const hidden = items.length - defaultCap;
    const isHero = section.key === "top_ranked_30_v3";
    const isCollapsed = !forceExpand && isPicksSectionCollapsed(collapsedState, section.key);
    const tip = section.term_id ? infoIcon(section.term_id) : "";
    return `
      <div class="dashboard-section sws-pick-section${isCollapsed ? " collapsed" : ""}${isHero ? " sws-pick-section-hero" : ""}" data-section-key="${section.key}">
        <div class="section-header" onclick="togglePicksSection(this, event)" role="button" tabindex="0"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();togglePicksSection(this);}">
          <div class="section-header-left">
            <div>
              <div class="sws-pick-section-title">
                <span class="section-name">${section.label}</span>
                <span class="sws-pick-section-count">${items.length}</span>
                ${tip}
                <span class="section-chevron">&#9660;</span>
              </div>
              <p class="sws-pick-section-subtitle">${escapeHtml(section.subtitle)}</p>
            </div>
          </div>
        </div>
        <div class="section-body">
          <div class="stock-cards sws-pick-grid">
            ${sliced.map((s, i) => renderPickCard(s, section.key, isHero ? i + 1 : null)).join("")}
          </div>
          ${hidden > 0 ? `<div class="sws-pick-overflow">${expanded ? `Showing all <strong>${items.length}</strong> · ` : `… and <strong>${hidden}</strong> more · `}<button type="button" class="sws-pick-overflow-btn" onclick="togglePicksExpandAll('${section.key}', event)">${expanded ? `Show top ${defaultCap} ↑` : `Show all (${items.length}) ↓`}</button>${expanded ? "" : ` · or open the PDF for the full list`}</div>` : ""}
        </div>
      </div>`;
  }).join("");

  containerEl.innerHTML = statusHtml + chipNav + sectionsHtml;
}

// Status line for the picks-tab search. Surfaces lazy-load progress and the
// count of universe-wide matches so the user can tell global search is on.
// Returns "" when no search is active so the picks tab looks identical to
// before this feature when idle.
function renderPicksSearchStatus(totalShown, offSectionCount) {
  if (!picksSearchQuery) return "";
  const q = escapeHtml(picksSearchQuery);
  let body;
  if (swsUniverseLoadFailed) {
    body = `<span style="color:var(--text-muted);">Universe index unavailable — searching loaded sections only. Run <code>node scripts/sws-build-scored-universe.mjs</code> to backfill.</span>`;
  } else if (!swsScoredUniverse) {
    body = `<span style="color:var(--text-muted);">Loading SWS universe… in-section matches shown for "<strong>${q}</strong>".</span>`;
  } else {
    const universeSize = swsScoredUniverse.length;
    body = `<span><strong>${totalShown}</strong> match${totalShown === 1 ? "" : "es"} for "<strong>${q}</strong>" across <strong>${universeSize.toLocaleString()}</strong> SWS stocks${offSectionCount ? ` · <strong>${offSectionCount}</strong> off-section` : ""}.</span>`;
  }
  return `<div class="sws-pick-search-status" style="padding:8px 12px; margin:4px 0 12px 0; background:rgba(255,255,255,0.03); border-radius:6px; font-size:13px;">${body}</div>`;
}

// Color band for the score number on the card. Mirrors v3 verdict tiers
// (TOP_PICK ≥60 → gold, STRONG ≥45 → green, ACCEPTABLE ≥30 → cyan,
// WATCH ≥22 → muted, AVOID < 22 → red) so a glance at the headline number
// matches the verdict label below it.
function pickScoreColor(score) {
  if (score == null) return "var(--text-muted)";
  if (score >= 60) return "var(--gold, #f5c542)";
  if (score >= 45) return "var(--green, #22c55e)";
  if (score >= 30) return "var(--cyan, #4a90e2)";
  if (score >= 22) return "var(--text-muted)";
  return "var(--red, #ef4444)";
}

// Freshness pill — green-ish if within 48h, muted if older, "stale" badge >7d.
function pickFreshnessPill(parsedAtIso) {
  if (!parsedAtIso) return "";
  const ageMs = Date.now() - new Date(parsedAtIso).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "";
  const hours = ageMs / 3600000;
  let label, cls = "";
  if (hours < 48) label = `${Math.round(hours)}h ago`;
  else {
    const days = Math.round(hours / 24);
    label = `${days}d ago`;
    if (days > 7) cls = " stale";
  }
  return `<span class="sws-freshness-pill${cls}" title="Deep-scrape parsed ${new Date(parsedAtIso).toLocaleString()}">${label}</span>`;
}

// Section-membership badges — driven by `section_status` stamped on each
// per-section stock by scripts/sws-stamp-section-status.mjs. "Newly Added"
// appears the first nightly a stock enters a section; "Trending" appears when
// rank gain crosses a section-size-aware threshold (and never on AVOID, where
// climbing the list is not a buy signal). On AVOID, the "newly added" badge
// is relabeled to "Newly Flagged" so the framing matches a sell-side list.
function humanPickSection(sectionKey) {
  const sec = PICKS_SECTIONS.find((s) => s.key === sectionKey);
  return sec ? (sec.chip_label || sec.label || sectionKey) : sectionKey;
}

function formatPickPriorScanTooltip(iso) {
  if (!iso) return "previous scan";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function renderPickStatusBadges(stock, sectionKey) {
  const ss = stock && stock.section_status;
  if (!ss) return "";
  const isAvoid = sectionKey === "avoid";
  const sectionLabel = humanPickSection(sectionKey);
  const priorTip = formatPickPriorScanTooltip(ss.prior_scanned_at);
  const parts = [];
  if (ss.newly_added) {
    if (isAvoid) {
      const tip = `Newly flagged for avoidance in this scan. Was not in the Avoid List in the previous scan (${priorTip}).`;
      parts.push(`<span class="sws-pick-badge sws-pick-badge--flagged" title="${escapeHtml(tip)}">Newly Flagged</span>`);
    } else {
      const tip = `Newly added to ${sectionLabel} in this scan. Was not in this list in the previous scan (${priorTip}).`;
      parts.push(`<span class="sws-pick-badge sws-pick-badge--new" title="${escapeHtml(tip)}">New</span>`);
    }
  }
  if (ss.trending && Number.isFinite(ss.rank_delta) && ss.rank_delta > 0) {
    const tip = `Climbed ${ss.rank_delta} rank${ss.rank_delta === 1 ? "" : "s"} in ${sectionLabel} since the previous scan (${priorTip}).`;
    parts.push(`<span class="sws-pick-badge sws-pick-badge--trending" title="${escapeHtml(tip)}">↑${ss.rank_delta}</span>`);
  }
  return parts.join("");
}

function renderPickCard(s, sectionKey, rank = null) {
  const fmtInr = (v) => v == null ? "—" : v >= 1e12 ? `₹${(v / 1e12).toFixed(2)} L Cr` : v >= 1e7 ? `₹${(v / 1e7).toFixed(v >= 1e10 ? 0 : 2)} Cr` : `₹${v.toLocaleString("en-IN")}`;
  const upside = s.upside_pct != null ? `${s.upside_pct > 0 ? "+" : ""}${s.upside_pct.toFixed(1)}%` : "—";
  const upsideColor = s.upside_pct == null ? "var(--text-muted)" : s.upside_pct >= 0 ? "var(--green)" : "var(--red)";
  const sn = s.snowflake_total ?? "—";
  // Headline score: v3 (fundamentals 74 + momentum 14 + safety overlay −15) > v2 > v1.
  // v3 is the primary score across the universe — the runFullScoring pipeline
  // emits it for every stock alongside v1/v2 for backward-compat.
  const headlineRaw = s.v3_score_100 != null ? s.v3_score_100 : (s.v2_score != null ? s.v2_score : s.score);
  const score = headlineRaw != null ? headlineRaw.toFixed(1) : "—";
  const scoreColor = pickScoreColor(headlineRaw);
  const scoreTermId = s.v3_score_100 != null ? "v3_composite_score" : "combined_score";
  // Composite verdict (multi-factor quality band): TOP_PICK/STRONG/ACCEPTABLE/WATCH/AVOID
  // when v3 is the headline; legacy v1 labels otherwise.
  const verdict = (s.v3_score_100 != null ? (s.composite_verdict || s.v3_verdict) : s.verdict) || "—";
  const verdictColor = {
    TOP_PICK: "var(--gold)", STRONG: "var(--green)", ACCEPTABLE: "var(--cyan)", WATCH: "var(--text-muted)", AVOID: "var(--red)",
    DEEP_VALUE: "var(--gold)", QUALITY_GROWTH: "var(--green)", FAIR_VALUE: "var(--cyan)", FULLY_VALUED: "var(--text-muted)", OVERVALUED: "var(--red)",
  }[verdict] || "var(--text-muted)";
  const verdictTermId = verdictIdFromLabel(verdict);
  // PR 2.3 — valuation_band is a SEPARATE signal (price vs AnalystConsensus FV).
  // Show it as a small chip next to the upside %, so a user can see at a glance
  // that e.g. v3=70 TOP_PICK + valuation PREMIUM ≠ "buy without thinking".
  const valBand = s.valuation_band || null;
  const valBandLabel = valBand ? valBand.replace(/_/g, " ") : "";
  const valBandColor = {
    DEEP_DISCOUNT: "var(--gold)", DISCOUNT: "var(--green)", FAIR: "var(--cyan)",
    PREMIUM: "var(--text-muted)", EXPENSIVE: "var(--red)",
  }[valBand] || "var(--text-muted)";
  const valBandChip = valBand
    ? `<span class="sws-pick-valband-chip" style="color:${valBandColor};border-color:${valBandColor};" title="Price vs AnalystConsensus fair value">${valBandLabel}</span>`
    : "";
  const surv = s.v2_breakdown?.surveillance;
  // Surveillance badge — when a flag is present, hook it to the glossary.
  // Native title is preserved as a fallback for keyboard-only users; the
  // delegated tooltip handler kicks in on hover/click via data-term-id.
  const survBadge = surv
    ? `<span class="sws-surveillance-badge" data-term-id="nse_surveillance" tabindex="0" role="button" aria-label="NSE surveillance flag" title="NSE ${surv.list} surveillance flag (${surv.timeframe || "—"})">${surv.list}</span>`
    : "";
  // Thin-coverage badge — surfaces when the scorer had < 60% of input fields.
  // Without it, missing inputs silently scored as zero pull the composite
  // toward the 40-50 band, which can mis-rank a thinly-covered name.
  const cov = typeof s.data_completeness_pct === "number" ? s.data_completeness_pct : null;
  const coverageBadge = (cov != null && cov < 60)
    ? `<span class="sws-thin-coverage-badge" title="Only ${cov}% of the 13 SWS input fields were populated when this stock was scored — verify manually before acting.">Thin · ${cov}%</span>`
    : "";
  // Fundamentals badge — only on the Best Fundamentals section. Matches the
  // score-breakdown modal's "Fundamentals 74" line exactly (5 SWS pillars +
  // AnalystConsensus FV upside) and rescales to 0–100 so users can read the
  // ranking number on the card itself. Identity: badge value = (modal value
  // ÷ 74) × 100, so the two displays always agree.
  let fundBadge = "";
  if (sectionKey === "best_fundamentals" && s.v3_breakdown) {
    const b = s.v3_breakdown;
    const fundSum = (b.pts_health || 0) + (b.pts_future || 0) + (b.pts_valuation || 0)
                  + (b.pts_past || 0) + (b.pts_dividends || 0) + (b.pts_fv_upside || 0);
    const fundScore100 = (fundSum / 74) * 100;
    fundBadge = `<span class="sws-fund-badge" title="Fundamentals score, rescaled to 100. Same definition as the score-breakdown modal's 'Fundamentals 74' line: 5 SWS pillars (Health + Future + Valuation + Past + Dividends) + AnalystConsensus FV upside.">F ${fundScore100.toFixed(1)}/100</span>`;
  }
  const statusBadges = renderPickStatusBadges(s, sectionKey);
  const rankBadge = rank ? `<span class="sws-pick-rank">${rank}</span>` : "";
  const fresh = pickFreshnessPill(s.data_freshness_at);

  let extraRow = "";
  if (sectionKey === "upcoming_earnings" && s.next_earnings_date) {
    const d = s.days_until == null ? "?" : `${s.days_until}d`;
    const lqr = s.last_quarter_result;
    // Beat/miss/inline class names match the JSON values verbatim — see
    // scripts/sws-fetch-earnings-beat.mjs. Card stays unchanged when null
    // (no Yahoo coverage, recent IPO, or last reported quarter > 180 days).
    const lqrBadge = lqr
      ? `<span class="sws-q-result-badge ${lqr}" data-term-id="last_quarter_result" tabindex="0" role="button" aria-label="Last quarter result: ${lqr}" title="Last quarter EPS vs estimate: ${lqr.toUpperCase()}">Last Q: ${lqr.toUpperCase()}</span>`
      : "";
    extraRow = `<div class="sws-pick-earnings-row">📅 ${s.next_earnings_date} (${d})${lqrBadge ? " " + lqrBadge : ""}</div>`;
  }

  // Card click is routed through handlePickCardClick, which ignores clicks
  // landing on info icons / glossary terms / embedded links so the tooltip
  // and external link behaviors aren't preempted by the modal trigger.
  const safeTicker = String(s.ticker || "").replace(/[^A-Z0-9&\-]/gi, "");
  // PR P9 — inline ★ on the card itself. Watchlist storage keys symbols
  // with the .NS suffix; SWS picks use bare tickers, so we append it for
  // the storage key and pass the SWS sector/name through to the API.
  const watchlistSymbol = `${safeTicker}.NS`;
  const inlineStar = `<span class="sws-pick-inline-star" onclick="event.stopPropagation();">${watchlistButton(watchlistSymbol, s.name || safeTicker, s.sector || "")}</span>`;
  return `
    <div class="stock-card sws-pick-card" tabindex="0" role="button" aria-label="Open detail for ${safeTicker}"
         data-ticker="${safeTicker}"
         onclick="handlePickCardClick(event, '${safeTicker}')"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSwsModal('${safeTicker}');}">
      <div class="sws-pick-card-top">
        <div class="sws-pick-card-id">
          ${rankBadge}
          <div class="sws-pick-card-id-text">
            <div class="sws-pick-card-ticker">${s.ticker}${survBadge}${coverageBadge}${fundBadge}${statusBadges}${s.sector ? `<span class="sws-pick-card-sector">${escapeHtml(s.sector)}</span>` : ""}</div>
            <div class="sws-pick-card-name">${s.name || ""}${fresh}</div>
          </div>
        </div>
        <div class="sws-pick-card-score">
          ${inlineStar}
          <div class="sws-pick-card-score-num" style="color:${scoreColor};">${score}${infoIcon(scoreTermId)}</div>
          <div class="sws-pick-card-score-verdict" style="color:${verdictColor};">${verdict.replace(/_/g, " ")}${verdictTermId ? infoIcon(verdictTermId) : ""}</div>
        </div>
      </div>
      <div class="sws-pick-card-stats">
        <div class="sws-pick-stat"><span class="sws-pick-stat-label">Px</span> ${fmtInr(s.current_price_inr)}</div>
        <div class="sws-pick-stat"><span class="sws-pick-stat-label">FV${infoIcon("analyst_fair_value")}</span> ${fmtInr(s.fair_value_inr)}</div>
        <div class="sws-pick-stat" style="color:${upsideColor};">${upside}${infoIcon("upside_pct")}${valBandChip ? " " + valBandChip : ""}</div>
        <div class="sws-pick-stat sws-pick-stat-snow"><span class="sws-pick-stat-label">Snow${infoIcon("snowflake_score")}</span> ${sn}/30</div>
      </div>
      <div class="sws-pick-card-narrative">${(s.narrative && s.narrative.card_one_line) || s.one_line || ""}</div>
      ${extraRow}
      ${s.sws_url ? `<div class="sws-pick-card-link"><a href="${s.sws_url}" target="_blank" rel="noopener" onclick="event.stopPropagation();">Open on SWS →</a></div>` : ""}
    </div>`;
}


function showPicksBanner(kind, msg) {
  const b = document.getElementById("picksStatusBanner");
  if (!b) return;
  const colors = {
    queued: { bg: "rgba(0,150,200,0.1)", border: "var(--cyan)", text: "var(--cyan)" },
    scanning: { bg: "rgba(0,180,100,0.1)", border: "var(--green)", text: "var(--green)" },
    panic: { bg: "rgba(220,80,80,0.1)", border: "var(--red)", text: "var(--red)" },
    error: { bg: "rgba(220,80,80,0.1)", border: "var(--red)", text: "var(--red)" },
  };
  const c = colors[kind] || colors.queued;
  b.style.display = "block";
  b.style.background = c.bg;
  b.style.border = `1px solid ${c.border}`;
  b.style.color = c.text;
  b.innerHTML = msg;
}

async function pollPicksStatus() {
  if (picksStatusPollTimer) clearInterval(picksStatusPollTimer);
  const tick = async () => {
    try {
      const res = await fetch("/api/sws-scan/status");
      const s = await res.json();
      if (s.panic_stop && s.panic_stop.active) {
        showPicksBanner("panic", `🚨 Scrape halted: <strong>${s.panic_stop.reason}</strong> (shard ${s.panic_stop.shard_id}) at ${new Date(s.panic_stop.detected_at).toLocaleTimeString()}. Review SWS account, then delete <code>data/sws/panic-stop.flag</code> to resume.`);
        return;
      }
      if (s.in_progress) {
        const lines = s.shards.filter((sh) => sh.last_run_at).map((sh) =>
          `Shard ${sh.id}: ${sh.done_count} done${sh.last_ticker ? ` (${sh.last_ticker})` : ""}${sh.complete ? " ✓" : ""}`,
        ).join(" · ");
        showPicksBanner("scanning", `🟢 Scanning · ${lines || "starting…"} · Total ${s.total_done}`);
      } else if (s.all_complete) {
        document.getElementById("picksStatusBanner").style.display = "none";
      }
    } catch (e) { /* silent */ }
  };
  tick();
  picksStatusPollTimer = setInterval(tick, 30 * 1000);
}

// ==================== SWS MODAL ====================
//
// Single modal element in the DOM. openSwsModal(ticker) populates it from
// /api/sws-stock/:ticker (deep-scrape data + leaderboard card with v2 score)
// and lazy-fetches /api/stock/:symbol for live technicals + news as a second
// overlay panel inside the modal so it doesn't block first paint.

let swsModalCurrentTicker = null;
let swsModalLastFocus = null;
// Per-ticker scroll positions so re-opening a modal (after closing, or after
// switching sections on the SWS Picks chip-nav) restores where the user left
// off instead of snapping back to the top. Bounded to ~50 tickers — beyond
// that we drop the oldest entry, since this is purely a UX nicety.
const swsModalScrollMemory = new Map();
const SWS_MODAL_SCROLL_MEMORY_MAX = 50;

async function openSwsModal(ticker) {
  if (!ticker) return;
  swsModalCurrentTicker = ticker;
  swsModalLastFocus = document.activeElement;
  const backdrop = document.getElementById("swsModalBackdrop");
  const body = document.getElementById("swsModalBody");
  if (!backdrop || !body) return;
  body.innerHTML = `<div style="padding:60px 20px;text-align:center;color:var(--text-muted);"><div class="loading-spinner" style="margin:0 auto 12px;"></div>Loading ${ticker}…</div>`;
  backdrop.classList.add("open");
  document.body.style.overflow = "hidden";

  try {
    const res = await fetch(`/api/sws-stock/${encodeURIComponent(ticker)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      body.innerHTML = `<div style="padding:40px 20px;color:var(--red);">Failed to load ${ticker}: ${err.error || res.status}</div>`;
      return;
    }
    const data = await res.json();
    if (swsModalCurrentTicker !== ticker) return; // user opened a different ticker since
    body.innerHTML = renderSwsModal(data);
    // PR T6 — inject the per-stock "we said X N days ago" strip at the top
    // of the modal body. Fire-and-forget: silent absent strip when there
    // are no paper-trade snapshots for the symbol.
    hydrateStockTrackStrip(ticker, body);
    const remembered = swsModalScrollMemory.get(ticker);
    if (typeof remembered === "number" && remembered > 0) {
      // The scrollable element is the backdrop (overflow:auto), NOT the body
      // (overflow:visible). Wait one frame so layout settles before we
      // restore — otherwise scrollHeight is still the old value and the
      // assignment is clipped.
      requestAnimationFrame(() => { backdrop.scrollTop = remembered; });
    }
  } catch (e) {
    body.innerHTML = `<div style="padding:40px 20px;color:var(--red);">Network error: ${e.message}</div>`;
  }
}

// PR T6 — per-stock "we said X N days ago" track strip.
//
// Pulls the 3 most-recent paper-trade snapshots for the given ticker from
// /api/track/history?symbol=X (PR T6.0 added the symbol param). Renders
// inline at the top of the modal body when ≥ 1 snapshot exists; absent
// otherwise. Each row uses signedColorFor for magnitude colouring + srLabel
// for screen readers (closest analog to TipRanks' analyst-call accuracy
// inline display — the strongest trust artifact on the platform).
const _stockTrackStripCache = new Map(); // ticker → { ts, data }
async function hydrateStockTrackStrip(ticker, body) {
  if (!ticker || !body) return;
  try {
    const cached = _stockTrackStripCache.get(ticker);
    let payload;
    if (cached && (Date.now() - cached.ts) < 5 * 60 * 1000) {
      payload = cached.data;
    } else {
      const url = `/api/track/history?symbol=${encodeURIComponent(ticker)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      payload = await res.json();
      _stockTrackStripCache.set(ticker, { ts: Date.now(), data: payload });
    }
    if (swsModalCurrentTicker !== ticker) return; // user opened a different ticker
    const trades = Array.isArray(payload.trades) ? payload.trades : [];
    if (trades.length === 0) return; // silent absence
    const strip = renderStockTrackStrip(ticker, trades);
    if (!strip) return;
    // Insert at the very top of the modal body, above renderSwsModal output.
    body.insertAdjacentHTML("afterbegin", strip);
  } catch { /* silent — strip is a bonus, not load-bearing */ }
}

function renderStockTrackStrip(ticker, trades) {
  if (!Array.isArray(trades) || trades.length === 0) return "";
  // 3 most-recent snapshots by snapshotAt.
  const sorted = [...trades].sort((a, b) => new Date(b.snapshotAt) - new Date(a.snapshotAt));
  const top = sorted.slice(0, 3);
  const rows = top.map((t) => {
    const snapDate = t.snapshotAt ? new Date(t.snapshotAt) : null;
    const daysAgo = snapDate ? Math.floor((Date.now() - snapDate.getTime()) / 86400000) : null;
    const r = t.returns || {};
    const ret = (r.returnPct != null && Number.isFinite(r.returnPct)) ? r.returnPct : null;
    const niftyRet = (r.niftyReturnPct != null && Number.isFinite(r.niftyReturnPct)) ? r.niftyReturnPct : null;
    const sectionLabel = (TRACK_TYPE_LABELS && TRACK_TYPE_LABELS[t.type]) || (t.type ? String(t.type).replace(/_/g, " ") : "—");
    const sc = signedColorFor(ret);
    const niftyDelta = (ret != null && niftyRet != null) ? (ret - niftyRet) : null;
    const niftyBit = niftyRet != null
      ? `&nbsp;·&nbsp;<span style="color:var(--text-muted);">vs Nifty</span> <span style="color:${signedColorFor(niftyRet).color};">${niftyRet >= 0 ? "+" : ""}${niftyRet.toFixed(1)}%</span>`
      : "";
    const alphaBit = niftyDelta != null
      ? `&nbsp;·&nbsp;<span style="color:var(--text-muted);">α</span> <span style="color:${signedColorFor(niftyDelta).color};">${niftyDelta >= 0 ? "+" : ""}${niftyDelta.toFixed(1)} pp</span>`
      : "";
    const retCell = (ret != null)
      ? `<span class="tx-num" style="color:${sc.color}; font-weight:700;" aria-label="${sc.srLabel} since pick"><span aria-hidden="true">${sc.glyph}</span> ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%</span>`
      : `<span style="color:var(--text-muted);">—</span>`;
    const ago = (daysAgo != null) ? `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago` : "earlier";
    return `
      <div class="stock-track-row" style="display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; padding:6px 0; border-bottom:1px dashed var(--border-soft); font-size:13px;">
        <span style="color:var(--text-muted); min-width:96px;">${ago}</span>
        <span style="color:var(--text-secondary);">SWS · ${escapeHtml(sectionLabel)}</span>
        <span style="margin-left:auto;">→ ${retCell}${niftyBit}${alphaBit}</span>
      </div>`;
  }).join("");
  return `
    <div class="stock-track-strip" data-symbol="${escapeHtml(ticker)}"
         style="margin: 0 0 18px; padding: 14px 16px; background: rgba(224,176,96,0.04); border:1px solid rgba(224,176,96,0.18); border-radius: var(--radius-200);">
      <div class="tx-micro" style="display:flex; align-items:center; gap:8px; margin-bottom: 8px;">
        <span style="color: var(--gold);">Track record for ${escapeHtml(ticker)}</span>
        <span style="color: var(--text-muted); font-weight:500; text-transform:none; letter-spacing:0;">${trades.length} recorded pick${trades.length === 1 ? "" : "s"}</span>
      </div>
      ${rows}
      <div class="tx-meta" style="margin-top:8px;">
        Past performance does not guarantee future results — see <a href="#" onclick="event.preventDefault(); closeSwsModal(); switchTab('track'); return false;" style="color:var(--gold); text-decoration:underline;">full Track Record</a> for methodology.
      </div>
    </div>`;
}

function closeSwsModal() {
  const backdrop = document.getElementById("swsModalBackdrop");
  // Remember scroll position before tearing down so the next open() can
  // restore it. Keyed by ticker so different stocks each track their own.
  // Note: the scroll container is the backdrop (overflow:auto), not the
  // inner body (which is overflow:visible).
  if (backdrop && swsModalCurrentTicker) {
    swsModalScrollMemory.set(swsModalCurrentTicker, backdrop.scrollTop || 0);
    if (swsModalScrollMemory.size > SWS_MODAL_SCROLL_MEMORY_MAX) {
      // Map preserves insertion order — drop the oldest entry.
      const firstKey = swsModalScrollMemory.keys().next().value;
      swsModalScrollMemory.delete(firstKey);
    }
  }
  if (backdrop) backdrop.classList.remove("open");
  document.body.style.overflow = "";
  swsModalCurrentTicker = null;
  if (swsModalLastFocus && typeof swsModalLastFocus.focus === "function") {
    try { swsModalLastFocus.focus(); } catch {}
  }
  swsModalLastFocus = null;
}

// Esc-to-close — bound once at module load.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const actionBackdrop = document.getElementById("actionListModalBackdrop");
    if (actionBackdrop && actionBackdrop.classList.contains("open")) {
      closeActionListModal();
      return;
    }
    const backdrop = document.getElementById("swsModalBackdrop");
    if (backdrop && backdrop.classList.contains("open")) closeSwsModal();
  }
});

// ==================== ACTION LIST MODAL ====================
//
// Click handler for the Action Mix pills in the Portfolio Analyzer.
// Reads holdingsByAction off the cached report and renders a list of
// every stock that landed in that action bucket. Each row reuses the
// existing swsHoldingRow renderer so the table format mirrors Tier A.

const ACTION_HELP_TEXT = {
  HOLD: "These stocks scored well enough to keep without action. No buying or selling needed.",
  EXIT: "Full exit recommended — score and outlook no longer support a position.",
  "EXIT-now": "Sell the entire position now — flagged for immediate exit.",
  "EXIT-staged": "Sell half today; the second half is contingent on a confirmation break.",
  Reduction: "Trim the position to free up capital for stronger ideas.",
  "Top-up": "Add to the position — the engine sees a favourable risk/reward.",
};

function actionHelpText(action) {
  if (!action) return "";
  if (ACTION_HELP_TEXT[action]) return ACTION_HELP_TEXT[action];
  if (action.startsWith("Reduction-")) return ACTION_HELP_TEXT.Reduction;
  if (action.startsWith("Top-up")) return ACTION_HELP_TEXT["Top-up"];
  if (action.startsWith("EXIT")) return ACTION_HELP_TEXT.EXIT;
  return "";
}

function openActionListModal(action) {
  if (!action) return;
  const backdrop = document.getElementById("actionListModalBackdrop");
  const body = document.getElementById("actionListModalBody");
  if (!backdrop || !body) return;

  const report = _analyzerCache?.report || null;
  const rows = report?.holdingsByAction?.[action] || [];
  const isReduction = action === "EXIT" || action.startsWith("EXIT-") || action.startsWith("Reduction-");
  const freedCol = isReduction
    ? `<th style="padding:10px 12px; text-align:right;">Freed ₹</th>`
    : "";
  const explainer = actionHelpText(action);

  const tableHtml = rows.length === 0
    ? `<div style="padding:30px 16px; text-align:center; font-size:13px; color:var(--text-muted);">No stocks under this action.</div>`
    : `<div style="overflow-x:auto; border:1px solid #2a3349; border-radius:8px; background:var(--panel);">
         <table style="width:100%; border-collapse:collapse; font-size:13px;">
           <thead>
             <tr style="background:rgba(0,0,0,0.2); text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-muted);">
               <th style="padding:10px 12px;">Stock</th>
               <th style="padding:10px 12px;">Action</th>
               <th style="padding:10px 12px;">v3 score</th>
               <th style="padding:10px 12px;">Snowflake</th>
               <th style="padding:10px 12px;">Position</th>
               <th style="padding:10px 12px; text-align:right;">P&amp;L</th>
               ${freedCol}
               <th style="padding:10px 12px;">Timing</th>
             </tr>
           </thead>
           <tbody data-action-list-rows>
             ${rows.map(swsHoldingRow).join("")}
           </tbody>
         </table>
       </div>`;

  // swsHoldingRow renders a Freed ₹ <td> on every row. For non-reduction
  // actions we drop that column header above; the cell is hidden via a
  // post-render CSS adjustment so the table doesn't shear.
  const hideFreedCellCss = isReduction
    ? ""
    : `<style>#actionListModalBody [data-action-list-rows] tr td:nth-child(7){display:none;}</style>`;

  body.innerHTML = `
    ${hideFreedCellCss}
    <div style="padding:6px 4px 16px;">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px;">
        <div style="font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">Stocks marked</div>
        ${swsActionBadge(action)}
        <div style="font-size:13px; color:var(--text-muted);">×${rows.length}</div>
      </div>
      ${explainer ? `<div style="font-size:12px; color:var(--text-muted); line-height:1.5;">${swsEscapeAttr(explainer)}</div>` : ""}
    </div>
    ${tableHtml}
  `;

  // Wire row clicks to chain into the per-stock deep-dive modal. The
  // existing swsHoldingRow already has onclick="openStockDetailModal(...)";
  // we close THIS modal first so the two backdrops don't stack.
  const tbody = body.querySelector("[data-action-list-rows]");
  if (tbody) {
    tbody.addEventListener("click", () => {
      // Close on the next tick so the row's own onclick (openStockDetailModal)
      // has already fired and switched focus to the detail modal.
      setTimeout(closeActionListModal, 0);
    }, { capture: true });
  }

  backdrop.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeActionListModal() {
  const backdrop = document.getElementById("actionListModalBackdrop");
  if (backdrop) backdrop.classList.remove("open");
  // Only release the body scroll lock if the per-stock detail modal isn't
  // also open (it owns the lock in that case).
  const swsBackdrop = document.getElementById("swsModalBackdrop");
  if (!swsBackdrop || !swsBackdrop.classList.contains("open")) {
    document.body.style.overflow = "";
  }
}

function renderSwsModal(data) {
  const { ticker, deep, card, surveillance, file_mtime, section_memberships, fundamentals_fallback } = data;
  const ov = (deep && deep.overview) || {};
  const card_ = card || {};
  const fb = fundamentals_fallback || {};
  const fmtInr = (v) => v == null ? "—" : v >= 1e12 ? `₹${(v / 1e12).toFixed(2)} L Cr` : v >= 1e7 ? `₹${(v / 1e7).toFixed(v >= 1e10 ? 0 : 2)} Cr` : `₹${v.toLocaleString("en-IN")}`;
  const fmtPct = (v, d = 2) => v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(d)}%`;
  const headlineRaw = card_.v3_score_100 != null ? card_.v3_score_100 : (card_.v2_score != null ? card_.v2_score : card_.score);
  const score = headlineRaw != null ? headlineRaw.toFixed(1) : "—";
  const scoreColor = pickScoreColor(headlineRaw);
  const scoreLabel = card_.v3_score_100 != null ? "v3" : (card_.v2_score != null ? "v2" : "score");
  // Composite verdict (multi-factor quality band) — TOP_PICK / STRONG / …
  const verdict = (card_.v3_score_100 != null ? (card_.composite_verdict || card_.v3_verdict) : card_.verdict) || "—";
  const verdictColor = {
    TOP_PICK: "var(--gold)", STRONG: "var(--green)", ACCEPTABLE: "var(--cyan)", WATCH: "var(--text-muted)", AVOID: "var(--red)",
    DEEP_VALUE: "var(--gold)", QUALITY_GROWTH: "var(--green)", FAIR_VALUE: "var(--cyan)", FULLY_VALUED: "var(--text-muted)", OVERVALUED: "var(--red)",
  }[verdict] || "var(--text-muted)";
  // PR 2.3 — valuation_band is a SEPARATE signal (price vs AnalystConsensus FV).
  // Surfaces alongside (NEVER instead of) the composite verdict so users can
  // see, e.g., a TOP_PICK that's currently EXPENSIVE.
  const valBand = card_.valuation_band || null;
  const valBandLabel = valBand ? valBand.replace(/_/g, " ") : "";
  const valBandColor = {
    DEEP_DISCOUNT: "var(--gold)", DISCOUNT: "var(--green)", FAIR: "var(--cyan)",
    PREMIUM: "var(--text-muted)", EXPENSIVE: "var(--red)",
  }[valBand] || "var(--text-muted)";
  const valBandPill = valBand
    ? `<div class="sws-modal-valband-pill" style="color:${valBandColor};border-color:${valBandColor};" title="Price vs AnalystConsensus fair value">${valBandLabel}</div>`
    : "";
  const survBadge = surveillance ? `<span class="sws-surveillance-badge" title="NSE ${surveillance.list} surveillance flag (${surveillance.timeframe || "—"})">${surveillance.list}</span>` : "";
  const fresh = pickFreshnessPill(deep && deep.parsed_at);
  const sn = ov.snowflake || {};
  const ret = ov.returns_pct || {};
  const mult = ov.multiples || {};

  // Score breakdown bars — show v3 when available (3-bar fundamentals/
  // momentum/safety split), v2 otherwise.
  const v2bd = card_.v2_breakdown || {};
  const v3bd = card_.v3_breakdown || null;
  const hasV3 = v3bd != null && card_.v3_score_100 != null;
  const barsHtml = (() => {
    if (headlineRaw == null) return "";
    let items;
    if (hasV3) {
      const fundTotal = (v3bd.pts_health || 0) + (v3bd.pts_future || 0) + (v3bd.pts_valuation || 0) + (v3bd.pts_past || 0) + (v3bd.pts_dividends || 0) + (v3bd.pts_fv_upside || 0);
      const momTotal = (v3bd.pts_mom_1y || 0) + (v3bd.pts_mom_3m || 0) + (v3bd.pts_mom_1m || 0);
      items = [
        { label: "Fundamentals 74", value: Math.round(fundTotal * 10) / 10, max: 74, hint: "5 SWS pillars (Health 22 · Future 20 · Valuation 12 · Past 12 · Dividends 8) + AnalystConsensus FV upside (12)" },
        { label: "Momentum 14", value: Math.round(momTotal * 10) / 10, max: 14, hint: "Universe-percentile returns: 1Y (8) + 3M (4) + 1M (2)" },
        { label: "Safety overlay", value: v3bd.pts_overlay, max: 0, min: -15, negative: true, hint: (v3bd.overlay_reasons || []).join(" · ") || "No surveillance / momentum-tail penalties triggered" },
      ];
    } else {
      items = [
        { label: "Fundamentals (v1)", value: v2bd.v1_fundamentals, max: 100, hint: "Snowflake + analyst upside + growth + margin + dividend + insider" },
        { label: "Catalyst bonus", value: v2bd.pts_catalyst, max: 5, hint: "Earnings beat setup + insider buying + analyst upgrade" },
        { label: "Risk overlay", value: v2bd.pts_risk_overlay, max: 0, min: -15, negative: true, hint: "ASM/GSM, high beta, multiple risk flags" },
      ];
    }
    return items.map((it) => {
      const v = it.value == null ? 0 : it.value;
      const pct = it.negative ? (Math.abs(v) / 15) * 100 : (v / it.max) * 100;
      return `
        <div class="sws-modal-bar" title="${it.hint}">
          <div class="bar-label">${it.label}</div>
          <div class="bar-track"><div class="bar-fill ${it.negative ? "negative" : ""}" style="width:${Math.min(100, Math.abs(pct)).toFixed(0)}%"></div></div>
          <div class="bar-value">${v == null ? "—" : (v > 0 && !it.negative ? "+" : "") + Number(v).toFixed(1)}</div>
        </div>`;
    }).join("");
  })();

  // Snowflake hexagon strip (5 dims)
  const hexHtml = (sn && Object.keys(sn).length) ? `
    <div class="sws-modal-section">
      <h4>Snowflake — ${ov.snowflake_total ?? "?"}/30 ${ov.snowflake_summary ? `· ${ov.snowflake_summary}` : ""}</h4>
      <div class="sws-modal-grid">
        ${["valuation","future_growth","past_performance","financial_health","dividends"].map((k) => {
          const score = sn[k];
          const lbl = k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          const pct = score != null ? Math.round((score / 6) * 100) : 0;
          const col = score == null ? "var(--text-muted)" : score >= 5 ? "var(--green)" : score >= 3 ? "var(--cyan)" : "var(--red)";
          return `
            <div class="sws-stat-cell">
              <div class="stat-label">${lbl}</div>
              <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
                <div class="stat-value" style="color:${col};">${score ?? "—"}<span style="font-size:10px;color:var(--text-muted);">/6</span></div>
                <div style="flex:1;height:4px;background:#1a2233;border-radius:2px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:${col};"></div></div>
              </div>
            </div>`;
        }).join("")}
      </div>
    </div>` : "";

  // Sector benchmarks — SWS publishes peer averages alongside primaryIndustry
  // (peer P/E, peer 1Y net margin, peer 3Y forward revenue growth). Shown
  // here as a 3-cell strip so the user can see this stock's value vs the
  // sector. Auto-hidden when not present (sponsoredNarrative-only stocks).
  const ib = ov.industry_benchmarks;
  const sectorLabel = card_.sector || deep?.sector || null;
  const benchHtml = (ib && sectorLabel) ? (() => {
    const fmtFrac = (v) => v != null ? `${(v * 100).toFixed(1)}%` : "—";
    const fmtMult = (v) => v != null ? `${v.toFixed(1)}x` : "—";
    const clampMult = (v) => (v == null || !Number.isFinite(Number(v)) || v < -500 || v > 500) ? null : v;
    const ownNetMargin = ov.net_margin_pct != null ? ov.net_margin_pct / 100 : null;
    // Sanity-clamp P/E (SWS occasionally publishes a stale 4-digit value, e.g.
    // INFY = 1440x). Falls back to the fundamentals.json snapshot.
    const ownPe = clampMult(mult.pe) ?? clampMult(fb.pe);
    // Future revenue growth — we don't have a per-stock equivalent, but show
    // the sector benchmark on its own.
    const cells = [
      { label: "P/E", own: fmtMult(ownPe), peer: fmtMult(ib.pe) },
      { label: "Net margin (1Y)", own: fmtFrac(ownNetMargin), peer: fmtFrac(ib.net_income_margin_1y) },
      { label: "Future rev growth (3Y)", own: "—", peer: fmtFrac(ib.future_revenue_growth_3y) },
    ];
    return `
    <div class="sws-modal-section">
      <h4>Sector benchmarks — ${escapeHtml(sectorLabel)}</h4>
      <div class="sws-modal-grid">
        ${cells.map((c) => `
          <div class="sws-stat-cell">
            <div class="stat-label">${c.label}</div>
            <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px;">
              <div class="stat-value" style="font-size:14px;">${c.own}</div>
              <div style="font-size:10px;color:var(--text-muted);">vs ${c.peer} peer</div>
            </div>
          </div>`).join("")}
      </div>
    </div>`;
  })() : "";

  // Quick stats — SWS first, fundamentals.json as fallback. Sanity clamps
  // suppress obviously-bad values (e.g. INFY P/E = 1440 from a stale SWS row)
  // by treating them as null so they fall through to the fallback.
  //
  // Rows whose value is null (data not available from any source) are filtered
  // out before render — see the .filter(([,v]) => v != null) in the grid below.
  // ROE / ROCE / D/E / Debt cover / Interest cover / Beta / CEO tenure are
  // currently unavailable from the API capture (`sws-api-parser.mjs` doesn't
  // extract them and the underlying GraphQL ops don't surface them either);
  // those rows will appear once a future parser change populates them.
  const pastPerf = (deep && deep.past_performance) || {};
  const finHealth = (deep && deep.financial_health) || {};
  const ownership = (deep && deep.ownership) || {};
  const mgmt = (deep && deep.management) || {};
  const sane = (v, lo, hi) => (v == null || !Number.isFinite(Number(v)) || Number(v) < lo || Number(v) > hi) ? null : Number(v);
  const pickVal = (...vals) => { for (const v of vals) { if (v != null && Number.isFinite(Number(v))) return Number(v); } return null; };
  const peVal = pickVal(sane(mult.pe, -500, 500), sane(fb.pe, -500, 500));
  const pbVal = pickVal(sane(mult.pb, 0, 100), sane(fb.pb, 0, 100));
  const psVal = pickVal(sane(mult.ps, 0, 100), sane(fb.ps, 0, 100));
  // EPS: parser writes overview.latest_eps (rarely populated — SWS yearly
  // time series usually returns eps:null). Fall back to net_income / shares
  // when those are present, matching the same derivation extractMultiples()
  // uses internally for PE. Same 0.01 floor to suppress paisa-level EPS
  // that would otherwise look spurious.
  const derivedEps = (ov.latest_net_income && ov.shares_outstanding && ov.shares_outstanding > 0)
    ? ov.latest_net_income / ov.shares_outstanding
    : null;
  const epsVal = pickVal(sane(ov.latest_eps, 0.01, 1e6), sane(derivedEps, 0.01, 1e6), sane(fb.eps, 0.01, 1e6));
  const roeVal = pickVal(sane(pastPerf.roe_pct, -200, 500), sane(fb.roe_pct, -200, 500));
  const roceVal = pickVal(sane(pastPerf.roce_pct, -200, 500), sane(fb.roce_pct, -200, 500));
  const deVal = pickVal(sane(ov.debt_to_equity_pct, 0, 2000), sane(fb.debt_to_equity_pct, 0, 2000));
  const intCoverVal = pickVal(finHealth.interest_cover_x, fb.interest_cover_x);
  const netMarginVal = pickVal(sane(ov.net_margin_pct, -200, 200), sane(fb.net_margin_pct, -200, 200));
  const divYieldVal = pickVal(sane(ov.dividend?.yield_pct, 0, 30), sane(fb.dividend_yield_pct, 0, 30));
  const payoutVal = pickVal(sane(ov.dividend?.payout_pct, 0, 200), sane(fb.payout_pct, 0, 200));
  const betaVal = sane(ov.beta, -10, 10);
  const debtCoverVal = sane(finHealth.debt_cover_pct, 0, 1e6);
  // Parser key: ownership.insider_ownership_pct. The legacy modal read
  // ownership.insider_pct, which never existed in the API-parser output.
  const insiderVal = sane(ownership.insider_ownership_pct ?? ownership.insider_pct, 0, 100);
  const ceoTenureVal = sane(mgmt.ceo_tenure_years, 0, 100);
  const stats = [
    ["P/E", peVal != null ? `${peVal.toFixed(1)}x` : null],
    ["P/B", pbVal != null ? `${pbVal.toFixed(2)}x` : null],
    ["P/S", psVal != null ? `${psVal.toFixed(1)}x` : null],
    ["EPS", epsVal != null ? `₹${epsVal.toFixed(2)}` : null],
    ["ROE", roeVal != null ? `${roeVal.toFixed(1)}%` : null],
    ["ROCE", roceVal != null ? `${roceVal.toFixed(1)}%` : null],
    ["D/E", deVal != null ? `${deVal.toFixed(1)}%` : null],
    ["Debt cover", debtCoverVal != null ? `${debtCoverVal.toFixed(1)}%` : null],
    ["Interest cover", intCoverVal != null ? `${intCoverVal.toFixed(1)}x` : null],
    ["Net margin", netMarginVal != null ? `${netMarginVal.toFixed(1)}%` : null],
    ["Beta", betaVal != null ? betaVal.toFixed(2) : null],
    ["Div yield", divYieldVal != null ? `${divYieldVal.toFixed(2)}%` : null,],
    ["Payout", payoutVal != null ? `${payoutVal.toFixed(0)}%` : null],
    ["Insider %", insiderVal != null ? `${insiderVal.toFixed(1)}%` : null],
    ["CEO tenure", ceoTenureVal != null ? `${ceoTenureVal.toFixed(1)} yr` : null],
  ];

  // Returns strip
  const retsHtml = `
    <div class="sws-modal-section">
      <h4>Total returns</h4>
      <div class="sws-modal-grid" style="grid-template-columns:repeat(5, 1fr);">
        ${["1M","3M","1Y","3Y","5Y"].map((k) => {
          const v = ret[k];
          const col = v == null ? "var(--text-muted)" : v >= 0 ? "var(--green)" : "var(--red)";
          return `<div class="sws-stat-cell"><div class="stat-label">${k}</div><div class="stat-value" style="color:${col};">${v == null ? "—" : fmtPct(v, 1)}</div></div>`;
        }).join("")}
      </div>
    </div>`;

  // Rewards / Risks
  const rewards = ov.rewards || [];
  const risks = ov.risks || [];
  const rewardsRisksHtml = (rewards.length || risks.length) ? `
    <div class="sws-modal-section">
      <div class="sws-modal-twocol">
        <div>
          <h4>Rewards (${rewards.length})</h4>
          ${rewards.length ? `<ul class="sws-bullet-list rewards">${rewards.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : `<div style="font-size:11px;color:var(--text-muted);">None flagged at last scan.</div>`}
        </div>
        <div>
          <h4>Risks (${risks.length})</h4>
          ${risks.length ? `<ul class="sws-bullet-list risks">${risks.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : `<div style="font-size:11px;color:var(--text-muted);">No SWS-flagged risks at last scan.</div>`}
        </div>
      </div>
    </div>` : "";

  // Catalysts. last_quarter_result is sourced from the picks card (Yahoo
  // earningsHistory enricher writes it there) — the deep file's
  // overview.last_quarter_result is always null since the SWS API parser
  // doesn't populate it. Prefer card_; fall back to ov for legacy.
  const revisions = ov.recent_analyst_revisions || [];
  const insiders = ov.insider_activity || [];
  const lqrModal = card_.last_quarter_result || ov.last_quarter_result || null;
  const lqrColor = lqrModal === "beat" ? "var(--green)" : lqrModal === "miss" ? "var(--red)" : "var(--text-muted)";
  const catalystHtml = (ov.next_earnings_date || revisions.length || insiders.length) ? `
    <div class="sws-modal-section">
      <h4>Catalysts &amp; activity</h4>
      <div style="font-size:12px;line-height:1.6;color:var(--text-primary);">
        ${ov.next_earnings_date ? `<div>📅 Next earnings: <strong>${ov.next_earnings_date}</strong>${lqrModal ? ` · last quarter: <span style="color:${lqrColor};text-transform:uppercase;font-weight:600;">${lqrModal}</span>` : ""}</div>` : ""}
        ${revisions.length ? `<div style="margin-top:6px;">📊 Recent analyst revisions: ${revisions.map((r) => `${r.direction === "increased" ? "↑" : "↓"} ${r.pct}% to ₹${r.new_target_inr} (${r.date})`).join(" · ")}</div>` : ""}
        ${insiders.length ? `<div style="margin-top:6px;">👁 Insider activity: ${insiders.length} event(s)</div>` : ""}
      </div>
    </div>` : "";

  // Recent news from SWS (Brief = analyst commentary, Event = corporate
  // actions). Populated by scripts/sws-news-scrape.mjs onto the same deep
  // JSON the /api/sws-stock endpoint already serves — no backend change.
  // Hidden when the news scrape hasn't run yet for this ticker (deep.news
  // empty or missing).
  const newsItems = Array.isArray(deep?.news) ? deep.news.slice(0, 8) : [];
  const newsHtml = newsItems.length ? `
    <div class="sws-modal-section">
      <details>
        <summary style="cursor:pointer;list-style:revert;">
          <h4 style="display:inline;margin:0;">Recent news (${newsItems.length})</h4>
        </summary>
        <ul class="sws-bullet-list" style="font-size:12px;line-height:1.55;margin-top:10px;">
          ${newsItems.map((n) => {
            const date = (n.date || "").slice(0, 10);
            const typeBadge = n.type === "event"
              ? `<span style="display:inline-block;padding:1px 6px;border-radius:3px;margin-right:4px;font-size:9px;background:rgba(34,211,238,0.12);color:var(--cyan);text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(n.keyDevTypeId || "event")}</span>`
              : `<span style="display:inline-block;padding:1px 6px;border-radius:3px;margin-right:4px;font-size:9px;background:rgba(251,191,36,0.12);color:#fbbf24;text-transform:uppercase;letter-spacing:0.5px;">brief</span>`;
            return `<li style="margin:6px 0;">
              <span style="color:var(--text-muted);font-size:10px;margin-right:6px;">${escapeHtml(date)}</span>
              ${typeBadge}
              <span style="color:var(--text-primary);">${escapeHtml(n.title || "")}</span>
              ${n.body ? `<div style="margin-top:2px;font-size:11px;color:var(--text-secondary);line-height:1.5;">${escapeHtml(n.body)}</div>` : ""}
            </li>`;
          }).join("")}
        </ul>
      </details>
    </div>` : "";

  // PR 2.11 — section-membership banner. Uses the same labels/emojis defined
  // in PICKS_SECTIONS so chip-nav and modal stay in lockstep. `avoid` and
  // `upcoming_earnings` are informational rather than buy-list signals — we
  // surface them only when they're the SOLE membership, otherwise users would
  // see e.g. "💎 Deep Value · ⚠ Avoid" which is incoherent (the avoid filter
  // captures different stocks than deep_value, but a stock in both makes the
  // page nervous; it'll be clearer once 2.8/2.9 land separately).
  const INFORMATIONAL_KEYS = new Set(["avoid", "upcoming_earnings"]);
  const sectionLabelByKey = (() => {
    const m = {};
    if (Array.isArray(PICKS_SECTIONS)) {
      for (const s of PICKS_SECTIONS) m[s.key] = { label: s.chip_label, emoji: s.emoji };
      // top_ranked_30_v3 is the API key; PICKS_SECTIONS uses the same key.
      if (m.top_ranked_30_v3) m.top_ranked_30 = m.top_ranked_30_v3;
    }
    return m;
  })();
  const memberships = Array.isArray(section_memberships) ? section_memberships : [];
  const buyListMemberships = memberships.filter((k) => !INFORMATIONAL_KEYS.has(k));
  const sectionsBannerHtml = (() => {
    if (memberships.length === 0) return "";
    const keysToRender = buyListMemberships.length ? buyListMemberships : memberships;
    const chips = keysToRender.map((key) => {
      const meta = sectionLabelByKey[key];
      const display = meta ? `${meta.emoji} ${meta.label}` : key;
      return `<span class="sws-modal-section-chip">${escapeHtml(display)}</span>`;
    }).join("");
    if (!chips) return "";
    return `
      <div class="sws-modal-sections-banner" role="note" aria-label="Picks-section membership">
        <span class="label">In sections:</span>
        <span class="sws-modal-section-chips">${chips}</span>
      </div>`;
  })();

  return `
    <div class="sws-modal-hero">
      <div style="flex:1;min-width:0;">
        <h2 id="swsModalTitle">${ticker} ${watchlistButton(`${ticker}.NS`, card_.name || ticker, card_.sector || '')}${survBadge}</h2>
        <div style="font-size:13px;color:var(--text-muted);">${escapeHtml(card_.name || ticker)}${card_.sector ? ` · ${escapeHtml(card_.sector)}` : ""}${fresh}</div>
        <div style="display:flex;gap:14px;margin-top:10px;font-size:12px;flex-wrap:wrap;">
          <div><span style="color:var(--text-muted);">Price</span> ${fmtInr(ov.current_price_inr)}</div>
          <div><span style="color:var(--text-muted);">Fair value</span> ${fmtInr(ov.fair_value_inr)}</div>
          <div><span style="color:var(--text-muted);">Upside</span> <span style="color:${ov.upside_pct == null ? "var(--text-muted)" : ov.upside_pct >= 0 ? "var(--green)" : "var(--red)"};">${fmtPct(ov.upside_pct, 1)}</span></div>
          <div><span style="color:var(--text-muted);">Mcap</span> ${fmtInr(ov.market_cap_inr)}</div>
          <div><span style="color:var(--text-muted);">52w</span> ${(() => {
            const lo = ov.fifty_two_week?.low ?? fb.week52_low_inr;
            const hi = ov.fifty_two_week?.high ?? fb.week52_high_inr;
            return (lo != null && hi != null) ? `${fmtInr(lo)}–${fmtInr(hi)}` : "—";
          })()}</div>
        </div>
      </div>
      <div class="sws-modal-score">
        <div class="score-value" style="color:${scoreColor};">${score}</div>
        <div class="score-label" style="color:${verdictColor};">${verdict.replace(/_/g, " ")}</div>
        ${valBandPill}
      </div>
    </div>

    ${sectionsBannerHtml}

    ${barsHtml ? `
    <div class="sws-modal-section">
      <h4>Score breakdown — ${hasV3 ? "v3 multi-factor blend" : "v2 fundamentals composite"} (out of 100)</h4>
      ${barsHtml}
      ${hasV3 ? `
        <div style="font-size:10px;color:var(--text-muted);margin-top:8px;">v3 = 5 SWS pillars (74) + AnalystConsensus FV upside + universe-percentile momentum (14) − safety overlay (max −15). Only inputs with ≥50% universe coverage are scored; 30% of stocks lack a fair-value estimate and get a neutral 6/12 on FV upside (flagged as fv_imputed in the breakdown).</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Score evolution: <strong>v1</strong> ${card_.score?.toFixed(1) || "—"} (fund only) → <strong>v2</strong> ${card_.v2_score?.toFixed(1) || "—"} (+ catalyst/risk) → <strong>v3</strong> ${card_.v3_score_100.toFixed(1)} (+ momentum, ≥50% coverage gate).</div>
      ` : `
        <div style="font-size:10px;color:var(--text-muted);margin-top:8px;">v2 = fundamentals (max 100) + catalyst (max +5) − risk overlay (max −15), clamped 0-100.</div>
      `}
    </div>` : ""}

    ${hexHtml}

    ${benchHtml}

    ${(() => {
      const visibleStats = stats.filter(([, v]) => v != null);
      if (!visibleStats.length) return "";
      return `<div class="sws-modal-section">
      <h4>Quick stats</h4>
      <div class="sws-modal-grid">
        ${visibleStats.map(([l, v]) => `<div class="sws-stat-cell"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join("")}
      </div>
    </div>`;
    })()}

    ${retsHtml}
    ${rewardsRisksHtml}
    ${catalystHtml}
    ${newsHtml}

    ${(card_.narrative && card_.narrative.pdf_rationale) ? `
    <div class="sws-modal-section">
      <h4>Research note</h4>
      <div style="font-size:12px;line-height:1.7;color:var(--text-primary);white-space:pre-line;">${escapeHtml(card_.narrative.pdf_rationale)}</div>
    </div>` : ""}

    <div class="sws-modal-section" style="border-top:none;padding-top:6px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--text-muted);">
      <div>${file_mtime ? `Deep-scrape mtime: ${new Date(file_mtime).toLocaleString()}` : ""}</div>
      ${card_.sws_url ? `<a href="${card_.sws_url}" target="_blank" rel="noopener" style="color:var(--cyan);text-decoration:none;">Open on Simply Wall Street →</a>` : ""}
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// ==================== UNIVERSAL STOCK DETAIL MODAL ====================
//
// openStockDetailModal(symbolOrTicker, sourceTab) is the single entry point
// for every clickable stock surface across the platform (scanner cards,
// search, watchlist, portfolio, MF overlap, etc.). The SWS Picks tab is
// untouched — it still calls openSwsModal() directly.
//
// Two-stage progressive paint:
//   Stage 0 — instant skeleton + spinner (before any fetch)
//   Stage 1 — /api/sws-stock/:ticker (~20ms local file). If 200, we render
//             the full SWS modal (reusing renderSwsModal + the lazy live
//             overlay) — same UX as SWS Picks.
//   Stage 1' — If /api/sws-stock 404s (ticker outside SWS scrape universe,
//              common for small-caps), we fall through to the live-only
//              render path which uses /api/stock/:symbol alone.

function normaliseSymbol(input) {
  if (!input) return { ticker: "", yahooSymbol: "" };
  let s = String(input).trim().toUpperCase();
  let suffix = ".NS";
  if (s.startsWith("BSE:")) { suffix = ".BO"; s = s.slice(4); }
  else if (s.startsWith("NSE:")) { s = s.slice(4); }
  if (s.endsWith(".BO")) { suffix = ".BO"; s = s.slice(0, -3); }
  else if (s.endsWith(".NS")) { s = s.slice(0, -3); }
  return { ticker: s, yahooSymbol: s + suffix };
}

function renderStockDetailLoading(displayTicker) {
  return `
    <div style="padding:60px 20px;text-align:center;color:var(--text-muted);">
      <div class="loading-spinner" style="margin:0 auto 16px;"></div>
      <div style="font-size:15px;color:var(--text-primary);font-weight:600;margin-bottom:6px;">Analyzing ${escapeHtml(displayTicker)}…</div>
      <div style="font-size:12px;">Fetching SWS deep data + live technicals + news (≈3s)</div>
    </div>
    <div class="sws-modal-section" style="opacity:0.4;">
      <div style="height:14px;width:160px;background:rgba(255,255,255,0.06);border-radius:4px;margin-bottom:10px;"></div>
      <div style="height:48px;background:rgba(255,255,255,0.04);border-radius:6px;"></div>
    </div>
    <div class="sws-modal-section" style="opacity:0.3;">
      <div style="height:14px;width:120px;background:rgba(255,255,255,0.06);border-radius:4px;margin-bottom:10px;"></div>
      <div style="height:80px;background:rgba(255,255,255,0.04);border-radius:6px;"></div>
    </div>
  `;
}

async function openStockDetailModal(symbolOrTicker, sourceTab) {
  const { ticker, yahooSymbol } = normaliseSymbol(symbolOrTicker);
  if (!ticker) return;

  // Hide search dropdown if open (relevant for search-result clicks)
  if (typeof searchResults !== "undefined" && searchResults) {
    searchResults.classList.remove("active");
  }
  if (typeof searchInput !== "undefined" && searchInput) {
    searchInput.value = "";
  }

  // Race-guard state shared with openSwsModal — same backdrop element,
  // same close handler, same focus restoration.
  swsModalCurrentTicker = ticker;
  swsModalLastFocus = document.activeElement;

  const backdrop = document.getElementById("swsModalBackdrop");
  const body = document.getElementById("swsModalBody");
  if (!backdrop || !body) return;

  // Stage 0 — open immediately with skeleton.
  body.innerHTML = renderStockDetailLoading(ticker);
  backdrop.classList.add("open");
  document.body.style.overflow = "hidden";

  // Stage 1 — try SWS deep data first (20ms typical, 404 for non-universe).
  let swsData = null;
  try {
    const r = await fetch(`/api/sws-stock/${encodeURIComponent(ticker)}`);
    if (r.ok) swsData = await r.json();
  } catch {
    // network error — fall through to live-only path
  }
  if (swsModalCurrentTicker !== ticker) return; // user clicked another card

  if (swsData) {
    // SWS-rich path: identical to SWS Picks UX. renderSwsModal paints the
    // full hero/snowflake/valuation/rewards-risks/news view.
    body.innerHTML = renderSwsModal(swsData);
  } else {
    // Live-only path: /api/sws-stock 404'd. Render from /api/stock alone.
    body.innerHTML = renderLiveOnlySkeleton(ticker, sourceTab);
    fetchAndRenderLiveOnlyDetail(ticker, yahooSymbol, sourceTab);
  }

  // Earnings Watch: if this stock has an upcoming-result event in the
  // next 14 days, fold the prediction + price band + playbook + recent
  // announcements + deal flow into the same modal. The injector silently
  // no-ops on 404 (no upcoming result) so unaffected stocks render
  // unchanged.
  if (typeof window.injectEarningsPreviewIntoModal === "function") {
    window.injectEarningsPreviewIntoModal(ticker);
  }
}

function renderLiveOnlySkeleton(ticker, sourceTab) {
  const sourceLabel = sourceTab ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.5px;background:rgba(96,165,250,0.15);color:#60a5fa;margin-left:8px;">${escapeHtml(sourceTab)}</span>` : "";
  return `
    <div class="sws-modal-hero">
      <div style="flex:1;min-width:0;">
        <h2 id="swsModalTitle">${escapeHtml(ticker)} ${watchlistButton(`${ticker}.NS`, ticker, '')}${sourceLabel}</h2>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Outside SWS deep-scrape universe — limited data available</div>
      </div>
    </div>
    <div class="sws-modal-section" id="stockDetailLiveSlot">
      <div style="padding:30px 0;text-align:center;color:var(--text-muted);">
        <div class="loading-spinner" style="margin:0 auto 12px;"></div>
        <div style="font-size:12px;">Loading…</div>
      </div>
    </div>
  `;
}

async function fetchAndRenderLiveOnlyDetail(ticker, yahooSymbol, sourceTab) {
  const slot = document.getElementById("stockDetailLiveSlot");
  if (!slot) return;
  let data = null;
  try {
    const res = await fetch(`/api/stock/${encodeURIComponent(yahooSymbol)}`);
    if (!res.ok) {
      slot.innerHTML = `<h4>Unable to load</h4><div style="font-size:12px;color:var(--red);">Stock data returned ${res.status} — likely insufficient history (recent IPO) or symbol not on Yahoo. Try the search bar to look up a different symbol.</div>`;
      return;
    }
    data = await res.json();
  } catch (e) {
    slot.innerHTML = `<h4>Unable to load</h4><div style="font-size:12px;color:var(--red);">Network error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (swsModalCurrentTicker !== ticker) return; // user navigated away

  if (data.error) {
    slot.innerHTML = `<h4>Unable to load</h4><div style="font-size:12px;color:var(--red);">${escapeHtml(data.error)}</div>`;
    return;
  }

  // Replace the entire modal body — we now have hero info from /api/stock too.
  const body = document.getElementById("swsModalBody");
  if (!body) return;
  body.innerHTML = renderLiveOnlyModal(ticker, data, sourceTab);
}

function renderLiveOnlyModal(ticker, data, sourceTab) {
  const quote = data.quote || {};
  const fundamentals = data.fundamentals || {};
  const longTerm = data.longTerm || {};
  const surv = data.surveillance;
  const news = (data.news || []).slice(0, 5);

  const fmtInr = (v) => v == null ? "—" : v >= 1e12 ? `₹${(v / 1e12).toFixed(2)} L Cr` : v >= 1e7 ? `₹${(v / 1e7).toFixed(v >= 1e10 ? 0 : 2)} Cr` : `₹${Number(v).toLocaleString("en-IN")}`;
  const sourceLabel = sourceTab ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.5px;background:rgba(96,165,250,0.15);color:#60a5fa;margin-left:8px;">${escapeHtml(sourceTab)}</span>` : "";

  const survBadge = surv ? `<span class="sws-surveillance-badge" title="NSE ${surv.list} surveillance flag (${surv.timeframe || "—"})">${escapeHtml(surv.list)}</span>` : "";

  // Fundamentals quick stats — pull from V2 if present, fall back to V1.
  const fundV2 = fundamentals.shadowV2 || fundamentals.v2 || null;
  const fundCore = fundamentals.snapshot || fundamentals.legacyV1 || fundamentals;
  const stats = [
    ["Price", quote.price != null ? `₹${formatNumber(quote.price)}` : "—"],
    ["Change", quote.changePercent != null ? `${quote.changePercent >= 0 ? "+" : ""}${Number(quote.changePercent).toFixed(2)}%` : "—"],
    ["P/E", fundCore.pe != null ? `${Number(fundCore.pe).toFixed(1)}x` : "—"],
    ["Sector P/E", fundCore.sectorPe != null ? `${Number(fundCore.sectorPe).toFixed(1)}x` : "—"],
    ["Mcap", fmtInr(fundCore.marketCap)],
    ["52w high", fundCore.week52High != null ? `₹${formatNumber(fundCore.week52High)}` : "—"],
    ["52w low", fundCore.week52Low != null ? `₹${formatNumber(fundCore.week52Low)}` : "—"],
    ["Sector", fundCore.sector ? escapeHtml(String(fundCore.sector).slice(0, 18)) : "—"],
  ];

  return `
    <div class="sws-modal-hero">
      <div style="flex:1;min-width:0;">
        <h2 id="swsModalTitle">${escapeHtml(ticker)} ${watchlistButton(`${ticker}.NS`, quote.name || fundCore.name || ticker, fundCore.sector || '')}${survBadge}${sourceLabel}</h2>
        <div style="font-size:13px;color:var(--text-muted);">${escapeHtml(quote.name || fundCore.name || ticker)}${fundCore.sector ? ` · ${escapeHtml(fundCore.sector)}` : ""}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">⚠ Outside SWS deep-scrape universe — limited data available (no Snowflake / fair-value / SWS rewards-risks)</div>
      </div>
    </div>

    ${surv ? `
    <div class="sws-modal-section" style="background:rgba(239,68,68,0.04);border-left:3px solid var(--red);">
      <div style="font-size:12px;color:var(--red);">⚠ NSE surveillance: <strong>${escapeHtml(surv.list)}</strong>${surv.timeframe ? ` (${escapeHtml(surv.timeframe)})` : ""}${surv.stage ? ` · stage ${escapeHtml(String(surv.stage))}` : ""}</div>
    </div>
    ` : ""}

    <div class="sws-modal-section">
      <h4>Quick stats</h4>
      <div class="sws-modal-grid">
        ${stats.map(([l, v]) => `<div class="sws-stat-cell"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join("")}
      </div>
    </div>

    ${(longTerm.recommendation || longTerm.narrative) ? `
    <div class="sws-modal-section">
      <h4>Long-term outlook (3–12 months)</h4>
      ${longTerm.recommendation ? `<div style="font-size:13px;color:var(--text-primary);margin-bottom:6px;"><strong>${escapeHtml(longTerm.recommendation)}</strong>${longTerm.score != null ? ` · score ${Math.round(longTerm.score)}/100` : ""}${longTerm.fundamentalVerdict ? ` · ${escapeHtml(longTerm.fundamentalVerdict.replace(/_/g, " "))}` : ""}</div>` : ""}
      ${longTerm.narrative ? `<div style="font-size:12px;line-height:1.7;color:var(--text-primary);white-space:pre-line;">${escapeHtml(longTerm.narrative)}</div>` : ""}
      ${longTerm.macroBoost != null ? `<div style="font-size:10px;color:var(--text-muted);margin-top:8px;">Macro tilt: ${longTerm.macroBoost >= 0 ? "+" : ""}${longTerm.macroBoost}</div>` : ""}
    </div>
    ` : ""}

    ${news.length ? `
    <div class="sws-modal-section">
      <h4>News (${news.length})</h4>
      <ul class="sws-bullet-list">
        ${news.map((n) => `<li>${n.url ? `<a href="${escapeAttr(n.url)}" target="_blank" rel="noopener" style="color:var(--text-primary);text-decoration:none;" onclick="event.stopPropagation();">${escapeHtml(n.title || "(untitled)")}</a>` : escapeHtml(n.title || "")}<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${n.source ? escapeHtml(n.source) : ""}${n.publishedAt ? ` · ${new Date(n.publishedAt).toLocaleDateString()}` : ""}</div></li>`).join("")}
      </ul>
    </div>
    ` : ""}

    <div class="sws-modal-section" style="border-top:none;padding-top:6px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--text-muted);">
      <div>Live data fetched at modal open. May lag up to 15 min during market hours.</div>
      <div>Source: ${escapeHtml(sourceTab || "—")}</div>
    </div>
  `;
}
