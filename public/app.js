/**
 * StarBhai · Indian Stock Intelligence — Frontend Application
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
let allMarketNews = []; // cached for filtering
let watchlist = new Set(); // symbol set for quick lookup

// DOM Elements
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const stockDetail = document.getElementById("stockDetail");
const dashboard = document.getElementById("dashboard");

// ==================== INITIALIZATION ====================

document.addEventListener("DOMContentLoaded", () => {
  updateClock();
  setInterval(updateClock, 1000);
  loadMarketData();
  loadMacroRegime(); // global: shown on every tab
  setInterval(loadMacroRegime, 15 * 60 * 1000); // refresh every 15 minutes
  loadDashboard();
  setRefreshInterval();
  setupSearch();
  attachGlossaryTooltips(); // event delegation for all .info-icon clicks/hovers
});

// ==================== ACCORDION SECTION TOGGLE ====================
//
// Scanner sections start collapsed so mobile users see all section names
// without scrolling. Tapping a header expands it; tapping again collapses.
// On desktop the first section (Buy Now) auto-expands after data loads.

function toggleSection(headerEl) {
  const section = headerEl.closest('.dashboard-section');
  if (!section) return;
  section.classList.toggle('collapsed');
}

// Auto-expand a section by ID once its data loads, so the user sees results
// immediately without needing to tap. Called from each tab's first-section
// loader (Buy Now for Market Scanner, Buy Now for Small-Cap, Deep Value for
// Fundamental Scanner).
function autoExpandSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (section && section.classList.contains('collapsed')) {
    section.classList.remove('collapsed');
  }
}

// Backward-compat alias used by the Buy Now loader
function autoExpandFirstSection() { autoExpandSection('buynowSection'); }

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
async function loadMacroRegime() {
  try {
    const res = await fetch("/api/macro/regime");
    if (!res.ok) return;
    const regime = await res.json();
    renderMacroBanner(regime);
  } catch (err) {
    // Silent — the banner is additive, failure means no banner.
  }
}

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
          return `
            <div class="ticker-item${isGift ? " ticker-gift" : ""}">
              <span class="ticker-name">${name}</span>
              <span class="ticker-price ${isPos ? "positive" : "negative"}">${formatNumber(idx.price)}</span>
              <span class="ticker-change ${isPos ? "positive-bg" : "negative-bg"}">
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
        <div class="search-result-item" onclick="loadStock('${r.symbol}')">
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
        <div class="sv-body">${reason} This stock is <strong>excluded from StarBhai's Deep Value and Quality Growth surfaces</strong> as a compliance precaution. Analytical scores are still shown for reference — not as a recommendation.</div>
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

// ── StarBhai long-term narrative renderer ─────────────────────────────
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
          StarBhai Thesis${infoIcon('long_term_narrative')}
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
              <div class="card-sub">${fundamentals.breakdown.tier || ''}</div>
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
            <div style="margin-top:10px;padding:8px 12px;border:1px solid var(--border-soft);border-radius:6px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);display:flex;gap:14px;flex-wrap:wrap;align-items:center;" title="SEBI Research Analyst record-keeping: this analytical verdict is reproducible from the inputs captured at the time of scoring.">
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

/**
 * Phase 8A: Pick-depth toggle (Balanced ↔ Concentrated).
 *
 * Balanced (default): render all picks returned by the scanner (up to 10).
 * Concentrated: slice to top-3 per category, hide Mid-Term via CSS.
 *
 * Backtest rationale: 4-year PIT Nifty 500 showed Concentrated (top-3
 * fixed, no MID_TERM) = +126% cumulative vs Balanced (top-5 with
 * MID_TERM) = +128%. Concentrated trades ~6 picks/month; Balanced ~15.
 * Users who want sharper, higher-conviction picks use Concentrated.
 *
 * State persists in localStorage under CONCENTRATION_KEY. Default is
 * "balanced" so existing users see no change on first load.
 */
const CONCENTRATION_KEY = "concentrationMode";
const CONCENTRATION_LIMIT = 3;

function getConcentrationMode() {
  try { return localStorage.getItem(CONCENTRATION_KEY) || "balanced"; }
  catch { return "balanced"; }
}
function setConcentrationMode(mode) {
  try { localStorage.setItem(CONCENTRATION_KEY, mode); }
  catch { /* ignore storage failures (incognito etc.) */ }
  applyConcentrationMode();
  // Re-render the scanners if we're on the dashboard so the new depth
  // takes effect immediately without a manual refresh.
  if (document.getElementById("dashboard")?.style.display !== "none") {
    loadDashboard();
  }
  // Fundamentals tab also honors concentration — re-run if that's active.
  const fundEl = document.getElementById("fundamentalsTab");
  if (fundEl && fundEl.style.display === "block" && typeof loadFundamentalsScanner === "function") {
    loadFundamentalsScanner();
  }
}
function applyConcentrationMode() {
  const mode = getConcentrationMode();
  document.body.dataset.concentration = mode;
  document.querySelectorAll(".pick-depth-btn").forEach((b) => {
    const isActive = b.dataset.mode === mode;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-checked", String(isActive));
  });
}
/**
 * Slice a picks array to the concentration limit (top-3) when the mode
 * is Concentrated. In Balanced mode, returns the array unchanged.
 */
function applyConcentration(stocks) {
  if (!Array.isArray(stocks)) return stocks;
  return getConcentrationMode() === "concentrated"
    ? stocks.slice(0, CONCENTRATION_LIMIT)
    : stocks;
}
// Wire the toggle state on first load.
document.addEventListener("DOMContentLoaded", applyConcentrationMode);

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

async function loadDashboard() {
  loadBuyNow();
  loadScan("midterm", "midtermCards");
  loadScan("sell", "sellCards");
  loadSectorHeatmap();
  loadWatchlistState();
}

/**
 * Populate the #scanNotices banner with data-quality information.
 * Shows two kinds of warnings:
 *   1. Vercel cap — when only 50/100 stocks were analyzed on production.
 *   2. Failed stocks — when some symbols didn't load (rate limit, wrong
 *      symbol, etc.), so the user knows the scan is a partial result.
 */
function updateScanNotices(data) {
  const el = document.getElementById("scanNotices");
  if (!el) return;
  const notices = [];

  if (data.truncatedForVercel) {
    notices.push(
      `<div style="padding:10px 14px; background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.25); border-radius:8px; font-size:12px; color:var(--text-secondary);">
        <strong style="color:var(--yellow);">ⓘ Vercel mode:</strong>
        Analyzing <strong>${data.universeSize}</strong> of ${data.fullUniverseSize} stocks to stay under serverless timeout.
        Some Nifty Next 50 stocks won't appear in recommendations on this deployment.
        Run locally for full coverage.
      </div>`
    );
  }

  if (data.failedCount > 0) {
    const symbolList = (data.failedSymbols || []).map((f) => f.symbol).slice(0, 8).join(", ");
    notices.push(
      `<div style="padding:10px 14px; background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.2); border-radius:8px; font-size:12px; color:var(--text-secondary); margin-top:${data.truncatedForVercel ? '8px' : '0'};">
        <strong style="color:#f87171;">⚠ Partial data:</strong>
        ${data.failedCount} stock${data.failedCount === 1 ? '' : 's'} failed to load (${escapeHtml(symbolList)}${data.failedCount > 8 ? '...' : ''}).
        Scan results exclude these — try refreshing in a minute.
      </div>`
    );
  }

  el.innerHTML = notices.join("");
}

async function loadScan(type, containerId) {
  const container = document.getElementById(containerId);

  try {
    const res = await fetch(`/api/scan/${type}`);
    const data = await res.json();

    // Show data-quality notices once (from the first scan that returns them).
    // These surface: (a) the 50-stock Vercel cap, (b) any stocks that failed
    // to load so the user knows the scan isn't a silent partial result.
    if (type === "buynow") updateScanNotices(data);

    if (data.error) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#9888;</div>
          <div class="empty-text">${escapeHtml(data.error)}</div>
        </div>
      `;
      return;
    }

    if (!data.stocks || data.stocks.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1;">
          <div class="empty-icon">${type === "sell" ? "&#10004;" : "&#128269;"}</div>
          <div class="empty-text">${
            type === "sell"
              ? "No strong sell signals detected - Your portfolio looks safe!"
              : "No strong mid-term buy signals found right now."
          }</div>
        </div>
      `;
      return;
    }

    // Phase 8A: apply Concentrated filter to midterm only. Volume/sell are
    // category-agnostic signals — we keep the full list for those.
    const stocksToRender = type === "midterm" ? applyConcentration(data.stocks) : data.stocks;
    container.innerHTML = stocksToRender.map((s) => renderStockCard(s, type)).join("");

    // Update last updated
    document.getElementById("lastUpdated").textContent = `Updated: ${new Date(data.lastUpdated).toLocaleTimeString("en-IN")}`;
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <div class="empty-icon">&#9888;</div>
        <div class="empty-text">Failed to load data. Server might be starting up - please try refreshing.</div>
      </div>
    `;
  }
}

function renderStockCard(stock, type) {
  const isPos = (stock.change || 0) >= 0;
  const recColor = getRecColor(stock.recommendation);

  let footer = "";
  if (type === "midterm" && stock.midTerm) {
    const mt = stock.midTerm;
    const slTarget = (mt.stopLoss && mt.target)
      ? `<div style="display:flex;gap:12px;align-items:center;margin-top:8px;padding:6px 10px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:8px;font-size:11px;">
          <span style="color:var(--red);">SL: ₹${formatNumber(mt.stopLoss)}</span>
          <span style="color:var(--green);">Target: ₹${formatNumber(mt.target)}</span>
          ${mt.volatilityPct ? `<span style="color:var(--yellow);">Vol: ${mt.volatilityPct}%</span>` : ""}
          ${mt.riskReward ? `<span style="color:var(--text-muted);">R:R ${mt.riskReward}x</span>` : ""}
        </div>`
      : "";
    footer = `
      ${slTarget}
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-long">${mt.recommendation}</span>
        <span style="font-size:12px; color:var(--text-muted);">Score: ${mt.score}/100 &middot; Trend: ${mt.trendAlignment}</span>
      </div>
    `;
  } else if (type === "sell") {
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-short">&#9888; EXIT</span>
        <span style="font-size:12px; color:var(--text-muted);">Score: ${stock.score}/100</span>
      </div>
    `;
  }

  return `
    <div class="stock-card" onclick="loadStock('${stock.symbol}')">
      <div class="stock-card-header">
        <div>
          <div class="stock-card-name">${escapeHtml(stock.name)}</div>
          <div class="stock-card-symbol">${stock.symbol} &middot; ${stock.sector || ""}</div>
        </div>
        <div>
          <div class="stock-card-price ${isPos ? "positive" : "negative"}">&#8377;${formatNumber(stock.price)}</div>
          <div class="stock-card-change ${isPos ? "positive" : "negative"}">
            ${isPos ? "+" : ""}${stock.changePercent?.toFixed(2)}%
          </div>
        </div>
      </div>
      <div style="margin-bottom:8px;">
        <span class="stock-card-rec" style="background:${recColor}22; color:${recColor}; border:1px solid ${recColor}44;">
          ${stock.recommendation}
        </span>
      </div>
      <div class="stock-card-metrics">
        <div class="stock-card-metric">
          <div class="metric-label">RSI</div>
          <div class="metric-value ${rsiColor(stock.rsi)}">${stock.rsi}</div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Volume</div>
          <div class="metric-value">${stock.volume || "N/A"}</div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Trend</div>
          <div class="metric-value" style="font-size:11px;">${stock.trend || "N/A"}</div>
        </div>
      </div>
      <div class="stock-card-reasoning">${escapeHtml(stock.reasoning || "")}</div>
      ${footer}
    </div>
  `;
}

// ==================== REFRESH ====================

function setRefreshInterval() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const seconds = parseInt(document.getElementById("refreshInterval").value);
  const indicator = document.getElementById("autoRefreshIndicator");

  if (seconds > 0) {
    refreshTimer = setInterval(() => {
      refreshAll();
    }, seconds * 1000);
    indicator.style.display = "flex";
  } else {
    indicator.style.display = "none";
  }
}

let _buynowUniverse = "nifty100";
function onBuynowUniverseChange(val) {
  _buynowUniverse = val === "expanded" ? "expanded" : "nifty100";
  loadBuyNow();
}

