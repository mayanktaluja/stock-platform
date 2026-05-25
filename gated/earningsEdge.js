/* eslint-disable no-undef */
// Earnings Edge tab — AGGRESSIVE sleeve from the 2026-05-19 alpha-strategy
// plan. Renders the deterministic KEC-bug-filter survivors as paper-trade
// signals, plus the active ledger of open / closed positions.

(function () {
  const FMT_PCT = (n) =>
    Number.isFinite(Number(n)) ? `${Number(n).toFixed(1)}%` : "—";
  const FMT_INR = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 1 })}`;
  };

  function renderHeader(data) {
    const ts = data.generated_at ? new Date(data.generated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px; padding-bottom:16px; border-bottom:1px solid var(--bg-graphite);">
        <div>
          <h2 class="editorial-headline" style="font-size:34px; font-weight:500; letter-spacing:-0.02em;">Earnings Edge</h2>
          <p style="font-size:12px; color:var(--text-muted); margin-top:3px;">
            AGGRESSIVE sleeve — post-result BEAT events that pass the deterministic KEC-bug filter (prior-Q miss check + fv_imputed haircut + debt/liquidity risk reject + problem-sector watchlist + Snowflake-Health ≥ 3 + market-cap ≥ ₹1000Cr + not on ASM/GSM).
            T+1 entry, T+30 hold, −8% trailing stop, −12% hard stop.
          </p>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <span class="last-updated">${ts}</span>
        </div>
      </div>
      <div style="background:rgba(96,165,250,0.06); border:1px solid rgba(96,165,250,0.22); border-radius:8px; padding:10px 14px; margin-bottom:24px; font-size:12px; color:var(--text-secondary); line-height:1.6;">
        <strong style="color:var(--info-text);">ⓘ Pre-live gate:</strong>
        ${data.resolved_beats_evaluated ?? "—"} resolved BEAT events evaluated. ${data.passed_count ?? "—"} passed the filter; ${data.rejected_count ?? "—"} rejected (rejection_tally: ${JSON.stringify(data.rejection_tally || {})}).
        Live deployment requires <strong>≥80 resolved paper trades across ≥2 fiscal quarters, ≥55% hit-rate</strong> (per <code>services/earnings/weightTuner.js</code>).
        <strong>This is personal research, not investment advice.</strong>
      </div>`;
  }

  function renderOpenTrades(openTrades) {
    if (!Array.isArray(openTrades) || !openTrades.length) {
      return `<div style="padding:24px; text-align:center; color:var(--text-muted);">No open paper trades yet.</div>`;
    }
    const rows = openTrades
      .map((t) => {
        const tkr = String(t.ticker).replace(/[^A-Z0-9_-]/gi, "");
        return `
          <tr style="border-bottom:1px solid var(--bg-graphite); cursor:pointer;"
              onclick="if (typeof openSwsModal === 'function') openSwsModal('${tkr}')">
            <td style="padding:10px 8px; font-weight:600;">${tkr}</td>
            <td style="padding:10px 8px; color:var(--text-muted); font-size:11px;">${t.sector || "—"}</td>
            <td style="padding:10px 8px; color:var(--text-muted);">${t.entry_date}</td>
            <td style="padding:10px 8px; text-align:right; font-variant-numeric:tabular-nums;">${FMT_INR(t.entry_price_inr)}</td>
            <td style="padding:10px 8px; text-align:right; color:var(--text-muted); font-size:11px;">${FMT_INR(t.entry_snapshot?.size_inr)}</td>
          </tr>`;
      })
      .join("");
    return `
      <h3 style="font-size:16px; margin:24px 0 12px 0;">Open Paper Trades · ${openTrades.length}</h3>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--bg-graphite); color:var(--text-muted); font-size:11px; letter-spacing:0.04em; text-transform:uppercase;">
              <th style="padding:10px 8px; text-align:left;">Ticker</th>
              <th style="padding:10px 8px; text-align:left;">Sector</th>
              <th style="padding:10px 8px; text-align:left;">Entry</th>
              <th style="padding:10px 8px; text-align:right;">Entry ₹</th>
              <th style="padding:10px 8px; text-align:right;">Size</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderClosedSummary(ledger) {
    const closed = (ledger?.trades || []).filter((t) => t.status === "CLOSED");
    if (!closed.length) return "";
    const wins = closed.filter((t) => {
      const e = Number(t.entry_price_inr);
      const x = Number(t.exit_price_inr);
      return Number.isFinite(e) && Number.isFinite(x) && x > e;
    }).length;
    const winRate = closed.length ? (wins / closed.length) * 100 : 0;
    return `
      <div style="margin-top:32px; padding:16px; background:var(--bg-secondary); border-radius:8px;">
        <strong>Closed trades:</strong> ${closed.length} · <strong>Wins:</strong> ${wins} · <strong>Win rate:</strong> ${winRate.toFixed(1)}% · <strong>Gate:</strong> need ${Math.max(0, 80 - closed.length)} more closes for ≥80 threshold.
      </div>`;
  }

  async function loadEarningsEdge() {
    const el = document.getElementById("earningsEdgeTab");
    if (!el) return;
    el.innerHTML = '<div style="padding:32px; text-align:center; color:var(--text-muted);">Loading Earnings Edge…</div>';
    try {
      const [latestRes, ledgerRes] = await Promise.all([
        fetch("/api/earnings-edge/latest"),
        fetch("/api/earnings-edge/paper-trades"),
      ]);
      if (latestRes.status === 404) {
        el.innerHTML = '<div style="padding:32px; text-align:center; color:var(--text-muted);">Earnings Edge data is not available yet.</div>';
        return;
      }
      if (!latestRes.ok) throw new Error(`HTTP ${latestRes.status}`);
      const latest = await latestRes.json();
      const ledger = ledgerRes.ok ? await ledgerRes.json() : null;
      el.innerHTML =
        renderHeader(latest) +
        renderOpenTrades(latest.open_trades) +
        renderClosedSummary(ledger);
    } catch (err) {
      console.error("[earningsEdge] load failed:", err);
      el.innerHTML = `<div style="padding:32px; text-align:center; color:var(--negative-text-soft);">Failed to load Earnings Edge: ${err.message}</div>`;
    }
  }

  window.loadEarningsEdge = loadEarningsEdge;
})();
