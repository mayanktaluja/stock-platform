import { detectConsecutiveMiss } from "../services/riskLab/quality/consecutiveMissDetector.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

// ─── KEC fixture (the canonical Q3-missed case) ────────────────────────
const KEC_NEWS = [
  { title: "KEC International Limited to Report Q4, 2026 Results on May 16, 2026", date: "2026-05-08T10:50:00.000Z" },
  { title: "KEC: Strong New Orders And Global T And D Wins Will Support Upside", date: "2026-05-06T16:07:22.000Z" },
  { title: "KEC: New Order Wins And Backlog Will Support Future Upside", date: "2026-04-17T13:06:21.000Z" },
  { title: "Transmission Execution Risks And Civil Weakness Will Test Long-Term Order Book Upside", date: "2026-03-12T17:04:08.000Z" },
  { title: "KEC International Limited Just Missed EPS By 41%: Here's What Analysts Think Will Happen Next", date: "2026-02-03T00:37:47.000Z" },
  { title: "Third quarter 2026 earnings: EPS and revenues miss analyst expectations", date: "2026-01-31T21:25:58.000Z" },
];
const KEC_EVENT_DATE = "2026-05-16T06:45:00.000Z";

console.log("consecutiveMissDetector: KEC canonical case");
{
  const result = detectConsecutiveMiss(KEC_NEWS, KEC_EVENT_DATE);
  assert("KEC: detected", result.detected === true);
  assert("KEC: penalty -4", result.penaltyPts === -4);
  assert("KEC: evidence length ≥ 2", result.evidence.length >= 2, result.evidence.length);
  assert("KEC: evidence[0] is most recent (2026-02-03)", result.evidence[0].date === "2026-02-03T00:37:47.000Z");
  assert("KEC: evidence[1] is the EPS+revenue miss", result.evidence[1].title.includes("EPS and revenues miss"));
  // Window assertions
  // event = 2026-05-16, buffer = 30d, lookback = 120d → window [2026-01-16, 2026-04-16]
  assert("KEC: window_end ~ 2026-04-16", result.windowEnd.startsWith("2026-04-16"));
  assert("KEC: window_start ~ 2026-01-16", result.windowStart.startsWith("2026-01-16"));
}

console.log("consecutiveMissDetector: pattern coverage");
{
  // Each pattern variant should fire
  const patterns = [
    "Q3 EPS missed analyst estimates",
    "Quarterly results miss analyst expectations",
    "Q3 2026 earnings: revenues miss analyst expectations",
    "First quarter results: EPS missed analyst expectations",
    "Just missed EPS by 12%",
    "Missed EPS estimate by 25%",
    "Q4 missed earnings estimate by 8%",
  ];
  for (const title of patterns) {
    const news = [{ title, date: "2026-02-01" }];
    const r = detectConsecutiveMiss(news, "2026-05-16");
    assert(`pattern: "${title.slice(0, 50)}..."`, r.detected === true);
  }
}

console.log("consecutiveMissDetector: negation guards (false positives)");
{
  // Strings that contain "miss" but should NOT fire
  const negative = [
    "Don't miss the rally as KEC surges",
    "KEC won't miss FY27 guidance per management",
    "Analysts will not miss the cap-ex story",
    "Order book ensures KEC won't miss EPS estimates",
    "Strong order book — KEC did not miss any major project",
  ];
  for (const title of negative) {
    const news = [{ title, date: "2026-02-01" }];
    const r = detectConsecutiveMiss(news, "2026-05-16");
    assert(`negation: "${title.slice(0, 50)}..."`, r.detected === false, r);
  }
}

console.log("consecutiveMissDetector: window enforcement");
{
  // News too OLD (>120d before event) — outside window
  const tooOld = [{ title: "EPS missed analyst expectations", date: "2025-10-01" }];
  const r1 = detectConsecutiveMiss(tooOld, "2026-05-16");
  assert("too old → not detected", r1.detected === false);

  // News too RECENT (within 30d buffer) — also outside window (the buffer
  // excludes news from the just-completed quarter)
  const tooRecent = [{ title: "EPS missed analyst expectations", date: "2026-05-10" }];
  const r2 = detectConsecutiveMiss(tooRecent, "2026-05-16");
  assert("inside buffer → not detected", r2.detected === false);

  // Exactly at window edge — should be included
  const eventDate = new Date("2026-05-16T00:00:00.000Z");
  const windowStart = new Date(eventDate.getTime() - 120 * 24 * 60 * 60 * 1000);
  const justInside = [{ title: "EPS missed analyst expectations", date: new Date(windowStart.getTime() + 1000).toISOString() }];
  const r3 = detectConsecutiveMiss(justInside, "2026-05-16T00:00:00.000Z");
  assert("just inside window → detected", r3.detected === true);
}

console.log("consecutiveMissDetector: guards");
{
  // No news
  const r1 = detectConsecutiveMiss([], "2026-05-16");
  assert("empty news → not detected", r1.detected === false);
  assert("empty news → reason no_news", r1.reason === "no_news");

  // Null news
  const r2 = detectConsecutiveMiss(null, "2026-05-16");
  assert("null news → not detected", r2.detected === false);

  // Missing event date
  const r3 = detectConsecutiveMiss(KEC_NEWS, null);
  assert("null event date → not detected", r3.detected === false);
  assert("null event date → reason invalid", r3.reason === "missing_or_invalid_event_date");

  // Malformed date in news → skipped, others still considered
  const mixedNews = [
    { title: "EPS missed analyst expectations", date: "not-a-date" },
    { title: "EPS missed analyst expectations", date: "2026-02-01" },
  ];
  const r4 = detectConsecutiveMiss(mixedNews, "2026-05-16");
  assert("malformed-date news → still detects valid entry", r4.detected === true && r4.evidence.length === 1);

  // Custom window opts
  const r5 = detectConsecutiveMiss(
    [{ title: "EPS missed analyst expectations", date: "2026-01-01" }],
    "2026-05-16",
    { lookbackDays: 60, bufferDays: 30 },
  );
  // 60-day lookback from 2026-05-16 = 2026-03-17 — Jan 1 is outside this
  assert("custom 60d window: Jan 1 outside", r5.detected === false);
}

console.log("consecutiveMissDetector: returns evidence sorted by date desc");
{
  const news = [
    // All three dates inside [2026-01-16, 2026-04-16] window
    { title: "EPS missed analyst expectations (early)", date: "2026-01-20" },
    { title: "EPS missed analyst expectations (middle)", date: "2026-02-15" },
    { title: "EPS missed analyst expectations (late)", date: "2026-03-15" },
  ];
  const r = detectConsecutiveMiss(news, "2026-05-16");
  assert("evidence sorted desc by date", r.evidence[0].title.includes("late"));
  assert("evidence[1] is middle", r.evidence[1].title.includes("middle"));
  assert("evidence[2] is early", r.evidence[2].title.includes("early"));
}

if (_failed === 0) {
  console.log("consecutiveMissDetector: PASS");
  process.exit(0);
} else {
  console.error(`consecutiveMissDetector: FAIL (${_failed})`);
  process.exit(1);
}