async function loadBuyNow() {
  const container = document.getElementById("buynowCards");
  const warmingBanner = document.getElementById("buynowWarmingBanner");

  // Show the warming-banner after 3s if the request is still pending — gives
  // users confidence that something is happening during the 45s cold start.
  const warmingTimer = setTimeout(() => {
    if (warmingBanner) warmingBanner.classList.add("visible");
  }, 3000);

  try {
    const url = _buynowUniverse === "expanded"
      ? "/api/scan/buynow?universe=expanded"
      : "/api/scan/buynow";
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">${escapeHtml(data.error)}</div></div>`;
      return;
    }

    // Render macro regime banner if present
    if (data.regime) renderMacroBanner(data.regime);

    // Degraded banner: server fell back to Nifty 100 because expanded
    // segments are still warming. Shown above results so users understand
    // why the universe selector says "Expanded" but picks look familiar.
    const degradedBanner = data.degraded
      ? `<div style="grid-column:1/-1;padding:12px 16px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:10px;font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px;">
          <strong style="color:var(--yellow);">&#9888; Expanded scan refreshing:</strong>
          ${data.degradedReason === "cache_warming"
            ? "Both Nifty 100 and Expanded caches are warming. Try again in a few minutes."
            : "Showing Nifty 100 picks while the 750-stock expanded scan rebuilds. Daily cron runs at 9:25–9:31 IST; data persists for 7 days."}
        </div>`
      : "";

    if (!data.stocks || data.stocks.length === 0) {
      container.innerHTML = degradedBanner + `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-icon">&#128269;</div>
          <div class="empty-text">${data.message ? escapeHtml(data.message) : "No strong buy signals detected right now. The market may be in a bearish phase — wait for better entries."}</div>
        </div>`;
      return;
    }

    // "Last updated Xh ago" pill — surfaces staleness so users know when
    // the precompute last ran. Pulls from precomputedAt (cron run time)
    // when available, falls back to lastUpdated (response generation).
    const stamp = data.precomputedAt || data.lastUpdated;
    const updatedPill = stamp
      ? `<div style="grid-column:1/-1;font-size:11px;color:var(--text-muted);margin-bottom:6px;">
          Last updated: <strong style="color:var(--text-secondary);">${timeAgo(stamp)}</strong>
          <span style="opacity:0.6;">(${new Date(stamp).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })})</span>
        </div>`
      : "";

    // High-conviction messaging when strict filters produce fewer picks
    const hcBanner = data.highConvictionMessage
      ? `<div style="grid-column:1/-1;padding:12px 16px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.22);border-radius:10px;font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px;">
          <strong style="color:var(--green);">High-conviction mode:</strong> ${escapeHtml(data.highConvictionMessage)}
        </div>`
      : "";

    // HERO PICK — the #1 highest-scoring Buy Now stock gets a distinct card.
    // Backtest shows the Top-1 Buy Now pick produces the largest alpha
    // (+34pp at 4yr horizon), so visually it deserves hero treatment.
    // Phase 8A: when Concentrated mode is on, slice to top-3 picks.
    const displayedStocks = applyConcentration(data.stocks);
    const [hero, ...rest] = displayedStocks;
    const heroHtml = hero ? renderBuyNowHero(hero) : "";
    const restHtml = rest.map(renderBuyNowCard).join("");
    container.innerHTML = degradedBanner + updatedPill + hcBanner + heroHtml + restHtml;
    autoExpandFirstSection();
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">Failed to load buy signals. Try refreshing.</div></div>`;
  } finally {
    clearTimeout(warmingTimer);
    if (warmingBanner) warmingBanner.classList.remove("visible");
  }
}

/**
 * Hero card for the top #1 Buy Now pick. Spans the full row width and
 * visually dominates the rest of the grid. The rationale for singling it
 * out: the multi-horizon backtest shows Top-1 concentration consistently
 * outperforms Top-3 / Top-10 — the signal strength is in the top rank.
 */
function renderBuyNowHero(stock) {
  const price = Number(stock.price).toFixed(2);
  const changePct = Number(stock.changePercent || 0).toFixed(2);
  const changeClass = stock.change >= 0 ? "positive" : "negative";
  const changeArrow = stock.change >= 0 ? "&#9650;" : "&#9660;";
  const score = stock.combinedScore ?? stock.score ?? null;
  const verdict = stock.fundamentalVerdict || "";
  const verdictPretty = verdict.replace(/_/g, " ");
  const sl = stock.stopLoss ? Number(stock.stopLoss).toFixed(2) : null;
  const target = stock.target ? Number(stock.target).toFixed(2) : null;
  const rr = (sl && target && stock.price)
    ? ((target - stock.price) / (stock.price - sl)).toFixed(1)
    : null;
  const reasoning = stock.reasoning || stock.rationale || "";

  return `
    <div class="hero-pick" style="grid-column:1/-1;position:relative;background:linear-gradient(135deg,rgba(52,211,153,0.14),rgba(52,211,153,0.04));border:1.5px solid var(--green);border-radius:14px;padding:20px 22px;margin-bottom:14px;">
      <div style="position:absolute;top:-11px;left:18px;background:var(--green);color:#0b1320;font-weight:700;font-size:11px;letter-spacing:0.06em;padding:4px 10px;border-radius:4px;">
        &#9733; PICK OF THE MONTH
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-top:4px;">
        <div style="flex:1;min-width:200px;">
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
            <a href="#" onclick="event.preventDefault();openStockDetail('${escapeHtml(stock.symbol)}')" style="font-size:22px;font-weight:700;color:var(--text-primary);text-decoration:none;">
              ${escapeHtml(stock.name || stock.symbol)}
            </a>
            <span style="font-size:12px;color:var(--text-muted);">${escapeHtml(stock.sector || "")}</span>
          </div>
          <div style="margin-top:4px;font-size:13px;color:var(--text-secondary);">
            ${escapeHtml(stock.symbol)} &middot; &#8377;${price}
            <span class="${changeClass}" style="margin-left:8px;">${changeArrow} ${Math.abs(changePct)}%</span>
          </div>
          ${reasoning ? `<div style="margin-top:10px;font-size:13px;color:var(--text-secondary);line-height:1.5;">${escapeHtml(reasoning)}</div>` : ""}
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          ${score !== null ? `<div style="text-align:center;min-width:72px;"><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">Score</div><div style="font-size:24px;font-weight:700;color:var(--green);">${Math.round(score)}</div></div>` : ""}
          ${verdict ? `<div style="text-align:center;min-width:100px;"><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">Verdict</div><div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-top:6px;">${escapeHtml(verdictPretty)}</div></div>` : ""}
          ${sl ? `<div style="text-align:center;min-width:72px;"><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">Stop Loss</div><div style="font-size:16px;font-weight:600;color:var(--red);margin-top:3px;">&#8377;${sl}</div></div>` : ""}
          ${target ? `<div style="text-align:center;min-width:72px;"><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">Target</div><div style="font-size:16px;font-weight:600;color:var(--green);margin-top:3px;">&#8377;${target}</div></div>` : ""}
          ${rr ? `<div style="text-align:center;min-width:56px;"><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">R:R</div><div style="font-size:16px;font-weight:600;color:var(--text-primary);margin-top:3px;">1:${rr}</div></div>` : ""}
        </div>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;color:var(--text-muted);">
        Educational only. Not investment advice. StarBhai is not a SEBI-registered investment adviser.
      </div>
    </div>
  `;
}

// ──────────────────── Macro Regime Banner ────────────────────

/**
 * Render the macro regime banner above the Buy Now section.
 * Hides itself when regime === "CALM" and severity === 1 (no actionable signal).
 */
function renderMacroBanner(regime) {
  const banner = document.getElementById("macroRegimeBanner");
  if (!banner) return;

  if (!regime || (regime.regime === "CALM" && regime.severity <= 1)) {
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
      <div class="macro-banner-meta">Severity ${regime.severity}/5 &middot; Confidence ${confidencePct}%</div>
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

function renderBuyNowCard(stock) {
  const isPos = (stock.change || 0) >= 0;

  // Macro tilt badge
  let macroBadge = "";
  if (stock.macroBoost != null && Math.abs(stock.macroBoost) >= 0.5) {
    const isPosBoost = stock.macroBoost > 0;
    const sign = isPosBoost ? "+" : "";
    const cls = isPosBoost ? "pos" : "neg";
    const tip = escapeHtml(stock.macroReason || "Macro regime sector tilt");
    macroBadge = `<span class="macro-boost-badge ${cls}" title="${tip}">${sign}${stock.macroBoost.toFixed(1)} macro</span>`;
  }

  // Fundamental verdict chip (shows the value assessment alongside technical rec)
  let verdictChip = "";
  if (stock.fundamentalVerdict) {
    const vColor = stock.fundamentalVerdict === "DEEP_VALUE" ? "var(--green)"
      : stock.fundamentalVerdict === "QUALITY_GROWTH" ? "var(--blue)"
      : "var(--text-muted)";
    verdictChip = `<span style="font-size:10px;padding:3px 8px;border-radius:6px;background:${vColor}18;color:${vColor};border:1px solid ${vColor}33;font-weight:700;">${stock.fundamentalVerdict.replace(/_/g, ' ')}${infoIcon(verdictIdFromLabel(stock.fundamentalVerdict))}</span>`;
  }

  // Confidence badge — shown when data is partial (no fundamentals available)
  const confLabel = stock.dataConfidence === "high" ? "" :
    `<span style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(251,191,36,0.12);color:var(--gold);font-weight:700;border:1px solid rgba(251,191,36,0.2);" title="Only ${stock.dataConfidence === 'medium' ? '2 of 3' : '1 of 3'} signal dimensions available — treat with caution.">PARTIAL DATA</span>`;

  // Earnings warning badge (Fix 5)
  const earningsBadge = stock.earningsNearby
    ? `<div style="margin-top:6px;padding:4px 8px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);border-radius:6px;font-size:10px;color:var(--yellow);font-weight:600;">&#9888; Earnings on ${stock.earningsNearby.date} &mdash; binary event risk</div>`
    : "";

  // Stop-loss and target row
  let slTargetRow = "";
  if (stock.stopLoss && stock.target) {
    slTargetRow = `
      <div style="display:flex;gap:12px;align-items:center;margin-top:8px;padding:6px 10px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:8px;font-size:11px;">
        <span style="color:var(--red);">SL: ₹${formatNumber(stock.stopLoss)}</span>
        <span style="color:var(--green);">Target: ₹${formatNumber(stock.target)}</span>
        ${stock.riskReward ? `<span style="color:var(--text-muted);">R:R ${stock.riskReward}x</span>` : ""}
      </div>`;
  }

  // Score breakdown tooltip
  const scoreBreakdown = stock.technicalScore != null
    ? `Tech: ${stock.technicalScore}${stock.fundamentalScore != null ? ' · Fund: ' + stock.fundamentalScore : ''}`
    : "";

  return `
    <div class="stock-card" onclick="loadStock('${stock.symbol}')" style="border-left: 3px solid var(--green);">
      <div class="stock-card-header">
        <div>
          <div class="stock-card-name">${escapeHtml(stock.name)}</div>
          <div class="stock-card-symbol">${stock.symbol} &middot; ${stock.sector || ""}</div>
        </div>
        <div>
          <div class="stock-card-price ${isPos ? "positive" : "negative"}">&#8377;${formatNumber(stock.price)}</div>
          <div class="stock-card-change ${isPos ? "positive" : "negative"}">${isPos ? "+" : ""}${stock.changePercent?.toFixed(2)}%</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
        <span class="stock-card-rec" style="background:rgba(52,211,153,0.15); color:var(--green); border:1px solid rgba(52,211,153,0.3); font-size:13px; padding:5px 14px;">
          &#9650; ${stock.recommendation}${infoIcon(recIdFromLabel(stock.recommendation))}
        </span>
        <span style="font-family:'JetBrains Mono',monospace; font-size:13px; font-weight:700; color:var(--green);" title="${escapeHtml(scoreBreakdown)}">Score: ${stock.score}/100${infoIcon('combined_score')}</span>
        ${verdictChip}
        ${macroBadge}
        ${confLabel}
      </div>
      <div class="stock-card-metrics">
        <div class="stock-card-metric">
          <div class="metric-label">RSI${infoIcon('rsi')}</div>
          <div class="metric-value ${rsiColor(stock.rsi)}">${stock.rsi}</div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Volume${infoIcon('volume')}</div>
          <div class="metric-value">${stock.volume || "N/A"}</div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Trend${infoIcon('trend')}</div>
          <div class="metric-value" style="font-size:11px;">${stock.trend || "N/A"}</div>
        </div>
      </div>
      ${slTargetRow}
      ${earningsBadge}
      <div class="stock-card-reasoning">${escapeHtml(stock.reasoning || "")}</div>
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-long">&#9650; STRONG SIGNAL</span>
        <span class="edu-chip" aria-label="Educational only, not a buy recommendation">Educational only</span>
        <span style="font-size:11px; color:var(--text-muted);">${stock.dataConfidence === "high" ? "Tech 40% + Fund 60%" : "Tech only"}</span>
      </div>
    </div>
  `;
}

async function refreshAll() {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spinning");

  await Promise.all([
    loadMarketData(),
    loadBuyNow(),
    loadScan("midterm", "midtermCards"),
    loadScan("sell", "sellCards"),
  ]);

  setTimeout(() => btn.classList.remove("spinning"), 500);
}

// ==================== TABS ====================

