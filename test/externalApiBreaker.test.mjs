// Unit tests for services/externalApiBreaker.js — verify the circuit-breaker
// state machine + stale-cache fallback contract.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createBreaker } from "../services/externalApiBreaker.js";

function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("happy path: returns fresh data and caches it", async () => {
  const clock = makeClock();
  const breaker = createBreaker({ name: "test", now: clock.now });
  const out = await breaker.call("k", async () => ({ value: 42 }));
  assert.equal(out.fresh, true);
  assert.equal(out.source, "upstream");
  assert.deepEqual(out.data, { value: 42 });
  assert.equal(breaker._state().cacheSize, 1);
  assert.equal(breaker._state().consecutiveFailures, 0);
});

test("3 consecutive failures opens the breaker", async () => {
  const clock = makeClock();
  const breaker = createBreaker({ name: "test", openAfterFailures: 3, now: clock.now });
  // Seed cache with a success first so we can verify stale-fallback later
  await breaker.call("k", async () => ({ value: "good" }));
  // 3 failures
  for (let i = 0; i < 3; i++) {
    const out = await breaker.call("k", async () => { throw new Error("upstream down"); });
    assert.equal(out.fresh, false);
    // First 2 failures: NOT open yet, but stale cache served
    if (i < 2) {
      assert.equal(out.source, "stale_cache_upstream_error");
    }
  }
  assert.equal(breaker._state().isOpen, true);
  // Next call: doesn't even try upstream; serves stale immediately
  let upstreamCalled = false;
  const out = await breaker.call("k", async () => { upstreamCalled = true; return { value: "should not be reached" }; });
  assert.equal(upstreamCalled, false);
  assert.equal(out.fresh, false);
  assert.equal(out.source, "stale_cache_breaker_open");
  assert.deepEqual(out.data, { value: "good" });
});

test("cooldown elapses → next call retries upstream", async () => {
  const clock = makeClock();
  const breaker = createBreaker({ name: "test", openAfterFailures: 2, cooldownMs: 1000, now: clock.now });
  await breaker.call("k", async () => ({ value: "good" }));
  await breaker.call("k", async () => { throw new Error("down"); });
  await breaker.call("k", async () => { throw new Error("down"); });
  assert.equal(breaker._state().isOpen, true);
  clock.advance(1500); // > cooldownMs
  assert.equal(breaker._state().isOpen, false);
  // Now upstream comes back
  const out = await breaker.call("k", async () => ({ value: "recovered" }));
  assert.equal(out.fresh, true);
  assert.deepEqual(out.data, { value: "recovered" });
  assert.equal(breaker._state().consecutiveFailures, 0);
});

test("stale cache TTL exceeded → no fallback, returns null", async () => {
  const clock = makeClock();
  const breaker = createBreaker({ name: "test", openAfterFailures: 1, staleCacheTtlMs: 1000, now: clock.now });
  await breaker.call("k", async () => ({ value: "good" }));
  clock.advance(2000); // stale beyond TTL
  const out = await breaker.call("k", async () => { throw new Error("down"); });
  assert.equal(out.fresh, false);
  assert.equal(out.data, null);
  assert.equal(out.source, "upstream_error_no_cache");
});

test("timeout is enforced and counted as failure", async () => {
  const clock = makeClock();
  const breaker = createBreaker({ name: "test", timeoutMs: 50, openAfterFailures: 1, now: clock.now });
  const out = await breaker.call("k", () => new Promise(() => {})); // never resolves
  assert.equal(out.fresh, false);
  assert.equal(out.source, "upstream_error_no_cache");
  assert.match(out.error, /timeout/);
  assert.equal(breaker._state().consecutiveFailures, 1);
});

test("different keys get independent cache entries", async () => {
  const clock = makeClock();
  const breaker = createBreaker({ name: "test", now: clock.now });
  await breaker.call("a", async () => ({ k: "a" }));
  await breaker.call("b", async () => ({ k: "b" }));
  assert.equal(breaker._state().cacheSize, 2);
});

test("breaker state is per-instance, not global", async () => {
  const clock = makeClock();
  const b1 = createBreaker({ name: "one", openAfterFailures: 1, now: clock.now });
  const b2 = createBreaker({ name: "two", openAfterFailures: 1, now: clock.now });
  await b1.call("k", async () => { throw new Error("down"); });
  assert.equal(b1._state().isOpen, true);
  assert.equal(b2._state().isOpen, false);
});
