(function () {
  const state = {
    loaded: false,
    loading: false,
    controller: null,
  };

  const SECTION_LABELS = {
    breaking_filings: "Breaking filings",
    portfolio_watchlist: "My portfolio/watchlist",
    negative_or_material: "Negative or material",
    results_earnings: "Results/earnings",
    us_sec_filings: "US SEC filings",
  };

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatAge(minutes) {
    if (!Number.isFinite(minutes)) return "lag n/a";
    if (minutes < 60) return `${Math.max(0, minutes)}m lag`;
    return `${Math.round(minutes / 60)}h lag`;
  }

  function formatDate(value) {
    if (!value) return "time n/a";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "time n/a";
    return date.toLocaleString("en-IN", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function setBanner(payload, isError = false) {
    const banner = el("marketInformationStatusBanner");
    if (!banner) return;
    const stale = payload?.runtime_audit?.stale;
    if (!isError && !stale) {
      banner.style.display = "none";
      banner.innerHTML = "";
      return;
    }
    banner.style.display = "block";
    banner.className = isError ? "state--error" : "state--warning";
    banner.style.cssText = [
      "display:block",
      "margin-bottom:16px",
      "padding:12px 14px",
      "border-radius:6px",
      `border:1px solid ${isError ? "rgba(248,113,113,0.35)" : "rgba(251,191,36,0.35)"}`,
      `background:${isError ? "rgba(248,113,113,0.1)" : "rgba(251,191,36,0.1)"}`,
      `color:${isError ? "#fecaca" : "#fde68a"}`,
      "font-size:12px",
    ].join(";");
    banner.textContent = isError
      ? "Market Radar snapshot is not ready yet. Run the manual refresh before relying on this feed."
      : `Market Radar snapshot is stale: ${Number(payload.runtime_audit.age_hours || 0).toFixed(1)}h old.`;
  }

  function buildQuery() {
    const params = new URLSearchParams();
    const search = el("marketInformationSearch")?.value?.trim();
    const sentiment = el("marketInformationSentiment")?.value || "all";
    const category = el("marketInformationCategory")?.value?.trim();
    const source = el("marketInformationSource")?.value || "all";
    const scope = el("marketInformationScope")?.value || "all";
    if (search) params.set("ticker", search);
    if (sentiment !== "all") params.set("sentiment", sentiment);
    if (category) params.set("category", category);
    if (source !== "all") params.set("source", source);
    if (scope !== "all") params.set("scope", scope);
    return params.toString();
  }

  function renderMetric(label, value) {
    return `
      <div style="border:1px solid var(--bg-graphite); border-radius:6px; padding:10px 12px; background:rgba(255,255,255,0.02); min-width:110px;">
        <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em;">${escapeHtml(label)}</div>
        <div style="font-size:18px; color:var(--text-primary); font-weight:700; margin-top:3px;">${escapeHtml(value)}</div>
      </div>
    `;
  }

  function renderCard(item) {
    const sentiment = item.sentiment || "neutral";
    const sentimentColor =
      sentiment === "negative" ? "#f87171" : sentiment === "positive" ? "#34d399" : "#93c5fd";
    return `
      <article class="market-information-card" data-testid="market-information-card" style="border:1px solid var(--bg-graphite); border-radius:8px; padding:14px; background:rgba(255,255,255,0.025);">
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:8px;">
          <div style="min-width:0;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <strong style="font-size:15px; color:var(--text-primary);">${escapeHtml(item.ticker || "N/A")}</strong>
              <span style="font-size:11px; color:var(--text-muted);">${escapeHtml(item.company_name || "")}</span>
            </div>
            <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">${escapeHtml(item.category || item.raw_type || "Filing")}</div>
          </div>
          <span style="font-size:10px; color:${sentimentColor}; border:1px solid ${sentimentColor}; border-radius:999px; padding:3px 7px; text-transform:uppercase; letter-spacing:0.05em;">${escapeHtml(sentiment)}</span>
        </div>
        <p style="font-size:13px; color:var(--text-primary); line-height:1.55; margin:0 0 10px;">${escapeHtml(item.summary || item.title || "No AI summary supplied.")}</p>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; font-size:11px; color:var(--text-muted);">
          <span>${escapeHtml(item.why_it_matters || "Fresh filing")}</span>
          <span>Published ${escapeHtml(formatDate(item.published_at))}</span>
          <span>${escapeHtml(formatAge(item.provider_lag_minutes))}</span>
          <span>${escapeHtml(item.source_market === "us" ? "US SEC" : "India")}</span>
          ${item.source_url ? `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--cyan);">Source</a>` : ""}
        </div>
      </article>
    `;
  }

  function renderSection(key, items) {
    const rows = Array.isArray(items) ? items : [];
    return `
      <section style="margin-top:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <h3 style="font-size:16px; color:var(--text-primary); margin:0;">${escapeHtml(SECTION_LABELS[key] || key)}</h3>
          <span style="font-size:11px; color:var(--text-muted);">${rows.length} item${rows.length === 1 ? "" : "s"}</span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px;">
          ${
            rows.length
              ? rows.map(renderCard).join("")
              : `<div class="empty-state" style="min-height:90px;"><div class="empty-text">No filings in this section.</div></div>`
          }
        </div>
      </section>
    `;
  }

  function renderPayload(payload) {
    const container = el("marketInformationContainer");
    if (!container) return;
    const stats = payload.stats || {};
    const audit = payload.runtime_audit || {};
    el("marketInformationLastUpdated").textContent = audit.generated_at
      ? `Snapshot ${formatDate(audit.generated_at)}`
      : "";
    setBanner(payload, false);
    container.innerHTML = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px;" data-testid="market-information-metrics">
        ${renderMetric("Filings", stats.total ?? 0)}
        ${renderMetric("Material", stats.material ?? 0)}
        ${renderMetric("Negative", stats.negative ?? 0)}
        ${renderMetric("My names", stats.portfolio_watchlist ?? 0)}
        ${renderMetric("US SEC", stats.us_sec_filings ?? 0)}
      </div>
      <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">
        ${escapeHtml(payload.description || "Informational filing radar.")}
      </div>
      ${Object.entries(payload.sections || {}).map(([key, items]) => renderSection(key, items)).join("")}
    `;
  }

  function renderLoading() {
    const container = el("marketInformationContainer");
    if (!container) return;
    container.innerHTML = `
      <div class="loading state--loading">
        <div class="loading-spinner"></div>
        <div class="loading-text">Loading Market Radar...</div>
      </div>
    `;
  }

  function renderError(message) {
    const container = el("marketInformationContainer");
    if (!container) return;
    setBanner(null, true);
    container.innerHTML = `
      <div class="empty-state state--error" data-testid="market-information-error">
        <div class="empty-icon">!</div>
        <div class="empty-text">${escapeHtml(message || "Market Radar is not ready yet.")}</div>
      </div>
    `;
  }

  async function loadMarketInformation({ force = false } = {}) {
    if (state.loading) return;
    if (state.loaded && !force) return;
    const container = el("marketInformationContainer");
    if (!container) return;
    state.loading = true;
    renderLoading();
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    try {
      const query = buildQuery();
      const response = await fetch(`/api/market-information/latest${query ? `?${query}` : ""}`, {
        signal: state.controller.signal,
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
      renderPayload(payload);
      state.loaded = true;
    } catch (err) {
      if (err.name !== "AbortError") renderError(err.message);
    } finally {
      state.loading = false;
    }
  }

  function initMarketInformationControls() {
    const style = document.createElement("style");
    style.textContent = `
      @media (max-width: 900px) {
        #marketInformationControls { grid-template-columns: 1fr 1fr !important; }
      }
      @media (max-width: 560px) {
        #marketInformationControls { grid-template-columns: 1fr !important; }
      }
    `;
    document.head.appendChild(style);

    for (const id of [
      "marketInformationSearch",
      "marketInformationSentiment",
      "marketInformationCategory",
      "marketInformationSource",
      "marketInformationScope",
    ]) {
      const node = el(id);
      if (!node) continue;
      const eventName = node.tagName === "SELECT" ? "change" : "input";
      node.addEventListener(eventName, () => {
        state.loaded = false;
        clearTimeout(node.__marketInformationTimer);
        node.__marketInformationTimer = setTimeout(() => loadMarketInformation({ force: true }), 250);
      });
    }
    el("marketInformationRefresh")?.addEventListener("click", () => {
      state.loaded = false;
      loadMarketInformation({ force: true });
    });
  }

  window.loadMarketInformation = loadMarketInformation;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMarketInformationControls, { once: true });
  } else {
    initMarketInformationControls();
  }
})();
