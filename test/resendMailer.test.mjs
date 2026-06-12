/**
 * Run with: node test/resendMailer.test.mjs
 */

import assert from "node:assert/strict";
import {
  buildResendPayload,
  isSandboxResendSender,
  mailerState,
  sendMail,
  validateBulkMailerConfig,
} from "../services/resendMailer.js";

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
assert.equal(isSandboxResendSender("Starbhai <onboarding@resend.dev>"), true);
assert.deepEqual(
  validateBulkMailerConfig({ RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <onboarding@resend.dev>" }),
  { ok: false, reason: "sandbox_sender_blocked" },
);
assert.equal(
  validateBulkMailerConfig({ RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <alerts@example.com>" }).ok,
  true,
);
assert.equal(
  validateBulkMailerConfig({ RESEND_API_KEY: "key", RESEND_FROM_EMAIL: "alerts@example.com" }).ok,
  true,
  "bulk preflight honors the legacy sender fallback",
);

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

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
try {
  globalThis.fetch = async () => {
    fetchCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "email-1" }) };
  };
  const sent = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body" },
    { env: { RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <alerts@example.com>" } },
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.id, "email-1");
  assert.equal(fetchCalls, 1);

  const noFetchDryRun = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body" },
    { dryRun: true, env: { RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <alerts@example.com>" } },
  );
  assert.equal(noFetchDryRun.ok, true);
  assert.equal(fetchCalls, 1, "dry-run does not call fetch");

  const sandboxBlocked = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body" },
    { rejectSandboxSender: true, env: { RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <onboarding@resend.dev>" } },
  );
  assert.equal(sandboxBlocked.ok, false);
  assert.equal(sandboxBlocked.reason, "sandbox_sender_blocked");

  globalThis.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden", text: async () => JSON.stringify({ message: "domain not verified" }) });
  const domainError = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body" },
    { env: { RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <alerts@example.com>" } },
  );
  assert.equal(domainError.ok, false);
  assert.equal(domainError.status, 403);
  assert.equal(domainError.reason, "resend_error");
  assert.equal(domainError.error, "domain not verified");

  globalThis.fetch = async () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => "" });
  const rateLimited = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body" },
    { env: { RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <alerts@example.com>" } },
  );
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.retryable, true);

  globalThis.fetch = async () => { throw new Error("network down"); };
  const fetchFailed = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body" },
    { env: { RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <alerts@example.com>" } },
  );
  assert.equal(fetchFailed.ok, false);
  assert.equal(fetchFailed.reason, "fetch_failed");
  assert.match(fetchFailed.error, /network down/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("resendMailer tests passed");
