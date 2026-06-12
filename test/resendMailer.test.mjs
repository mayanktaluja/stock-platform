/**
 * Run with: node test/resendMailer.test.mjs
 */

import assert from "node:assert/strict";
import {
  buildGmailPayload,
  buildResendPayload,
  isSandboxResendSender,
  mailProvider,
  mailerState,
  sendMail,
  validateBulkMailerConfig,
} from "../services/resendMailer.js";

assert.deepEqual(mailerState({}), { enabled: false, reason: "RESEND_API_KEY missing" });
assert.deepEqual(
  mailerState({ RESEND_API_KEY: "key", SWS_MAIL_FROM: "Starbhai <alerts@example.com>" }),
  { enabled: true, reason: null, provider: "resend" },
);
assert.equal(mailProvider({ SWS_MAIL_PROVIDER: "gmail" }), "gmail");
assert.deepEqual(
  mailerState({ SWS_MAIL_PROVIDER: "gmail" }),
  { enabled: false, reason: "GMAIL_CLIENT_ID missing" },
);
assert.deepEqual(
  mailerState({
    SWS_MAIL_PROVIDER: "gmail",
    GMAIL_CLIENT_ID: "client",
    GMAIL_CLIENT_SECRET: "secret",
    GMAIL_REFRESH_TOKEN: "refresh",
    GMAIL_MAIL_FROM: "Starbhai <mtaluja11@gmail.com>",
  }),
  { enabled: true, reason: null, provider: "gmail" },
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
assert.deepEqual(
  validateBulkMailerConfig({
    SWS_MAIL_PROVIDER: "gmail",
    GMAIL_CLIENT_ID: "client",
    GMAIL_CLIENT_SECRET: "secret",
    GMAIL_REFRESH_TOKEN: "refresh",
    GMAIL_MAIL_FROM: "Starbhai <mtaluja11@gmail.com>",
  }),
  { ok: true, reason: null, sender: "Starbhai <mtaluja11@gmail.com>", provider: "gmail" },
);
assert.equal(
  validateBulkMailerConfig({ RESEND_API_KEY: "key", RESEND_FROM_EMAIL: "alerts@example.com" }).ok,
  true,
  "bulk preflight honors the legacy sender fallback",
);

const gmailPayload = buildGmailPayload({
  to: "reader@example.com",
  from: "Starbhai <mtaluja11@gmail.com>",
  subject: "Impact ✓",
  text: "Positive impact",
  html: "<strong>Positive impact</strong>",
});
assert.equal(gmailPayload.provider, "gmail");
assert.equal(gmailPayload.to[0], "reader@example.com");
assert.match(gmailPayload.raw, /^[A-Za-z0-9_-]+$/);
const decodedGmail = Buffer.from(gmailPayload.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
assert.match(decodedGmail, /Subject: =\?UTF-8\?B\?/);
assert.match(decodedGmail, /Content-Type: multipart\/alternative/);

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

  const gmailEnv = {
    SWS_MAIL_PROVIDER: "gmail",
    GMAIL_CLIENT_ID: "client",
    GMAIL_CLIENT_SECRET: "secret",
    GMAIL_REFRESH_TOKEN: "refresh",
    GMAIL_MAIL_FROM: "Starbhai <mtaluja11@gmail.com>",
  };
  const gmailCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    gmailCalls.push({ url: String(url), body: String(options.body || "") });
    if (String(url).includes("/token")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "access-token" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "gmail-1", threadId: "thread-1" }) };
  };
  const gmailSent = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body", html: "<b>Body</b>" },
    { env: gmailEnv },
  );
  assert.equal(gmailSent.ok, true);
  assert.equal(gmailSent.provider, "gmail");
  assert.equal(gmailSent.id, "gmail-1");
  assert.equal(gmailCalls.length, 2);
  assert.match(gmailCalls[0].body, /refresh_token=refresh/);
  assert.match(gmailCalls[1].body, /"raw"/);

  globalThis.fetch = async (url) => {
    if (String(url).includes("/token")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "access-token" }) };
    }
    return { ok: false, status: 429, statusText: "Too Many Requests", text: async () => JSON.stringify({ error: { message: "rate limited" } }) };
  };
  const gmailRateLimited = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body" },
    { env: gmailEnv },
  );
  assert.equal(gmailRateLimited.ok, false);
  assert.equal(gmailRateLimited.provider, "gmail");
  assert.equal(gmailRateLimited.reason, "gmail_error");
  assert.equal(gmailRateLimited.retryable, true);

  globalThis.fetch = async (url) => {
    if (String(url).includes("/token")) throw new Error("token network down");
    throw new Error("unexpected");
  };
  const gmailFetchFailed = await sendMail(
    { to: "reader@example.com", subject: "Sample", text: "Body" },
    { env: gmailEnv },
  );
  assert.equal(gmailFetchFailed.ok, false);
  assert.equal(gmailFetchFailed.reason, "fetch_failed");
  assert.match(gmailFetchFailed.error, /token network down/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("resendMailer tests passed");