function switchTab(tab) {
  const tabs = document.querySelectorAll("#mainTabs .tab");
  // A11y: mirror aria-selected on every tab so screen readers announce the
  // active tab correctly. The actual activation happens further down where
  // activeBtn.classList.add("active") runs.
  tabs.forEach((t) => {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
  });

  const dashEl = document.getElementById("dashboard");
  const newsEl = document.getElementById("newsTab");
  const portEl = document.getElementById("portfolioTab");
  const smeEl = document.getElementById("smeTab");
  const fundEl = document.getElementById("fundamentalsTab");
  const trackEl = document.getElementById("trackTab");
  const analyzerEl = document.getElementById("analyzerTab");
  const picksEl = document.getElementById("picksTab");

  dashEl.style.display = "none";
  newsEl.style.display = "none";
  portEl.style.display = "none";
  smeEl.style.display = "none";
  if (fundEl) fundEl.style.display = "none";
  if (trackEl) trackEl.style.display = "none";
  if (analyzerEl) analyzerEl.style.display = "none";
  if (picksEl) picksEl.style.display = "none";
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
    newsRefreshTimer = setInterval(loadMarketNews, 10 * 60 * 1000);
  } else if (tab === "portfolio") {
    portEl.style.display = "block";
    loadPortfolio();
  } else if (tab === "sme") {
    smeEl.style.display = "block";
    loadSmeDashboard();
  } else if (tab === "fundamentals") {
    if (fundEl) fundEl.style.display = "block";
    loadFundamentalsScanner();
  } else if (tab === "track") {
    if (trackEl) trackEl.style.display = "block";
    loadTrackRecord();
  } else if (tab === "analyzer") {
    if (analyzerEl) analyzerEl.style.display = "block";
    initPortfolioAnalyzer();
  } else if (tab === "picks") {
    if (picksEl) picksEl.style.display = "block";
    loadPicks();
  } else {
    // Default: scanner tab
    const scanBtn = Array.from(tabs).find((t) => t.getAttribute("onclick")?.includes("scanner"));
    if (scanBtn) scanBtn.classList.add("active");
    dashEl.style.display = "block";
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
                <div onclick="loadStock('${u.symbol}')" style="cursor:pointer;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;background:${c.bg};border:1px solid ${c.border};">
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
      <div onclick="loadStock('${mover.symbol}')" style="cursor:pointer;display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:7px 10px;border-radius:6px;background:rgba(255,255,255,0.02);border:1px solid ${color}22;">
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
    <div class="portfolio-card" onclick="loadStock('${h.symbol}')" style="
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

// ==================== FUNDAMENTAL VALUE SCANNER ====================

async function loadFundamentalsScanner() {
  loadFundCategory("deepValue", "fundDeepValueCards");
  loadFundCategory("qualityGrowth", "fundQualityGrowthCards");
  loadFundCategory("fullyValued", "fundOvervaluedCards");
}

async function loadFundCategory(category, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    const res = await fetch(`/api/scan/fundamentals?category=${category}`);
    const data = await res.json();

    // Show snapshot age in header. Use the MORE RECENT of generatedAt
    // (NSE price/P/E) and enrichedAt (Yahoo quality metrics). Previously
    // only generatedAt was read, so the banner stamped "Updated 12 days
    // ago" even when enrichedAt had moved a week ago. With the daily
    // cron both should track closely, but robust UX = pick the newer one.
    const ageEl = document.getElementById("fundSnapshotAge");
    const freshestTs = (() => {
      const candidates = [data.snapshotGeneratedAt, data.snapshotEnrichedAt]
        .map((s) => (s ? new Date(s).getTime() : null))
        .filter((n) => n && !Number.isNaN(n));
      return candidates.length ? new Date(Math.max(...candidates)) : null;
    })();
    if (ageEl && freshestTs) {
      const now = new Date();
      const diffDays = Math.floor((now - freshestTs) / (1000 * 60 * 60 * 24));
      const label = diffDays === 0
        ? "Updated today"
        : diffDays === 1 ? "Updated 1 day ago"
        : `Updated ${diffDays} days ago`;
      ageEl.textContent = label;
    }

    if (data.error) {
      container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">${escapeHtml(data.error)}</div></div>`;
      return;
    }

    if (!data.stocks || data.stocks.length === 0) {
      container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#128269;</div><div class="empty-text">No stocks in this category right now.</div></div>`;
      return;
    }

    // Phase 8A: apply Concentrated filter (slice to top-3) when that mode is on.
    const displayed = applyConcentration(data.stocks);
    container.innerHTML = displayed.map((s) => renderFundamentalCard(s, category)).join("");
    // Auto-expand the first section (Deep Value) on the Fundamental tab
    if (category === "deepValue") autoExpandSection("fundDeepValueSection");
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">Failed to load fundamentals.</div></div>`;
  }
}

function renderFundamentalCard(scored, category) {
  const snap = scored.snapshot;
  const pe = snap.pe;
  const sectorPe = snap.sectorPe;
  const price = snap.price;
  const week52Low = snap.week52Low;
  const week52High = snap.week52High;

  const borderColor =
    category === "deepValue" ? "#22c55e" :
    category === "qualityGrowth" ? "var(--blue)" :
    "var(--red)";

  const verdictColor =
    scored.verdict === "DEEP_VALUE" ? "var(--green)" :
    scored.verdict === "QUALITY_GROWTH" ? "var(--blue)" :
    scored.verdict === "FAIR_VALUE" ? "var(--text-secondary)" :
    scored.verdict === "FULLY_VALUED" ? "var(--yellow)" : "var(--red)";

  // 52W position bar
  let positionBar = "";
  if (price && week52Low && week52High && week52High > week52Low) {
    const pos = Math.round(((price - week52Low) / (week52High - week52Low)) * 100);
    positionBar = `
      <div style="margin-top:10px;">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-bottom:4px;">
          <span>₹${formatNumber(week52Low)} (52W Low)</span>
          <span>${pos}% of range</span>
          <span>₹${formatNumber(week52High)} (52W High)</span>
        </div>
        <div class="volume-bar-wrap">
          <div class="volume-bar-fill" style="width:${pos}%; background: linear-gradient(90deg, var(--green), var(--yellow), var(--red));"></div>
        </div>
      </div>`;
  }

  // P/E comparison
  const peRow = pe && sectorPe ? `
    <div class="stock-card-metrics" style="margin-top:12px;">
      <div class="stock-card-metric">
        <div class="metric-label">Stock P/E${infoIcon('pe_ratio')}</div>
        <div class="metric-value" style="color:${pe < sectorPe ? 'var(--green)' : 'var(--red)'};">${pe.toFixed(1)}</div>
      </div>
      <div class="stock-card-metric">
        <div class="metric-label">Sector P/E${infoIcon('sector_pe')}</div>
        <div class="metric-value">${sectorPe.toFixed(1)}</div>
      </div>
      <div class="stock-card-metric">
        <div class="metric-label">Discount</div>
        <div class="metric-value" style="color:${pe < sectorPe ? 'var(--green)' : 'var(--red)'};">${((1 - pe / sectorPe) * 100).toFixed(0)}%</div>
      </div>
    </div>` : `
    <div class="stock-card-metrics" style="margin-top:12px;">
      <div class="stock-card-metric">
        <div class="metric-label">P/E${infoIcon('pe_ratio')}</div>
        <div class="metric-value">${pe ? pe.toFixed(1) : 'N/A'}</div>
      </div>
      <div class="stock-card-metric">
        <div class="metric-label">Market Cap${infoIcon('market_cap')}</div>
        <div class="metric-value" style="font-size:11px;">${snap.marketCapCr ? formatMarketCap(snap.marketCap) : 'N/A'}</div>
      </div>
      <div class="stock-card-metric">
        <div class="metric-label">Sector</div>
        <div class="metric-value" style="font-size:11px;">${escapeHtml((snap.sector || '').slice(0, 12))}</div>
      </div>
    </div>`;

  // Macro tilt chip — fundamentals take a half-weight macro adjustment (±8 clamp)
  let macroChip = "";
  if (scored.macroBoost != null && Math.abs(scored.macroBoost) >= 0.5) {
    const isPosBoost = scored.macroBoost > 0;
    const sign = isPosBoost ? "+" : "";
    const cls = isPosBoost ? "pos" : "neg";
    const tip = escapeHtml(scored.macroReason || "Macro regime sector tilt (half-weight)");
    macroChip = `<span class="macro-boost-badge ${cls}" title="${tip}">${sign}${scored.macroBoost.toFixed(1)} macro</span>`;
  }

  const isPos = false; // not really applicable here; use verdict color
  return `
    <div class="stock-card" onclick="loadStock('${snap.symbol}')" style="border-left: 3px solid ${borderColor};">
      <div class="stock-card-header">
        <div>
          <div class="stock-card-name">${escapeHtml(snap.name || snap.symbol.replace('.NS', ''))}</div>
          <div class="stock-card-symbol">${snap.symbol} · ${escapeHtml((snap.sector || '').slice(0, 24))}</div>
        </div>
        <div>
          <div class="stock-card-price">&#8377;${formatNumber(price)}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:${verdictColor};font-weight:700;text-align:right;margin-top:2px;">Score: ${scored.adjustedScore != null ? Math.round(scored.adjustedScore) : scored.score}</div>
        </div>
      </div>
      <div style="margin:10px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="stock-card-rec" style="background:${verdictColor}22; color:${verdictColor}; border:1px solid ${verdictColor}44; font-size:12px; padding:4px 12px;">
          ${scored.verdict.replace(/_/g, ' ')}${infoIcon(verdictIdFromLabel(scored.verdict))}
        </span>
        ${macroChip}
      </div>
      ${peRow}
      ${positionBar}
      <div class="stock-card-reasoning" style="margin-top:12px;">${escapeHtml(scored.reasoning)}</div>
      <div class="stock-card-footer">
        <span style="font-size:11px;color:var(--text-muted);">
          ${snap.marketCapCr ? formatMarketCap(snap.marketCap) : ''}
        </span>
        <span style="font-size:11px;color:var(--text-muted);">
          ${escapeHtml((snap.industry || '').slice(0, 30))}
        </span>
      </div>
    </div>`;
}

// ==================== SME SCANNER ====================

function loadSmeDashboard() {
  loadSmeTrackRecord();
  loadSmeScan("buynow", "smeBuynowCards", "buy opportunities");
  loadSmeScan("volume", "smeVolumeCards", "volume breakouts");
  loadSmeScan("midterm", "smeMidtermCards", "mid-term picks");
  loadSmeScan("sell", "smeSellCards", "sell alerts");
}

async function refreshSme() {
  const btn = document.getElementById("smeRefreshBtn");
  if (btn) btn.classList.add("spinning");
  await Promise.all([
    loadSmeTrackRecord(),
    loadSmeScan("buynow", "smeBuynowCards", "buy opportunities"),
    loadSmeScan("volume", "smeVolumeCards", "volume breakouts"),
    loadSmeScan("midterm", "smeMidtermCards", "mid-term picks"),
    loadSmeScan("sell", "smeSellCards", "sell alerts"),
  ]);
  setTimeout(() => { if (btn) btn.classList.remove("spinning"); }, 500);
}

/**
 * Fetch and render the scanner's historical track record for smallcap_buynow.
 *
 * Rationale: users see "MOMENTUM CLUSTER · TA Score 73" and need to know
 * if that signal historically wins ~70% or ~40% of the time. SEBI-registered
 * RAs MUST disclose track-record; we do so here even as an unregistered
 * educational platform because it's the right thing for user trust.
 *
 * Data comes from /api/track/history which aggregates the daily
 * paper-trade snapshots (scanner picks → auto-snapshotted → tracked over
 * 30 days → closed). We surface the key numbers plus a link-out hint.
 */
async function loadSmeTrackRecord() {
  const el = document.getElementById("smeTrackRecord");
  if (!el) return;
  try {
    const res = await fetch("/api/track/history?limit=1");
    const data = await res.json();
    const bucket = data?.byType?.smallcap_buynow;
    if (!bucket || !bucket.total) {
      el.innerHTML = "";
      return;
    }
    const winColor = bucket.winRate >= 60 ? "#86efac" : bucket.winRate >= 50 ? "#fde047" : "#fca5a5";
    const alphaColor = bucket.avgAlpha >= 0 ? "#86efac" : "#fca5a5";
    el.innerHTML = `
      <div style="background:linear-gradient(135deg, rgba(52,211,153,0.06), rgba(96,165,250,0.04)); border:1px solid rgba(52,211,153,0.2); border-radius:8px; padding:14px 16px; font-size:12px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
          <div>
            <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; font-weight:700; margin-bottom:4px;">Scanner track record &mdash; Bullish Momentum picks</div>
            <div style="display:flex; gap:20px; flex-wrap:wrap; align-items:baseline;">
              <div><span style="font-size:20px; font-weight:700;">${bucket.total}</span> <span style="color:var(--text-muted); font-size:11px;">picks tracked</span></div>
              <div><span style="font-size:20px; font-weight:700; color:${winColor};">${bucket.winRate.toFixed(1)}%</span> <span style="color:var(--text-muted); font-size:11px;">win rate</span></div>
              <div><span style="font-size:18px; font-weight:700; color:${bucket.avgReturn >= 0 ? '#86efac' : '#fca5a5'};">${bucket.avgReturn >= 0 ? '+' : ''}${bucket.avgReturn.toFixed(2)}%</span> <span style="color:var(--text-muted); font-size:11px;">avg return</span></div>
              <div><span style="font-size:18px; font-weight:700; color:${alphaColor};">${bucket.avgAlpha >= 0 ? '+' : ''}${bucket.avgAlpha.toFixed(2)}%</span> <span style="color:var(--text-muted); font-size:11px;">vs Nifty</span></div>
            </div>
            <div style="color:var(--text-muted); font-size:11px; margin-top:6px;">
              Auto-snapshotted daily · measured over 30 trading days · ${bucket.beatsNiftyRate != null ? `${bucket.beatsNiftyRate.toFixed(0)}% beat Nifty` : ''}
              ${bucket.bestPick ? ` · best: ${bucket.bestPick.symbol.replace(/\.NS$/, '')} (${bucket.bestPick.returnPct >= 0 ? '+' : ''}${bucket.bestPick.returnPct.toFixed(1)}%)` : ''}
              ${bucket.worstPick ? ` · worst: ${bucket.worstPick.symbol.replace(/\.NS$/, '')} (${bucket.worstPick.returnPct.toFixed(1)}%)` : ''}
            </div>
          </div>
          <span class="edu-chip" aria-label="Past performance disclaimer">Past returns ≠ future</span>
        </div>
      </div>`;
  } catch {
    el.innerHTML = "";
  }
}

async function loadSmeScan(category, containerId, label) {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    const res = await fetch(`/api/sme/scan?category=${category}`);
    const data = await res.json();

    // Update scanned count and timestamp on first response
    const countEl = document.getElementById("smeScannedCount");
    if (countEl && data.totalScanned) countEl.textContent = data.totalScanned;
    const updatedEl = document.getElementById("smeLastUpdated");
    if (updatedEl && data.lastUpdated) updatedEl.textContent = `Updated: ${new Date(data.lastUpdated).toLocaleTimeString("en-IN")}`;

    if (data.error) {
      container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">${escapeHtml(data.error)}</div></div>`;
      return;
    }

    if (!data.stocks || data.stocks.length === 0) {
      container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#128269;</div><div class="empty-text">No small-cap ${label} found right now.</div></div>`;
      return;
    }

    // Filter-activity banner: shows what was excluded from this scan
    // (quality fails, illiquid names, parabolic names). Transparency about
    // the scanner's filters so users aren't wondering why a name they
    // expected to see isn't on the list.
    //
    // Concentration banner: flags material sector clustering when present.
    const filterBanner = renderSmeFilterBanner(data.filterStats, category);
    const concentrationBanner = renderSmeConcentrationBanner(data.concentration);
    container.innerHTML = filterBanner + concentrationBanner + data.stocks.map((s) => renderSmeCard(s, category)).join("");
    // Auto-expand the first section (Buy Now) on the Small-Cap tab
    if (category === "buynow") autoExpandSection("smeBuynowSection");
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">Failed to load ${label}.</div></div>`;
  }
}

