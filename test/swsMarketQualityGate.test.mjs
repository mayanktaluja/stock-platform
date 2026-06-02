import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateQualityGate } from "../scripts/sws-market-quality-gate.mjs";
import { MARKET_CANARIES, summarizeMarketQuality } from "../scripts/sws-market-quality-summary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUMMARY_SCRIPT = path.join(ROOT, "scripts", "sws-market-quality-summary.mjs");
const GATE_SCRIPT = path.join(ROOT, "scripts", "sws-market-quality-gate.mjs");

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function makeDeep(ticker, opts = {}) {
  const news = opts.news ?? [{
    date: "2026-06-01T00:00:00.000Z",
    title: `${ticker} fixture headline`,
  }];
  return {
    ticker,
    parsed_at: "2026-06-01T00:00:00.000Z",
    overview: {
      rewards: opts.rewards ?? [`${ticker} trades below fair value`],
      risks: opts.risks ?? [],
      recent_news_count: news.length,
    },
    news,
  };
}

function makeFixtureRoot(market = "us", opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sws-market-quality-"));
  const dataDir = path.join(root, "data", `sws-${market}`);
  const deepDir = path.join(dataDir, "deep");
  fs.mkdirSync(deepDir, { recursive: true });

  for (const ticker of MARKET_CANARIES[market]) {
    writeJson(path.join(deepDir, `${ticker}.json`), makeDeep(ticker, opts.deep?.[ticker] || {}));
  }
  writeJson(path.join(dataDir, "news-latest.json"), {
    generated_at: "2026-06-01T00:00:00.000Z",
    window_days: 30,
    coverage_count: MARKET_CANARIES[market].length,
    items_count: MARKET_CANARIES[market].length,
    items: MARKET_CANARIES[market].map((ticker) => ({ ticker, date: "2026-06-01T00:00:00.000Z", title: ticker })),
  });
  writeJson(path.join(dataDir, "news-progress.json"), {
    generated_at: "2026-06-01T00:00:01.000Z",
    market,
    shard_count: 1,
    done_count: MARKET_CANARIES[market].length,
    failed_count: 0,
    aborted: false,
    finished_at: "2026-06-01T00:00:01.000Z",
  });

  if (!opts.skipTarball) {
    execFileSync("tar", ["-czf", path.join(dataDir, `deep-${market}.tar.gz`), "-C", dataDir, "deep"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  if (opts.looseOnlyTicker) {
    writeJson(path.join(deepDir, `${opts.looseOnlyTicker}.json`), makeDeep(opts.looseOnlyTicker));
  }

  return { root, dataDir, deepDir };
}

function healthySummary(market = "kr", overrides = {}) {
  const canaries = Object.fromEntries(MARKET_CANARIES[market].map((ticker) => [ticker, {
    present: true,
    news_count: 1,
    rewards_count: 1,
    risks_count: 0,
    has_news: true,
    has_rewards: true,
    has_risks: false,
  }]));
  return {
    market,
    generated_at: "2026-06-01T00:00:05.000Z",
    deep_files_scanned: MARKET_CANARIES[market].length,
    news_populated_count: MARKET_CANARIES[market].length,
    news_items_total: MARKET_CANARIES[market].length,
    rewards_populated_count: MARKET_CANARIES[market].length,
    risks_populated_count: 0,
    canary_results: canaries,
    tarball_mtime: "2026-06-01T00:00:04.000Z",
    source: "tarball",
    source_problems: [],
    news_aggregate: {
      present: true,
      generated_at: "2026-06-01T00:00:02.000Z",
      coverage_count: MARKET_CANARIES[market].length,
      items_count: MARKET_CANARIES[market].length,
    },
    news_progress: {
      present: true,
      generated_at: "2026-06-01T00:00:02.000Z",
      finished_at: "2026-06-01T00:00:02.000Z",
      done_count: MARKET_CANARIES[market].length,
      failed_count: 0,
      aborted: false,
    },
    ...overrides,
  };
}

test("quality summary scans deployable tarball before loose deep fallback", () => {
  const { root } = makeFixtureRoot("us", { looseOnlyTicker: "LOOSE_ONLY" });
  try {
    const summary = summarizeMarketQuality({ market: "us", root });
    assert.equal(summary.source, "tarball");
    assert.equal(summary.deep_files_scanned, MARKET_CANARIES.us.length);
    assert.equal(summary.news_populated_count, MARKET_CANARIES.us.length);
    assert.equal(summary.news_items_total, MARKET_CANARIES.us.length);
    assert.equal(summary.rewards_populated_count, MARKET_CANARIES.us.length);
    assert.equal(summary.risks_populated_count, 0);
    assert.ok(summary.tarball_mtime);
    assert.deepEqual(summary.source_problems, []);
    for (const ticker of MARKET_CANARIES.us) {
      assert.equal(summary.canary_results[ticker].present, true, `${ticker} missing from canaries`);
      assert.equal(summary.canary_results[ticker].has_news, true, `${ticker} missing news`);
      assert.equal(summary.canary_results[ticker].has_rewards, true, `${ticker} missing rewards`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality summary falls back to loose deep only when tarball is missing", () => {
  const { root } = makeFixtureRoot("tw", { skipTarball: true });
  try {
    const summary = summarizeMarketQuality({ market: "tw", root });
    assert.equal(summary.source, "loose");
    assert.equal(summary.tarball_mtime, null);
    assert.equal(summary.deep_files_scanned, MARKET_CANARIES.tw.length);
    assert.ok(summary.source_problems.some((p) => p.code === "missing_tarball"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quality gate accepts healthy modal enrichment with zero risks as WARN only", () => {
  const report = evaluateQualityGate(healthySummary("kr"), { market: "kr" });
  assert.equal(report.failures.length, 0);
  assert.ok(report.warnings.some((w) => w.name === "risks_populated_visibility"));
});

test("quality gate blocks collapsed rewards and canaries without enrichment", () => {
  const summary = healthySummary("tw", {
    deep_files_scanned: 1000,
    rewards_populated_count: 1,
    canary_results: {
      ...healthySummary("tw").canary_results,
      "2451.TW": {
        present: true,
        news_count: 0,
        rewards_count: 0,
        risks_count: 0,
        has_news: false,
        has_rewards: false,
        has_risks: false,
      },
    },
  });
  const report = evaluateQualityGate(summary, { market: "tw" });
  assert.ok(report.failures.some((f) => f.name === "rewards_not_near_zero"));
  assert.ok(report.failures.some((f) => f.name === "canary_has_news:2451.TW"));
  assert.ok(report.failures.some((f) => f.name === "canary_has_rewards:2451.TW"));
});

test("quality gate blocks missing canaries and missing or aborted news signals", () => {
  const summary = healthySummary("us", {
    canary_results: {
      ...healthySummary("us").canary_results,
      FSM: { present: false, news_count: 0, rewards_count: 0, risks_count: 0 },
    },
    news_aggregate: { present: false },
    news_progress: { present: true, done_count: 0, aborted: true },
  });
  const report = evaluateQualityGate(summary, { market: "us" });
  assert.ok(report.failures.some((f) => f.name === "canary_present:FSM"));
  assert.ok(report.failures.some((f) => f.name === "news_aggregate_present"));
  assert.ok(report.failures.some((f) => f.name === "news_progress_not_aborted"));
  assert.ok(report.failures.some((f) => f.name === "news_progress_has_done_count"));
});

test("quality gate blocks source problems, including stale tarball summaries", () => {
  const report = evaluateQualityGate(healthySummary("kr", {
    source_problems: [{
      code: "tarball_older_than_news_progress",
      detail: {
        tarball_mtime: "2026-06-01T00:00:00.000Z",
        news_progress_at: "2026-06-01T00:10:00.000Z",
      },
    }],
  }), { market: "kr" });
  assert.ok(report.failures.some((f) => f.name === "no_source_problems"));
});

test("quality summary and gate CLIs round-trip through stdout/stdin", () => {
  const { root } = makeFixtureRoot("us");
  try {
    const summaryRun = spawnSync("node", [SUMMARY_SCRIPT, "--market", "us"], {
      cwd: ROOT,
      env: { ...process.env, SWS_REPO_ROOT_OVERRIDE: root },
      encoding: "utf8",
    });
    assert.equal(summaryRun.status, 0, summaryRun.stderr);
    const summary = JSON.parse(summaryRun.stdout);
    assert.equal(summary.source, "tarball");

    const gateRun = spawnSync("node", [GATE_SCRIPT, "--market", "us"], {
      cwd: ROOT,
      input: summaryRun.stdout,
      encoding: "utf8",
    });
    assert.equal(gateRun.status, 0, gateRun.stderr || gateRun.stdout);
    const report = JSON.parse(gateRun.stdout);
    assert.equal(report.failures.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
