/**
 * Risk Lab (experimental) — UI renderer.
 *
 * Read-only side-by-side view of original SWS picks vs lab-adjusted views.
 * Two lenses: Macro (geopolitical/regime overlay) and Quality (KEC-style
 * earnings-quality flags). No production picks/scoring is modified — this
 * tab is a hypothesis viewer for the user to evaluate whether the overlay
 * theory holds before any migration into core.
 *
 * Data source: /api/risk-lab/picks-adjusted (PR 8).
 * Per-user toggle: localStorage.riskLabEnabled === "false" → hides the
 * tab button entirely (lab still produces data; just the UI is hidden).
 */
(function () {
  "use strict";

  const ROOT_ID = "riskLabRoot";
  const STORAGE_KEY = "riskLabEnabled";
  let _cache = null;
  let _activeLens = "quality"; // start with Quality Lens — the KEC case is fresher

  // ─── Per-user toggle (hide the tab if user disabled it locally) ─────
  function isUserEnabled() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v !== "false";
    } catch {
      return true;
    }
  }

  function applyUserToggleOnBoot() {
    const btn = document.getElementById("riskLabTabBtn");
    if (!btn) return;
    if (!isUserEnabled()) {
      btn.style.display = "none";
    }
  }

  // Run on load — defer to next tick so DOM is parsed
  setTimeout(applyUserToggleOnBoot, 0);

  // ─── Helpers ────────────────────────────────────────────────────────
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "style" && typeof v === "object") {
          Object.assign(node.style, v);
        } else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === "className") {
          node.className = v;
        } else if (v !== undefined && v !== null) {
          node.setAttribute(k, v);
        }
      }
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      if (typeof c === "string" || typeof c === "number") {
        node.appendChild(document.createTextNode(String(c)));
      } else {
        node.appendChild(c);
      }
    }
    return node;
  }

  function fmtScore(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
    return Number(n).toFixed(1);
  }

  function fmtDelta(n) {
    if (!Number.isFinite(Number(n))) return "0";
    const v = Number(n);
    if (v === 0) return "0";
    return v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
  }

  function fmtVerdict(v) {
    if (!v) return "—";
    return String(v).replace(/_/g, " ");
  }

  function colorForDelta(n) {
    const v = Number(n || 0);
    if (v < -2) return "#ef4444";
    if (v < 0) return "#f59e0b";
    if (v > 2) return "#10b981";
    if (v > 0) return "#84cc16";
    return "var(--text-muted)";
  }

  function colorForQuality(verdict) {
    return {
      HIGH: "#10b981",
      MEDIUM: "#f59e0b",
      LOW: "#ef4444",
      INSUFFICIENT_DATA: "var(--text-muted)",
    }[verdict] || "var(--text-muted)";
  }

  // ─── Loader ─────────────────────────────────────────────────────────
  async function loadPayload() {
    if (_cache) return _cache;
    const res = await fetch("/api/risk-lab/picks-adjusted");
    if (res.status === 404) throw new Error("Risk Lab is currently disabled (RISK_LAB_ENABLED=false)");
    if (res.status === 503) throw new Error("Risk Lab data not yet generated — run scripts/refresh-risk-lab.mjs");
    if (!res.ok) throw new Error(`API error ${res.status}`);
    _cache = await res.json();
    return _cache;
  }

  // ─── Renderers ──────────────────────────────────────────────────────
  function renderBanner(payload) {
    const s = payload.summary || {};
    const regime = payload.regime || {};
    const regimeBadge = regime.regime
      ? el("span", {
          style: {
            background: regime.regime === "CALM" ? "rgba(132,204,22,0.15)" : "rgba(239,68,68,0.15)",
            color: regime.regime === "CALM" ? "#84cc16" : "#ef4444",
            padding: "3px 10px",
            borderRadius: "12px",
            fontSize: "11px",
            fontWeight: "600",
            letterSpacing: "0.04em",
          },
        }, `${regime.regimeLabel || regime.regime} · sev ${regime.severity || "?"}`)
      : el("span", { style: { color: "var(--text-muted)" } }, "regime unavailable");

    const subnote = payload.source_regime_generated_at
      ? `regime generated ${new Date(payload.source_regime_generated_at).toLocaleString()}`
      : "regime source missing";

    return el(
      "div",
      {
        style: {
          padding: "16px 18px",
          background: "rgba(20,30,50,0.6)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "10px",
          marginBottom: "18px",
          display: "flex",
          flexWrap: "wrap",
          gap: "20px",
          alignItems: "center",
          justifyContent: "space-between",
        },
      },
      el("div", null,
        el("div", { style: { fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" } },
          "Current Regime"),
        el("div", { style: { marginTop: "4px", display: "flex", alignItems: "center", gap: "10px" } },
          regimeBadge,
          el("span", { style: { fontSize: "11px", color: "var(--text-muted)" } }, subnote),
        ),
      ),
      el("div", { style: { display: "flex", gap: "16px", flexWrap: "wrap" } },
        statChip("Total stocks", s.total_stocks),
        statChip("Macro flagged", s.macro_flagged_count, "#f59e0b"),
        statChip("Macro vetoed", s.macro_vetoed_count, "#ef4444"),
        statChip("Quality flagged", s.quality_flagged_count, "#f59e0b"),
        statChip("Quality vetoed", s.quality_vetoed_count, "#ef4444"),
        statChip("Low quality", s.low_quality_count, "#ef4444"),
      ),
    );
  }

  function statChip(label, value, accent) {
    return el(
      "div",
      { style: { textAlign: "right" } },
      el("div", { style: { fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" } }, label),
      el("div", { style: { fontSize: "18px", fontWeight: "600", color: accent || "var(--text-primary)", marginTop: "2px" } }, value ?? 0),
    );
  }

  function renderLensTabs() {
    const lensBtn = (id, label) => el(
      "button",
      {
        className: `risk-lab-lens-btn${_activeLens === id ? " active" : ""}`,
        style: {
          padding: "8px 16px",
          background: _activeLens === id ? "rgba(96,165,250,0.15)" : "transparent",
          color: _activeLens === id ? "#60a5fa" : "var(--text-muted)",
          border: `1px solid ${_activeLens === id ? "rgba(96,165,250,0.35)" : "rgba(255,255,255,0.08)"}`,
          borderRadius: "6px",
          cursor: "pointer",
          fontSize: "12px",
          fontWeight: "500",
          letterSpacing: "0.04em",
        },
        onClick: () => { _activeLens = id; render(); },
      },
      label,
    );

    return el(
      "div",
      { style: { display: "flex", gap: "8px", marginBottom: "16px" } },
      lensBtn("quality", "Quality Lens"),
      lensBtn("macro", "Macro Lens"),
      lensBtn("combined", "Combined view"),
    );
  }

  function renderCaseStudy(payload) {
    // ANANTRAJ-class + KEC-class spotlight stocks — pulled directly from the
    // adjusted picks list. Shows the user "this is what the lab caught that
    // production missed".
    const stocks = payload.stocks || [];
    const macroNotables = stocks
      .filter((s) => Number(s.macro_score_delta || 0) < 0)
      .sort((a, b) => Number(a.macro_score_delta || 0) - Number(b.macro_score_delta || 0))
      .slice(0, 3);
    const qualityNotables = stocks
      .filter((s) => s.quality_veto?.vetoed || (s.quality_verdict === "LOW" && s.original_verdict === "TOP_PICK"))
      .sort((a, b) => Number(a.quality_score_delta || 0) - Number(b.quality_score_delta || 0))
      .slice(0, 3);

    function studyBlock(title, subtitle, list, lensType) {
      if (list.length === 0) {
        return el(
          "div",
          { style: { padding: "14px 16px", background: "rgba(20,30,50,0.4)", borderRadius: "8px", flex: "1" } },
          el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "4px" } }, title),
          el("div", { style: { fontSize: "11px", color: "var(--text-muted)" } }, "No notable cases in current snapshot."),
        );
      }
      return el(
        "div",
        { style: { padding: "14px 16px", background: "rgba(20,30,50,0.4)", borderRadius: "8px", flex: "1" } },
        el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "2px" } }, title),
        el("div", { style: { fontSize: "11px", color: "var(--text-muted)", marginBottom: "10px" } }, subtitle),
        ...list.map((s) => el(
          "div",
          { style: { display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: "12px" } },
          el("span", { style: { fontWeight: "500" } }, s.ticker || "?"),
          el("span", { style: { color: colorForDelta(lensType === "macro" ? s.macro_score_delta : s.quality_score_delta) } },
            `${fmtDelta(lensType === "macro" ? s.macro_score_delta : s.quality_score_delta)} → ${fmtVerdict(lensType === "macro" ? s.macro_adjusted_verdict : s.quality_adjusted_verdict)}`),
        )),
      );
    }

    return el(
      "div",
      { style: { display: "flex", gap: "14px", marginBottom: "20px", flexWrap: "wrap" } },
      studyBlock("Macro lens — top discounted", "Stocks where the regime overlay imposed the largest negative delta.", macroNotables, "macro"),
      studyBlock("Quality lens — KEC-class traps", "TOP_PICKs the Quality Lens would have flagged. Each has 3+ quality red flags in SWS data.", qualityNotables, "quality"),
    );
  }

  function renderTable(payload) {
    const stocks = payload.stocks || [];
    let filtered;

    if (_activeLens === "macro") {
      filtered = stocks
        .filter((s) => Number(s.macro_score_delta || 0) !== 0 || s.macro_veto?.vetoed)
        .sort((a, b) => Number(a.macro_score_delta || 0) - Number(b.macro_score_delta || 0));
    } else if (_activeLens === "quality") {
      filtered = stocks
        .filter((s) => (s.quality_flags?.length || 0) > 0 || s.quality_veto?.vetoed)
        .sort((a, b) => Number(a.quality_score_delta || 0) - Number(b.quality_score_delta || 0));
    } else {
      // combined — show anything with either macro or quality movement
      filtered = stocks
        .filter((s) => Number(s.macro_score_delta || 0) !== 0 || (s.quality_flags?.length || 0) > 0)
        .sort((a, b) => {
          const aD = Number(a.macro_score_delta || 0) + Number(a.quality_score_delta || 0);
          const bD = Number(b.macro_score_delta || 0) + Number(b.quality_score_delta || 0);
          return aD - bD;
        });
    }

    if (filtered.length === 0) {
      return el(
        "div",
        { style: { padding: "30px", textAlign: "center", color: "var(--text-muted)" } },
        "No stocks fire the current lens. Try another lens or wait for the next macro refresh.",
      );
    }

    const header = el(
      "div",
      {
        style: {
          display: "grid",
          gridTemplateColumns: "100px 120px 80px 80px 100px 1fr",
          gap: "8px",
          padding: "10px 12px",
          background: "rgba(20,30,50,0.6)",
          borderRadius: "6px",
          marginBottom: "4px",
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-muted)",
        },
      },
      el("div", null, "Ticker"),
      el("div", null, "Original Verdict"),
      el("div", { style: { textAlign: "right" } }, "Orig Score"),
      el("div", { style: { textAlign: "right" } }, _activeLens === "macro" ? "Macro Δ" : _activeLens === "quality" ? "Quality Δ" : "Combined Δ"),
      el("div", null, "Adjusted"),
      el("div", null, "Reason / Flags"),
    );

    const rows = filtered.slice(0, 100).map((s) => renderRow(s));

    return el(
      "div",
      null,
      header,
      ...rows,
      filtered.length > 100
        ? el("div", { style: { padding: "12px", textAlign: "center", fontSize: "11px", color: "var(--text-muted)" } },
            `Showing first 100 of ${filtered.length} matches (sorted by worst delta).`)
        : null,
    );
  }

  function renderRow(s) {
    const delta = _activeLens === "macro"
      ? Number(s.macro_score_delta || 0)
      : _activeLens === "quality"
        ? Number(s.quality_score_delta || 0)
        : Number(s.macro_score_delta || 0) + Number(s.quality_score_delta || 0);
    const adjVerdict = _activeLens === "macro"
      ? s.macro_adjusted_verdict
      : _activeLens === "quality"
        ? s.quality_adjusted_verdict
        : (s.quality_veto?.vetoed || s.macro_veto?.vetoed
            ? "RISK HOLD"
            : s.quality_adjusted_verdict || s.macro_adjusted_verdict);

    // Build reason / flags chip list
    const chips = [];
    if (_activeLens === "macro" || _activeLens === "combined") {
      if (s.macro_veto?.vetoed) {
        chips.push(chip("MACRO VETO", "#ef4444"));
      }
      if (s.sector_used && s.macro_score_delta) {
        chips.push(chip(`${s.sector_used} ${fmtDelta(s.macro_score_delta)}`, colorForDelta(s.macro_score_delta)));
      }
    }
    if (_activeLens === "quality" || _activeLens === "combined") {
      if (s.quality_veto?.vetoed) {
        chips.push(chip("QUALITY VETO", "#ef4444"));
      }
      if (s.quality_verdict && s.quality_verdict !== "HIGH") {
        chips.push(chip(s.quality_verdict, colorForQuality(s.quality_verdict)));
      }
      for (const f of (s.quality_flags || []).slice(0, 4)) {
        const label = f.category || f.type || f.overlay || "flag";
        chips.push(chip(label, colorForDelta(f.severity)));
      }
      if ((s.quality_flags || []).length > 4) {
        chips.push(chip(`+${s.quality_flags.length - 4}`, "var(--text-muted)"));
      }
    }

    return el(
      "div",
      {
        style: {
          display: "grid",
          gridTemplateColumns: "100px 120px 80px 80px 100px 1fr",
          gap: "8px",
          padding: "10px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          fontSize: "12px",
          alignItems: "center",
        },
      },
      el("div", { style: { fontWeight: "600" } }, s.ticker || "?"),
      el("div", { style: { color: "var(--text-muted)" } }, fmtVerdict(s.original_verdict)),
      el("div", { style: { textAlign: "right" } }, fmtScore(s.original_score)),
      el("div", { style: { textAlign: "right", color: colorForDelta(delta) } }, fmtDelta(delta)),
      el("div", { style: { color: adjVerdict?.includes("HOLD") || adjVerdict?.includes("VETO") ? "#ef4444" : "var(--text-primary)" } },
        fmtVerdict(adjVerdict)),
      el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } }, ...chips),
    );
  }

  function chip(text, color) {
    return el("span", {
      style: {
        padding: "2px 8px",
        background: `${color}22`,
        color,
        borderRadius: "10px",
        fontSize: "10px",
        fontWeight: "500",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      },
    }, text);
  }

  function renderUserToggle() {
    return el(
      "div",
      { style: { marginTop: "24px", paddingTop: "16px", borderTop: "1px solid rgba(255,255,255,0.06)", fontSize: "11px", color: "var(--text-muted)" } },
      "Risk Lab is experimental and does not affect production picks. ",
      el("a", {
        href: "#",
        style: { color: "#60a5fa", marginLeft: "6px" },
        onClick: (e) => {
          e.preventDefault();
          try {
            localStorage.setItem(STORAGE_KEY, "false");
          } catch {}
          const btn = document.getElementById("riskLabTabBtn");
          if (btn) btn.style.display = "none";
          // Send the user back to the default Picks tab
          if (typeof switchTab === "function") switchTab("picks");
        },
      }, "Hide this tab"),
      el("span", { style: { marginLeft: "10px" } }, " · Re-enable by clearing localStorage.riskLabEnabled in dev console."),
    );
  }

  // ─── Top-level render ───────────────────────────────────────────────
  function render() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    if (!_cache) {
      root.innerHTML = "";
      root.appendChild(el("div", { className: "loading" },
        el("div", { className: "loading-spinner" }),
        el("div", { className: "loading-text" }, "Loading Risk Lab…"),
      ));
      return;
    }
    root.innerHTML = "";
    root.appendChild(renderBanner(_cache));
    root.appendChild(renderCaseStudy(_cache));
    root.appendChild(renderLensTabs());
    root.appendChild(renderTable(_cache));
    root.appendChild(renderUserToggle());
  }

  // ─── Public entry point (called from app.js switchTab) ──────────────
  async function loadRiskLab() {
    try {
      render(); // show loading state
      await loadPayload();
      render();
    } catch (err) {
      const root = document.getElementById(ROOT_ID);
      if (root) {
        root.innerHTML = "";
        root.appendChild(el("div", { style: { padding: "30px", textAlign: "center" } },
          el("div", { style: { fontSize: "14px", color: "#ef4444", marginBottom: "8px" } }, "Risk Lab unavailable"),
          el("div", { style: { fontSize: "12px", color: "var(--text-muted)" } }, err.message || String(err)),
        ));
      }
    }
  }

  // Expose to app.js (it calls window.loadRiskLab in switchTab)
  window.loadRiskLab = loadRiskLab;
})();