function renderSmeCard(stock, category) {
  const isPos = (stock.pChange || 0) >= 0;
  const dirClass = stock.direction === "LONG" ? "direction-long" : stock.direction === "SHORT" ? "direction-short" : "direction-neutral";
  const borderColor =
    category === "buynow" ? "#22c55e" :
    category === "sell" ? "var(--red)" :
    category === "volume" ? "var(--yellow)" :
    "var(--green)";

  // Macro tilt badge — small-caps have a 1.3x amplifier so swings are bigger
  let macroBadge = "";
  let headwindStrip = "";
  if (stock.macroBoost != null && Math.abs(stock.macroBoost) >= 0.5) {
    const isPosBoost = stock.macroBoost > 0;
    const sign = isPosBoost ? "+" : "";
    const cls = isPosBoost ? "pos" : "neg";
    const tip = escapeHtml(stock.macroReason || "Macro regime sector tilt (amplified for small-caps)");
    macroBadge = `<span class="macro-boost-badge ${cls}" title="${tip}">${sign}${stock.macroBoost.toFixed(1)} macro</span>`;
  }
  if (stock.macroHeadwind) {
    headwindStrip = `<div class="macro-headwind-strip" title="${escapeHtml(stock.macroReason || "")}">&#9888; Macro headwind — small-caps amplify sector pressure</div>`;
  }

  // Fundamentals chip — partial coverage (~500 curated names) so guard for null.
  // Shown alongside macro badge so users can see both the momentum tilt and
  // the value/quality read at a glance. Scanner still ranks on momentum; this
  // is context, not a ranking input.
  let fundChip = "";
  if (stock.fundamentalScore != null && stock.fundamentalVerdict) {
    const v = stock.fundamentalVerdict;
    const vColor =
      v === "DEEP_VALUE" ? "var(--green)" :
      v === "QUALITY_GROWTH" ? "var(--blue)" :
      v === "OVERVALUED" ? "var(--red)" :
      "var(--text-muted)";
    const vLabel = v.replace(/_/g, " ");
    fundChip = `<span style="font-size:10px;padding:3px 8px;border-radius:6px;background:${vColor}18;color:${vColor};border:1px solid ${vColor}33;font-weight:700;" title="Fundamentals score ${stock.fundamentalScore}/100 — ${vLabel}. Scanner ranks on momentum; this is context.">${vLabel} &middot; ${stock.fundamentalScore}/100</span>`;
  }

  // Determine what to show in footer based on category.
  //
  // For "buynow", we show a SINGLE 0-100 confidence score (same convention as
  // the Market Scanner). Previously this was midtermScore + intradayScore which
  // could be 150-200 — meaningless to the user. Now it's the macro-adjusted
  // midterm score, consistent with the midterm/sell categories below, which
  // means the number here has the same meaning across every tab:
  //     "Higher = higher conviction, out of 100."
  // Footer labels softened to observational language per SEBI review:
  //   "STRONG SIGNAL" → "Momentum cluster" (buynow)
  //   "EXIT"          → "Review — bearish"  (sell)
  //   "SWING"         → "Swing setup"       (midterm)
  // Score methodology differs by category; labels reflect that so the
  // user knows buynow TA-Score (full 15-indicator analyzeStock) is more
  // rigorous than midterm Momentum-Score (3-factor heuristic):
  //   buynow:  TA Score        (full technical analysis)
  //   midterm: Momentum Score  (3-factor momentum heuristic)
  //   sell:    Momentum Score  (same — NOT full TA, explicitly labelled)
  //   volume:  Activity %      (volatility × volume)
  // Every card carries the "Educational · not advice" chip, not just buynow.
  let footer = "";
  if (category === "buynow") {
    const buyNowScore = Math.round(
      stock.adjustedMidtermScore != null ? stock.adjustedMidtermScore : stock.midtermScore
    );
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-long">&#9650; MOMENTUM CLUSTER</span>
        <span class="edu-chip" aria-label="Educational only">Educational &middot; not advice</span>
        <span style="font-size:12px;color:var(--text-muted);" title="Full technical analysis score (15+ indicators) adjusted for macro regime.">TA Score: ${buyNowScore}/100</span>
      </div>`;
  } else if (category === "volume") {
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction ${dirClass}">${stock.direction}</span>
        <span class="edu-chip" aria-label="Educational only">Educational &middot; not advice</span>
        <span style="font-size:12px;color:var(--yellow);font-family:'JetBrains Mono',monospace;">Activity: ${stock.volatility}%</span>
      </div>`;
  } else if (category === "midterm") {
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-long">SWING SETUP</span>
        <span class="edu-chip" aria-label="Educational only">Educational &middot; not advice</span>
        <span style="font-size:12px;color:var(--text-muted);" title="3-factor momentum heuristic (30d / 1y / today). Lower rigour than the Momentum Cluster scanner which runs full technical analysis.">Momentum Score: ${stock.midtermScore}/100</span>
      </div>`;
  } else if (category === "sell") {
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-short">&#9888; REVIEW &mdash; BEARISH</span>
        <span class="edu-chip" aria-label="Educational only">Educational &middot; not advice</span>
        <span style="font-size:12px;color:var(--text-muted);" title="Bearish momentum heuristic — NOT a sell instruction. Oversold stocks sometimes bounce; distinguishing 'weak' from 'falling knife' requires additional analysis.">Momentum Score: ${stock.midtermScore}/100</span>
      </div>`;
  }

  return `
    <div class="stock-card" onclick="loadStock('${stock.symbol}')" style="border-left: 3px solid ${borderColor};">
      <div class="stock-card-header">
        <div>
          <div class="stock-card-name">${escapeHtml(stock.name || stock.symbol.replace('.NS', ''))}</div>
          <div class="stock-card-symbol">${stock.symbol}${stock.sector ? ' &middot; ' + escapeHtml(stock.sector) : ''}</div>
        </div>
        <div>
          <div class="stock-card-price ${isPos ? 'positive' : 'negative'}">&#8377;${formatNumber(stock.lastPrice)}</div>
          <div class="stock-card-change ${isPos ? 'positive' : 'negative'}">${isPos ? '+' : ''}${stock.pChange?.toFixed(2)}%</div>
        </div>
      </div>
      ${(macroBadge || fundChip) ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">${macroBadge}${fundChip}</div>` : ""}
      ${renderSmeSafetyBadges(stock)}
      <div class="stock-card-metrics">
        <div class="stock-card-metric">
          <div class="metric-label">Volume</div>
          <div class="metric-value">${formatVolume(stock.totalTradedVolume)}</div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Volatility</div>
          <div class="metric-value" style="color:${parseFloat(stock.volatility) > 3 ? 'var(--yellow)' : 'inherit'};">${stock.volatility}%</div>
        </div>
        <div class="stock-card-metric" title="${stock.liquidityValueCr != null ? `Today's traded value: ₹${stock.liquidityValueCr} Cr. Tiers: high > ₹10 Cr, medium ₹1–10 Cr, low < ₹1 Cr.` : 'Liquidity data unavailable.'}">
          <div class="metric-label">Liquidity</div>
          <div class="metric-value" style="font-size:11px; color:${stock.liquidityTier === 'high' ? '#86efac' : stock.liquidityTier === 'medium' ? '#fde047' : stock.liquidityTier === 'low' ? '#fca5a5' : 'inherit'};">
            ${stock.liquidityTier ? stock.liquidityTier.toUpperCase() : '—'}
            ${stock.liquidityValueCr != null ? `<span style="font-size:10px; color:var(--text-muted);"> &middot; ₹${stock.liquidityValueCr}Cr</span>` : ''}
          </div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Day Range</div>
          <div class="metric-value" style="font-size:11px;">&#8377;${formatNumber(stock.dayLow)}-${formatNumber(stock.dayHigh)}</div>
        </div>
      </div>
      ${headwindStrip}
      ${footer}
    </div>`;
}

/**
 * Render a filter-activity banner showing which screens excluded names
 * from the pick list. Example: "Screened out: 12 illiquid · 8 quality
 * fail · 4 parabolic". Lets users see what the scanner is filtering
 * before they scroll the (filtered) results.
 *
 * Also surfaces the macro-gating notice — when we're in a severity-4+
 * bearish regime, pick count drops to conservative size (3-5 instead
 * of 10) to avoid building leverage into an active headwind.
 */
function renderSmeFilterBanner(filterStats, category) {
  if (!filterStats) return "";
  const parts = [];
  if (filterStats.qualityFailExcluded > 0) parts.push(`${filterStats.qualityFailExcluded} quality-fail`);
  if (filterStats.lowLiquidityExcluded > 0) parts.push(`${filterStats.lowLiquidityExcluded} illiquid (<₹1 Cr/day)`);
  if (filterStats.parabolicExcluded > 0) parts.push(`${filterStats.parabolicExcluded} parabolic`);

  const macroGated = filterStats.macroGated;
  if (parts.length === 0 && !macroGated) return "";

  const filterText = parts.length > 0 ? `Screened out: ${parts.join(" · ")}.` : "";
  const macroText = macroGated
    ? `<strong style="color:#fca5a5;">Macro gate active</strong> — pick count reduced to ${filterStats.macroGatedLimit} (from 10) due to severity-4+ bearish regime.`
    : "";

  return `
    <div style="grid-column:1/-1; background:rgba(96,165,250,0.04); border:1px solid rgba(96,165,250,0.15); border-radius:8px; padding:10px 14px; margin-bottom:10px; font-size:11px; color:var(--text-muted); line-height:1.55;">
      <span style="color:#93c5fd; font-weight:700; letter-spacing:0.3px;">Scanner filters:</span>
      ${filterText}
      ${macroText ? " &nbsp;·&nbsp; " + macroText : ""}
      <span style="margin-left:8px; font-style:italic;">(quality + liquidity + parabolic-chase screens applied to ${category === "volume" ? "this screen" : "pick list"})</span>
    </div>`;
}

/**
 * Render a sector-concentration banner above the card grid when the
 * scanner's picks cluster materially in one sector. Suppressed on
 * "diversified" results since there's nothing to warn about.
 *
 * Users who act on the top-N picks uniformly without reading the
 * banner would otherwise build a sector bet disguised as a diversified
 * momentum basket. The banner makes the hidden concentration explicit.
 */
function renderSmeConcentrationBanner(concentration) {
  if (!concentration || concentration.level === "diversified") return "";
  const color = {
    heavy:    { border: "rgba(239,68,68,0.35)",  bg: "rgba(239,68,68,0.08)",  text: "#fca5a5" },
    material: { border: "rgba(250,204,21,0.3)",  bg: "rgba(250,204,21,0.08)", text: "#fde047" },
    mild:     { border: "rgba(96,165,250,0.25)", bg: "rgba(96,165,250,0.05)", text: "#93c5fd" },
  }[concentration.level] || { border: "var(--border-soft)", bg: "transparent", text: "var(--text-muted)" };
  const label = {
    heavy:    "Heavy sector concentration",
    material: "Material sector concentration",
    mild:     "Mild sector clustering",
  }[concentration.level] || "Sector mix";
  return `
    <div style="grid-column:1/-1; background:${color.bg}; border:1px solid ${color.border}; border-radius:8px; padding:12px 14px; margin-bottom:12px; font-size:12px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
        <div style="display:flex; gap:10px; align-items:flex-start; flex:1; min-width:240px;">
          <span style="font-size:14px;">&#9888;</span>
          <div>
            <div style="font-weight:700; color:${color.text}; text-transform:uppercase; letter-spacing:0.4px; font-size:11px; margin-bottom:4px;">${label}</div>
            <div style="color:var(--text-secondary); line-height:1.55;">${escapeHtml(concentration.narrative)}</div>
          </div>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:flex-start;">
          ${(concentration.bySector || []).slice(0, 4).map((s) => `<span style="font-size:10px; font-family:'JetBrains Mono',monospace; font-weight:600; padding:3px 8px; border-radius:3px; background:rgba(255,255,255,0.03); border:1px solid var(--border-soft); color:var(--text-secondary);">${escapeHtml(s.sector)} ${s.pct.toFixed(0)}%</span>`).join("")}
        </div>
      </div>
    </div>`;
}

/**
 * Render the safety-flag chip row on a small-cap card.
 *
 * Signals-that-might-be-hazards shown compactly with tooltips for the
 * full explanation. The goal is to prevent a user from reading
 * "MOMENTUM CLUSTER" on a parabolic / overbought / illiquid stock as
 * an unconditional entry signal.
 *
 * Colour coding:
 *   high severity   → red   (parabolic 50%+ and still rallying)
 *   medium severity → amber (overbought, extended, illiquid, at 52W edge, low R/R)
 */
function renderSmeSafetyBadges(stock) {
  const flags = stock.safetyFlags;
  if (!Array.isArray(flags) || flags.length === 0) return "";
  const icon = {
    parabolic:     "&#128680;", // rocket for "going parabolic"
    extended:      "&#9650;",   // up-triangle
    overbought:    "&#9679;",   // filled circle
    "at-52w-high": "&#9650;",
    "at-52w-low":  "&#9660;",
    "low-liquidity": "&#8771;", // approx-equal (thin liquidity)
    "low-rr":      "&#9878;",   // opposition
    "quality-fail": "&#9888;",  // warning sign for quality screen fail
  };
  const chips = flags.map((f) => {
    const isHigh = f.severity === "high";
    const color = isHigh ? "#fca5a5" : "#fde047";
    const bg = isHigh ? "rgba(239,68,68,0.12)" : "rgba(250,204,21,0.10)";
    const border = isHigh ? "rgba(239,68,68,0.3)" : "rgba(250,204,21,0.25)";
    const label = {
      parabolic: "Parabolic move",
      extended: "Extended run",
      overbought: "Overbought",
      "at-52w-high": "At 52W high",
      "at-52w-low": "Near 52W low",
      "low-liquidity": "Thin liquidity",
      "low-rr": "Low R/R",
      "quality-fail": "Quality fail",
    }[f.kind] || f.kind;
    return `<span style="display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:700; padding:2px 8px; border-radius:3px; background:${bg}; color:${color}; border:1px solid ${border}; letter-spacing:0.3px; text-transform:uppercase;" title="${escapeHtml(f.message)}">${icon[f.kind] || "&#9888;"} ${label}</span>`;
  }).join(" ");
  return `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">${chips}</div>`;
}

