/**
 * Run with: node test/throttleQueue.test.mjs
 */

import assert from "node:assert/strict";
import { createThrottleQueue } from "../services/alerts/throttleQueue.js";

const quiet = { warn() {} };

// FIFO order + all tasks run (minGapMs 0 → no real waiting).
{
  const order = [];
  const q = createThrottleQueue({ minGapMs: 0, logger: quiet });
  for (let i = 0; i < 5; i += 1) q.enqueue(async () => { order.push(i); });
  // let the drain loop flush
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  assert.equal(q.size(), 0);
}

// A throwing task does not wedge the queue — later tasks still run.
{
  const ran = [];
  const q = createThrottleQueue({ minGapMs: 0, logger: quiet });
  q.enqueue(async () => { throw new Error("boom"); });
  q.enqueue(async () => { ran.push("after"); });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ["after"]);
}

// Bounded: enqueuing past maxQueue drops the OLDEST, keeps the newest.
{
  const ran = [];
  // Block the drain with a slow first task so the rest pile up synchronously.
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = createThrottleQueue({ minGapMs: 0, maxQueue: 2, logger: quiet });
  q.enqueue(async () => { await gate; ran.push("slow"); }); // in-flight (shifted out, draining)
  q.enqueue(async () => { ran.push("a"); }); // queue: [a]
  q.enqueue(async () => { ran.push("b"); }); // queue: [a,b]
  const ok = q.enqueue(async () => { ran.push("c"); }); // full → drop oldest (a) → [b,c]
  assert.equal(ok, false);
  assert.equal(q.dropped(), 1);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(ran.includes("slow"));
  assert.ok(ran.includes("b") && ran.includes("c"));
  assert.ok(!ran.includes("a")); // oldest queued item was dropped
}

// Throttle: with a real gap, two tasks are spaced by >= minGapMs.
{
  const stamps = [];
  const q = createThrottleQueue({ minGapMs: 30, logger: quiet });
  q.enqueue(async () => { stamps.push(Date.now()); });
  q.enqueue(async () => { stamps.push(Date.now()); });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] - stamps[0] >= 25, `gap ${stamps[1] - stamps[0]}ms`);
}

console.log("throttleQueue.test.mjs OK");
