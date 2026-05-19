// PR #8 — global keyboard shortcuts.
//
// Loaded as a defer-tag script after gated/app.js so it sees window.switchTab,
// window.telemetry, etc. NOT an ES module — the existing pattern for
// gated/earnings.js and gated/riskLab.js (which auto-attach to window).
//
// Shortcuts:
//   • Cmd/Ctrl-K        — focus the header search box
//   • g then p|n|w|t|a|e|r — jump to tab (picks/news/watchlist/track/analyzer/earnings/riskLab)
//   • ?                  — toggle the shortcuts cheatsheet dialog
//   • Escape             — close cheatsheet (the existing Escape handler
//                          in app.js handles modals separately)
//
// Skipped when focus is inside an <input>, <textarea>, or [contenteditable]
// — typing "g" into the search box should not be intercepted.

(function () {
  const TAB_KEYS = {
    p: "picks",
    n: "news",
    w: "watchlist",
    t: "track",
    a: "analyzer",
    e: "earnings",
    r: "riskLab",
  };

  let _gPrefixTimer = null;
  let _gPrefixActive = false;

  function isTypingInField(target) {
    if (!target) return false;
    const tag = (target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function focusSearch() {
    const el = document.getElementById("searchInput");
    if (el && typeof el.focus === "function") el.focus();
    try { window.telemetry?.emit?.("keyboard_shortcut", { kind: "search_open" }); } catch {}
  }

  function jumpToTab(tab) {
    if (typeof window.switchTab !== "function") return;
    window.switchTab(tab);
    try { window.telemetry?.emit?.("keyboard_shortcut", { kind: "tab_jump", tab }); } catch {}
  }

  function toggleCheatsheet() {
    const dlg = document.getElementById("shortcutsModal");
    if (!dlg) return;
    if (dlg.classList.contains("open")) {
      dlg.classList.remove("open");
    } else {
      dlg.classList.add("open");
    }
    try { window.telemetry?.emit?.("keyboard_shortcut", { kind: "cheatsheet_toggle" }); } catch {}
  }

  function _clearGPrefix() {
    _gPrefixActive = false;
    if (_gPrefixTimer) clearTimeout(_gPrefixTimer);
    _gPrefixTimer = null;
  }

  document.addEventListener("keydown", (e) => {
    // Always allow Escape to close the cheatsheet (other Escape handlers
    // in app.js cover modals)
    if (e.key === "Escape") {
      const dlg = document.getElementById("shortcutsModal");
      if (dlg?.classList.contains("open")) {
        dlg.classList.remove("open");
        return;
      }
    }

    if (isTypingInField(e.target)) {
      _clearGPrefix();
      return;
    }

    // Cmd/Ctrl-K → focus header search
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      focusSearch();
      _clearGPrefix();
      return;
    }

    // ? → toggle cheatsheet
    if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      toggleCheatsheet();
      _clearGPrefix();
      return;
    }

    // g-prefix → next key is the tab letter
    if (e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      _gPrefixActive = true;
      _gPrefixTimer = setTimeout(_clearGPrefix, 600);
      return;
    }

    if (_gPrefixActive) {
      const tab = TAB_KEYS[e.key.toLowerCase()];
      _clearGPrefix();
      if (tab) {
        e.preventDefault();
        jumpToTab(tab);
      }
    }
  });
})();
