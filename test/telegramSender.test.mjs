/**
 * Run with: node test/telegramSender.test.mjs
 */

import assert from "node:assert/strict";
import { escapeHtml, buildTelegramPayload, sendTelegram } from "../services/alerts/telegramSender.js";

const ENV = { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "999" };
const noSleep = async () => {};

// --- escapeHtml ---
assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
assert.equal(escapeHtml("RBI 🚨 hike"), "RBI 🚨 hike"); // emoji passes through
assert.equal(escapeHtml(null), "");

// --- buildTelegramPayload ---
assert.throws(() => buildTelegramPayload({ text: "" }, ENV), /non-empty/);

const routine = buildTelegramPayload({ text: "hi" }, ENV);
assert.equal(routine.chat_id, "999");
assert.equal(routine.parse_mode, "HTML");
assert.equal(routine.disable_notification, true); // routine = silent
assert.equal(routine.link_preview_options.is_disabled, true);
assert.equal(routine.reply_markup, undefined);

const breaking = buildTelegramPayload({ text: "boom", breaking: true }, ENV);
assert.equal(breaking.disable_notification, false); // breaking = makes a sound

const withButtons = buildTelegramPayload(
  { text: "x", buttons: [{ text: "Open", url: "https://e.com" }, { text: "bad" }] },
  ENV,
);
assert.equal(withButtons.reply_markup.inline_keyboard[0].length, 1); // the button missing url is dropped
assert.deepEqual(withButtons.reply_markup.inline_keyboard[0][0], { text: "Open", url: "https://e.com" });

// truncation at 3900 with ellipsis
const long = buildTelegramPayload({ text: "x".repeat(5000) }, ENV);
assert.ok(long.text.length <= 3900);
assert.ok(long.text.endsWith("…"));

// --- sendTelegram self-skip when unconfigured ---
const skipped = await sendTelegram({ text: "hi" }, { env: {}, fetchImpl: () => { throw new Error("should not fetch"); } });
assert.deepEqual(skipped, { ok: true, skipped: true, reason: "TG_BOT_TOKEN missing" });

// --- dry run never hits network ---
const dry = await sendTelegram({ text: "hi" }, { env: ENV, dryRun: true, fetchImpl: () => { throw new Error("no"); } });
assert.equal(dry.ok, true);
assert.equal(dry.skipped, true);
assert.equal(dry.reason, "dry_run");

// --- happy path ---
let calls = 0;
const okFetch = async () => { calls += 1; return { status: 200, ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) }; };
const sent = await sendTelegram({ text: "hi" }, { env: ENV, fetchImpl: okFetch });
assert.equal(sent.ok, true);
assert.equal(sent.skipped, false);
assert.equal(calls, 1);

// --- 429 honored then success ---
let n = 0;
const flaky = async () => {
  n += 1;
  if (n === 1) return { status: 429, ok: false, json: async () => ({ parameters: { retry_after: 1 } }) };
  return { status: 200, ok: true, json: async () => ({ ok: true }) };
};
const retried = await sendTelegram({ text: "hi" }, { env: ENV, fetchImpl: flaky, sleep: noSleep });
assert.equal(retried.ok, true);
assert.equal(n, 2);

// --- 429 exhausts retries → ok:false ---
const always429 = async () => ({ status: 429, ok: false, json: async () => ({ parameters: { retry_after: 1 } }) });
const exhausted = await sendTelegram({ text: "hi" }, { env: ENV, fetchImpl: always429, sleep: noSleep, maxRetries: 1 });
assert.equal(exhausted.ok, false);
assert.equal(exhausted.status, 429);

// --- 400 is NOT retried (non-retryable) ---
let cnt400 = 0;
const bad = async () => { cnt400 += 1; return { status: 400, ok: false, json: async () => ({ description: "bad html" }) }; };
const rejected = await sendTelegram({ text: "hi" }, { env: ENV, fetchImpl: bad, sleep: noSleep });
assert.equal(rejected.ok, false);
assert.equal(rejected.status, 400);
assert.equal(cnt400, 1); // tried exactly once
assert.match(rejected.reason, /bad html/);

console.log("telegramSender.test.mjs OK");
