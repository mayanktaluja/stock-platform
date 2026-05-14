/**
 * Regression: POST /api/watchlist/add must reject symbols outside the
 * tracked universe.
 *
 * Bug #7 — the handler only null-checked `symbol`, then persisted whatever
 * string it got. Garbage ("ZZ_GARBAGE_TEST") and even raw HTML
 * ("<script>alert(1)</script>") landed in .watchlist.json. The frontend
 * escapes on render so it was never XSS, but the store filled with junk and
 * downstream price / SWS lookups assume a real ticker.
 *
 * The fix routes the symbol through findBySymbol() before persisting and
 * returns 400 on a miss. This locks that: garbage → 400, and the validator
 * still resolves a real ticker (positive path checked directly, so the test
 * never writes to storage).
 *
 * Run via: npm run test:regression  (needs the suite's live server)
 */
import { findBySymbol } from "../../stockList.js";

const BASE = process.env.REGRESSION_BASE_URL || "http://localhost:4022";

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

async function postAdd(symbol) {
  const res = await fetch(`${BASE}/api/watchlist/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol }),
  });
  return res.status;
}

console.log("Bug #7 — watchlist symbol validation");

// ── Rejected payloads: garbage never persists, so no cleanup needed. ──
const garbage = ["<script>alert(1)</script>", "ZZ_GARBAGE_TEST", ""];
for (const bad of garbage) {
  const status = await postAdd(bad);
  assert(`rejects ${JSON.stringify(bad).slice(0, 32)} with 400`, status === 400, status);
}

// ── Positive path: the validator resolves a real ticker. Checked directly
// against findBySymbol so the test never round-trips through storage. ──
assert("findBySymbol resolves INFY.NS", !!findBySymbol("INFY.NS"), findBySymbol("INFY.NS"));
assert("findBySymbol resolves bare INFY", !!findBySymbol("INFY"), findBySymbol("INFY"));
assert("findBySymbol rejects ZZ_GARBAGE_TEST", findBySymbol("ZZ_GARBAGE_TEST") === null, findBySymbol("ZZ_GARBAGE_TEST"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
