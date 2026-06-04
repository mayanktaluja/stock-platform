import test from "node:test";
import assert from "node:assert/strict";
import { extractSwsNewsSignals } from "../services/swsNewsSignal.js";

const now = new Date("2026-06-04T00:00:00Z");

test("negative material SWS news is an attention signal, not an action object", () => {
  const signal = extractSwsNewsSignals([
    {
      date: "2026-06-01",
      title: "Analysts trim price target on overvaluation risk",
      body: "The fair-value target was cut after the stock reached most of its upside.",
    },
  ], { now });

  assert.equal(signal.signal, -1);
  assert.equal(signal.materialDisclosure, true);
  assert.match(signal.summary, /veto adds|confirm/i);
  assert.match(signal.blockedReasons.join(" "), /manual review/);
  assert.equal(signal.evidence.length, 1);
});

test("positive SWS news is supportive context only", () => {
  const signal = extractSwsNewsSignals([
    {
      date: "2026-06-02",
      title: "Company wins new contract",
      body: "Revenue growth opportunity improves.",
    },
  ], { now });

  assert.equal(signal.signal, 1);
  assert.equal(signal.materialDisclosure, false);
  assert.match(signal.summary, /not a standalone top-up trigger/i);
});

test("mixed SWS news stays neutral and noisy", () => {
  const signal = extractSwsNewsSignals([
    { date: "2026-06-02", title: "Company wins order", body: "Revenue growth opportunity." },
    { date: "2026-06-03", title: "Analysts downgrade on margin pressure", body: "Target cut after weak margins." },
  ], { now });

  assert.equal(signal.signal, 0);
  assert.equal(signal.confidence_delta, 0);
  assert.match(signal.summary, /Mixed SWS news/i);
});