// ==================== MARKET NEWS ====================

let _newsDigest = null; // cached digest for filter re-renders

async function loadMarketNews() {
  const container = document.getElementById("newsContainer");

  try {
    // Fetch verdict and news in parallel
    const [newsRes, verdictRes] = await Promise.all([
      fetch("/api/news/market"),
      fetch("/api/market-verdict").catch(() => null),
    ]);
    const data = await newsRes.json();
    const verdict = verdictRes ? await verdictRes.json().catch(() => null) : null;

    if (data.error) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><div class="empty-text">${escapeHtml(data.error)}</div></div>`;
      return;
    }

    allMarketNews = data.articles || [];
    _newsDigest = data.digest || null;

    const updatedEl = document.getElementById("newsLastUpdated");
    if (updatedEl) updatedEl.textContent = `Updated: ${new Date(data.lastUpdated).toLocaleTimeString("en-IN")}`;

    renderNewsPage(allMarketNews, _newsDigest, verdict);
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">&#9888;</div><div class="empty-text">Failed to load news. Try again.</div></div>`;
  }
}

function renderNewsPage(articles, digest, verdict) {
  const container = document.getElementById("newsContainer");

  if (!articles || articles.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">&#128240;</div><div class="empty-text">No news articles found.</div></div>`;
    return;
  }

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
        <div style="margin-top:12px;font-size:10px;color:var(--text-muted);text-align:right;">5-signal composite · Score: ${verdict.score} · Not investment advice</div>
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
          <!-- Bullish Drivers -->
          <div style="padding:14px 16px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.18);border-radius:10px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--green);font-weight:700;margin-bottom:10px;">&#9650; Bullish Drivers</div>
            ${digest.bullishDrivers && digest.bullishDrivers.length > 0
              ? `<ul style="margin:0;padding-left:16px;display:flex;flex-direction:column;gap:6px;">
                  ${digest.bullishDrivers.map((d) => `<li style="font-size:12px;color:var(--text-secondary);line-height:1.5;">${escapeHtml(d)}</li>`).join("")}
                </ul>`
              : `<div style="font-size:12px;color:var(--text-muted);">No clear bullish signals today.</div>`
            }
          </div>

          <!-- Bearish Risks -->
          <div style="padding:14px 16px;background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.18);border-radius:10px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--red);font-weight:700;margin-bottom:10px;">&#9660; Bearish Risks</div>
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

        <div style="margin-top:14px;font-size:10px;color:var(--text-muted);text-align:right;">AI-generated from ${articles.length} headlines · Not investment advice</div>
      </div>
    `;
  }

  // ── Raw Headlines (collapsed by default) ──
  const bullish = articles.filter((a) => a.sentiment === "bullish");
  const bearish = articles.filter((a) => a.sentiment === "bearish");
  const neutral = articles.filter((a) => a.sentiment === "neutral");

  html += `
    <div class="dashboard-section collapsed">
      <div class="section-header" onclick="toggleSection(this)" style="margin-bottom:12px;">
        <div class="section-header-left">
          <div class="section-accent buynow"></div>
          <div>
            <div class="section-name">All Headlines (${articles.length}) <span class="section-chevron">&#9660;</span></div>
            <div class="section-desc">${bullish.length} bullish · ${bearish.length} bearish · ${neutral.length} neutral</div>
          </div>
        </div>
      </div>
      <div class="section-body">
        <div style="display:flex;gap:6px;margin-bottom:14px;">
          <button class="tab active" onclick="filterNews('all', this)">All (${articles.length})</button>
          <button class="tab" onclick="filterNews('bullish', this)">Bullish (${bullish.length})</button>
          <button class="tab" onclick="filterNews('bearish', this)">Bearish (${bearish.length})</button>
        </div>
        <div id="newsHeadlinesList" class="news-list">
          ${articles.slice(0, 20).map(renderNewsHeadlineCard).join("")}
        </div>
      </div>
    </div>
  `;

  container.innerHTML = html;
}

function renderNewsHeadlineCard(a) {
  const sentColor =
    a.sentiment === "bullish" ? "var(--green)" :
    a.sentiment === "bearish" ? "var(--red)" : "var(--text-muted)";
  const sentBg =
    a.sentiment === "bullish" ? "rgba(52,211,153,0.08)" :
    a.sentiment === "bearish" ? "rgba(248,113,113,0.08)" : "rgba(100,116,139,0.04)";

  return `
    <a class="news-item" href="${a.link || '#'}" target="_blank" rel="noopener" style="align-items:flex-start;">
      <div style="flex:1;">
        <div class="news-title">${escapeHtml(a.title)}</div>
        <div class="news-meta" style="margin-top:6px;">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${sentBg};color:${sentColor};font-size:10px;font-weight:700;text-transform:uppercase;">${a.sentiment}</span>
          <span>${escapeHtml(a.publisher || '')}</span>
          <span>${a.publishedAt ? timeAgo(a.publishedAt) : ''}</span>
        </div>
      </div>
    </a>`;
}

function filterNews(type, btn) {
  btn.parentElement.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");

  const listEl = document.getElementById("newsHeadlinesList");
  if (!listEl) return;

  const filtered = type === "all" ? allMarketNews : allMarketNews.filter((a) => a.sentiment === type);
  listEl.innerHTML = filtered.slice(0, 20).map(renderNewsHeadlineCard).join("");
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
  buynow_nifty100: "Buy Now (Nifty 100)",
  smallcap_buynow: "Small-Cap Buy Now",
  fundamental_deep_value: "Fundamental Deep Value",
};

async function loadTrackRecord(forceBust = false) {
  const filterEl = document.getElementById("trackFilter");
  const filterType = filterEl?.value && filterEl.value !== "all" ? filterEl.value : null;
  const url = `/api/track/history${filterType ? "?type=" + filterType : ""}${forceBust ? (filterType ? "&" : "?") + "bust=1" : ""}`;

  const tableEl = document.getElementById("trackHistoryTable");
  const updatedEl = document.getElementById("trackLastUpdated");

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.message && (!data.trades || data.trades.length === 0)) {
      // Empty state — no snapshots yet
      document.getElementById("trackTotalPicks").textContent = "0";
      document.getElementById("trackWinRate").textContent = "—";
      document.getElementById("trackAvgReturn").textContent = "—";
      document.getElementById("trackBeatsNifty").textContent = "—";
      document.getElementById("trackHistoryCount").textContent = "0 PICKS";
      document.getElementById("trackByTypeSection").innerHTML = "";
      document.getElementById("trackByRegimeSection").innerHTML = "";
      tableEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">&#128202;</div>
          <div class="empty-text">${escapeHtml(data.message)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
            Open the Market Scanner / Small-Cap / Fundamental tabs to trigger the first snapshots.<br>
            One snapshot per day per category is captured automatically.
          </div>
        </div>`;
      return;
    }

    // Headline metrics
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

    // Trade history table
    tableEl.innerHTML = renderTrackHistoryTable(data.trades);

    // Phase 8D: Portfolio vs Nifty line chart
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
      const winColor = perf.winRate >= 55 ? "#22c55e" : perf.winRate >= 45 ? "#eab308" : "#ef4444";
      const beatsColor = perf.beatsNiftyRate == null
        ? "var(--text-muted)"
        : perf.beatsNiftyRate >= 55 ? "#22c55e"
        : perf.beatsNiftyRate >= 45 ? "#eab308" : "#ef4444";
      const avgColor = perf.avgReturn >= 0 ? "#22c55e" : "#ef4444";
      return `
        <div style="display:grid;grid-template-columns:1fr auto auto auto auto;gap:14px;align-items:center;padding:10px 14px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);font-size:12px;">
          <div style="font-weight:700;">${escapeHtml(label)}</div>
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

  const rows = trades.map((t) => {
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
      <div onclick="loadStock('${t.symbol.replace('.NS', '')}')" style="display:grid;grid-template-columns:1fr 100px 90px 90px 90px 90px 70px;gap:12px;align-items:center;padding:10px 14px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);font-size:12px;cursor:pointer;transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.06)';" onmouseout="this.style.background='rgba(255,255,255,0.02)';">
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

  return `
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
        <div style="margin-top:10px;font-size:9px;color:var(--text-muted);text-align:right;">Stock + market composite · Not investment advice</div>
      </div>
    </div>`;
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

// ==================== SECTOR HEATMAP ====================

async function loadSectorHeatmap() {
  const container = document.getElementById("sectorHeatmapContent");
  const badge = document.getElementById("marketBreadthBadge");
  if (!container) return;

  try {
    const res = await fetch("/api/sector-heatmap");
    const data = await res.json();

    if (!data.sectors || data.sectors.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">&#127777;</div><div class="empty-text">Sector data loading...</div></div>`;
      return;
    }

    // Update badge with market breadth
    const mb = data.marketBreadth || {};
    if (badge) {
      const adv = mb.advancing || 0;
      const dec = mb.declining || 0;
      badge.textContent = `${adv} ↑ ${dec} ↓`;
      badge.style.background = adv > dec ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)";
      badge.style.color = adv > dec ? "var(--green)" : "var(--red)";
    }

    const heatmapRows = data.sectors.map((s) => {
      const isPos = s.avgChange >= 0;
      const barWidth = Math.min(100, Math.abs(s.avgChange) * 20); // scale: 5% = full bar
      const barColor = isPos ? "var(--green)" : "var(--red)";
      return `
        <div style="display:grid;grid-template-columns:120px 1fr 70px 70px;gap:10px;align-items:center;padding:8px 12px;border-radius:8px;background:rgba(255,255,255,0.02);border:1px solid var(--border-soft);font-size:12px;">
          <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.sector)}</div>
          <div style="height:6px;background:rgba(255,255,255,0.04);border-radius:3px;overflow:hidden;">
            <div style="width:${barWidth}%;height:100%;background:${barColor};border-radius:3px;${!isPos ? 'margin-left:auto;' : ''}"></div>
          </div>
          <div style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${barColor};text-align:right;">${isPos ? '+' : ''}${s.avgChange}%</div>
          <div style="font-size:10px;color:var(--text-muted);text-align:right;">${s.winners}↑ ${s.losers}↓</div>
        </div>`;
    }).join("");

    // FII/DII row (loaded separately). Uses the normalised {fii, dii}
    // shape from /api/fii-dii — each row is an object with buyValue,
    // sellValue, netValue in ₹Cr plus the trading date. We show the
    // net number because that's what traders watch: a negative FII
    // net-value is a headwind for the next 2–5 sessions.
    let fiiDiiRow = "";
    try {
      const fiiRes = await fetch("/api/fii-dii");
      const fiiData = await fiiRes.json();
      if (fiiData.available && (fiiData.fii || fiiData.dii)) {
        const fmtCr = (v) => {
          if (v == null || !Number.isFinite(v)) return "N/A";
          const sign = v > 0 ? "+" : "";
          // Inputs are already in ₹Cr, so just format with 1 decimal + comma
          return `${sign}${v.toLocaleString("en-IN", { maximumFractionDigits: 1 })}`;
        };
        const pill = (label, row) => {
          if (!row) return "";
          const net = row.netValue;
          const isPos = net != null && net >= 0;
          const color = net == null ? "var(--text-muted)" : isPos ? "var(--green)" : "var(--red)";
          return `
            <div style="flex:1;min-width:150px;padding:10px 12px;background:rgba(255,255,255,0.025);border:1px solid var(--border-soft);border-radius:8px;">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:700;">${label}</div>
              <div style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:700;color:${color};margin:2px 0;">
                ${fmtCr(net)} <span style="font-size:11px;color:var(--text-muted);font-weight:500;">₹Cr net</span>
              </div>
              <div style="font-size:10px;color:var(--text-muted);font-family:'JetBrains Mono',monospace;">
                Buy ${fmtCr(row.buyValue)} · Sell ${fmtCr(row.sellValue)}
              </div>
            </div>`;
        };
        const dateLabel = fiiData.date ? `for ${escapeHtml(fiiData.date)}` : "";
        fiiDiiRow = `
          <div style="margin-top:14px;padding:12px 14px;background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.2);border-radius:10px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);font-weight:700;margin-bottom:10px;">
              FII / DII Activity ${dateLabel}${infoIcon('macro_regime')}
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              ${pill("FII / FPI", fiiData.fii)}
              ${pill("DII", fiiData.dii)}
            </div>
          </div>`;
      } else {
        // Honest fallback — the endpoint is genuinely unreachable or the
        // data hasn't been published yet (NSE publishes ~18:30 IST).
        const msg = escapeHtml(fiiData.message || "FII/DII data temporarily unavailable from NSE.");
        fiiDiiRow = `
          <div style="margin-top:14px;padding:10px 14px;background:rgba(255,255,255,0.02);border:1px solid var(--border-soft);border-radius:8px;font-size:11px;color:var(--text-muted);">
            ${msg}
          </div>`;
      }
    } catch { /* silent */ }

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;">${heatmapRows}</div>
      ${fiiDiiRow}
    `;
  } catch (err) {
    container.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:12px;">Sector data unavailable.</div>`;
  }
}

// ==================== WATCHLIST ====================

async function loadWatchlistState() {
  try {
    const res = await fetch("/api/watchlist");
    const data = await res.json();
    watchlist = new Set((data.stocks || []).map((s) => s.symbol));
  } catch { /* silent */ }
}

