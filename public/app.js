/**
 * StarBhai · Indian Stock Intelligence — Frontend Application
 */

// State
let currentView = "dashboard"; // dashboard | stock
let currentSymbol = null;
let refreshTimer = null;
let newsRefreshTimer = null;
let searchTimeout = null;
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

/** Map a fundamental verdict (DEEP_VALUE etc) to its glossary ID. */
function verdictIdFromLabel(verdict) {
  if (!verdict) return null;
  const map = {
    DEEP_VALUE: "deep_value",
    QUALITY_GROWTH: "quality_growth",
    FAIR_VALUE: "fair_value",
    FULLY_VALUED: "fully_valued",
    OVERVALUED: "overvalued",
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

    if (query.length < 1) {
      searchResults.classList.remove("active");
      return;
    }

    searchTimeout = setTimeout(() => searchStocks(query), 300);
  });

  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim().length >= 1) {
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

async function searchStocks(query) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (data.results && data.results.length > 0) {
      searchResults.innerHTML = data.results
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
      searchResults.classList.add("active");
    } else {
      searchResults.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-muted);">
          No Indian stocks found for "${escapeHtml(query)}"
        </div>
      `;
      searchResults.classList.add("active");
    }
  } catch (err) {
    console.error("Search failed:", err);
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

function renderStockDetail(data) {
  const { quote, analysis, midTerm, sentiment, fundamentals, news, macro, stockVerdict, historicalChart, lastUpdated } = data;

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
  loadVolumeBreakout();
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

async function loadBuyNow() {
  const container = document.getElementById("buynowCards");
  const warmingBanner = document.getElementById("buynowWarmingBanner");

  // Show the warming-banner after 3s if the request is still pending — gives
  // users confidence that something is happening during the 45s cold start.
  const warmingTimer = setTimeout(() => {
    if (warmingBanner) warmingBanner.classList.add("visible");
  }, 3000);

  try {
    const res = await fetch("/api/scan/buynow");
    const data = await res.json();

    if (data.error) {
      container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">${escapeHtml(data.error)}</div></div>`;
      return;
    }

    // Render macro regime banner if present
    if (data.regime) renderMacroBanner(data.regime);

    if (!data.stocks || data.stocks.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-icon">&#128269;</div>
          <div class="empty-text">No strong buy signals detected right now. The market may be in a bearish phase — wait for better entries.</div>
        </div>`;
      return;
    }

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
    container.innerHTML = hcBanner + heroHtml + restHtml;
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

async function loadVolumeBreakout() {
  const container = document.getElementById("volumeCards");

  try {
    const res = await fetch("/api/scan/volume-breakout");
    const data = await res.json();

    if (data.error) {
      container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">${escapeHtml(data.error)}</div></div>`;
      return;
    }

    // Update elapsed indicator
    const elapsedEl = document.getElementById("volumeElapsed");
    if (elapsedEl && data.elapsedFraction !== undefined) {
      elapsedEl.textContent = `${data.elapsedFraction}% of trading day elapsed`;
    }

    document.getElementById("lastUpdated").textContent =
      `Updated: ${new Date(data.lastUpdated).toLocaleTimeString("en-IN")}`;

    if (!data.stocks || data.stocks.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-icon">&#128202;</div>
          <div class="empty-text">No significant volume breakouts right now. Check back during market hours.</div>
        </div>`;
      return;
    }

    container.innerHTML = data.stocks.map(renderVolumeCard).join("");
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon">&#9888;</div><div class="empty-text">Failed to load volume data. Server may be starting up.</div></div>`;
  }
}

