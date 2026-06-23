/**
 * Run with: node test/alertsState.test.mjs
 */

import assert from "node:assert/strict";
import { alertsState, boolFlag, botToken, chatId } from "../services/alerts/alertsState.js";

// Unconfigured → self-skip with a specific reason.
assert.deepEqual(alertsState({}), { enabled: false, reason: "TG_BOT_TOKEN missing" });
assert.deepEqual(alertsState({ TG_BOT_TOKEN: "t" }), { enabled: false, reason: "TG_CHAT_ID missing" });

// Fully configured → enabled.
assert.deepEqual(
  alertsState({ TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "999" }),
  { enabled: true, reason: null },
);

// Kill switch wins over present creds.
assert.deepEqual(
  alertsState({ ALERTS_ENABLED: "0", TG_BOT_TOKEN: "t", TG_CHAT_ID: "c" }),
  { enabled: false, reason: "ALERTS_ENABLED=0" },
);

// Whitespace-only creds are treated as absent.
assert.deepEqual(alertsState({ TG_BOT_TOKEN: "  ", TG_CHAT_ID: "c" }), { enabled: false, reason: "TG_BOT_TOKEN missing" });

assert.equal(botToken({ TG_BOT_TOKEN: " 123:abc " }), "123:abc");
assert.equal(chatId({ TG_CHAT_ID: " 42 " }), "42");

assert.equal(boolFlag("1"), true);
assert.equal(boolFlag("true"), true);
assert.equal(boolFlag("0"), false);
assert.equal(boolFlag(undefined), false);

console.log("alertsState.test.mjs OK");
