/* eslint-disable no-undef */
// v2 SWS renderer — standalone module. Loaded AFTER app.js, monkey-patches
// the existing swsReasonRow() / swsHoldingRow() globals to surface the v2
// recommendation block (conviction badge, 3-paragraph narrative,
// counter-thesis expander, peer-substitute chip).
//
// Integration (when ready — left as a manual step to avoid colliding with
// in-flight WIP on public/app.js / public/index.html):
//
//   <script src="app.js"></script>
//   <script src="swsV2Render.js"></script>
//
// Activates only when SWS engine response carries `sws.v2_recommendation`
// (env: RECOMMENDER_VERSION ≠ v1). Falls back silently to v1 render
// otherwise.

(function () {
  if (typeof window === "undefined") return;

  const CONVICTION_COLORS = {
    HIGH: { bg: "rgba(34,197,94,0.18)",   border: "rgba(34,197,94,0.6)",   text: "#86efac" },
    "MEDIUM-HIGH": { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.4)",   text: "#86efac" },
    MEDIUM: { bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.4)", text: "#cbd5e1" },
    "MEDIUM-LOW": { bg: "rgba(250,204,21,0.10)", border: "rgba(250,204,21,0.4)",  text: "#fde047" },
    LOW: { bg: "rgba(239,68,68,0.10)",   border: "rgba(239,68,68,0.4)",   text: "#fca5a5" },
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function convictionBadge(rec) {
    if (!rec || !rec.conviction) return "";
    const c = CONVICTION_COLORS[rec.conviction] || CONVICTION_COLORS.MEDIUM;
    const layerCount = rec.net_delta != null
      ? `Δ${rec.net_delta > 0 ? "+" : ""}${rec.net_delta}`
      : "—";
    return `<span style="display:inline-block; padding:3px 8px; border-radius:4px; background:${c.bg}; border:1px solid ${c.border}; color:${c.text}; font-size:10px; font-weight:700; letter-spacing:0.3px; margin-left:6px;" title="Net layer delta from cross-check + catalyst + India-risk votes">${rec.conviction} · ${layerCount}</span>`;
  }

  function layerVoteIcons(rec) {
    if (!rec || !rec.layer_votes) return "";
    const icon = (v) => v > 0 ? "↑" : v < 0 ? "↓" : "→";
    const color = (v) => v > 0 ? "#86efac" : v < 0 ? "#fca5a5" : "#94a3b8";
    const layers = [
      { k: "Cross-check", v: rec.layer_votes.crosscheck },
      { k: "Catalyst", v: rec.layer_votes.catalyst },
      { k: "India-risk", v: rec.layer_votes.indianRisk },
    ];
    return `<div style="margin-top:6px; display:inline-flex; gap:8px; font-size:11px;">
      ${layers.map((l) => `<span title="${escapeHtml(l.k)} layer vote" style="color:${color(l.v)};">${escapeHtml(l.k)} ${icon(l.v)}</span>`).join("")}
    </div>`;
  }

  function narrativeBlock(rec) {
    if (!rec || !Array.isArray(rec.narrative_paragraphs)) return "";
    return rec.narrative_paragraphs.map((p, i) => {
      // Each paragraph already includes inline **bold** markdown — render
      // those as <strong>. Keep the rest as plaintext for safety (no
      // dynamic <a>/<img> from user-controlled data).
      const html = escapeHtml(p)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(•[^•\n]+)/g, '<div style="margin-top:4px;">$1</div>');
      return `<p style="margin:${i === 0 ? "10px" : "12px"} 0 0 0; font-size:12px; line-height:1.55; color:var(--text);">${html}</p>`;
    }).join("");
  }

  function counterThesisBlock(rec) {
    if (!rec || (!rec.counter_thesis && !rec.falsification_trigger)) return "";
    const ct = escapeHtml(rec.counter_thesis || "");
    const ft = escapeHtml(rec.falsification_trigger || "")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return `<details style="margin-top:10px; background:rgba(0,0,0,0.18); border:1px solid #1f2937; border-radius:6px; padding:8px 12px;">
      <summary style="cursor:pointer; font-size:11px; color:var(--text-muted); letter-spacing:0.3px;">▸ Counter-thesis &amp; falsification trigger</summary>
      ${ct ? `<p style="margin:8px 0 4px; font-size:12px; line-height:1.5;">${ct}</p>` : ""}
      ${ft ? `<p style="margin:8px 0 0; font-size:11.5px; line-height:1.5; color:var(--text-muted);">${ft}</p>` : ""}
    </details>`;
  }

  function peerChip(holding) {
    const peer = holding?.sws?.peer_substitute;
    if (!peer || !peer.top_peer) return "";
    const top = peer.top_peer;
    const safeTk = escapeHtml(top.ticker);
    const safeWhy = escapeHtml(top.why);
    return `<div style="margin-top:8px; padding:6px 10px; background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.25); border-radius:5px; font-size:11px; cursor:pointer;" onclick="openSwsModal('${safeTk}')" title="Same-sector peer with higher v3 — consider as rotation candidate">
      <strong style="color:#93c5fd;">↻ Peer: ${safeTk}</strong> <span style="color:var(--text-muted);">— ${safeWhy}</span>
    </div>`;
  }

  // Replacement for the existing swsReasonRow (in app.js). When
  // sws.v2_recommendation is present, render the v2 card; otherwise call
  // the original v1 renderer so unmigrated views still work.
  const originalSwsReasonRow = window.swsReasonRow;

  window.swsReasonRow = function swsReasonRowV2(h) {
    const rec = h?.sws?.v2_recommendation;
    if (!rec) return typeof originalSwsReasonRow === "function" ? originalSwsReasonRow(h) : "";
    const tk = h.sws?.ticker || h.symbol || "—";
    return `<div style="margin-top:10px; background:rgba(255,255,255,0.025); border:1px solid #1f2937; border-radius:8px; padding:12px 14px;">
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <strong style="color:var(--text); font-size:12px;">${escapeHtml(tk)}</strong>
        <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.4px;">v2 recommendation</span>
        ${convictionBadge(rec)}
      </div>
      ${layerVoteIcons(rec)}
      ${narrativeBlock(rec)}
      ${peerChip(h)}
      ${counterThesisBlock(rec)}
    </div>`;
  };

  // Augment the holding-row action badge with a small conviction dot
  // (LOW = red dot, HIGH = green dot, etc.). Keeps the badge compact —
  // the full conviction tag lives in the reason row card.
  const originalSwsHoldingRow = window.swsHoldingRow;
  if (typeof originalSwsHoldingRow === "function") {
    window.swsHoldingRow = function swsHoldingRowV2(h) {
      const html = originalSwsHoldingRow(h);
      const rec = h?.sws?.v2_recommendation;
      if (!rec || !rec.conviction) return html;
      const c = CONVICTION_COLORS[rec.conviction] || CONVICTION_COLORS.MEDIUM;
      const dot = `<span style="display:inline-block; width:6px; height:6px; border-radius:3px; background:${c.text}; margin-left:6px; vertical-align:middle;" title="v2 conviction: ${rec.conviction}"></span>`;
      // Inject the dot right after the action badge's </span>. Best-effort
      // string match — falls through harmlessly if the markup changes.
      return html.replace(
        /(<span[^>]*>(?:EXIT|Reduction-50%|Reduction-25-33%|HOLD|Top-up-modest|Top-up|STRONG Top-up)<\/span>)/,
        (m) => m + dot,
      );
    };
  }

  // Surface the sector-wipeout banner above Tier A when present. Hooks
  // into renderSWSTierA if available; otherwise no-op.
  const originalRenderSWSTierA = window.renderSWSTierA;
  if (typeof originalRenderSWSTierA === "function") {
    window.renderSWSTierA = function renderSWSTierAV2(tier) {
      const base = originalRenderSWSTierA(tier);
      const wipes = tier?.sector_wipeouts || [];
      if (wipes.length === 0) return base;
      const banner = `<div style="margin-bottom:12px; padding:10px 14px; background:rgba(250,204,21,0.10); border:1px solid rgba(250,204,21,0.35); border-radius:6px; font-size:12px; color:#fde047;">
        <strong>⚠ Sector-wipeout warning:</strong>
        ${wipes.map((w) => `${escapeHtml(w.sector)} (${w.affected_tickers.join(", ")})`).join("; ")}
        — these reductions would leave your portfolio with zero exposure to the named sector. Consider partial trim or rotate within sector.
      </div>`;
      return banner + base;
    };
  }

  console.log("[swsV2Render] active — v2 recommendation cards enabled");
})();
