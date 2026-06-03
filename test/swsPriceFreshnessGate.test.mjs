import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateSwsPriceFreshness } from "../scripts/sws-price-freshness-gate.mjs";
import { extractSwsReturnsPct, swsPriceSeries } from "../scripts/sws-price-utils.mjs";

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function makeRaw(ticker, opts = {}) {
  return {
    ticker,
    fetchedAt: opts.fetchedAt ?? "2026-06-02T22:00:00.000Z",
    rest: {
      price: {
        data: opts.priceData ?? [
          { date: "2026-05-29", close: 100 },
          { date: "2026-06-02", close: 105 },
        ],
      },
    },
  };
}

function expectedReturns(priceData) {
  return extractSwsReturnsPct({ rest: { price: { data: priceData } } });
}

function makeDeep(ticker, opts = {}) {
  const priceData = opts.priceData ?? [
    { date: "2026-05-29", close: 100 },
    { date: "2026-06-02", close: 105 },
  ];
  return {
    ticker,
    parsed_at: opts.parsedAt ?? "2026-06-02T22:05:00.000Z",
    overview: {
      current_price_inr: opts.price ?? 105,
      returns_pct: opts.returnsPct ?? expectedReturns(priceData),
    },
  };
}

function compactCardReturns(returnsPct) {
  return Object.fromEntries(
    ["1D", "7D", "1M", "3M", "1Y"]
      .filter((key) => Number.isFinite(returnsPct?.[key]))
      .map((key) => [key, returnsPct[key]]),
  );
}

function makeRoot({ deepOverrides = {}, cardOverrides = {}, tarDeep = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sws-price-gate-"));
  const ticker = "INFY";
  const priceData = [
    { date: "2026-05-29", close: 100 },
    { date: "2026-06-02", close: 105 },
  ];
  writeJson(path.join(root, "deep-api", `${ticker}.json`), makeRaw(ticker, { priceData }));
  const deep = makeDeep(ticker, { priceData, ...deepOverrides });
  writeJson(path.join(root, "deep", `${ticker}.json`), deep);
  writeJson(path.join(root, "picks-latest.json"), {
    sections: {
      top_ranked_30_v3: [{
        ticker,
        current_price_inr: cardOverrides.price ?? deep.overview.current_price_inr,
        returns_pct: cardOverrides.returnsPct ?? compactCardReturns(deep.overview.returns_pct),
      }],
    },
  });
  const tarSource = fs.mkdtempSync(path.join(os.tmpdir(), "sws-price-gate-tar-"));
  try {
    writeJson(path.join(tarSource, "deep", `${ticker}.json`), tarDeep ?? deep);
    execFileSync("tar", ["-czf", path.join(root, "deep.tar.gz"), "-C", tarSource, "deep"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } finally {
    fs.rmSync(tarSource, { recursive: true, force: true });
  }
  return root;
}

test("fresh raw, deep, picks card, and tarball pass", () => {
  const root = makeRoot();
  try {
    assert.equal(evaluateSwsPriceFreshness({ root, source: "loose" }).ok, true);
    assert.equal(evaluateSwsPriceFreshness({ root, source: "tarball" }).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("newer raw price tape blocks stale parsed deep data", () => {
  const root = makeRoot({
    deepOverrides: {
      parsedAt: "2026-05-31T12:00:00.000Z",
      price: 100,
      returnsPct: { "1D": 0, "7D": 0, "1M": 0, "3M": 0, "6M": 0, "1Y": 0, "5Y": null },
    },
  });
  try {
    const result = evaluateSwsPriceFreshness({ root, source: "loose" });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.name === "deep_price_stale" && f.ticker === "INFY"));
    assert.ok(result.findings.some((f) => f.name === "deep_return_mismatch" && f.detail.key === "1D"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("picks card mismatch blocks even when parsed deep is fresh", () => {
  const root = makeRoot({
    cardOverrides: {
      price: 104,
      returnsPct: { "1D": 4, "7D": 4, "1M": 4, "3M": 4, "6M": 4, "1Y": 4, "5Y": null },
    },
  });
  try {
    const result = evaluateSwsPriceFreshness({ root, source: "loose" });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((f) => f.name === "picks_price_mismatch" && f.ticker === "INFY"));
    assert.ok(result.findings.some((f) => f.name === "picks_return_mismatch" && f.detail.key === "1D"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale packed deep tarball blocks after loose deep is fresh", () => {
  const root = makeRoot({
    tarDeep: makeDeep("INFY", {
      parsedAt: "2026-05-31T12:00:00.000Z",
      price: 100,
      returnsPct: { "1D": 0, "7D": 0, "1M": 0, "3M": 0, "6M": 0, "1Y": 0, "5Y": null },
    }),
  });
  try {
    assert.equal(evaluateSwsPriceFreshness({ root, source: "loose" }).ok, true);
    const tarball = evaluateSwsPriceFreshness({ root, source: "tarball" });
    assert.equal(tarball.ok, false);
    assert.ok(tarball.findings.some((f) => f.name === "deep_price_stale" && f.ticker === "INFY"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SWS return math sorts price tape and uses prior available trading close", () => {
  const unsorted = [
    { date: "2026-06-02", close: 105 },
    { date: "2026-05-29", close: 100 },
  ];
  assert.deepEqual(swsPriceSeries(unsorted).map((p) => p.date), ["2026-05-29", "2026-06-02"]);
  const ret = extractSwsReturnsPct(unsorted);
  assert.ok(Math.abs(ret["1D"] - 5) < 0.000001);
});

test("SWS return math does not collapse same-day duplicate rows to 0%", () => {
  const ret = extractSwsReturnsPct([
    { date: "2026-06-02", close: 100 },
    { date: "2026-06-02", close: 105 },
  ]);
  assert.equal(ret["1D"], null);
});
