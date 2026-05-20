// 5x Lab tab — UI controller. Loads the 4 sections from
// /api/multibagger/* and renders them into #multibaggerLabContent.
// Module-level cache mirrors gated/earnings.js pattern (_earningsSnapshot).
//
// Sections rendered (top → bottom):
//   1. Trajectory tracker (gross + net curves, days elapsed)
//   2. Today's Action card (1-3 actions)
//   3. Model Portfolio (open positions with live PnL)
//   4. 5x Candidate Pipeline (top 30 sorted by score)
//   5. Catalyst Trades sub-table
//   6. Risk Dashboard
//   7. Health alerts

let _multibaggerOverview = null;
let _multibaggerLoadedAt = null;

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtInr(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
  if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(1)}k`;
  return `₹${Math.round(v)}`;
}

function fmtPct(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

async function loadMultibaggerLab() {
  const target = document.getElementById("multibaggerLabContent");
  if (!target) return;
  target.innerHTML = '<div class="loading" style="padding:40px; text-align:center; color:var(--text-muted);">Loading 5x strategy snapshot…</div>';
  try {
    const res = await fetch("/api/multibagger/overview");
    if (res.status === 404) {
      target.innerHTML = '<div style="padding:24px; color:var(--text-muted); text-align:center;">5x Lab is personal-use only. This account does not have access.</div>';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _multibaggerOverview = data;
    _multibaggerLoadedAt = new Date().toISOString();
    renderMultibaggerLab(data);
    // Update the backtest-status footer
    const fs = document.getElementById("multibaggerLabBacktestStatus");
    if (fs) fs.textContent = "not yet (needs 9mo forward archive)";
  } catch (err) {
    target.innerHTML = `<div style="padding:24px; color:#fca5a5; background:rgba(220,38,38,0.08); border-radius:6px;">Failed to load 5x Lab: ${escapeHtml(err.message)}</div>`;
  }
}

function renderMultibaggerLab(data) {
  const target = document.getElementById("multibaggerLabContent");
  if (!target) return;
  const html = [
    renderTrajectorySection(data),
    renderStrategySection(data),
    renderActionsSection(data),
    renderPortfolioSection(data),
    renderPipelineSection(data),
    renderCatalystSection(data),
    renderHealthSection(data),
  ].join("");
  target.innerHTML = html;
}

function renderTrajectorySection(data) {
  const start = data.portfolio_summary?.starting_capital_inr ?? 100_000;
  const target = start * 5;
  const cash = data.portfolio_summary?.cash_inr ?? start;
  const value = cash; // best-effort until mtm is wired into the API
  const multiple = value / start;
  const pct = ((multiple - 1) * 100).toFixed(1);
  return `
    <section data-section="trajectory" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; padding:16px; background:rgba(167,139,250,0.04); border:1px solid rgba(167,139,250,0.20); border-radius:8px; margin-bottom:24px;">
      <div>
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em;">Current value</div>
        <div data-test="multibagger-current-value" style="font-size:28px; font-weight:600;">${escapeHtml(fmtInr(value))}</div>
        <div style="font-size:11px; color:var(--text-muted);">${pct}% from ₹1L start</div>
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em;">Target (net)</div>
        <div style="font-size:24px; font-weight:500;">${escapeHtml(fmtInr(target))}</div>
        <div style="font-size:11px; color:var(--text-muted);">5x net in 12 months</div>
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em;">Gross required</div>
        <div style="font-size:24px; font-weight:500; color:#fbbf24;">~₹6.0L</div>
        <div style="font-size:11px; color:var(--text-muted);">After STCG churn (6x gross)</div>
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.08em;">Macro regime</div>
        <div data-test="multibagger-macro-regime" style="font-size:18px; font-weight:500;">${escapeHtml(data.macro_regime || "—")}</div>
        <div style="font-size:11px; color:var(--text-muted);">Universe scored ${data.universe_size ?? "—"}</div>
      </div>
    </section>
  `;
}

function bulletList(items, color) {
  if (!Array.isArray(items) || !items.length) return "";
  return `<ul style="margin:6px 0 0; padding-left:18px; color:${color || "var(--text-secondary)"};">` +
    items.map((t) => `<li style="margin-bottom:4px; line-height:1.5;">${escapeHtml(t)}</li>`).join("") +
    `</ul>`;
}

function renderStrategySection(data) {
  const s = data.strategy;
  if (!s) return "";
  return `
    <section data-section="strategy" data-test="multibagger-strategy" style="margin-bottom:24px; border:1px solid var(--bg-graphite); border-radius:8px; overflow:hidden;">
      <div style="padding:14px 16px; background:var(--bg-graphite);">
        <h3 style="margin:0; font-size:14px; font-weight:600;">Strategy &amp; reasoning</h3>
        <p style="margin:4px 0 0; font-size:12px; color:var(--text-muted);">${escapeHtml(s.headline || "")}</p>
      </div>
      <div style="padding:8px 16px 16px;">
        <details open style="margin-top:10px;">
          <summary style="cursor:pointer; font-size:12px; font-weight:600; color:#a78bfa;">How stocks are picked</summary>
          ${bulletList(s.how_stocks_are_picked)}
        </details>
        <details style="margin-top:10px;">
          <summary style="cursor:pointer; font-size:12px; font-weight:600; color:#a78bfa;">How sectors are picked</summary>
          ${bulletList(s.how_sectors_are_picked)}
        </details>
        <details style="margin-top:10px;">
          <summary style="cursor:pointer; font-size:12px; font-weight:600; color:#a78bfa;">What gets removed (hard gates)</summary>
          ${bulletList(s.what_gets_removed)}
        </details>
        <details style="margin-top:10px;">
          <summary style="cursor:pointer; font-size:12px; font-weight:600; color:#a78bfa;">The 5x mechanism</summary>
          ${bulletList(s.the_5x_mechanism)}
        </details>
        <details style="margin-top:10px;">
          <summary style="cursor:pointer; font-size:12px; font-weight:600; color:#f87171;">Pre-mortem — how this fails</summary>
          ${bulletList(s.pre_mortem, "#fca5a5")}
        </details>
        <div data-test="multibagger-honest-note" style="margin-top:14px; padding:10px 12px; background:rgba(248,113,113,0.08); border:1px solid rgba(248,113,113,0.25); border-radius:6px; font-size:12px; color:#fca5a5; line-height:1.5;">
          ${escapeHtml(s.honest_note || "")}
        </div>
      </div>
    </section>
  `;
}

function renderActionsSection(data) {
  return `
    <section data-section="actions" style="padding:16px; background:var(--bg-graphite); border-radius:8px; margin-bottom:24px;">
      <h3 style="margin:0 0 12px; font-size:14px; font-weight:600;">Today's Action</h3>
      <div style="color:var(--text-muted); font-size:13px;" data-test="multibagger-action-empty">
        No actions today. Pipeline contains ${data.verdicts?.five_x_count || 0} 5X_CANDIDATE and ${data.verdicts?.high_conviction_count || 0} HIGH_CONVICTION names. Open positions: ${data.portfolio_summary?.open_positions ?? 0}.
      </div>
    </section>
  `;
}

function renderPortfolioSection(data) {
  const open = data.portfolio_summary?.open_positions ?? 0;
  if (!open) {
    return `
      <section data-section="portfolio" style="margin-bottom:24px;">
        <h3 style="font-size:14px; font-weight:600; margin-bottom:8px;">Model portfolio</h3>
        <div data-test="multibagger-portfolio-empty" style="color:var(--text-muted); font-size:13px; padding:14px; background:var(--bg-graphite); border-radius:6px;">
          No positions yet. Open ${data.portfolio_summary?.starting_capital_inr ? fmtInr(data.portfolio_summary.starting_capital_inr) : "₹1L"} cash; ready to deploy on the first BUY action.
        </div>
      </section>
    `;
  }
  return `
    <section data-section="portfolio" style="margin-bottom:24px;">
      <h3 style="font-size:14px; font-weight:600; margin-bottom:8px;">Model portfolio (${open} open)</h3>
      <div style="color:var(--text-muted); font-size:13px;">Per-position live PnL surfacing arrives in PR 7 with mark-to-market wiring.</div>
    </section>
  `;
}

function renderPipelineSection(data) {
  const cands = data.top_candidates || [];
  if (!cands.length) {
    return `
      <section data-section="pipeline" style="margin-bottom:24px;">
        <h3 style="font-size:14px; font-weight:600; margin-bottom:8px;">5x Candidate pipeline</h3>
        <div style="color:var(--text-muted); font-size:13px;">No candidates available — refresh job may not have run.</div>
      </section>
    `;
  }
  const rows = cands.slice(0, 20).map((c, i) => `
    <tr>
      <td style="padding:6px 8px; font-size:11px; color:var(--text-muted);">${i + 1}</td>
      <td style="padding:6px 8px; font-weight:500;">${escapeHtml(c.ticker)}</td>
      <td style="padding:6px 8px; color:var(--text-muted); font-size:12px;">${escapeHtml(c.sector || "—")}</td>
      <td style="padding:6px 8px; text-align:right; font-weight:500;">${(c.score_0_100 ?? 0).toFixed(1)}</td>
      <td style="padding:6px 8px; text-align:right; font-size:11px;">
        <span data-test="verdict-pill" style="padding:2px 6px; border-radius:4px; background:${verdictColor(c.verdict)}; color:white;">${escapeHtml(c.verdict || "—")}</span>
      </td>
    </tr>
    <tr data-test="candidate-rationale-row">
      <td colspan="5" style="padding:0 8px 10px;">${renderCandidateRationale(c)}</td>
    </tr>
  `).join("");
  return `
    <section data-section="pipeline" style="margin-bottom:24px;">
      <h3 style="font-size:14px; font-weight:600; margin-bottom:8px;">5x Candidate pipeline (top ${Math.min(cands.length, 20)})</h3>
      <table data-test="multibagger-candidate-table" style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead><tr style="border-bottom:1px solid var(--bg-graphite);">
          <th style="padding:6px 8px; text-align:left; font-weight:600; color:var(--text-muted);">#</th>
          <th style="padding:6px 8px; text-align:left; font-weight:600; color:var(--text-muted);">Ticker</th>
          <th style="padding:6px 8px; text-align:left; font-weight:600; color:var(--text-muted);">Sector</th>
          <th style="padding:6px 8px; text-align:right; font-weight:600; color:var(--text-muted);">Score</th>
          <th style="padding:6px 8px; text-align:right; font-weight:600; color:var(--text-muted);">Verdict</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderCandidateRationale(c) {
  const r = c.rationale;
  if (!r) return `<span style="font-size:11px; color:var(--text-muted);">No rationale available.</span>`;
  const why = (r.why_picked || []).map((t) => `<li style="margin-bottom:3px;">${escapeHtml(t)}</li>`).join("");
  const bear = (r.bear_case || []).map((t) => `<li style="margin-bottom:3px;">${escapeHtml(t)}</li>`).join("");
  return `
    <details style="font-size:12px;">
      <summary style="cursor:pointer; color:#a78bfa; font-size:11px;">Why this pick + bear case</summary>
      <div style="padding:8px 0 4px;">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:#34d399; margin-bottom:2px;">Bull case</div>
        <ul style="margin:0 0 8px; padding-left:18px; color:var(--text-secondary); line-height:1.5;">${why || "<li>Composite score across 12 factors.</li>"}</ul>
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:#f87171; margin-bottom:2px;">Bear case</div>
        <ul style="margin:0 0 8px; padding-left:18px; color:#fca5a5; line-height:1.5;">${bear}</ul>
        <div style="font-size:11px; color:var(--text-muted); font-style:italic;">${escapeHtml(r.target_multiple_rationale || "")}</div>
      </div>
    </details>
  `;
}

