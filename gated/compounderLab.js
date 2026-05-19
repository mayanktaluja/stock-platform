/* eslint-disable no-undef */
// Compounder Lab tab — SAFE sleeve from the 2026-05-19 alpha-strategy plan.
// Renders the quality-quintile basket from data/compounder/latest.json with
// per-stock click-through to the shared SWS modal.
//
// Personal-use only — server returns 404 to non-allowlisted users so this
// loader will simply fail-quietly for anyone outside the allowlist.

(function () {
  const FMT_PCT = (n) =>
    Number.isFinite(Number(n)) ? `${Number(n).toFixed(1)}%` : "—";
  const FMT_CR = (paise) => {
    const n = Number(paise);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return `₹${(n / 1e7).toFixed(0)}Cr`;
  };

  function renderHeader(data) {
    const ts = data.generated_at ? new Date(data.generated_at) : null;
    const tsLabel = ts ? ts.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px; padding-bottom:16px; border-bottom:1px solid var(--bg-graphite);">
        <div>
          <h2 class="editorial-headline" style="font-size:34px; font-weight:500; letter-spacing:-0.02em;">Compounder Lab</h2>
          <p style="font-size:12px; color:var(--text-muted); margin-top:3px;">
            SAFE sleeve — top ${data.filter?.basket_size ?? 20} quality compounders ranked by AnalystConsensus FV upside.
            Filter: Snowflake-Past ≥ ${data.filter?.min_snowflake_past ?? 5}, Health ≥ ${data.filter?.min_snowflake_health ?? 4}, Dividend ≥ ${data.filter?.min_snowflake_dividend ?? 4}, market-cap ≥ ₹${(data.filter?.min_market_cap_inr ?? 500_00_00_000) / 1e7}Cr, no debt/liquidity risk keywords.
            Quarterly rebalance.
          </p>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <span class="last-updated" id="compounderLastUpdated">${tsLabel}</span>
        </div>
      </div>
      <div style="background:rgba(96,165,250,0.06); border:1px solid rgba(96,165,250,0.22); border-radius:8px; padding:10px 14px; margin-bottom:24px; font-size:12px; color:var(--text-secondary); line-height:1.6;">
        <strong style="color:var(--info-text);">ⓘ How this tab works:</strong>
        Universe: ${data.universe_size ?? "—"} SWS-scored stocks. ${data.pre_filtered_count ?? "—"} pass market-cap + valid-upside pre-filter; ${data.passed_count ?? "—"} survive the full quality screen; top ${data.basket?.length ?? 0} by upside_pct go into the basket.
        Trim signals are evaluated quarterly: TRIM_50 when upside ≤ −10%, EXIT when Snowflake-Health drops or a new debt/liquidity risk appears.
        <strong>This is personal research, not investment advice.</strong>
      </div>`;
  }

  function renderBasketTable(basket) {
    if (!Array.isArray(basket) || !basket.length) {
      return `<div style="padding:24px; text-align:center; color:var(--text-muted);">No basket members yet — run <code>node scripts/refresh-compounder.mjs</code> locally.</div>`;
    }
    const rows = basket
      .map((b, i) => {
        const tickerSafe = String(b.ticker).replace(/[^A-Z0-9_-]/gi, "");
        return `
          <tr style="border-bottom:1px solid var(--bg-graphite); cursor:pointer;"
              onclick="if (typeof openSwsModal === 'function') openSwsModal('${tickerSafe}')"
              title="Open SWS detail for ${tickerSafe}">
            <td style="padding:10px 8px; color:var(--text-muted); font-variant-numeric:tabular-nums;">${i + 1}</td>
            <td style="padding:10px 8px; font-weight:600;">${tickerSafe}</td>
            <td style="padding:10px 8px; color:var(--text-secondary);">${b.name || "—"}</td>
            <td style="padding:10px 8px; color:var(--text-muted); font-size:11px;">${b.sector || "—"}</td>
            <td style="padding:10px 8px; font-variant-numeric:tabular-nums; text-align:right;">P${b.snowflake_past}·H${b.snowflake_health}·D${b.snowflake_dividend}</td>
            <td style="padding:10px 8px; font-variant-numeric:tabular-nums; text-align:right; color:var(--positive-text-soft); font-weight:600;">${FMT_PCT(b.upside_pct)}</td>
            <td style="padding:10px 8px; font-variant-numeric:tabular-nums; text-align:right; color:var(--text-muted);">${FMT_CR(b.market_cap_inr)}</td>
          </tr>`;
      })
      .join("");
    return `
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--bg-graphite); color:var(--text-muted); font-size:11px; letter-spacing:0.04em; text-transform:uppercase;">
              <th style="padding:10px 8px; text-align:left; width:32px;">#</th>
              <th style="padding:10px 8px; text-align:left;">Ticker</th>
              <th style="padding:10px 8px; text-align:left;">Name</th>
              <th style="padding:10px 8px; text-align:left;">Sector</th>
              <th style="padding:10px 8px; text-align:right;">Snowflake</th>
              <th style="padding:10px 8px; text-align:right;">FV Upside</th>
              <th style="padding:10px 8px; text-align:right;">Mkt Cap</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderPaperTrades(ledger) {
    if (!ledger || !Array.isArray(ledger.trades) || !ledger.trades.length) {
      return "";
    }
    const open = ledger.trades.filter((t) => t.status === "OPEN");
    const closed = ledger.trades.filter((t) => t.status === "CLOSED");
    return `
      <div style="margin-top:32px; padding-top:24px; border-top:1px solid var(--bg-graphite);">
        <h3 style="font-size:16px; margin-bottom:12px;">Paper-Trade Ledger</h3>
        <p style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">
          ${open.length} open · ${closed.length} closed · live-deploy gate: ≥80 resolved, ≥2 fiscal quarters, ≥55% hit-rate (per <code>services/earnings/weightTuner.js</code>).
        </p>
      </div>`;
  }

  async function loadCompounderLab() {
    const el = document.getElementById("compounderTab");
    if (!el) return;
    el.innerHTML = '<div style="padding:32px; text-align:center; color:var(--text-muted);">Loading Compounder Lab…</div>';
    try {
      const [latestRes, ledgerRes] = await Promise.all([
        fetch("/api/compounder/latest"),
        fetch("/api/compounder/paper-trades"),
      ]);
      if (latestRes.status === 404) {
        el.innerHTML = '<div style="padding:32px; text-align:center; color:var(--text-muted);">Compounder Lab is personal-use only.</div>';
        return;
      }
      if (!latestRes.ok) throw new Error(`HTTP ${latestRes.status}`);
      const latest = await latestRes.json();
      const ledger = ledgerRes.ok ? await ledgerRes.json() : null;
      el.innerHTML =
        renderHeader(latest) +
        renderBasketTable(latest.basket) +
        renderPaperTrades(ledger);
    } catch (err) {
      console.error("[compounderLab] load failed:", err);
      el.innerHTML = `<div style="padding:32px; text-align:center; color:var(--negative-text-soft);">Failed to load Compounder Lab: ${err.message}</div>`;
    }
  }

  window.loadCompounderLab = loadCompounderLab;
})();
