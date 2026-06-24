/**
 * Run with: node test/regimeAlert.test.mjs
 */

import assert from "node:assert/strict";
import { formatRegimeAlert, isBreaking } from "../services/alerts/regimeAlert.js";

// Invalid input → null (caller skips).
assert.equal(formatRegimeAlert(null), null);
assert.equal(formatRegimeAlert({}), null);
assert.equal(formatRegimeAlert({ regime: 123 }), null);

// Breaking threshold = severity >= 4.
assert.equal(isBreaking({ severity: 3 }), false);
assert.equal(isBreaking({ severity: 4 }), true);
assert.equal(isBreaking({ severity: 5 }), true);

const base = {
  regime: "RATE_HIKE",
  regimeLabel: "Rate Hike",
  severity: 3,
  confidence: 0.7,
  classifierProvider: "groq",
  sectorImpacts: [
    { sector: "Banking", impact: 2 },
    { sector: "Realty", impact: -5 },
    { sector: "Auto", impact: -3 },
    { sector: "IT", impact: 1 },
  ],
  keyEvents: ["RBI raises repo rate by 25 bps"],
};

const a = formatRegimeAlert(base);
assert.equal(a.breaking, false); // sev 3
assert.ok(a.text.includes("Rate Hike"));
assert.ok(a.text.includes("sev <b>3/5</b>"));
assert.ok(a.text.includes("conf 0.70"));
assert.ok(a.text.includes("groq"));
assert.ok(a.text.includes("RBI raises repo"));
assert.equal(a.key, "regime:RATE_HIKE|3");
assert.equal(a.buttons.length, 1);
assert.ok(!a.text.startsWith("🚨")); // not breaking

// Most-negative sectors first, capped at 3 → Realty(-5), Auto(-3), IT(1). Banking(2) dropped.
const sectorLine = a.text.split("\n").find((l) => l.includes("Realty"));
assert.ok(sectorLine.indexOf("Realty") < sectorLine.indexOf("Auto"));
assert.ok(sectorLine.includes("IT"));
assert.ok(!sectorLine.includes("Banking")); // 4th (least negative), sliced off
assert.ok(sectorLine.includes("↓")); // negative arrow present
assert.ok(sectorLine.includes("↑")); // IT positive arrow present

// Breaking regime → 🚨 prefix.
const sev5 = formatRegimeAlert({ ...base, severity: 5 });
assert.equal(sev5.breaking, true);
assert.ok(sev5.text.startsWith("🚨"));

// Transition arrow when prev differs.
const withPrev = formatRegimeAlert(base, { regime: "CALM", regimeLabel: "Calm" });
assert.ok(withPrev.text.includes("Calm →"));

// No arrow when prev is same regime.
const samePrev = formatRegimeAlert(base, { regime: "RATE_HIKE", regimeLabel: "Rate Hike" });
assert.ok(!samePrev.text.includes("→"));

// HTML in label/keyEvent is escaped.
const evil = formatRegimeAlert({
  ...base,
  regimeLabel: "Rate <b>Hike</b> & Co",
  keyEvents: ["<script>x</script>"],
});
assert.ok(evil.text.includes("Rate &lt;b&gt;Hike&lt;/b&gt; &amp; Co"));
assert.ok(evil.text.includes("&lt;script&gt;"));

console.log("regimeAlert.test.mjs OK");