async function toggleWatchlist(symbol, name, sector) {
  const action = watchlist.has(symbol) ? "remove" : "add";
  try {
    await fetch(`/api/watchlist/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, name, sector }),
    });
    if (action === "add") watchlist.add(symbol);
    else watchlist.delete(symbol);
    // Update the star icon + aria-pressed state if visible
    const btn = document.querySelector(`[data-watchlist-symbol="${symbol}"]`);
    if (btn) {
      const saved = watchlist.has(symbol);
      btn.textContent = saved ? "★" : "☆";
      btn.setAttribute("aria-pressed", String(saved));
      btn.style.color = saved ? "var(--gold)" : "var(--text-muted)";
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
  const engineToggle = document.getElementById("useSWSEngine");
  const freshCapitalWrap = document.getElementById("analyzerEngineFreshCapital");

  if (engineToggle) {
    const saved = localStorage.getItem("analyzer_engine");
    engineToggle.checked = saved !== "legacy";
    if (freshCapitalWrap) freshCapitalWrap.style.display = engineToggle.checked ? "flex" : "none";
    engineToggle.addEventListener("change", () => {
      localStorage.setItem("analyzer_engine", engineToggle.checked ? "sws" : "legacy");
      if (freshCapitalWrap) freshCapitalWrap.style.display = engineToggle.checked ? "flex" : "none";
    });
  }

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
  const engineToggle = document.getElementById("useSWSEngine");
  const useSws = !!(engineToggle && engineToggle.checked);
  document.getElementById("analyzerProgressText").textContent = useSws
    ? `Scoring ${file.name} via SWS Engine…`
    : `Analyzing ${file.name}…`;

  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("taxSlabPct", String(_optimizerState.taxSlabPct));
    fd.append("preset", _optimizerState.preset);
    if (useSws) {
      fd.append("engine", "sws");
      const fresh = Number(document.getElementById("analyzerFreshCapital")?.value || 0);
      if (Number.isFinite(fresh) && fresh > 0) fd.append("freshCapitalInr", String(fresh));
    }
    const res = await fetch("/api/portfolio/analyze", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error + (data.hint ? `\n\nHint: ${data.hint}` : ""));
    }
    _optimizerState.sessionId = data.sessionId || data.report?.optimizer?.sessionId || null;
    _optimizerState.optimizer = data.report?.optimizer || null;
    if (data.report?.engine === "sws") {
      renderSWSAnalyzerReport(data.report, data.elapsedMs);
    } else {
      renderAnalyzerReport(data.report, data.elapsedMs);
    }
    setAnalyzerState("report");
  } catch (err) {
    setAnalyzerState("upload");
    errEl.textContent = err.message;
    errEl.style.display = "block";
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

const ANALYZER_ACTION_COLORS = {
  CUT_LOSS:     { bg: "rgba(220,38,38,0.15)",  border: "rgba(220,38,38,0.5)",  text: "#fca5a5" },
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

const SWS_ACTION_COLORS = {
  "EXIT":              { bg: "rgba(220,38,38,0.18)", border: "rgba(220,38,38,0.55)", text: "#fca5a5" },
  "Reduction-50%":     { bg: "rgba(239,68,68,0.14)", border: "rgba(239,68,68,0.45)", text: "#f87171" },
  "Reduction-25-33%":  { bg: "rgba(250,204,21,0.14)", border: "rgba(250,204,21,0.4)", text: "#fde047" },
  "HOLD":              { bg: "rgba(59,130,246,0.12)", border: "rgba(59,130,246,0.35)", text: "#93c5fd" },
  "Top-up-modest":     { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.4)",   text: "#86efac" },
  "Top-up":            { bg: "rgba(34,197,94,0.18)",  border: "rgba(34,197,94,0.6)",   text: "#86efac" },
  "STRONG Top-up":     { bg: "rgba(34,197,94,0.25)",  border: "rgba(34,197,94,0.7)",   text: "#bbf7d0" },
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
  };
  const c = colors[timing.verdict] || colors["Yes-not-urgent"];
  const window = timing.window ? ` · ${timing.window}` : "";
  return `<span title="${swsEscapeAttr(timing.reason || "")}" style="display:inline-block; padding:2px 8px; border-radius:3px; background:${c.bg}; color:${c.text}; font-size:10px; font-weight:600; letter-spacing:0.2px;">${timing.verdict}${window}</span>`;
}

function swsEscapeAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function swsKpiCard(label, valueHtml) {
  return `<div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; padding:12px 14px;">
    <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px;">${label}</div>
    <div style="font-size:18px; font-weight:700;">${valueHtml}</div>
  </div>`;
}

function swsHoldingRow(h) {
  const sws = h.sws || {};
  const tk = sws.ticker || h.symbol || "—";
  const name = sws.name || h.name || "";
  const v2 = sws.v2_score != null ? sws.v2_score : "—";
  const verdict = sws.verdict || "—";
  const cv = h.currentValue;
  const pos = h.positionWeight != null ? h.positionWeight + "%" : "—";
  const pnlPct = h.pnlPercent;
  return `<tr style="border-top:1px solid #2a3349; cursor:pointer;" onclick="loadStock('${tk}.NS')">
    <td style="padding:10px 12px;">
      <div style="font-weight:600;">${tk}</div>
      <div style="font-size:11px; color:var(--text-muted);">${swsEscapeAttr(name)}${sws.sector ? " · " + swsEscapeAttr(sws.sector) : ""}</div>
    </td>
    <td style="padding:10px 12px;">${swsActionBadge(h.action)}</td>
    <td style="padding:10px 12px;">
      <div style="font-weight:600;">${v2}</div>
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

function swsReasonRow(h) {
  if (!h.reasons || h.reasons.length === 0) return "";
  const tk = h.sws?.ticker || h.symbol || "—";
  return `<details style="margin-top:8px; background:rgba(255,255,255,0.02); border:1px solid #1f2937; border-radius:6px; padding:8px 12px;">
    <summary style="cursor:pointer; font-size:12px; color:var(--text-muted);"><strong style="color:var(--text);">${tk}</strong> · why this action</summary>
    <ul style="margin:8px 0 0 0; padding-left:20px; font-size:12px; line-height:1.6;">
      ${h.reasons.map(r => `<li>${swsEscapeAttr(r)}</li>`).join("")}
    </ul>
    ${h.timing && h.timing.reason ? `<div style="margin-top:6px; font-size:11px; color:var(--text-muted); padding:6px 10px; background:rgba(0,0,0,0.2); border-radius:4px;"><strong>Timing:</strong> ${swsEscapeAttr(h.timing.reason)}</div>` : ""}
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
            <th style="padding:10px 12px;">v2 score</th>
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

function swsBasketRow(r) {
  const upside = r.upside_pct != null ? `<span style="color:${r.upside_pct >= 0 ? '#86efac' : '#f87171'};">${r.upside_pct >= 0 ? '+' : ''}${r.upside_pct.toFixed(1)}%</span>` : "—";
  const sourceTag = r.source === "holding"
    ? `<span title="In-portfolio top-up" style="font-size:9px; padding:1px 6px; background:rgba(34,197,94,0.12); color:#86efac; border-radius:3px; letter-spacing:0.3px;">HELD</span>`
    : `<span title="Outside-portfolio fresh pick" style="font-size:9px; padding:1px 6px; background:rgba(59,130,246,0.12); color:#93c5fd; border-radius:3px; letter-spacing:0.3px;">FRESH</span>`;
  const suggested = r.suggested_inr ? `<div style="font-size:10px; color:var(--text-muted);">Suggested ${inr(r.suggested_inr)}</div>` : "";
  return `<div style="padding:10px 14px; border-bottom:1px solid #1a2238; cursor:pointer;" onclick="loadStock('${r.ticker}.NS')">
    <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <strong style="font-size:13px;">${r.ticker}</strong>
        ${sourceTag}
      </div>
      <div style="font-size:11px; color:var(--text-muted); font-weight:600;">v2 ${r.v2_score ?? "—"}</div>
    </div>
    <div style="margin-top:4px; font-size:11px; color:var(--text-muted); display:flex; gap:10px; flex-wrap:wrap;">
      <span>${swsEscapeAttr(r.sector || "—")}</span>
      <span>${swsSnowflakeMini(r.snowflake)}</span>
    </div>
    <div style="margin-top:4px; display:flex; justify-content:space-between; gap:8px; font-size:11px;">
      <span>FV: ${upside}</span>
      <span style="color:var(--text-muted);">P/E ${r.multiples?.pe?.toFixed?.(1) ?? "—"}x · Yield ${r.dividend_yield_pct?.toFixed?.(1) ?? "—"}%</span>
    </div>
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

function renderSWSTierB(baskets) {
  const def = baskets.defensive || [];
  const grw = baskets.growth || [];
  const core = baskets.core || [];
  if (def.length === 0 && grw.length === 0 && core.length === 0) {
    return `<div style="margin-bottom:22px;">
      <div style="font-size:13px; font-weight:700; margin-bottom:8px; color:var(--text-muted);">Tier B · Top-ups</div>
      <div style="background:var(--panel); border:1px solid #2a3349; border-radius:8px; padding:14px; font-size:12px; color:var(--text-muted);">No qualifying top-ups in current snapshot. Picks-latest may need refresh.</div>
    </div>`;
  }
  return `<div style="margin-bottom:24px;">
    <div style="display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px;">
      <div style="font-size:14px; font-weight:700;">Tier B · Top-ups <span style="color:var(--text-muted); font-size:12px; font-weight:500;">(Two baskets + shared Core)</span></div>
      <div style="font-size:11px; color:var(--text-muted);">In-portfolio top-ups + outside fresh picks · 65/35 split</div>
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:14px;">
      ${swsBasketCard("Defensive", "Health ≥5 · Div ≥3 · Beta &lt;0.7", def, "#86efac")}
      ${swsBasketCard("Growth", "Future ≥4 · Upside ≥15% · QG/DV", grw, "#93c5fd")}
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
        return `<div style="padding:8px 14px; border-top:${i > 0 ? '1px solid #1a2238' : 'none'}; display:flex; justify-content:space-between; align-items:center; gap:10px; cursor:pointer;" onclick="loadStock('${sws.ticker}.NS')">
          <div>
            <strong style="font-size:13px;">${sws.ticker}</strong>
            <span style="font-size:11px; color:var(--text-muted); margin-left:8px;">${swsEscapeAttr(sws.name || "")} · ${swsEscapeAttr(sws.sector || "—")}</span>
          </div>
          <div style="display:flex; align-items:center; gap:10px; font-size:11px;">
            <span>v2 <strong>${sws.v2_score ?? "—"}</strong></span>
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
            <div style="font-size:11px; color:var(--text-muted);">${h.swsCovered === false ? '<span style="padding:2px 6px; background:rgba(107,114,128,0.15); border-radius:3px;">No SWS data</span>' : `v2 ${sws.v2_score ?? "—"}`}</div>
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
            <th style="padding:8px 12px; text-align:right;">Avg v2</th>
            <th style="padding:8px 12px;">Holdings</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(s => `<tr style="border-top:1px solid #1a2238;">
            <td style="padding:8px 12px; font-weight:600;">${swsEscapeAttr(s.sector)}</td>
            <td style="padding:8px 12px; text-align:right; font-weight:600;">${s.pct}%</td>
            <td style="padding:8px 12px; text-align:right; color:var(--text-muted);">${s.avgSnowflake ?? "—"}</td>
            <td style="padding:8px 12px; text-align:right; color:var(--text-muted);">${s.avgV2 ?? "—"}</td>
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

function renderSWSAnalyzerReport(report, elapsedMs) {
  const root = document.getElementById("analyzerReport");
  if (!root) return;

  const snap = report.snapshot || {};
  const banner = report.banner || {};
  const tiers = report.tiers || {};
  const baskets = tiers.B?.baskets || {};
  const sectorOverlay = report.sectorOverlay || [];

  const snapshotAt = banner.snapshot_at ? new Date(banner.snapshot_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
  const elapsed = elapsedMs != null ? `${elapsedMs}ms` : "—";

  root.innerHTML = `
    <div style="background:linear-gradient(135deg, rgba(59,130,246,0.08), rgba(34,197,94,0.04)); border:1px solid rgba(59,130,246,0.25); border-radius:10px; padding:14px 18px; margin-bottom:18px; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap;">
      <div>
        <div style="font-size:14px; font-weight:700; color:#93c5fd;">${banner.engine || "SWS Engine (Beta)"}</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
          Snapshot: ${snapshotAt} · ${swsEscapeAttr(banner.coverage_text || "")} · scored in ${elapsed}
        </div>
      </div>
      <button onclick="resetAnalyzer()" style="background:transparent; border:1px solid #2a3349; color:var(--text); padding:6px 14px; border-radius:6px; cursor:pointer; font-size:12px;">Re-upload</button>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:18px;">
      ${swsKpiCard("Invested", inr(snap.totalInvested))}
      ${swsKpiCard("Current value", inr(snap.totalCurrent))}
      ${swsKpiCard("Net P&amp;L", `<span style="color:${pctColor(snap.totalPnLPct)}">${inr(snap.totalPnL)} (${snap.totalPnLPct ?? 0}%)</span>`)}
      ${swsKpiCard("Avg Snowflake", `${snap.avgSnowflake ?? "—"}<span style="color:var(--text-muted); font-size:12px;">/30</span>`)}
      ${swsKpiCard("Avg v2 score", `${snap.avgV2Score ?? "—"}<span style="color:var(--text-muted); font-size:12px;">/100</span>`)}
      ${swsKpiCard("Holdings", `${snap.holdingsCount} <span style="color:var(--text-muted); font-size:12px;">(${snap.coveredCount} SWS-covered)</span>`)}
    </div>

    <div style="background:var(--panel); border:1px solid #2a3349; border-radius:10px; padding:14px 18px; margin-bottom:18px;">
      <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px;">Action mix</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        ${Object.entries(snap.actionMix || {}).map(([action, n]) => `
          ${swsActionBadge(action)}
          <span style="font-size:13px; color:var(--text-muted); margin-right:8px;">×${n}</span>
        `).join("")}
      </div>
    </div>

    ${renderSWSTierA(tiers.A)}
    ${renderSWSTierB(baskets)}
    ${renderSWSTierC(tiers.C)}
    ${renderSWSTierD(tiers.D)}
    ${renderSWSSectorOverlay(sectorOverlay)}
    ${renderSWSMfSection(report.mfPositions)}

    <div style="background:rgba(250,204,21,0.05); border:1px solid rgba(250,204,21,0.15); border-radius:8px; padding:12px 16px; margin-top:24px; font-size:11px; color:#fde047; line-height:1.6;">
      ${swsEscapeAttr(report.disclaimer || "")}
    </div>
  `;
}

function renderAnalyzerReport(report, elapsedMs) {
  renderAnalyzerSummary(report, elapsedMs);
  renderAnalyzerPortfolioActions(report);
  // Priority 3 + 2: render risk-profile card + asset-allocation gap card
  // BEFORE the per-fund grid. SEBI-RAs lead with allocation, then drill
  // into individual funds.
  renderAnalyzerRiskProfile(report.mfPositions?.riskProfile);
  renderAnalyzerAssetAllocation(report.mfPositions?.assetAllocation, report.mfPositions?.riskProfile);
  renderAnalyzerMfPositions(report.mfPositions);
  renderAnalyzerRiskBlock(report);
  renderAnalyzerOptimizer(report.optimizer);
  renderAnalyzerUrgent(report);
  renderAnalyzerHoldings(report);
  renderAnalyzerUnmatched(report);
  renderAnalyzerDisclaimer(report);
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
  const text = "Educational · not advice";
  const style = mode === "inline"
    ? "display:inline-block; font-size:9px; font-weight:700; padding:2px 6px; margin-left:8px; border-radius:3px; background:rgba(250,204,21,0.10); color:#fde047; letter-spacing:0.4px; border:1px solid rgba(250,204,21,0.25); text-transform:uppercase; vertical-align:middle;"
    : "display:inline-block; font-size:10px; font-weight:700; padding:3px 8px; border-radius:4px; background:rgba(250,204,21,0.08); color:#fde047; letter-spacing:0.4px; border:1px solid rgba(250,204,21,0.2); text-transform:uppercase;";
  return `<span style="${style}" title="StarBhai is not a SEBI-registered investment adviser. This is educational research — signals and observations, not personalised investment advice.">${text}</span>`;
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
// re-runs renderAnalyzerReport with the latest report.
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
  { key: "midterm", term_id: "section_midterm", emoji: "⚡", label: "⚡ Midterm Picks (3-12 months)", chip_label: "Midterm", subtitle: "Trend-following — momentum already on side, with FV upside ≥ 15% remaining." },
  { key: "dividend_aristocrats", term_id: "section_dividend_aristocrats", emoji: "💰", label: "💰 Dividend Aristocrats", chip_label: "Dividend", subtitle: "Sustainable payers: Dividend pillar ≥ 5, payout < 70%, yield ≥ 1.5%." },
  { key: "smallcap_gems", term_id: "section_smallcap_gems", emoji: "🔍", label: "🔍 Smallcap/Midcap Hidden Gems", chip_label: "Smallcap Gems", subtitle: "Smaller-cap quality: mcap < ₹50,000cr + Snowflake ≥ 22 + upside ≥ 15%." },
  { key: "insider_buying", term_id: "section_insider_buying", emoji: "👁", label: "👁 Insider Buying", chip_label: "Insider", subtitle: "Material insider / MD buys in last 90 days. Data field not yet captured." },
  { key: "upcoming_earnings", term_id: "section_upcoming_earnings", emoji: "📅", label: "📅 Upcoming Earnings (next 30 days)", chip_label: "Earnings", subtitle: "Catalyst calendar — sorted by results date. Avoid initiating right before; useful pre-results setups for holdings." },
  { key: "avoid", term_id: "section_avoid", emoji: "⚠", label: "⚠ Avoid List", chip_label: "Avoid", subtitle: "v3 AVOID — cross-check against your portfolio every refresh." },
];

// Per-section soft cap on cards displayed inline. The Top-30 section gets
// its full 30; everything else stays at 12 (with a "more" hint). Upcoming
// earnings is the worst offender today (156 entries) — capping at 30 keeps
// the page actionable.
const PICKS_INLINE_CAP = {
  top_ranked_30_v3: 30,
  upcoming_earnings: 30,
};
const PICKS_INLINE_DEFAULT_CAP = 12;

let picksStatusPollTimer = null;

async function loadPicks() {
  const containerEl = document.getElementById("picksContainer");
  const metaEl = document.getElementById("picksMeta");
  containerEl.innerHTML = `<div class="loading"><div class="loading-spinner"></div><div class="loading-text">Loading picks…</div></div>`;

  try {
    const res = await fetch("/api/sws-picks");
    if (res.status === 404) {
      containerEl.innerHTML = renderPicksEmptyState();
      metaEl.textContent = "No scan run yet";
      pollPicksStatus(); // still useful — show scan progress if a scan is currently running
      return;
    }
    const data = await res.json();
    renderPicks(data);
    metaEl.textContent = `Scanned ${new Date(data.scanned_at).toLocaleString()} · ${data.scored_count} stocks scored · ${data.failed_count} failed (in retry)`;
    pollPicksStatus();
  } catch (e) {
    containerEl.innerHTML = `<div style="padding:24px;color:var(--red);">Failed to load picks: ${e.message}</div>`;
  }
}

function renderPicksEmptyState() {
  return `
    <div style="padding:32px; border:1px dashed #2a3550; border-radius:8px; text-align:center;">
      <h3 style="margin-top:0;color:var(--text-primary);">No SWS scan has been run yet</h3>
      <p style="color:var(--text-muted); margin:12px 0 20px 0; max-width:680px; margin-left:auto; margin-right:auto;">
        Click <strong>Quick refresh</strong> or <strong>Full refresh</strong> above to start. The scan is driven by 3 parallel Claude sessions
        scraping every NSE/BSE listing on Simply Wall Street with built-in subscription protection (rate caps, jitter, panic-stop on any block signal).
        Wall-clock: ~5 hrs for Quick, ~3 days for Full. The data file lives at <code>data/sws/picks-latest.json</code>.
      </p>
      <p style="color:var(--text-muted); font-size:12px;">
        After clicking, open 3 terminal windows, run <code>claude</code>, then <code>/sws-scan-shard 1</code> / <code>2</code> / <code>3</code>.
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

function renderPicksChipNav(visibleSections, collapsedState) {
  const chips = visibleSections.map(({ section, items }) => {
    const isCollapsed = isPicksSectionCollapsed(collapsedState, section.key);
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

  // Filter once so chip-nav and the section list stay in sync.
  const visibleSections = [];
  let totalShown = 0;
  for (const section of PICKS_SECTIONS) {
    const items = (data.sections && data.sections[section.key]) || [];
    if (items.length === 0) continue;
    visibleSections.push({ section, items });
    totalShown += items.length;
  }

  if (!totalShown) {
    containerEl.innerHTML = `<div style="padding:24px;color:var(--text-muted);">Scan completed but no stocks matched any section filters. Check thresholds in scripts/sws-scoring.mjs.</div>`;
    return;
  }

  const chipNav = renderPicksChipNav(visibleSections, collapsedState);

  const sectionsHtml = visibleSections.map(({ section, items }) => {
    const cap = PICKS_INLINE_CAP[section.key] ?? PICKS_INLINE_DEFAULT_CAP;
    const sliced = items.slice(0, cap);
    const overflow = items.length > cap ? items.length - cap : 0;
    const isHero = section.key === "top_ranked_30_v3";
    const isCollapsed = isPicksSectionCollapsed(collapsedState, section.key);
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
          ${overflow ? `<div class="sws-pick-overflow">… and ${overflow} more · refine filters or open the PDF for the full list</div>` : ""}
        </div>
      </div>`;
  }).join("");

  containerEl.innerHTML = chipNav + sectionsHtml;
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

function renderPickCard(s, sectionKey, rank = null) {
  const fmtInr = (v) => v == null ? "—" : v >= 1e12 ? `₹${(v / 1e12).toFixed(2)}t` : v >= 1e9 ? `₹${(v / 1e9).toFixed(1)}b` : v >= 1e7 ? `₹${(v / 1e7).toFixed(0)}cr` : `₹${v.toLocaleString("en-IN")}`;
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
  // Prefer v3_verdict (TOP_PICK/STRONG/ACCEPTABLE/WATCH/AVOID) when v3 is the
  // headline score; fall back to v1's verdict labels for stocks scored only
  // under v1/v2.
  const verdict = (s.v3_score_100 != null ? s.v3_verdict : s.verdict) || "—";
  const verdictColor = {
    TOP_PICK: "var(--gold)", STRONG: "var(--green)", ACCEPTABLE: "var(--cyan)", WATCH: "var(--text-muted)", AVOID: "var(--red)",
    DEEP_VALUE: "var(--gold)", QUALITY_GROWTH: "var(--green)", FAIR_VALUE: "var(--cyan)", FULLY_VALUED: "var(--text-muted)", OVERVALUED: "var(--red)",
  }[verdict] || "var(--text-muted)";
  const verdictTermId = verdictIdFromLabel(verdict);
  const surv = s.v2_breakdown?.surveillance;
  // Surveillance badge — when a flag is present, hook it to the glossary.
  // Native title is preserved as a fallback for keyboard-only users; the
  // delegated tooltip handler kicks in on hover/click via data-term-id.
  const survBadge = surv
    ? `<span class="sws-surveillance-badge" data-term-id="nse_surveillance" tabindex="0" role="button" aria-label="NSE surveillance flag" title="NSE ${surv.list} surveillance flag (${surv.timeframe || "—"})">${surv.list}</span>`
    : "";
  const rankBadge = rank ? `<span class="sws-pick-rank">${rank}</span>` : "";
  const fresh = pickFreshnessPill(s.data_freshness_at);

  let extraRow = "";
  if (sectionKey === "upcoming_earnings" && s.next_earnings_date) {
    const d = s.days_until == null ? "?" : `${s.days_until}d`;
    const lqr = s.last_quarter_result ? `last Q: ${s.last_quarter_result}` : "";
    extraRow = `<div class="sws-pick-earnings-row">📅 ${s.next_earnings_date} (${d}) ${lqr ? "· " + lqr : ""}</div>`;
  }

  // Card click is routed through handlePickCardClick, which ignores clicks
  // landing on info icons / glossary terms / embedded links so the tooltip
  // and external link behaviors aren't preempted by the modal trigger.
  const safeTicker = String(s.ticker || "").replace(/[^A-Z0-9&\-]/gi, "");
  return `
    <div class="stock-card sws-pick-card" tabindex="0" role="button" aria-label="Open detail for ${safeTicker}"
         data-ticker="${safeTicker}"
         onclick="handlePickCardClick(event, '${safeTicker}')"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openSwsModal('${safeTicker}');}">
      <div class="sws-pick-card-top">
        <div class="sws-pick-card-id">
          ${rankBadge}
          <div class="sws-pick-card-id-text">
            <div class="sws-pick-card-ticker">${s.ticker}${survBadge}${s.sector ? `<span class="sws-pick-card-sector">${escapeHtml(s.sector)}</span>` : ""}</div>
            <div class="sws-pick-card-name">${s.name || ""}${fresh}</div>
          </div>
        </div>
        <div class="sws-pick-card-score">
          <div class="sws-pick-card-score-num" style="color:${scoreColor};">${score}${infoIcon(scoreTermId)}</div>
          <div class="sws-pick-card-score-verdict" style="color:${verdictColor};">${verdict.replace(/_/g, " ")}${verdictTermId ? infoIcon(verdictTermId) : ""}</div>
        </div>
      </div>
      <div class="sws-pick-card-stats">
        <div class="sws-pick-stat"><span class="sws-pick-stat-label">Px</span> ${fmtInr(s.current_price_inr)}</div>
        <div class="sws-pick-stat"><span class="sws-pick-stat-label">FV${infoIcon("analyst_fair_value")}</span> ${fmtInr(s.fair_value_inr)}</div>
        <div class="sws-pick-stat" style="color:${upsideColor};">${upside}${infoIcon("upside_pct")}</div>
        <div class="sws-pick-stat sws-pick-stat-snow"><span class="sws-pick-stat-label">Snow${infoIcon("snowflake_score")}</span> ${sn}/30</div>
      </div>
      <div class="sws-pick-card-narrative">${(s.narrative && s.narrative.card_one_line) || s.one_line || ""}</div>
      ${extraRow}
      ${s.sws_url ? `<div class="sws-pick-card-link"><a href="${s.sws_url}" target="_blank" rel="noopener" onclick="event.stopPropagation();">Open on SWS →</a></div>` : ""}
    </div>`;
}

async function triggerSwsRefresh(mode) {
  const endpoint = mode === "quick" ? "/api/sws-refresh/quick"
                : mode === "earnings" ? "/api/sws-refresh/earnings"
                : "/api/sws-refresh/full";
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" } });
    const data = await res.json();
    showPicksBanner("queued", `Refresh queued. ${data.next_step || ""}`);
    pollPicksStatus();
  } catch (e) {
    showPicksBanner("error", `Failed to queue refresh: ${e.message}`);
  }
}

function downloadSwsPdf() {
  window.open("/api/sws-pdf/latest", "_blank");
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
    // Lazy-fetch live overlay (tech + news + recommendation) so the SWS card
    // shows immediately and live data fills in afterwards.
    fetchAndRenderSwsLiveOverlay(ticker);
  } catch (e) {
    body.innerHTML = `<div style="padding:40px 20px;color:var(--red);">Network error: ${e.message}</div>`;
  }
}

function closeSwsModal() {
  const backdrop = document.getElementById("swsModalBackdrop");
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
    const backdrop = document.getElementById("swsModalBackdrop");
    if (backdrop && backdrop.classList.contains("open")) closeSwsModal();
  }
});

