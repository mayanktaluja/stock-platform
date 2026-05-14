/**
 * Regression: the Market Intelligence digest must reflect sector + FII data
 * that is actually fetchable.
 *
 * Bug #4 — buildDeterministicDigest read sectorHeatmapCache / fiiDiiCache
 * directly, but /api/news/market never populated them. Those caches only
 * filled as a side effect of someone hitting /api/sector-heatmap or
 * /api/fii-dii first, so on a cold cache the digest's keyTakeaways carried
 * the literal strings "Sectoral breadth data not yet available" and "FII
 * data not yet available" — even though both were perfectly fetchable.
 *
 * The fix has /api/news/market warm that data itself (getSectorHeatmapData /
 * getFiiDiiData) before building the digest.
 *
 * Test ordering matters: it hits /api/news/market FIRST, while the suite's
 * server still has cold sector/FII caches — that's exactly the path the bug
 * lived on. Warming the caches before the news call would mask the bug. It
 * then probes /api/sector-heatmap and /api/fii-dii to decide whether the
 * data was genuinely available; the "not yet available" assertion self-skips
 * when it legitimately wasn't (no network, NSE outage).
 *
 * Run via: npm run test:regression  (needs the suite's live server)
 */
const BASE = process.env.REGRESSION_BASE_URL || "http://localhost:4022";

let pass = 0;
let fail = 0;
let skipped = 0;
function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", JSON.stringify(got));
  }
}
function skip(name, why) {
  skipped++;
  console.log("  ⊘", name, " (skipped —", why + ")");
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

console.log("Bug #4 — Market Intelligence digest cache warming");

// ── 1. Hit /api/news/market FIRST, on cold sector/FII caches. ──
const news = await getJson("/api/news/market");
assert("/api/news/market → 200", news.status === 200, news.status);

const takeaways = (news.body?.digest?.keyTakeaways || []).join(" | ");

// ── 2. Probe the upstreams to learn what was genuinely available. By now
//       the news route (if fixed) has warmed both caches, so these are fast. ──
const heatmap = await getJson("/api/sector-heatmap");
const fiidii = await getJson("/api/fii-dii");

// ── 3. Assert the digest reflects data that IS available. ──
const sectorsAvailable = (heatmap.body?.sectors?.length || 0) > 0;
if (sectorsAvailable) {
  assert(
    'digest does not falsely claim "Sectoral breadth data not yet available"',
    !takeaways.includes("Sectoral breadth data not yet available"),
    takeaways,
  );
} else {
  skip("sectoral breadth claim", "/api/sector-heatmap returned 0 sectors");
}

const fiiAvailable =
  fiidii.body?.available !== false && fiidii.body?.fii?.netValue != null;
if (fiiAvailable) {
  assert(
    'digest does not falsely claim "FII data not yet available"',
    !takeaways.includes("FII data not yet available"),
    takeaways,
  );
} else {
  skip("FII data claim", "/api/fii-dii unavailable from NSE");
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