function verdictColor(v) {
  return v === "5X_CANDIDATE" ? "#a78bfa"
       : v === "HIGH_CONVICTION" ? "#34d399"
       : v === "WATCH" ? "#fbbf24"
       : v === "HARD_REJECT" ? "#f87171"
       : "#64748b";
}

function renderCatalystSection(data) {
  const slate = data.catalyst_slate || [];
  if (!slate.length) {
    return `
      <section data-section="catalyst" style="margin-bottom:24px;">
        <h3 style="font-size:14px; font-weight:600; margin-bottom:8px;">Catalyst slate (Pillar 2)</h3>
        <div style="color:var(--text-muted); font-size:13px;">Empty — no earnings BEAT / dividend / block-deal triggers today.</div>
      </section>
    `;
  }
  const rows = slate.map((s) => `
    <li style="padding:6px 0; border-bottom:1px solid var(--bg-graphite); font-size:13px;">
      <strong>${escapeHtml(s.symbol || s.ticker)}</strong>
      <span style="color:var(--text-muted); font-size:11px; margin-left:8px;">${escapeHtml(s.type)}</span>
    </li>
  `).join("");
  return `
    <section data-section="catalyst" style="margin-bottom:24px;">
      <h3 style="font-size:14px; font-weight:600; margin-bottom:8px;">Catalyst slate (Pillar 2)</h3>
      <ul style="list-style:none; padding:0; margin:0;">${rows}</ul>
    </section>
  `;
}

function renderHealthSection(data) {
  const alerts = data.health?.alerts || [];
  if (!alerts.length) {
    return `<section data-section="health" data-test="multibagger-health-clean" style="font-size:11px; color:var(--text-muted);">Health: clean · no alerts.</section>`;
  }
  const rows = alerts.map((a) => `<li style="font-size:11px; color:#fbbf24;">${escapeHtml(a)}</li>`).join("");
  return `
    <section data-section="health" style="margin-top:8px;">
      <h3 style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">Health alerts</h3>
      <ul style="list-style:disc; padding-left:18px; margin:0;">${rows}</ul>
    </section>
  `;
}

// Expose to global so TAB_CONFIG.enter() can call it.
window.loadMultibaggerLab = loadMultibaggerLab;
