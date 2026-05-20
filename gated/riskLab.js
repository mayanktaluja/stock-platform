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
  // STORAGE_KEY bumped to v2 (2026-05-19) so any stale "false" value
  // from the original key — including an accidental click on the
  // in-tab "Hide Risk Lab tab for me" button before Phase 2 promoted
  // the Macro Thesis sub-view — is ignored. Users who deliberately
  // hide the tab from now on use the new key; the orphaned `riskLabEnabled`
  // entry sits harmlessly in their localStorage and gets garbage-
  // collected when they clear site data.
  const STORAGE_KEY = "riskLabEnabled_v2";
  let _cache = null;
  let _activeLens = "quality"; // start with Quality Lens — the KEC case is fresher
  // Per-column sort + expand state. Both ephemeral (no localStorage), both
  // reset on lens switch (delta getter is lens-specific; filter set differs).
  let _sortState = { key: null, dir: null };
  let _showAll = false;
  // Search query persists across lens switches — ticker/flag text has the
  // same meaning regardless of which lens is active, so resetting would
  // surprise users mid-search. Debounce timer batches keystrokes into one
  // re-render so 1884-row Combined lens stays smooth.
  //
  // UI/UX overhaul 2026-05-19 — also persisted to localStorage so a tab
  // away + back doesn't drop the query the user typed.
  const RISKLAB_SEARCH_KEY = "risklab.search.v1";
  function loadRiskLabSearch() {
    try { return localStorage.getItem(RISKLAB_SEARCH_KEY) || ""; } catch { return ""; }
  }
  function saveRiskLabSearch(q) {
    try {
      if (q) localStorage.setItem(RISKLAB_SEARCH_KEY, q);
      else localStorage.removeItem(RISKLAB_SEARCH_KEY);
    } catch {}
  }
  let _searchQuery = loadRiskLabSearch();
  let _searchDebounceTimer = null;

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

  // Verdict ladder mirrors services/swsScoring.js:375-381.
  function verdictRank(v) {
    return { TOP_PICK: 5, STRONG: 4, ACCEPTABLE: 3, WATCH: 2, AVOID: 1 }[v] ?? 0;
  }
  // Hold-states bucket below AVOID — sorting desc on Adjusted groups them at the bottom.
  function adjustedRank(v) {
    if (v === "MACRO_HOLD" || v === "QUALITY_HOLD" || v === "RISK HOLD") return -1;
    return verdictRank(v);
  }

  function cycleSort(key) {
    if (_sortState.key !== key) _sortState = { key, dir: "desc" };
    else if (_sortState.dir === "desc") _sortState = { key, dir: "asc" };
    else _sortState = { key: null, dir: null };
    render();
  }

  // DOM-friendly counterpart to app.js's infoIcon(termId) — the lab builds
  // its UI via document.createElement, so it can't consume the string-based
  // helper. Returns a real DOM node compatible with appendChild + el()
  // children. The platform-wide delegated tooltip listener at
  // gated/app.js:638 picks up any .info-icon / [data-term-id] automatically.
  function infoBubble(termId) {
    if (!termId || !window.GLOSSARY || !window.GLOSSARY[termId]) return null;
    const def = window.GLOSSARY[termId];
    return el("span", {
      className: "info-icon",
      "data-term-id": termId,
      tabindex: "0",
      "aria-label": `Info: ${def.term || termId}`,
    }, "i");
  }

  // Case-insensitive substring match across ticker + verdicts + flag categories
  // + sector. Reads raw fields (not fmtVerdict output) so "QUALITY_HOLD" and
  // "RISK HOLD" both match a query of "hold".
  function matchesSearch(s, q) {
    if (!q) return true;
    const haystack = [
      s.ticker,
      s.name,
      s.original_verdict,
      s.macro_adjusted_verdict,
      s.quality_adjusted_verdict,
      s.quality_verdict,
      s.sector_used,
      ...(s.quality_flags || []).flatMap((f) => [f.category, f.type, f.overlay]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }

  function updateSearch(value) {
    _searchQuery = value;
    // Persist on the leading edge so a tab-away mid-debounce still saves
    // whatever the user typed; the trailing render() does not need the
    // saved value.
    saveRiskLabSearch(_searchQuery);
    if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => {
      _searchDebounceTimer = null;
      render();
    }, 150);
  }

  function sortHeader(label, key, align, termId) {
    const isActive = _sortState.key === key;
    const arrow = isActive ? (_sortState.dir === "desc" ? " ↓" : " ↑") : "";
    const wrapper = el("div", {
      "data-testid": `risk-lab-header-${key}`,
      role: "button",
      tabindex: "0",
      "aria-sort": isActive ? (_sortState.dir === "desc" ? "descending" : "ascending") : "none",
      style: {
        cursor: "pointer",
        textAlign: align || "left",
        userSelect: "none",
        color: isActive ? "#60a5fa" : "var(--text-muted)",
      },
      onClick: (e) => {
        // Don't trigger sort if the user clicked the info bubble — that has
        // its own tooltip behaviour handled by the delegated listener.
        if (e.target.closest("[data-term-id]")) return;
        cycleSort(key);
      },
    }, label + arrow);
    const bubble = infoBubble(termId);
    if (bubble) wrapper.appendChild(bubble);
    return wrapper;
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

  // PR B3 — separate cache for the macro-thesis payload (different shape;
  // loaded only when the user opens the Thesis lens to avoid the extra
  // ~50KB on every Risk Lab tab visit).
  let _thesisCache = null;
  async function loadThesisPayload() {
    if (_thesisCache) return _thesisCache;
    try {
      const res = await fetch("/api/risk-lab/macro-thesis");
      if (res.status === 404 || res.status === 503) {
        _thesisCache = { _missing: true, message: res.status === 503 ? "macro-thesis-latest.json not yet generated" : "Risk Lab disabled" };
        return _thesisCache;
      }
      if (!res.ok) {
        _thesisCache = { _missing: true, message: `API error ${res.status}` };
        return _thesisCache;
      }
      _thesisCache = await res.json();
    } catch (err) {
      _thesisCache = { _missing: true, message: err.message || String(err) };
    }
    return _thesisCache;
  }

  // ─── Renderers ──────────────────────────────────────────────────────
  function renderBanner(payload) {
    const s = payload.summary || {};
    const regime = payload.regime || {};
    const regimeTermId = typeof regimeIdFromLabel === "function" ? regimeIdFromLabel(regime.regime) : null;
    const regimeAttrs = {
      style: {
        background: regime.regime === "CALM" ? "rgba(132,204,22,0.15)" : "rgba(239,68,68,0.15)",
        color: regime.regime === "CALM" ? "#84cc16" : "#ef4444",
        padding: "3px 10px",
        borderRadius: "12px",
        fontSize: "11px",
        fontWeight: "600",
        letterSpacing: "0.04em",
      },
    };
    // If the regime maps to a glossary entry, wire the badge itself as an
    // invisible tooltip trigger. cursor:help hints hoverability without
    // adding a separate ⓘ glyph inside the badge's padding (would clash
    // with the badge's pill shape).
    if (regimeTermId && window.GLOSSARY && window.GLOSSARY[regimeTermId]) {
      regimeAttrs.className = "glossary-term";
      regimeAttrs["data-term-id"] = regimeTermId;
      regimeAttrs.style.cursor = "help";
    }
    const regimeBadge = regime.regime
      ? el("span", regimeAttrs, `${regime.regimeLabel || regime.regime} · sev ${regime.severity || "?"}`)
      : el("span", { style: { color: "var(--text-muted)" } }, "regime unavailable");

    const subnote = payload.source_regime_generated_at
      ? `regime generated ${new Date(payload.source_regime_generated_at).toLocaleString()}`
      : "regime source missing";

    const currentRegimeLabel = el("div", {
      style: { fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: "6px" },
    }, "Current Regime");
    const regimeSeverityBubble = infoBubble("regime_severity");
    if (regimeSeverityBubble) currentRegimeLabel.appendChild(regimeSeverityBubble);

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
        currentRegimeLabel,
        el("div", { style: { marginTop: "4px", display: "flex", alignItems: "center", gap: "10px" } },
          regimeBadge,
          el("span", { style: { fontSize: "11px", color: "var(--text-muted)" } }, subnote),
        ),
      ),
      el("div", { style: { display: "flex", gap: "16px", flexWrap: "wrap" } },
        statChip("Total stocks", s.total_stocks, null, "lab_total_stocks"),
        statChip("Macro flagged", s.macro_flagged_count, "#f59e0b", "lab_macro_flagged"),
        statChip("Macro vetoed", s.macro_vetoed_count, "#ef4444", "lab_macro_vetoed"),
        statChip("Quality flagged", s.quality_flagged_count, "#f59e0b", "lab_quality_flagged"),
        statChip("Quality vetoed", s.quality_vetoed_count, "#ef4444", "lab_quality_vetoed"),
        statChip("Low quality", s.low_quality_count, "#ef4444", "lab_low_quality"),
      ),
    );
  }

  function statChip(label, value, accent, termId) {
    const labelNode = el("div", {
      style: { fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", display: "inline-flex", alignItems: "center", gap: "5px" },
    }, label);
    const bubble = infoBubble(termId);
    if (bubble) labelNode.appendChild(bubble);
    return el(
      "div",
      { style: { textAlign: "right" } },
      labelNode,
      el("div", { style: { fontSize: "18px", fontWeight: "600", color: accent || "var(--text-primary)", marginTop: "2px" } }, value ?? 0),
    );
  }

  function renderLensTabs() {
    const lensBtn = (id, label, termId) => {
      const btn = el(
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
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          },
          onClick: (e) => {
            // Clicks landing on the info bubble should show its tooltip, not
            // switch lenses.
            if (e.target.closest("[data-term-id]")) return;
            _activeLens = id;
            _sortState = { key: null, dir: null };
            _showAll = false;
            render();
          },
        },
        label,
      );
      const bubble = infoBubble(termId);
      if (bubble) btn.appendChild(bubble);
      return btn;
    };

    return el(
      "div",
      { style: { display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" } },
      lensBtn("quality", "Quality Lens", "lens_quality"),
      lensBtn("macro", "Macro Lens", "lens_macro"),
      lensBtn("combined", "Combined view", "lens_combined"),
      lensBtn("thesis", "Macro Thesis", "lens_thesis"),
    );
  }

  // PR B3 — Macro Thesis renderer. Shows current regime, 4 scenario branches
  // (continue / escalate / de-escalate / new_shock), top beneficiaries with
  // pure-play stock candidates, top losers, position-cap warning, all caveats.
  function renderMacroThesis(thesis) {
    const root = el("div", { "data-testid": "macro-thesis-root", style: { padding: "8px 0" } });
    if (!thesis || thesis._missing) {
      root.appendChild(el("div", {
        style: { padding: "30px", textAlign: "center", color: "var(--text-muted)" },
      }, thesis?.message || "Macro Thesis data unavailable — run buildMacroThesis."));
      return root;
    }
    if (thesis.indeterminate) {
      root.appendChild(el("div", {
        style: { padding: "16px", border: "1px solid #fbbf24", borderRadius: "8px", marginBottom: "16px", color: "#fbbf24" },
      }, `INDETERMINATE — ${thesis.reason || "no actionable scenarios"}`));
    }
    // Regime banner
    const r = thesis.regime || {};
    // Helper for compact "<label> ⓘ" pairs used in the regime banner.
    const thesisLabel = (text, termId) => {
      const node = el("div", {
        style: { fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: "5px" },
      }, text);
      const bubble = infoBubble(termId);
      if (bubble) node.appendChild(bubble);
      return node;
    };
    const regimeTermId = typeof regimeIdFromLabel === "function" ? regimeIdFromLabel(r.regime) : null;
    const regimeValueAttrs = { style: { fontSize: "16px", fontWeight: "600", color: "#e2e8f0" } };
    if (regimeTermId && window.GLOSSARY && window.GLOSSARY[regimeTermId]) {
      regimeValueAttrs.className = "glossary-term";
      regimeValueAttrs["data-term-id"] = regimeTermId;
      regimeValueAttrs.style.cursor = "help";
    }
    root.appendChild(el("div", {
      style: { display: "flex", gap: "16px", flexWrap: "wrap", padding: "12px 16px", background: "rgba(15,20,34,0.5)", border: "1px solid #1a2233", borderRadius: "8px", marginBottom: "16px" },
    },
      el("div", null,
        thesisLabel("Current regime", null),
        el("div", regimeValueAttrs, r.label || r.regime || "?"),
      ),
      el("div", null,
        thesisLabel("Severity", "regime_severity"),
        el("div", { style: { fontSize: "16px", fontWeight: "600", color: r.severity >= 4 ? "#f87171" : r.severity >= 3 ? "#fbbf24" : "#93c5fd" } }, String(r.severity ?? "—")),
      ),
      r.days_in_state != null ? el("div", null,
        thesisLabel("Days in state", "regime_days_in_state"),
        el("div", { style: { fontSize: "16px", fontWeight: "600", color: "#e2e8f0" } }, `${r.days_in_state}d`),
      ) : null,
      r.confidence != null ? el("div", null,
        thesisLabel("Regime confidence", "regime_confidence"),
        el("div", { style: { fontSize: "16px", fontWeight: "600", color: r.confidence < 0.6 ? "#fbbf24" : "#86efac" } }, `${Math.round(r.confidence * 100)}%`),
      ) : null,
    ));

    // PR 4 — "Why this regime?" block. Surfaces the LLM's reasoning + the
    // top headlines that drove the regime call + classifier provenance.
    // This is what the user was missing: WHY do we think we're in OIL_SHOCK?
    if (r.reasoning || (Array.isArray(r.key_events) && r.key_events.length > 0)) {
      const why = el("div", {
        "data-testid": "thesis-why-regime",
        style: { padding: "12px 14px", border: "1px solid rgba(96,165,250,0.25)", borderRadius: "8px", marginBottom: "16px", background: "rgba(15,20,34,0.5)" },
      });
      why.appendChild(el("div", { style: { fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: "8px" } }, "Why this regime"));
      if (r.reasoning) {
        why.appendChild(el("div", { style: { fontSize: "12px", color: "#cbd5e1", lineHeight: "1.5", marginBottom: r.key_events?.length ? "8px" : "0" } }, r.reasoning));
      }
      if (Array.isArray(r.key_events) && r.key_events.length > 0) {
        why.appendChild(el("div", { style: { fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.04em", marginBottom: "4px" } }, "Top headlines that drove the call:"));
        const ul = el("ul", { style: { margin: "0", padding: "0", listStyle: "none" } });
        for (const ev of r.key_events.slice(0, 5)) {
          ul.appendChild(el("li", { style: { fontSize: "11px", color: "#cbd5e1", lineHeight: "1.4", marginBottom: "3px" } }, `▸ ${ev}`));
        }
        why.appendChild(ul);
      }
      // Classifier provenance line — small, but mandatory for SEBI Reg 16
      const provBits = [];
      if (r.classifier_provider) provBits.push(`classifier: ${r.classifier_provider}`);
      if (r.tier_coverage) provBits.push(`tier coverage: A+${r.tier_coverage["A+"] || 0} A${r.tier_coverage["A"] || 0} B${r.tier_coverage["B"] || 0}`);
      if (r.generated_at) provBits.push(`generated ${new Date(r.generated_at).toLocaleString()}`);
      if (provBits.length) {
        why.appendChild(el("div", { style: { fontSize: "9px", color: "var(--text-muted)", marginTop: "6px", fontStyle: "italic" } }, provBits.join(" · ")));
      }
      root.appendChild(why);
    }

    // Position-cap warning banner (SEBI Reg 16)
    const posCapBanner = el("div", {
      style: { padding: "10px 14px", border: "1px dashed #fbbf24", borderRadius: "6px", marginBottom: "16px", fontSize: "11px", color: "#fbbf24", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
    }, `⚠ Position-sizing cap: max ${thesis.position_cap_pct || 10}% of portfolio per thesis. Diversify across multiple theses; do not concentrate based on a single scenario.`);
    const posCapBubble = infoBubble("thesis_position_cap");
    if (posCapBubble) posCapBanner.appendChild(posCapBubble);
    root.appendChild(posCapBanner);

    // Per-branch cards
    const cardsWrap = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "12px" } });
    for (const b of (thesis.branches || [])) {
      const probColor = b.probability >= 0.4 ? "#86efac" : b.probability >= 0.2 ? "#fbbf24" : "#cbd5e1";
      const indFlag = b.indeterminate
        ? el("span", { style: { fontSize: "9px", color: "#f87171", marginLeft: "6px", padding: "1px 5px", border: "1px solid #f87171", borderRadius: "3px" } }, "INDETERMINATE")
        : null;
      const card = el("div", {
        "data-testid": `thesis-branch-${b.key}`,
        style: { padding: "14px", border: "1px solid #1a2233", borderRadius: "8px", background: "rgba(15,20,34,0.6)" },
      });
      const branchTermId = `thesis_branch_${b.key}`;
      const branchKeyNode = el("div", { style: { fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: "5px" } }, b.key);
      const branchKeyBubble = infoBubble(branchTermId);
      if (branchKeyBubble) branchKeyNode.appendChild(branchKeyBubble);
      const probNode = el("div", { style: { fontSize: "20px", fontWeight: "700", color: probColor, display: "inline-flex", alignItems: "center", gap: "4px" } }, `${Math.round((b.probability || 0) * 100)}%`);
      const probBubble = infoBubble("thesis_probability");
      if (probBubble) probNode.appendChild(probBubble);
      card.appendChild(el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginBottom: "10px" } },
        el("div", null,
          branchKeyNode,
          el("div", { style: { fontSize: "13px", color: "#e2e8f0", fontWeight: "500" } }, b.label, indFlag),
        ),
        el("div", { style: { textAlign: "right" } },
          probNode,
          el("div", { style: { fontSize: "9px", color: "var(--text-muted)" } }, `~${b.duration_days || "?"}d horizon · n=${b.n_analogs || 0}`),
        ),
      ));
      // Beneficiaries
      const ben = (b.beneficiaries || []).slice(0, 3);
      if (ben.length > 0) {
        const benHeader = el("div", { style: { fontSize: "10px", color: "#86efac", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: "6px", display: "inline-flex", alignItems: "center", gap: "5px" } }, "▲ Beneficiaries");
        const benBubble = infoBubble("thesis_beneficiaries");
        if (benBubble) benHeader.appendChild(benBubble);
        card.appendChild(benHeader);
        for (const beneficiary of ben) {
          const benRow = el("div", { style: { padding: "6px 8px", background: "rgba(34,197,94,0.06)", borderRadius: "4px", marginBottom: "4px" } });
          const labelLine = beneficiary.source === "analog"
            ? `${beneficiary.sector_label} — median ${beneficiary.expected_return_pct > 0 ? "+" : ""}${beneficiary.expected_return_pct}% (IQR ${beneficiary.p25}–${beneficiary.p75}%, n=${beneficiary.n_analogs})`
            : `${beneficiary.sector_label} — expected upside (template, no analog evidence)`;
          benRow.appendChild(el("div", { style: { fontSize: "11px", color: "#cbd5e1" } }, labelLine));
          const stocks = (beneficiary.stock_candidates?.stocks || []).slice(0, 3);
          if (stocks.length > 0) {
            const stockLine = stocks.map((s) => `${s.ticker} (v3 ${s.v3_score_100 || "?"})`).join(" · ");
            benRow.appendChild(el("div", { style: { fontSize: "10px", color: "var(--text-muted)", marginTop: "2px" } }, `pure plays: ${stockLine}`));
          }
          card.appendChild(benRow);
        }
      }
      // Losers
      const los = (b.losers || []).slice(0, 3);
      if (los.length > 0) {
        const losHeader = el("div", { style: { fontSize: "10px", color: "#fca5a5", letterSpacing: "0.05em", textTransform: "uppercase", marginTop: "6px", marginBottom: "6px", display: "inline-flex", alignItems: "center", gap: "5px" } }, "▼ Hit");
        const losBubble = infoBubble("thesis_losers");
        if (losBubble) losHeader.appendChild(losBubble);
        card.appendChild(losHeader);
        for (const loser of los) {
          const lossLine = loser.source === "analog"
            ? `${loser.sector_label} — median ${loser.expected_return_pct}% (IQR ${loser.p25}–${loser.p75}%, n=${loser.n_analogs})`
            : `${loser.sector_label} — expected downside (template, no analog evidence)`;
          card.appendChild(el("div", { style: { padding: "4px 8px", background: "rgba(239,68,68,0.06)", borderRadius: "4px", fontSize: "11px", color: "#cbd5e1", marginBottom: "2px" } }, lossLine));
        }
      }

      // PR 4 — "How this branch was built" expander. Shows the probability
      // math (base × modulator = probability), the analog pool used, and
      // the matched analog dates+labels. Closed by default so the cards
      // stay scannable; one click and the audit trail is visible.
      if (b.reasoning) {
        const det = document.createElement("details");
        det.setAttribute("data-testid", `thesis-branch-reasoning-${b.key}`);
        det.style.marginTop = "8px";
        det.style.borderTop = "1px dashed rgba(148,163,184,0.2)";
        det.style.paddingTop = "8px";
        const sum = document.createElement("summary");
        sum.style.fontSize = "10px";
        sum.style.color = "var(--text-muted)";
        sum.style.cursor = "pointer";
        sum.style.letterSpacing = "0.04em";
        sum.style.textTransform = "uppercase";
        sum.textContent = `How this ${b.probability ? Math.round(b.probability * 100) + "%" : ""} was derived`;
        det.appendChild(sum);
        const body = el("div", { style: { fontSize: "10.5px", color: "#cbd5e1", marginTop: "6px", lineHeight: "1.5" } });
        // Math line
        if (b.reasoning.base_probability != null && b.reasoning.modulator_applied != null) {
          const product = b.reasoning.base_probability * b.reasoning.modulator_applied;
          body.appendChild(el("div", null,
            `base ${b.reasoning.base_probability.toFixed(2)} × modulator ${b.reasoning.modulator_applied.toFixed(2)} = `,
            el("span", { style: { color: "#e2e8f0", fontWeight: "600" } }, product.toFixed(3)),
            " (normalised against other branches to ",
            el("span", { style: { color: "#e2e8f0", fontWeight: "600" } }, `${Math.round((b.probability || 0) * 100)}%`),
            ")",
          ));
        }
        // Analog pool line
        body.appendChild(el("div", { style: { marginTop: "4px" } },
          `Analog pool: ${b.reasoning.analog_pool_regime || "?"} · n=${b.n_analogs || 0}`,
        ));
        // Matched analogs
        const analogs = Array.isArray(b.reasoning.analogs) ? b.reasoning.analogs.slice(0, 5) : [];
        if (analogs.length > 0) {
          body.appendChild(el("div", { style: { marginTop: "4px", color: "var(--text-muted)" } }, "Matched analogs:"));
          const ul = el("ul", { style: { margin: "0", padding: "0", listStyle: "none" } });
          for (const a of analogs) {
            ul.appendChild(el("li", { style: { fontSize: "10px", color: "#cbd5e1", lineHeight: "1.35", marginLeft: "8px" } },
              `• ${a.date || "?"}${a.label ? ` — ${a.label}` : ""}${a.severity != null ? ` (sev ${a.severity})` : ""}${a.source ? ` [${a.source}]` : ""}`,
            ));
          }
          body.appendChild(ul);
        }
        // Analog warnings
        const warns = Array.isArray(b.reasoning.analog_warnings) ? b.reasoning.analog_warnings : [];
        if (warns.length > 0) {
          body.appendChild(el("div", { style: { marginTop: "6px", padding: "4px 6px", border: "1px solid rgba(251,191,36,0.3)", borderRadius: "4px", background: "rgba(251,191,36,0.05)", color: "#fbbf24", fontSize: "9.5px" } },
            warns.map((w) => `⚠ ${w}`).join(" · "),
          ));
        }
        det.appendChild(body);
        card.appendChild(det);
      }

      cardsWrap.appendChild(card);
    }
    root.appendChild(cardsWrap);

    // PR B4 — upcoming catalysts strip
    if (Array.isArray(thesis.upcoming_catalysts) && thesis.upcoming_catalysts.length > 0) {
      const cat = el("div", {
        "data-testid": "thesis-catalysts",
        style: { marginTop: "16px", padding: "12px 14px", border: "1px solid #1a2233", borderRadius: "6px", background: "rgba(15,20,34,0.6)" },
      });
      const catHeader = el("div", { style: { fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: "8px", display: "inline-flex", alignItems: "center", gap: "5px" } }, "Upcoming catalysts (next 30 days)");
      const catBubble = infoBubble("thesis_upcoming_catalysts");
      if (catBubble) catHeader.appendChild(catBubble);
      cat.appendChild(catHeader);
      const wrap = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } });
      for (const c of thesis.upcoming_catalysts) {
        const chip = el("div", {
          style: {
            padding: "4px 10px", borderRadius: "12px", fontSize: "10.5px",
            background: c.days_until <= 7 ? "rgba(248,113,113,0.12)" : c.days_until <= 14 ? "rgba(251,191,36,0.12)" : "rgba(96,165,250,0.10)",
            color: c.days_until <= 7 ? "#fca5a5" : c.days_until <= 14 ? "#fbbf24" : "#93c5fd",
            border: `1px solid ${c.days_until <= 7 ? "rgba(248,113,113,0.3)" : c.days_until <= 14 ? "rgba(251,191,36,0.3)" : "rgba(96,165,250,0.25)"}`,
          },
        }, `${c.kind} · ${c.label} · in ${c.days_until}d`);
        wrap.appendChild(chip);
      }
      cat.appendChild(wrap);
      root.appendChild(cat);
    }

    // SEBI Reg 16 caveats
    if (thesis.caveats?.length > 0) {
      const cv = el("div", { "data-testid": "thesis-caveats", style: { marginTop: "16px", padding: "12px 14px", border: "1px solid rgba(148,163,184,0.3)", borderRadius: "6px", background: "rgba(15,20,34,0.4)" } });
      const cvHeader = el("div", { style: { fontSize: "10px", color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: "6px", display: "inline-flex", alignItems: "center", gap: "5px" } }, "SEBI Reg 16 caveats");
      const cvBubble = infoBubble("thesis_sebi_reg16");
      if (cvBubble) cvHeader.appendChild(cvBubble);
      cv.appendChild(cvHeader);
      for (const c of thesis.caveats) {
        cv.appendChild(el("div", { style: { fontSize: "11px", color: "#cbd5e1", marginBottom: "4px" } }, `• ${c}`));
      }
      root.appendChild(cv);
    }

    // PR 4 — audit footer. Mirrors the Earnings Watch "How prediction was
    // built" pattern: schema, freshness, classifier provenance, math
    // engine version. All the data needed to reproduce/audit this thesis.
    if (thesis.audit) {
      const a = thesis.audit;
      const auditFooter = el("div", {
        "data-testid": "thesis-audit",
        style: { marginTop: "12px", padding: "8px 12px", borderRadius: "6px", background: "rgba(15,20,34,0.3)", fontSize: "9.5px", color: "var(--text-muted)", fontStyle: "italic", lineHeight: "1.45" },
      });
      const parts = [];
      if (a.thesis_schema) parts.push(`schema: ${a.thesis_schema}`);
      if (a.regime_generated_at) parts.push(`regime: ${new Date(a.regime_generated_at).toLocaleString()}`);
      if (a.regime_classifier) parts.push(`classifier: ${a.regime_classifier}`);
      if (a.scenario_engine_version) parts.push(`engine: ${a.scenario_engine_version}`);
      if (thesis.generated_at) parts.push(`computed: ${new Date(thesis.generated_at).toLocaleString()}`);
      auditFooter.textContent = parts.join(" · ");
      root.appendChild(auditFooter);
    }

    return root;
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

    function studyBlock(title, subtitle, list, lensType, titleTermId) {
      const titleNode = el(
        "div",
        { style: { fontSize: "13px", fontWeight: "600", marginBottom: "4px", display: "inline-flex", alignItems: "center", gap: "6px" } },
        title,
      );
      const titleBubble = infoBubble(titleTermId);
      if (titleBubble) titleNode.appendChild(titleBubble);
      if (list.length === 0) {
        return el(
          "div",
          { style: { padding: "14px 16px", background: "rgba(20,30,50,0.4)", borderRadius: "8px", flex: "1" } },
          titleNode,
          el("div", { style: { fontSize: "11px", color: "var(--text-muted)" } }, "No notable cases in current snapshot."),
        );
      }
      return el(
        "div",
        { style: { padding: "14px 16px", background: "rgba(20,30,50,0.4)", borderRadius: "8px", flex: "1" } },
        titleNode,
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
      studyBlock("Macro lens — top discounted", "Stocks where the regime overlay imposed the largest negative delta.", macroNotables, "macro", "lens_macro"),
      studyBlock("Quality lens — KEC-class traps", "TOP_PICKs the Quality Lens would have flagged. Each has 3+ quality red flags in SWS data.", qualityNotables, "quality", "lens_quality"),
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

    // Search overlay — applies after lens filter, before sort. Persists across
    // lens switches; ticker/flag text means the same thing on every lens.
    const trimmedQuery = _searchQuery.trim().toLowerCase();
    if (trimmedQuery) {
      filtered = filtered.filter((s) => matchesSearch(s, trimmedQuery));
    }

    // Per-column sort overlay — replaces the lens default when a header is active.
    // Reads raw fields (not fmtVerdict'd output, which strips underscores).
    if (_sortState.key) {
      const getters = {
        ticker: (s) => (s.ticker || "").toString(),
        origVerdict: (s) => verdictRank(s.original_verdict),
        origScore: (s) => Number(s.original_score || 0),
        delta: (s) => _activeLens === "macro"
          ? Number(s.macro_score_delta || 0)
          : _activeLens === "quality"
            ? Number(s.quality_score_delta || 0)
            : Number(s.macro_score_delta || 0) + Number(s.quality_score_delta || 0),
        adjusted: (s) => adjustedRank(
          _activeLens === "macro" ? s.macro_adjusted_verdict
            : _activeLens === "quality" ? s.quality_adjusted_verdict
            : (s.quality_veto?.vetoed || s.macro_veto?.vetoed
                ? "RISK HOLD"
                : s.quality_adjusted_verdict || s.macro_adjusted_verdict),
        ),
      };
      const getter = getters[_sortState.key];
      if (getter) {
        const mult = _sortState.dir === "desc" ? -1 : 1;
        filtered = [...filtered].sort((a, b) => {
          const va = getter(a);
          const vb = getter(b);
          if (typeof va === "string") return va.localeCompare(vb) * mult;
          return (va - vb) * mult;
        });
      }
    }

    const searchInput = el("input", {
      type: "search",
      placeholder: "Search ticker, verdict, or flag…",
      "data-testid": "risk-lab-search-input",
      value: _searchQuery,
      "aria-label": "Search Risk Lab table",
      style: {
        width: "100%",
        boxSizing: "border-box",
        padding: "8px 12px",
        marginBottom: "10px",
        background: "rgba(15,20,34,0.6)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: "6px",
        color: "var(--text-primary)",
        fontSize: "12px",
        outline: "none",
      },
      onInput: (e) => updateSearch(e.target.value),
    });

    if (filtered.length === 0) {
      const emptyMsg = trimmedQuery
        ? `No matches for "${_searchQuery}". Try a different ticker or flag name.`
        : "No stocks fire the current lens. Try another lens or wait for the next macro refresh.";
      return el("div", null, searchInput,
        el("div", { style: { padding: "30px", textAlign: "center", color: "var(--text-muted)" } }, emptyMsg),
      );
    }

    const deltaLabel = _activeLens === "macro" ? "Macro Δ" : _activeLens === "quality" ? "Quality Δ" : "Combined Δ";
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
      sortHeader("Ticker", "ticker"),
      sortHeader("Original Verdict", "origVerdict"),
      sortHeader("Orig Score", "origScore", "right", "col_orig_score"),
      sortHeader(deltaLabel, "delta", "right", _activeLens === "macro" ? "col_macro_delta" : _activeLens === "quality" ? "col_quality_delta" : "col_combined_delta"),
      sortHeader("Adjusted", "adjusted", null, "col_adjusted"),
      (() => {
        const reasonHeader = el("div", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } }, "Reason / Flags");
        const bubble = infoBubble("col_reason_flags");
        if (bubble) reasonHeader.appendChild(bubble);
        return reasonHeader;
      })(),
    );

    const rows = (_showAll ? filtered : filtered.slice(0, 100)).map((s) => renderRow(s));

    const footer = filtered.length > 100
      ? el("button", {
          "data-testid": "risk-lab-show-all-btn",
          style: {
            display: "block",
            margin: "12px auto",
            padding: "8px 18px",
            background: "transparent",
            border: "1px solid rgba(96,165,250,0.4)",
            color: "#60a5fa",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "11px",
            letterSpacing: "0.04em",
          },
          onClick: () => { _showAll = !_showAll; render(); },
        }, _showAll ? `Collapse to first 100 (of ${filtered.length})` : `Show all ${filtered.length} matches`)
      : null;

    return el("div", null, searchInput, header, ...rows, footer);
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

    // Build reason / flags chip list. Each chip gets a data-term-id where
    // a glossary entry exists so hovering the chip itself surfaces the
    // explainer — no extra ⓘ icon needed inside the pill.
    const chips = [];
    if (_activeLens === "macro" || _activeLens === "combined") {
      if (s.macro_veto?.vetoed) {
        chips.push(chip("MACRO VETO", "#ef4444", "macro_veto"));
      }
      if (s.sector_used && s.macro_score_delta) {
        // Sector + delta chip is data, not a glossary term — no termId.
        chips.push(chip(`${s.sector_used} ${fmtDelta(s.macro_score_delta)}`, colorForDelta(s.macro_score_delta)));
      }
    }
    if (_activeLens === "quality" || _activeLens === "combined") {
      if (s.quality_veto?.vetoed) {
        chips.push(chip("QUALITY VETO", "#ef4444", "quality_veto"));
      }
      if (s.quality_verdict && s.quality_verdict !== "HIGH") {
        chips.push(chip(s.quality_verdict, colorForQuality(s.quality_verdict), `quality_${String(s.quality_verdict).toLowerCase()}`));
      }
      for (const f of (s.quality_flags || []).slice(0, 4)) {
        const label = f.category || f.type || f.overlay || "flag";
        // Convention: glossary IDs follow flag_<category>. Falls back to
        // null if the category isn't yet in the glossary — chip stays
        // visible but without a tooltip.
        chips.push(chip(label, colorForDelta(f.severity), label ? `flag_${label}` : null));
      }
      if ((s.quality_flags || []).length > 4) {
        chips.push(chip(`+${s.quality_flags.length - 4}`, "var(--text-muted)"));
      }
    }

    // Verdict cells get invisible tooltip triggers via data-term-id +
    // .glossary-term (dashed underline + cursor: help). No visible ⓘ
    // inside the cell — the Adjusted column is only 100px and a 14px
    // icon would push the verdict text to ellipsis.
    const origVerdictId = typeof verdictIdFromLabel === "function" ? verdictIdFromLabel(s.original_verdict) : null;
    const origVerdictAttrs = { style: { color: "var(--text-muted)" } };
    if (origVerdictId && window.GLOSSARY && window.GLOSSARY[origVerdictId]) {
      origVerdictAttrs.className = "glossary-term";
      origVerdictAttrs["data-term-id"] = origVerdictId;
      origVerdictAttrs.style.cursor = "help";
    }
    const adjVerdictId = typeof verdictIdFromLabel === "function" ? verdictIdFromLabel(adjVerdict) : null;
    const adjVerdictAttrs = {
      style: { color: adjVerdict?.includes("HOLD") || adjVerdict?.includes("VETO") ? "#ef4444" : "var(--text-primary)" },
    };
    if (adjVerdictId && window.GLOSSARY && window.GLOSSARY[adjVerdictId]) {
      adjVerdictAttrs.className = "glossary-term";
      adjVerdictAttrs["data-term-id"] = adjVerdictId;
      adjVerdictAttrs.style.cursor = "help";
    }

    return el(
      "div",
      {
        "data-testid": "risk-lab-row",
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
      el("div", origVerdictAttrs, fmtVerdict(s.original_verdict)),
      el("div", { style: { textAlign: "right" } }, fmtScore(s.original_score)),
      el("div", { style: { textAlign: "right", color: colorForDelta(delta) } }, fmtDelta(delta)),
      el("div", adjVerdictAttrs, fmtVerdict(adjVerdict)),
      el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } }, ...chips),
    );
  }

  function chip(text, color, termId) {
    const attrs = {
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
    };
    // If the chip text is a known glossary term, wire it as an invisible
    // tooltip trigger via the platform's delegated handler. The chip itself
    // becomes the hover target — no extra ⓘ icon needed inside the pill.
    if (termId && window.GLOSSARY && window.GLOSSARY[termId]) {
      attrs.className = "glossary-term";
      attrs["data-term-id"] = termId;
      attrs.style.cursor = "help";
    }
    return el("span", attrs, text);
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
          // If the privileged "More" menu is mounted, rebuild it so the now-
          // disabled Risk Lab item drops out (it reads this same localStorage key).
          if (typeof window.buildLabsMenu === "function") window.buildLabsMenu();
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
    // Capture search-input focus + cursor before DOM teardown so live-filter
    // re-renders don't drop keystrokes or jump the caret to the end.
    const active = document.activeElement;
    const restoreSearch = active?.dataset?.testid === "risk-lab-search-input"
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
    root.innerHTML = "";
    root.appendChild(renderBanner(_cache));
    root.appendChild(renderCaseStudy(_cache));
    root.appendChild(renderLensTabs());
    if (_activeLens === "thesis") {
      // Lazy-load the thesis payload on first visit
      if (!_thesisCache) {
        loadThesisPayload().then(() => render());
        root.appendChild(el("div", { style: { padding: "20px", color: "var(--text-muted)" } }, "Loading Macro Thesis…"));
      } else {
        root.appendChild(renderMacroThesis(_thesisCache));
      }
    } else {
      root.appendChild(renderTable(_cache));
    }
    root.appendChild(renderUserToggle());
    if (restoreSearch) {
      const nextInput = document.querySelector('[data-testid="risk-lab-search-input"]');
      if (nextInput) {
        nextInput.focus();
        try { nextInput.setSelectionRange(restoreSearch.start, restoreSearch.end); } catch {}
      }
    }
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
