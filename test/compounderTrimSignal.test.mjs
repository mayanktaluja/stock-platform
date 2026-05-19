/**
 * Tests for services/compounder/compounderTrimSignal.js.
 *
 * Run with: node test/compounderTrimSignal.test.mjs
 */

import { evaluateTrimSignal } from "../services/compounder/compounderTrimSignal.js";

let pass = 0;
let fail = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}

function position(overrides = {}) {
  return {
    entry_snowflake_health: 5,
    entry_risks: [],
    ...overrides,
  };
}
function current(overrides = {}) {
  return {
    snowflake_health: 5,
    risks: [],
    upside_pct: 30,
    ...overrides,
  };
}

console.log("\ncompounderTrimSignal — evaluateTrimSignal");

assert(
  "HOLD when upside positive + no health drop",
  evaluateTrimSignal(position(), current()).action === "HOLD",
);
assert(
  "TRIM_50 when upside -10%",
  evaluateTrimSignal(position(), current({ upside_pct: -10 })).action === "TRIM_50",
);
assert(
  "TRIM_50 when upside -25%",
  evaluateTrimSignal(position(), current({ upside_pct: -25 })).action === "TRIM_50",
);
assert(
  "HOLD when upside -5% (above trim threshold)",
  evaluateTrimSignal(position(), current({ upside_pct: -5 })).action === "HOLD",
);

assert(
  "EXIT when health drops 5 → 4",
  evaluateTrimSignal(position(), current({ snowflake_health: 4 })).action === "EXIT",
);
assert(
  "EXIT when health drops 5 → 3",
  evaluateTrimSignal(position(), current({ snowflake_health: 3 })).action === "EXIT",
);
assert(
  "HOLD when health unchanged",
  evaluateTrimSignal(position(), current({ snowflake_health: 5 })).action === "HOLD",
);
assert(
  "HOLD when health improves",
  evaluateTrimSignal(position({ entry_snowflake_health: 4 }), current({ snowflake_health: 5 })).action === "HOLD",
);

assert(
  "EXIT when NEW debt risk appears",
  evaluateTrimSignal(
    position({ entry_risks: ["Some unrelated risk"] }),
    current({ risks: ["Interest payments are not well covered"] }),
  ).action === "EXIT",
);
assert(
  "HOLD when debt risk was present at entry",
  evaluateTrimSignal(
    position({ entry_risks: ["Interest payments are not well covered"] }),
    current({ risks: ["Interest payments are not well covered"] }),
  ).action === "HOLD",
);

assert(
  "insufficient-data when position null",
  evaluateTrimSignal(null, current()).action === "HOLD",
);

// Priority: health drop wins over upside trim
const res = evaluateTrimSignal(
  position({ entry_snowflake_health: 5 }),
  current({ snowflake_health: 3, upside_pct: -50 }),
);
assert("EXIT takes precedence over TRIM_50", res.action === "EXIT", res);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
