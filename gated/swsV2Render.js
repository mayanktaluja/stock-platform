/* eslint-disable no-undef */
// SWS rendering augmentations — small extension layer on top of app.js.
//
// History: this file used to monkey-patch swsReasonRow / swsHoldingRow
// with v2-recommendation rendering. As of PR-2 (analyzer 10/10 plan),
// swsReasonRow in app.js is the canonical card and absorbs the
// conviction badge / layer votes / narrative paragraphs / counter-thesis
// / peer chip natively. The only behaviour kept here is the Tier-A
// sector-wipeout banner — it augments renderSWSTierA without overriding
// any per-row content, so it stays as a pure additive override.

(function () {
  if (typeof window === "undefined") return;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Surface the sector-wipeout banner above Tier A when present. Hooks
  // into renderSWSTierA if available; otherwise no-op.
  const originalRenderSWSTierA = window.renderSWSTierA;
  if (typeof originalRenderSWSTierA === "function") {
    window.renderSWSTierA = function renderSWSTierAWipeout(tier) {
      const base = originalRenderSWSTierA(tier);
      const wipes = tier?.sector_wipeouts || [];
      if (wipes.length === 0) return base;
      const banner = `<div style="margin-bottom:12px; padding:10px 14px; background:rgba(250,204,21,0.10); border:1px solid rgba(250,204,21,0.35); border-radius:6px; font-size:12px; color:var(--yellow-bright);">
        <strong>⚠ Sector-wipeout warning:</strong>
        ${wipes.map((w) => `${escapeHtml(w.sector)} (${w.affected_tickers.join(", ")})`).join("; ")}
        — these reductions would leave your portfolio with zero exposure to the named sector. Consider partial trim or rotate within sector.
      </div>`;
      return banner + base;
    };
  }
})();