function renderVolumeCard(stock) {
  const isPos = stock.changePercent >= 0;
  const ratioDisplay = stock.volumeRatio.toFixed(1);
  const rawDisplay = stock.rawRatio.toFixed(1);

  // Bar fill: cap at 5x for visual, colour by strength
  const barPct = Math.min(100, (stock.volumeRatio / 5) * 100);
  const barColor =
    stock.signalStrength === "EXPLOSIVE"
      ? "#f59e0b"
      : stock.signalStrength === "VERY HIGH"
      ? "#f97316"
      : stock.signalStrength === "HIGH"
      ? "#3b82f6"
      : "#64748b";

  const dirClass =
    stock.direction === "BULLISH"
      ? "direction-long"
      : stock.direction === "BEARISH"
      ? "direction-short"
      : "direction-neutral";

  const sigClass =
    stock.signalStrength === "EXPLOSIVE"
      ? "signal-explosive"
      : stock.signalStrength === "VERY HIGH"
      ? "signal-very-high"
      : stock.signalStrength === "HIGH"
      ? "signal-high"
      : "signal-moderate";

  const dirIcon =
    stock.direction === "BULLISH" ? "&#9650;" : stock.direction === "BEARISH" ? "&#9660;" : "&#9644;";

  return `
    <div class="stock-card" onclick="loadStock('${stock.symbol}')">
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

      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
        <span class="signal-badge ${sigClass}">${stock.signalStrength}</span>
        <span class="stock-card-direction ${dirClass}" style="font-size:12px;padding:3px 10px;border-radius:6px;">${dirIcon} ${stock.direction}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:${barColor};">${ratioDisplay}x projected</span>
      </div>

      <div class="volume-bar-wrap">
        <div class="volume-bar-fill" style="width:${barPct}%;background:${barColor};"></div>
      </div>
      <div class="volume-ratio-label">
        <span>Today so far: ${rawDisplay}x avg</span>
        <span>Projected EOD: ${ratioDisplay}x avg</span>
      </div>

      <div class="stock-card-metrics">
        <div class="stock-card-metric">
          <div class="metric-label">Today Vol</div>
          <div class="metric-value" style="color:${barColor};">${formatVolume(stock.currentVolume)}</div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Avg Daily</div>
          <div class="metric-value">${formatVolume(stock.avgVolume)}</div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Day Range</div>
          <div class="metric-value" style="font-size:11px;">&#8377;${formatNumber(stock.dayLow)}-${formatNumber(stock.dayHigh)}</div>
        </div>
      </div>

      <div class="stock-card-reasoning">${escapeHtml(stock.reasoning)}</div>

      <div class="stock-card-footer">
        <span class="stock-card-direction ${dirClass}">${stock.action}</span>
        <div class="stock-card-targets">
          ${stock.stopLoss ? `SL: &#8377;${stock.stopLoss}` : ""}
          ${stock.target ? ` | T: &#8377;${stock.target}` : ""}
        </div>
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
    loadVolumeBreakout(),
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

  dashEl.style.display = "none";
  newsEl.style.display = "none";
  portEl.style.display = "none";
  smeEl.style.display = "none";
  if (fundEl) fundEl.style.display = "none";
  if (trackEl) trackEl.style.display = "none";
  if (analyzerEl) analyzerEl.style.display = "none";
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
  loadSmeScan("buynow", "smeBuynowCards", "buy opportunities");
  loadSmeScan("volume", "smeVolumeCards", "volume breakouts");
  loadSmeScan("midterm", "smeMidtermCards", "mid-term picks");
  loadSmeScan("sell", "smeSellCards", "sell alerts");
}

