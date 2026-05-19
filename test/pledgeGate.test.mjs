// Tests for services/multibagger/pledgeGate.js.
// Run: node test/pledgeGate.test.mjs

import assert from "node:assert/strict";
import {
  evaluatePledgeFromEvents,
  evaluatePledgeFromAnnouncements,
  evaluatePledge,
  PLEDGE_GATE_CONFIG,
} from "../services/multibagger/pledgeGate.js";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

console.log("\npledgeGate");

const NOW = "2026-05-20";

it("config constants are exposed", () => {
  assert.equal(PLEDGE_GATE_CONFIG.HIGH_PLEDGE_PCT, 25);
  assert.equal(PLEDGE_GATE_CONFIG.STEEP_INCREASE_PCT_POINTS, 10);
  assert.equal(PLEDGE_GATE_CONFIG.WINDOW_DAYS, 90);
});

it("structured: passes when no events match symbol", () => {
  const r = evaluatePledgeFromEvents({
    symbol: "ACME",
    events: [{ symbol: "OTHER", event_date_iso: "2026-05-01", pledge_pct_after: 30 }],
    now_iso: NOW,
  });
  assert.equal(r.pass, true);
  assert.equal(r.matched_events, 0);
});

it("structured: fails on high absolute pledge", () => {
  const r = evaluatePledgeFromEvents({
    symbol: "ACME",
    events: [{ symbol: "ACME", event_date_iso: "2026-05-01", pledge_pct_after: 28, pledge_pct_before: 25 }],
    now_iso: NOW,
  });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /pledge_28pct/);
});

it("structured: fails on steep increase even if absolute < 25%", () => {
  const r = evaluatePledgeFromEvents({
    symbol: "ACME",
    events: [{ symbol: "ACME", event_date_iso: "2026-05-01", pledge_pct_after: 18, pledge_pct_before: 5 }],
    now_iso: NOW,
  });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /pledge_delta_13pp/);
});

it("structured: ignores events older than 90d", () => {
  const r = evaluatePledgeFromEvents({
    symbol: "ACME",
    events: [{ symbol: "ACME", event_date_iso: "2025-01-01", pledge_pct_after: 50 }],
    now_iso: NOW,
  });
  assert.equal(r.pass, true);
});

it("text-scan: detects 'pledge' subject keyword", () => {
  const r = evaluatePledgeFromAnnouncements({
    symbol: "ACME",
    announcements: [{ symbol: "ACME", announced_at_iso: "2026-05-15", subject: "Disclosure of pledge by promoter — Acme Ltd" }],
    now_iso: NOW,
  });
  assert.equal(r.pass, false);
  assert.equal(r.matched_events, 1);
});

it("text-scan: detects SAST 31 form filings", () => {
  const r = evaluatePledgeFromAnnouncements({
    symbol: "ACME",
    announcements: [{ symbol: "ACME", announced_at_iso: "2026-05-10", subject: "SAST 31 filing — promoter holding update" }],
    now_iso: NOW,
  });
  assert.equal(r.pass, false);
});

it("text-scan: passes when no keyword hits", () => {
  const r = evaluatePledgeFromAnnouncements({
    symbol: "ACME",
    announcements: [{ symbol: "ACME", announced_at_iso: "2026-05-10", subject: "Investor Presentation Q4 FY26" }],
    now_iso: NOW,
  });
  assert.equal(r.pass, true);
});

it("text-scan: ignores announcements older than 90d", () => {
  const r = evaluatePledgeFromAnnouncements({
    symbol: "ACME",
    announcements: [{ symbol: "ACME", announced_at_iso: "2025-01-01", subject: "Pledge creation announcement" }],
    now_iso: NOW,
  });
  assert.equal(r.pass, true);
});

it("orchestrator: structured path preferred when both supplied", () => {
  const r = evaluatePledge({
    symbol: "ACME",
    events: [{ symbol: "ACME", event_date_iso: "2026-05-01", pledge_pct_after: 30 }],
    announcements: [{ symbol: "ACME", announced_at_iso: "2026-05-15", subject: "Pledge created" }],
    now_iso: NOW,
  });
  assert.equal(r.source, "structured");
  assert.equal(r.pass, false);
});

it("orchestrator: falls back to text-scan when no events", () => {
  const r = evaluatePledge({
    symbol: "ACME",
    events: [],
    announcements: [{ symbol: "ACME", announced_at_iso: "2026-05-15", subject: "Pledge created" }],
    now_iso: NOW,
  });
  assert.equal(r.source, "text_scan");
  assert.equal(r.pass, false);
});

it("orchestrator: passes when no data available", () => {
  const r = evaluatePledge({ symbol: "ACME", events: [], announcements: [], now_iso: NOW });
  assert.equal(r.source, "no_data");
  assert.equal(r.pass, true);
});

console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
