/**
 * Run with: node test/resendMailer.test.mjs
 */

import assert from "node:assert/strict";
import { buildResendPayload, mailerState, sendMail } from "../services/resendMailer.js";

assert.deepEqual(mailerState({}), { enabled: false, reason: "RESEND_API_KEY missing" });
assert.deepEqual(
  mailerState({ RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <alerts@example.com>" }),
  { enabled: true, reason: null },
);

assert.throws(
  () => buildResendPayload({ to: "", from: "a@example.com", subject: "x", text: "x" }),
  /recipient/,
);
assert.deepEqual(buildResendPayload({
  to: "mtaluja11@gmail.com",
  from: "Starbhai <alerts@example.com>",
  subject: "Sample",
  text: "Body",
}).to, ["mtaluja11@gmail.com"]);

const disabled = await sendMail(
  { to: "mtaluja11@gmail.com", from: "alerts@example.com", subject: "Sample", text: "Body" },
  { env: {} },
);
assert.equal(disabled.ok, true);
assert.equal(disabled.skipped, true);
assert.equal(disabled.reason, "RESEND_API_KEY missing");

const dryRun = await sendMail(
  { to: "mtaluja11@gmail.com", from: "alerts@example.com", subject: "Sample", text: "Body" },
  { dryRun: true, env: { RESEND_API_KEY: "key", SWS_MAIL_FROM: "alerts@example.com" } },
);
assert.equal(dryRun.ok, true);
assert.equal(dryRun.dry_run, true);

console.log("resendMailer tests passed");