async function refreshSme() {
  const btn = document.getElementById("smeRefreshBtn");
  if (btn) btn.classList.add("spinning");
  await Promise.all([
    loadSmeScan("buynow", "smeBuynowCards", "buy opportunities"),
    loadSmeScan("volume", "smeVolumeCards", "volume breakouts"),
    loadSmeScan("midterm", "smeMidtermCards", "mid-term picks"),
    loadSmeScan("sell", "smeSellCards", "sell alerts"),
  ]);
  setTimeout(() => { if (btn) btn.classList.remove("spinning"); }, 500);
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

    container.innerHTML = data.stocks.map((s) => renderSmeCard(s, category)).join("");
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

  // Determine what to show in footer based on category.
  //
  // For "buynow", we show a SINGLE 0-100 confidence score (same convention as
  // the Market Scanner). Previously this was midtermScore + intradayScore which
  // could be 150-200 — meaningless to the user. Now it's the macro-adjusted
  // midterm score, consistent with the midterm/sell categories below, which
  // means the number here has the same meaning across every tab:
  //     "Higher = higher conviction, out of 100."
  let footer = "";
  if (category === "buynow") {
    const buyNowScore = Math.round(
      stock.adjustedMidtermScore != null ? stock.adjustedMidtermScore : stock.midtermScore
    );
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-long">&#9650; STRONG SIGNAL</span>
        <span class="edu-chip" aria-label="Educational only">Educational only</span>
        <span style="font-size:12px;color:var(--text-muted);">Score: ${buyNowScore}/100</span>
      </div>`;
  } else if (category === "volume") {
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction ${dirClass}">${stock.direction}</span>
        <span style="font-size:12px;color:var(--yellow);font-family:'JetBrains Mono',monospace;">Volatility: ${stock.volatility}%</span>
      </div>`;
  } else if (category === "midterm") {
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-long">SWING</span>
        <span style="font-size:12px;color:var(--text-muted);">Score: ${stock.midtermScore}/100</span>
      </div>`;
  } else if (category === "sell") {
    footer = `
      <div class="stock-card-footer">
        <span class="stock-card-direction direction-short">&#9888; EXIT</span>
        <span style="font-size:12px;color:var(--text-muted);">Score: ${stock.midtermScore}/100</span>
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
      ${macroBadge ? `<div style="margin-bottom:8px;">${macroBadge}</div>` : ""}
      <div class="stock-card-metrics">
        <div class="stock-card-metric">
          <div class="metric-label">Volume</div>
          <div class="metric-value">${formatVolume(stock.totalTradedVolume)}</div>
        </div>
        <div class="stock-card-metric">
          <div class="metric-label">Volatility</div>
          <div class="metric-value" style="color:${parseFloat(stock.volatility) > 3 ? 'var(--yellow)' : 'inherit'};">${stock.volatility}%</div>
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

function initPortfolioAnalyzer() {
  if (_analyzerWired) return;
  _analyzerWired = true;

  const input = document.getElementById("analyzerFileInput");
  const browseBtn = document.getElementById("analyzerBrowseBtn");
  const dropArea = document.getElementById("analyzerDropArea");

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
  document.getElementById("analyzerProgressText").textContent =
    `Analyzing ${file.name}…`;

  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/portfolio/analyze", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error + (data.hint ? `\n\nHint: ${data.hint}` : ""));
    }
    renderAnalyzerReport(data.report, data.elapsedMs);
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

function renderAnalyzerReport(report, elapsedMs) {
  renderAnalyzerSummary(report, elapsedMs);
  renderAnalyzerPortfolioActions(report);
  renderAnalyzerRiskBlock(report);
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
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">P&amp;L</div>
        <div style="font-size:22px; font-weight:700; color:${pnlColor};">
          ${s.totalPnL >= 0 ? "+" : ""}${inr(s.totalPnL)}
          <span style="font-size:14px; font-weight:500; margin-left:6px;">(${s.totalPnLPct >= 0 ? "+" : ""}${s.totalPnLPct.toFixed(2)}%)</span>
        </div>
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

    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; font-size:11px; color:var(--text-muted); gap:10px; flex-wrap:wrap;">
      <div>${freshnessBadge(report)}</div>
      <div>Analyzed ${s.holdingsCount} holdings${s.unmatchedCount > 0 ? ` · ${s.unmatchedCount} not analysed` : ""} · ${elapsedMs}ms</div>
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

  // Risk card
  const riskCard = r ? `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px; margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">Risk profile (vs. Nifty 50, last ${r.sampleDays} trading days)</div>
        ${notAdviceChip()}
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px;">
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Weighted beta</div>
          <div style="font-size:20px; font-weight:700; color:${betaColor};">${fmtNum(beta)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${r.betaCoverage}/${r.betaTotal} holdings priced</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Annualised volatility</div>
          <div style="font-size:20px; font-weight:700; color:${volColor};">${fmtPct(vol)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Nifty: ${fmtPct(benchVol)}</div>
        </div>
        <div style="padding:12px; background:#0b1220; border:1px solid #1a2233; border-radius:8px;">
          <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">Sharpe (rf=6.5%)</div>
          <div style="font-size:20px; font-weight:700; color:${sharpeColor};">${fmtNum(sharpe)}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Nifty: ${fmtNum(benchSharpe)}</div>
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

  // Stress-test card
  const rows = tests.map((t) => {
    const pct = t.projectedLossPct;
    const amt = t.projectedLossAmount;
    const color = pct < -25 ? "#fca5a5" : pct < -15 ? "#fde047" : "#93c5fd";
    return `
      <div style="display:grid; grid-template-columns: 1fr 120px 140px 140px; gap:12px; align-items:center; padding:10px 0; border-bottom:1px solid #1a2233; font-size:13px;">
        <div>${t.name}</div>
        <div style="color:var(--text-muted); font-size:12px;">Nifty ${fmtPct(t.marketShockPct, true)}</div>
        <div style="color:${color}; font-weight:700;">${fmtPct(pct, true)}</div>
        <div style="color:${color}; font-weight:600; text-align:right;">${amt >= 0 ? "+" : ""}${inr(amt)}</div>
      </div>`;
  }).join("");

  const stressCard = tests.length ? `
    <div style="background:var(--panel); border:1px solid #1a2233; border-radius:10px; padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:10px; flex-wrap:wrap;">
        <div style="font-size:14px; font-weight:700;">Stress tests (CAPM-style, using per-stock beta)</div>
        ${notAdviceChip()}
      </div>
      <div style="display:grid; grid-template-columns: 1fr 120px 140px 140px; gap:12px; font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; padding-bottom:4px;">
        <div>Scenario</div><div>Market shock</div><div>Projected Δ</div><div style="text-align:right;">Δ in ₹</div>
      </div>
      ${rows}
      <div style="margin-top:10px; font-size:11px; color:var(--text-muted); line-height:1.55;">
        Simple CAPM projection: for each holding, expected return = β × market return. Real shocks aren't linear, and sector factors matter — these numbers are a floor on tail-risk thinking, not a forecast.
      </div>
    </div>` : "";

  el.innerHTML = riskCard + stressCard;
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
    ? `<div style="margin:14px 0; padding:12px 14px; background:#111827; border-radius:6px;">
        <div style="font-size:12px; font-weight:700; margin-bottom:8px;">Risk profile</div>
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap:10px; font-size:12px;">
          ${h.risk.beta != null ? `<div><span style="color:var(--text-muted);">Beta:</span> <strong>${h.risk.beta.toFixed(2)}</strong></div>` : ""}
          ${h.risk.annualizedVolatility != null ? `<div><span style="color:var(--text-muted);">Vol (ann.):</span> <strong>${h.risk.annualizedVolatility.toFixed(1)}%</strong></div>` : ""}
          ${h.risk.maxDrawdown1y != null ? `<div><span style="color:var(--text-muted);">Max DD (1y):</span> <strong style="color:#fca5a5;">${h.risk.maxDrawdown1y.toFixed(1)}%</strong></div>` : ""}
          ${h.risk.var95Daily != null ? `<div><span style="color:var(--text-muted);">95% daily VaR:</span> <strong style="color:#fca5a5;">${h.risk.var95Daily.toFixed(2)}%</strong></div>` : ""}
        </div>
      </div>` : "";

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
