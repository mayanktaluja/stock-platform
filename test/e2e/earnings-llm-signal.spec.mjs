// PR 4 — the LLM qualitative signal is wired through to the API.
//
// earningsLlmBatcher attaches `signals.llm_signal` (Groq → Gemini →
// heuristic) between aggregation and prediction; the predictor scores
// it as component 9 (±10) into `score_breakdown.llm_signal`.
//
// This spec asserts the CONTRACT — every scored event carries a
// well-formed signal and a finite component score. It tolerates the
// `neutral` / `heuristic` path: in CI and on any box without LLM API
// keys the deterministic heuristic produces the signal, and that is a
// valid, expected provider — not a failure.

import { test, expect } from "@playwright/test";

const BIAS = ["lean_beat", "neutral", "lean_miss"];
const PROVIDERS = ["groq", "gemini", "heuristic"];

test.describe("Earnings LLM qualitative signal (PR 4)", () => {
  test("scored events carry a well-formed llm_signal + finite component score", async ({ request }) => {
    const res = await request.get("/api/earnings/upcoming");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    test.skip(!!body.missing, "no earnings snapshot committed yet");

    const scored = body.events.filter((e) => e.prediction?.verdict !== "INSUFFICIENT_DATA");
    expect(scored.length).toBeGreaterThan(0);

    let withSignal = 0;
    for (const e of scored) {
      // The component score is always present and finite (0 when no signal).
      expect(Number.isFinite(e.prediction.score_breakdown.llm_signal)).toBe(true);
      expect(Math.abs(e.prediction.score_breakdown.llm_signal)).toBeLessThanOrEqual(10);

      const sig = e.signals?.llm_signal;
      if (!sig) continue;
      withSignal += 1;
      expect(BIAS).toContain(sig.bias);
      expect(PROVIDERS).toContain(sig.classifier_provider);
      expect(Number.isInteger(sig.confidence_delta_pct)).toBe(true);
      expect(sig.confidence_delta_pct).toBeGreaterThanOrEqual(-5);
      expect(sig.confidence_delta_pct).toBeLessThanOrEqual(5);
      // Sign coherence — a lean_beat must not carry a negative delta.
      if (sig.bias === "lean_beat") expect(sig.confidence_delta_pct).toBeGreaterThanOrEqual(0);
      if (sig.bias === "lean_miss") expect(sig.confidence_delta_pct).toBeLessThanOrEqual(0);
      if (sig.bias === "neutral") expect(sig.confidence_delta_pct).toBe(0);
      expect(typeof sig.top_reason).toBe("string");
      expect(typeof sig.top_risk).toBe("string");
      expect(typeof sig.model_id).toBe("string");
    }

    // The bulk of scored events should carry a resolved signal — the
    // batcher only skips LOW-data-quality events.
    expect(withSignal / scored.length).toBeGreaterThan(0.8);
  });
});
