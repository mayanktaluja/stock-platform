/**
 * Run with: node test/topicManager.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { ensureTopics, loadTopicMap, CATEGORY_TITLES } from "../services/alerts/topicManager.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "topicmap-"));
const mapPath = path.join(dir, "topic-map.json");

try {
  // No bot token → not ready.
  let r = await ensureTopics(["markets"], { env: {}, mapPath, fetchImpl: () => { throw new Error("no fetch"); } });
  assert.equal(r.ready, false);
  assert.match(r.reason, /TG_BOT_TOKEN/);

  // Token but no group → not ready, no fetch.
  r = await ensureTopics(["markets"], { env: { TG_BOT_TOKEN: "t" }, mapPath, fetchImpl: () => { throw new Error("no fetch"); } });
  assert.equal(r.ready, false);
  assert.match(r.reason, /TG_GROUP_ID/);

  // Token + group + fake API → creates a topic per category, persists map.
  let threadSeq = 100;
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body).name);
    return { ok: true, json: async () => ({ ok: true, result: { message_thread_id: threadSeq++ } }) };
  };
  const env = { TG_BOT_TOKEN: "t", TG_GROUP_ID: "-100123" };
  r = await ensureTopics(["markets", "macro", "crypto"], { env, mapPath, fetchImpl: fakeFetch });
  assert.equal(r.ready, true);
  assert.equal(r.created, 3);
  assert.equal(r.groupId, "-100123");
  assert.deepEqual(Object.keys(r.topics).sort(), ["crypto", "macro", "markets"]);
  assert.ok(existsSync(mapPath));
  assert.equal(loadTopicMap(mapPath).topics.markets, 100);
  // Topic titles came from the canonical map.
  assert.ok(calls.includes(CATEGORY_TITLES.markets));

  // Idempotent: re-run with an overlapping set → only the NEW category is created.
  const calls2 = [];
  const fakeFetch2 = async (url, opts) => { calls2.push(JSON.parse(opts.body).name); return { ok: true, json: async () => ({ ok: true, result: { message_thread_id: threadSeq++ } }) }; };
  r = await ensureTopics(["markets", "macro", "trump"], { env, mapPath, fetchImpl: fakeFetch2 });
  assert.equal(r.ready, true);
  assert.equal(r.created, 1); // only "trump" is new
  assert.deepEqual(calls2, [CATEGORY_TITLES.trump]);

  // API failure → not ready, surfaced reason.
  const failFetch = async () => ({ ok: false, json: async () => ({ ok: false, description: "bot is not admin" }) });
  r = await ensureTopics(["geopolitics"], { env, mapPath, fetchImpl: failFetch });
  assert.equal(r.ready, false);
  assert.match(r.reason, /geopolitics|admin/);

  console.log("topicManager.test.mjs OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
