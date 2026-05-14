/**
 * Regression: SWS rewards/risks extraction must produce non-empty lists.
 *
 * Bug #3 — the E2E review found every stock in the 5,517-name SWS universe
 * had empty overview.rewards / overview.risks. Root cause: the API pipeline's
 * extractRewardsRisks() read
 * CompanyNarrativesWithHistogram.narratives.edges[].node.rewards — a path that
 * does not exist anywhere in the SWS API response. The old DOM-scraper unit
 * test (scripts/sws-parse-capture.test.mjs) kept passing because it exercises
 * the *text* parser against a fixture, never the API parser.
 *
 * The fix reads the real source: the /backend/statements REST endpoint, now
 * fetched as api.rest.statements. The on-page Rewards / Risk Analysis lists
 * are the rows with area "Rewards"/"Risks", public:true, and a definitive
 * state ("pass" for rewards, "fail" for risks).
 *
 * Fixtures are real captures of /backend/statements (Chrome MCP, 2026-05-14):
 *   - sws-statements-tcs.json       — 166 rows → 8 rewards, 0 risks
 *   - sws-statements-icicibank.json — 166 rows → 4 rewards, 2 risks
 * The ICICIBANK fixture keeps the parser-relevant fields (area/type/value/
 * outcome/outcome_name/severity/description/public/state); name/question/
 * tooltip context were dropped at capture time and the parser never reads
 * them. This is the test that would have caught the regression — it exercises
 * the API parser path, not the DOM one.
 *
 * Run via: npm run test:regression  (pure — no server needed)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractRewardsRisks } from "../../scripts/sws-api-parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

// extractRewardsRisks reads api.rest.statements — wrap each captured
// /backend/statements response in that shape.
const asApi = (statementsResponse) => ({ rest: { statements: statementsResponse } });

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

console.log("Bug #3 — SWS rewards/risks extraction");

// ── TCS: 8 rewards, 0 risks (matches the rendered SWS page). ──
const tcs = extractRewardsRisks(asApi(fixture("sws-statements-tcs.json")));
assert("TCS → 8 rewards", tcs.rewards.length === 8, tcs.rewards.length);
assert("TCS → 0 risks", tcs.risks.length === 0, tcs.risks.length);
assert(
  "TCS rewards carry real description text",
  tcs.rewards.some((r) => /Price-To-Earnings ratio .* below the Indian market/.test(r)),
  tcs.rewards,
);

// ── ICICIBANK: 4 rewards, 2 risks incl. "Unstable dividend track record". ──
const icici = extractRewardsRisks(asApi(fixture("sws-statements-icicibank.json")));
assert("ICICIBANK → 4 rewards", icici.rewards.length === 4, icici.rewards.length);
assert("ICICIBANK → 2 risks", icici.risks.length === 2, icici.risks.length);
assert(
  "ICICIBANK risks include 'Unstable dividend track record'",
  icici.risks.includes("Unstable dividend track record"),
  icici.risks,
);
assert(
  "ICICIBANK risks include 'Significant insider selling over the past 3 months'",
  icici.risks.includes("Significant insider selling over the past 3 months"),
  icici.risks,
);
// Exclusion: failed reward checks (public+fail) must NOT leak into rewards.
assert(
  "ICICIBANK excludes failed reward checks ('Not trading at good value…')",
  !icici.rewards.some((r) => /^Not trading/.test(r)),
  icici.rewards,
);
// Exclusion: passing risk checks (public+pass) must NOT leak into risks.
assert(
  "ICICIBANK excludes passing risk checks",
  !icici.risks.some((r) => /high quality|currently profitable|stable over past/i.test(r)),
  icici.risks,
);

// ── The core regression guard: a real capture must never extract empty. ──
assert(
  "extraction is non-empty for a real capture (the bug was universe-wide empties)",
  tcs.rewards.length > 0 && icici.rewards.length > 0 && icici.risks.length > 0,
  { tcsRewards: tcs.rewards.length, iciciRewards: icici.rewards.length, iciciRisks: icici.risks.length },
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
