// drainEntryQueue — queue → format → dedup → dispatch → record-AFTER-send → rewrite.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drainEntryQueue } from "../scripts/refresh-news-alerts.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  const p = Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  not ok ${name}\n    ${e.message}`);
    });
  chain = chain.then(() => p);
}
let chain = Promise.resolve();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-drain-"));
let n = 0;
function writeQueue(transitions) {
  const p = path.join(dir, `q${n++}.json`);
  fs.writeFileSync(p, JSON.stringify({ generated_at: "2026-07-03T21:00:00Z", transitions }));
  return p;
}
const CONFIRMED = { ticker: "AAA", from: "STABILIZING", to: "ENTRY_CONFIRMED", price_inr: 100 };
const KNIFE = { ticker: "BBB", from: "STABILIZING", to: "FALLING_KNIFE", price_inr: 50 };
const SILENT = { ticker: "CCC", from: "STABILIZING", to: "MACRO_DEFER" };

function fakeDeps({ sendOk = true, known = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      hasKey: (k) => {
        calls.push(["hasKey", k]);
        return known.has(k);
      },
      recordSent: (k) => calls.push(["recordSent", k]),
      dispatch: async (a) => {
        calls.push(["dispatch", a.key]);
        return { ok: sendOk };
      },
      log: { log: () => {}, warn: () => {} },
    },
  };
}

check("happy path: sends, records AFTER dispatch, deletes drained queue", async () => {
  const q = writeQueue([CONFIRMED, SILENT]);
  const { calls, deps } = fakeDeps();
  const res = await drainEntryQueue({ queuePath: q, deps });
  assert.deepEqual({ sent: res.sent, dropped: res.dropped, kept: res.kept }, { sent: 1, dropped: 1, kept: 0 });
  const dispatchIdx = calls.findIndex((c) => c[0] === "dispatch");
  const recordIdx = calls.findIndex((c) => c[0] === "recordSent");
  assert.ok(dispatchIdx >= 0 && recordIdx > dispatchIdx, "recordSent must come AFTER dispatch");
  assert.ok(!fs.existsSync(q), "fully drained queue is deleted");
});

check("failed dispatch keeps the row queued (retry next tick), others still processed", async () => {
  const q = writeQueue([CONFIRMED, KNIFE]);
  const { deps } = fakeDeps({ sendOk: false });
  const res = await drainEntryQueue({ queuePath: q, deps });
  assert.equal(res.sent, 0);
  assert.equal(res.kept, 2);
  const survivors = JSON.parse(fs.readFileSync(q, "utf-8")).transitions;
  assert.equal(survivors.length, 2, "queue file still holds both rows");
});

check("hasKey hit drops without dispatching", async () => {
  const { calls, deps } = fakeDeps();
  // discover the real key by a first run, then replay with it marked known
  const q1 = writeQueue([KNIFE]);
  await drainEntryQueue({ queuePath: q1, deps });
  const sentKey = calls.find((c) => c[0] === "recordSent")[1];
  const q2 = writeQueue([KNIFE]);
  const second = fakeDeps({ known: new Set([sentKey]) });
  const res = await drainEntryQueue({ queuePath: q2, deps: second.deps });
  assert.equal(res.dup, 1);
  assert.ok(!second.calls.some((c) => c[0] === "dispatch"), "no dispatch on dup");
  assert.ok(!fs.existsSync(q2), "dup rows drain out of the queue");
});

check("dry-run: sends nothing, queue byte-identical", async () => {
  const q = writeQueue([CONFIRMED]);
  const before = fs.readFileSync(q, "utf-8");
  const { calls, deps } = fakeDeps();
  await drainEntryQueue({ queuePath: q, dryRun: true, deps });
  assert.ok(!calls.some((c) => c[0] === "dispatch" || c[0] === "recordSent"));
  assert.equal(fs.readFileSync(q, "utf-8"), before);
});

check("absent queue: cheap no-op", async () => {
  const res = await drainEntryQueue({ queuePath: path.join(dir, "nope.json"), deps: fakeDeps().deps });
  assert.equal(res.absent, true);
});

check("corrupt queue: warns, leaves file untouched", async () => {
  const q = path.join(dir, "corrupt.json");
  fs.writeFileSync(q, "{nope");
  const res = await drainEntryQueue({ queuePath: q, deps: fakeDeps().deps });
  assert.equal(res.error, "corrupt");
  assert.equal(fs.readFileSync(q, "utf-8"), "{nope");
});

chain.then(() => {
  console.log(`\nentryQueueDrain result: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