function renderSwsModal(data) {
  const { ticker, deep, card, surveillance, file_mtime } = data;
  const ov = (deep && deep.overview) || {};
  const card_ = card || {};
  const fmtInr = (v) => v == null ? "—" : v >= 1e12 ? `₹${(v / 1e12).toFixed(2)}t` : v >= 1e9 ? `₹${(v / 1e9).toFixed(1)}b` : v >= 1e7 ? `₹${(v / 1e7).toFixed(0)}cr` : `₹${v.toLocaleString("en-IN")}`;
  const fmtPct = (v, d = 2) => v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(d)}%`;
  const headlineRaw = card_.v3_score_100 != null ? card_.v3_score_100 : (card_.v2_score != null ? card_.v2_score : card_.score);
  const score = headlineRaw != null ? headlineRaw.toFixed(1) : "—";
  const scoreColor = pickScoreColor(headlineRaw);
  const scoreLabel = card_.v3_score_100 != null ? "v3" : (card_.v2_score != null ? "v2" : "score");
  const verdict = (card_.v3_score_100 != null ? card_.v3_verdict : card_.verdict) || "—";
  const verdictColor = {
    TOP_PICK: "var(--gold)", STRONG: "var(--green)", ACCEPTABLE: "var(--cyan)", WATCH: "var(--text-muted)", AVOID: "var(--red)",
    DEEP_VALUE: "var(--gold)", QUALITY_GROWTH: "var(--green)", FAIR_VALUE: "var(--cyan)", FULLY_VALUED: "var(--text-muted)", OVERVALUED: "var(--red)",
  }[verdict] || "var(--text-muted)";
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
    const ownNetMargin = ov.net_margin_pct != null ? ov.net_margin_pct / 100 : null;
    const ownPe = mult.pe;
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

  // Quick stats
  const pastPerf = (deep && deep.past_performance) || {};
  const finHealth = (deep && deep.financial_health) || {};
  const ownership = (deep && deep.ownership) || {};
  const mgmt = (deep && deep.management) || {};
  const stats = [
    ["P/E", mult.pe != null ? `${mult.pe.toFixed(1)}x` : "—"],
    ["P/B", mult.pb != null ? `${mult.pb.toFixed(2)}x` : "—"],
    ["P/S", mult.ps != null ? `${mult.ps.toFixed(1)}x` : "—"],
    ["EPS", ov.eps != null ? `₹${ov.eps.toFixed(2)}` : "—"],
    ["ROE", pastPerf.roe_pct != null ? `${pastPerf.roe_pct.toFixed(1)}%` : "—"],
    ["ROCE", pastPerf.roce_pct != null ? `${pastPerf.roce_pct.toFixed(1)}%` : "—"],
    ["D/E", ov.debt_to_equity_pct != null ? `${ov.debt_to_equity_pct.toFixed(1)}%` : "—"],
    ["Debt cover", finHealth.debt_cover_pct != null ? `${finHealth.debt_cover_pct.toFixed(1)}%` : "—"],
    ["Interest cover", finHealth.interest_cover_x != null ? `${finHealth.interest_cover_x.toFixed(1)}x` : "—"],
    ["Net margin", ov.net_margin_pct != null ? `${ov.net_margin_pct.toFixed(1)}%` : "—"],
    ["Beta", ov.beta != null ? ov.beta.toFixed(2) : "—"],
    ["Div yield", ov.dividend?.yield_pct != null ? `${ov.dividend.yield_pct.toFixed(2)}%` : "—"],
    ["Payout", ov.dividend?.payout_pct != null ? `${ov.dividend.payout_pct.toFixed(0)}%` : "—"],
    ["Insider %", ownership.insider_pct != null ? `${ownership.insider_pct.toFixed(1)}%` : "—"],
    ["CEO tenure", mgmt.ceo_tenure_years != null ? `${mgmt.ceo_tenure_years.toFixed(1)} yr` : "—"],
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

  // Catalysts
  const revisions = ov.recent_analyst_revisions || [];
  const insiders = ov.insider_activity || [];
  const catalystHtml = (ov.next_earnings_date || revisions.length || insiders.length) ? `
    <div class="sws-modal-section">
      <h4>Catalysts &amp; activity</h4>
      <div style="font-size:12px;line-height:1.6;color:var(--text-primary);">
        ${ov.next_earnings_date ? `<div>📅 Next earnings: <strong>${ov.next_earnings_date}</strong>${ov.last_quarter_result ? ` · last quarter: <span style="color:${ov.last_quarter_result === "beat" ? "var(--green)" : "var(--red)"};">${ov.last_quarter_result}</span>` : ""}</div>` : ""}
        ${revisions.length ? `<div style="margin-top:6px;">📊 Recent analyst revisions: ${revisions.map((r) => `${r.direction === "increased" ? "↑" : "↓"} ${r.pct}% to ₹${r.new_target_inr} (${r.date})`).join(" · ")}</div>` : ""}
        ${insiders.length ? `<div style="margin-top:6px;">👁 Insider activity: ${insiders.length} event(s)</div>` : ""}
      </div>
    </div>` : "";

  // Live overlay placeholder (filled by fetchAndRenderSwsLiveOverlay)
  const livePlaceholder = `
    <div class="sws-modal-section" id="swsModalLiveOverlay">
      <h4>Live signals (technicals · news · regulatory)</h4>
      <div style="font-size:11px;color:var(--text-muted);">Loading live engine…</div>
    </div>`;

  return `
    <div class="sws-modal-hero">
      <div style="flex:1;min-width:0;">
        <h2 id="swsModalTitle">${ticker}${survBadge}</h2>
        <div style="font-size:13px;color:var(--text-muted);">${escapeHtml(card_.name || ticker)}${card_.sector ? ` · ${escapeHtml(card_.sector)}` : ""}${fresh}</div>
        <div style="display:flex;gap:14px;margin-top:10px;font-size:12px;flex-wrap:wrap;">
          <div><span style="color:var(--text-muted);">Price</span> ${fmtInr(ov.current_price_inr)}</div>
          <div><span style="color:var(--text-muted);">Fair value</span> ${fmtInr(ov.fair_value_inr)}</div>
          <div><span style="color:var(--text-muted);">Upside</span> <span style="color:${ov.upside_pct == null ? "var(--text-muted)" : ov.upside_pct >= 0 ? "var(--green)" : "var(--red)"};">${fmtPct(ov.upside_pct, 1)}</span></div>
          <div><span style="color:var(--text-muted);">Mcap</span> ${fmtInr(ov.market_cap_inr)}</div>
          <div><span style="color:var(--text-muted);">52w</span> ${ov.fifty_two_week ? `${fmtInr(ov.fifty_two_week.low)}–${fmtInr(ov.fifty_two_week.high)}` : "—"}</div>
        </div>
      </div>
      <div class="sws-modal-score">
        <div class="score-value" style="color:${scoreColor};">${score}</div>
        <div class="score-label" style="color:${verdictColor};">${verdict.replace(/_/g, " ")}</div>
      </div>
    </div>

    ${barsHtml ? `
    <div class="sws-modal-section">
      <h4>Score breakdown — ${hasV3 ? "v3 multi-factor blend" : "v2 fundamentals composite"} (out of 100)</h4>
      ${barsHtml}
      ${hasV3 ? `
        <div style="font-size:10px;color:var(--text-muted);margin-top:8px;">v3 = 5 SWS pillars (74) + AnalystConsensus FV upside + universe-percentile momentum (14) − safety overlay (max −15). Only inputs with ≥50% universe coverage are scored; 30% of stocks lack a fair-value estimate and get a neutral 6/12 on FV upside (flagged as fv_imputed in the breakdown).</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Score evolution: <strong>v1</strong> ${card_.score?.toFixed(1) || "—"} (fund only) → <strong>v2</strong> ${card_.v2_score?.toFixed(1) || "—"} (+ catalyst/risk) → <strong>v3</strong> ${card_.v3_score_100.toFixed(1)} (+ momentum, ≥50% coverage gate).</div>
      ` : `
        <div style="font-size:10px;color:var(--text-muted);margin-top:8px;">v2 = fundamentals (max 100) + catalyst (max +5) − risk overlay (max −15), clamped 0-100. Live technicals shown in the Live signals panel below.</div>
      `}
    </div>` : ""}

    ${hexHtml}

    ${benchHtml}

    <div class="sws-modal-section">
      <h4>Quick stats</h4>
      <div class="sws-modal-grid">
        ${stats.map(([l, v]) => `<div class="sws-stat-cell"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join("")}
      </div>
    </div>

    ${retsHtml}
    ${rewardsRisksHtml}
    ${catalystHtml}

    ${(card_.narrative && card_.narrative.pdf_rationale) ? `
    <div class="sws-modal-section">
      <h4>Research note</h4>
      <div style="font-size:12px;line-height:1.7;color:var(--text-primary);white-space:pre-line;">${escapeHtml(card_.narrative.pdf_rationale)}</div>
    </div>` : ""}

    ${livePlaceholder}

    <div class="sws-modal-section" style="border-top:none;padding-top:6px;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--text-muted);">
      <div>${file_mtime ? `Deep-scrape mtime: ${new Date(file_mtime).toLocaleString()}` : ""}</div>
      ${card_.sws_url ? `<a href="${card_.sws_url}" target="_blank" rel="noopener" style="color:var(--cyan);text-decoration:none;">Open on Simply Wall Street →</a>` : ""}
    </div>
  `;
}

// Lazy live overlay: technical signal + news headlines + recommendation.
// Hits /api/stock/:symbol after first paint of the modal.
async function fetchAndRenderSwsLiveOverlay(ticker) {
  const slot = document.getElementById("swsModalLiveOverlay");
  if (!slot) return;
  try {
    const res = await fetch(`/api/stock/${encodeURIComponent(ticker)}`);
    if (!res.ok) {
      slot.innerHTML = `<h4>Live signals</h4><div style="font-size:11px;color:var(--text-muted);">Live engine returned ${res.status} — likely insufficient history (recent IPO) or symbol not on Yahoo.</div>`;
      return;
    }
    const data = await res.json();
    if (swsModalCurrentTicker !== ticker) return; // user navigated away
    const tech = data.analysis?.technicalScore;
    const sent = data.analysis?.sentimentScore;
    const fund = data.analysis?.fundamentalScore;
    const combined = data.analysis?.combinedScore;
    const reco = data.analysis?.recommendation;
    const surv = data.surveillance;
    const news = (data.news || []).slice(0, 5);
    const macro = data.longTerm?.macroBoost;

    const colorPill = (label, val, max = 100) => {
      if (val == null) return `<div class="sws-stat-cell"><div class="stat-label">${label}</div><div class="stat-value" style="color:var(--text-muted);">—</div></div>`;
      const col = val >= 70 ? "var(--green)" : val >= 50 ? "var(--cyan)" : val >= 35 ? "var(--gold, #f5c542)" : "var(--red)";
      return `<div class="sws-stat-cell"><div class="stat-label">${label}</div><div class="stat-value" style="color:${col};">${Math.round(val)}<span style="font-size:10px;color:var(--text-muted);">/${max}</span></div></div>`;
    };

    const recoColor = !reco ? "var(--text-muted)" :
      reco.includes("STRONG BUY") || reco === "BUY" ? "var(--green)" :
      reco === "HOLD" ? "var(--cyan)" :
      reco.includes("SELL") ? "var(--red)" : "var(--text-muted)";

    slot.innerHTML = `
      <h4>Live signals — independent live engine (technicals · sentiment · regulatory)</h4>
      <div class="sws-modal-grid" style="margin-bottom:10px;">
        ${colorPill("Technicals", tech)}
        ${colorPill("Sentiment", sent)}
        ${colorPill("Fundamentals", fund)}
        ${colorPill("Combined", combined)}
      </div>
      ${reco ? `<div style="font-size:13px;margin-bottom:10px;"><span style="color:var(--text-muted);">Recommendation:</span> <strong style="color:${recoColor};">${escapeHtml(reco)}</strong></div>` : ""}
      ${surv ? `<div style="font-size:11px;color:var(--red);margin-bottom:10px;">⚠ NSE surveillance: <strong>${escapeHtml(surv.list)}</strong>${surv.timeframe ? ` (${escapeHtml(surv.timeframe)})` : ""}${surv.stage ? ` · stage ${escapeHtml(String(surv.stage))}` : ""}</div>` : ""}
      ${news.length ? `
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-top:14px;">News (${news.length})</div>
        <ul class="sws-bullet-list" style="margin-top:6px;">
          ${news.map((n) => `<li>${n.url ? `<a href="${escapeAttr(n.url)}" target="_blank" rel="noopener" style="color:var(--text-primary);text-decoration:none;" onclick="event.stopPropagation();">${escapeHtml(n.title || "(untitled)")}</a>` : escapeHtml(n.title || "")}<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${n.source ? escapeHtml(n.source) : ""}${n.publishedAt ? ` · ${new Date(n.publishedAt).toLocaleDateString()}` : ""}</div></li>`).join("")}
        </ul>` : ""}
      ${macro != null ? `<div style="font-size:10px;color:var(--text-muted);margin-top:10px;">Macro tilt applied: ${macro >= 0 ? "+" : ""}${macro}</div>` : ""}
      <div style="font-size:10px;color:var(--text-muted);margin-top:10px;">Live data is fetched at modal open from NSE/Yahoo. May lag up to 15 min during market hours.</div>
    `;
  } catch (e) {
    slot.innerHTML = `<h4>Live signals</h4><div style="font-size:11px;color:var(--red);">Live overlay failed: ${escapeHtml(e.message)}</div>`;
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
