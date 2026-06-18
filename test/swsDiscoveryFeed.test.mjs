import assert from "node:assert/strict";

import { buildDiscoveryFeedEmail, buildSwsDiscoveryFeed } from "../services/swsDiscoveryFeed.js";

const generatedAt = "2026-06-18T04:00:00.000Z";

function row(overrides) {
  return {
    ticker: "TEST",
    name: "Test Limited",
    sector: "Industrials",
    v4_score: 50,
    v4_verdict: "STRONG",
    regulatory_flags: { surveillance: null },
    risk_overlay: { risks_count: 1 },
    ...overrides,
  };
}

function deep({ future = 0, returns = {}, news = [], dataQuality = null } = {}) {
  return {
    overview: {
      snowflake: { future, future_growth: future },
      returns_pct: returns,
      ...(dataQuality ? { snowflake_data_quality: dataQuality } : {}),
    },
    news,
  };
}

const feed = buildSwsDiscoveryFeed({
  generatedAt,
  scoredUniverse: {
    stocks: [
      row({ ticker: "FINOPB", name: "Fino Payments Bank Limited", sector: "Banks", v4_score: 47.4, v4_verdict: "STRONG" }),
      row({ ticker: "KRISHNADEF", name: "Krishna Defence and Allied Industries Limited", sector: "Capital Goods", v4_score: 61.9, v4_verdict: "TOP_PICK" }),
      row({ ticker: "WEAKTAPE", v4_score: 51, v4_verdict: "STRONG" }),
      row({ ticker: "ASMNAME", v4_score: 65, v4_verdict: "TOP_PICK", regulatory_flags: { surveillance: "ASM" } }),
      row({ ticker: "GSMNAME", v4_score: 70, v4_verdict: "TOP_PICK", regulatory_flags: { surveillance: "GSM" } }),
    ],
  },
  picksLatest: { sections: { top_ranked_30_v4: [], snowflake_gap_lab: [{ ticker: "KRISHNADEF" }] } },
  deepByTicker: {
    FINOPB: deep({
      future: 5,
      returns: { "7D": 3.2, "1M": 2.3, "3M": -25.1, "6M": -50.4, "1Y": -50.5 },
      news: [{ title: "New minor risk - Profit margin trend", date: "2026-06-10T00:00:00.000Z" }],
    }),
    KRISHNADEF: deep({
      future: 0,
      returns: { "7D": 7.3, "3M": 13, "6M": 63.4, "1Y": 27.1 },
      dataQuality: { affected_pillars: ["Future"], by_pillar: { Future: { insufficient: 6 } } },
      news: [
        { title: "Full year 2026 earnings released: EPS: ₹28.12 (vs ₹15.82 in FY 2025)", date: "2026-05-22T00:00:00.000Z" },
        { title: "Investor sentiment improves as stock rises 22%", date: "2026-05-20T00:00:00.000Z" },
      ],
    }),
    WEAKTAPE: deep({
      future: 5,
      returns: { "7D": -4, "1M": -8, "3M": -20 },
      news: [{ title: "Investor sentiment deteriorates as stock falls 16%", date: "2026-06-08T00:00:00.000Z" }],
    }),
    ASMNAME: deep({ future: 5, returns: { "7D": 8 }, news: [{ title: "Revenue rises strongly", date: "2026-06-09T00:00:00.000Z" }] }),
    GSMNAME: deep({ future: 5, returns: { "7D": 8 }, news: [{ title: "Revenue rises strongly", date: "2026-06-09T00:00:00.000Z" }] }),
  },
  inputChanges: {
    run_id: "test-run",
    confirmation_policy: "two_consecutive_full_runs",
    changes: [
      { ticker: "FINOPB", changes: [{ field: "snowflake.future", previous: 3, current: 5 }] },
    ],
  },
});

const byTicker = new Map(feed.items.map((item) => [item.ticker, item]));

assert.ok(byTicker.has("FINOPB"), "FINOPB should appear in the discovery feed");
assert.ok(byTicker.get("FINOPB").lanes.some((lane) => lane.id === "off_section_high_future"), "FINOPB should land in Off-section High Future");
assert.ok(byTicker.get("FINOPB").caution_flags.includes("needs_tape_confirmation"), "weak tape high-future names should be review-only");

assert.ok(byTicker.has("KRISHNADEF"), "KRISHNADEF should appear in the discovery feed");
assert.ok(byTicker.get("KRISHNADEF").lanes.some((lane) => lane.id === "momentum_news_confirmed"), "KRISHNADEF should land in Momentum + News");
assert.ok(byTicker.get("KRISHNADEF").caution_flags.includes("future_data_unavailable"), "Future 0/6 with no-data should be cautioned, not treated as low growth");

assert.ok(byTicker.get("WEAKTAPE").caution_flags.includes("news_headwind"), "negative-news/weak-tape names are caution-tagged");
assert.ok(byTicker.get("ASMNAME").caution_flags.includes("surveillance_hard_caution"), "ASM names are hard-cautioned");
assert.equal(byTicker.has("GSMNAME"), false, "GSM names are suppressed");

const email = buildDiscoveryFeedEmail(feed);
assert.match(email.html, /Discovery Radar/);
assert.match(email.html, /<table role="presentation"/);
assert.match(email.html, /Off-section High Future/);
assert.match(email.html, /Why surfaced/);
assert.doesNotMatch(email.html, /\{"schema_version"/);

console.log("sws discovery feed classification and email formatting ok");
