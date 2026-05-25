import assert from "node:assert/strict";
import { enrichMarketCardReturns, normaliseMarketReturns } from "../services/marketReturnNormalizer.js";

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "→", e.message);
  }
}

console.log("\nmarket return normalizer\n");

check("prefers deep returns over card and audit returns", () => {
  const returns = normaliseMarketReturns({
    deep: { overview: { returns_pct: { "1D": 1.1, "7D": -2.2, "1M": 3.3, "3M": 4.4, "1Y": 5.5 } } },
    card: {
      returns_pct: { "1D": 9, "7D": 9, "1M": 9, "3M": 9, "1Y": 9 },
      audit_trail: { inputs_used: { returns_1d: 8, returns_7d: 8, returns_1m: 8, returns_3m: 8, returns_1y: 8 } },
    },
  });
  assert.deepEqual(returns, { "1D": 1.1, "7D": -2.2, "1M": 3.3, "3M": 4.4, "1Y": 5.5 });
});

check("uses card returns when deep is absent", () => {
  const returns = normaliseMarketReturns({
    card: { returns_pct: { "1D": 0.5, "7D": 1.5, "1M": 2.5, "3M": 3.5, "1Y": 4.5 } },
  });
  assert.deepEqual(returns, { "1D": 0.5, "7D": 1.5, "1M": 2.5, "3M": 3.5, "1Y": 4.5 });
});

check("falls back to audit aliases for stale cards", () => {
  const returns = normaliseMarketReturns({
    card: {
      audit_trail: {
        inputs_used: {
          returns_1d: -0.4,
          returns_7d: 2.4,
          returns_1m: 3.4,
          returns_3m: 4.4,
          returns_1y: 5.4,
        },
      },
    },
  });
  assert.deepEqual(returns, { "1D": -0.4, "7D": 2.4, "1M": 3.4, "3M": 4.4, "1Y": 5.4 });
});

check("enriches a response card without mutating the source card", () => {
  const card = { ticker: "RET", returns_pct: { "1M": 3 } };
  const returns = { "1D": 1, "7D": 2, "1M": 3, "3M": 4, "1Y": 5 };
  const enriched = enrichMarketCardReturns(card, returns);
  assert.deepEqual(enriched.returns_pct, returns);
  assert.deepEqual(card.returns_pct, { "1M": 3 });
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

