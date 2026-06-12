const RESEND_URL = "https://api.resend.com/emails";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users";

function boolFlag(value) {
  return String(value || "").trim().toLowerCase() === "1" || String(value || "").trim().toLowerCase() === "true";
}

function isEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || "").trim());
}

export function mailProvider(env = process.env) {
  const provider = String(env.SWS_MAIL_PROVIDER || "resend").trim().toLowerCase();
  return provider === "gmail" ? "gmail" : "resend";
}

function senderAddress(value) {
  const raw = String(value || "").trim();
  const angle = raw.match(/<([^>]+)>/);
  return String(angle ? angle[1] : raw).trim().toLowerCase();
}

export function isSandboxResendSender(value) {
  return senderAddress(value) === "onboarding@resend.dev";
}

function resendSender(env = process.env) {
  return String(env.SWS_MAIL_FROM || env.RESEND_FROM_EMAIL || "").trim();
}

function gmailSender(env = process.env) {
  const explicit = String(env.GMAIL_MAIL_FROM || env.GMAIL_SENDER_EMAIL || "").trim();
  if (explicit) return explicit;
  const generic = String(env.SWS_MAIL_FROM || "").trim();
  return isSandboxResendSender(generic) ? "" : generic;
}

export function mailerState(env = process.env) {
  if (env.SWS_MAIL_ENABLED === "0") return { enabled: false, reason: "SWS_MAIL_ENABLED=0" };
  if (mailProvider(env) === "gmail") {
    if (!env.GMAIL_CLIENT_ID && !env.GOOGLE_CLIENT_ID) return { enabled: false, reason: "GMAIL_CLIENT_ID missing" };
    if (!env.GMAIL_CLIENT_SECRET && !env.GOOGLE_CLIENT_SECRET) return { enabled: false, reason: "GMAIL_CLIENT_SECRET missing" };
    if (!env.GMAIL_REFRESH_TOKEN) return { enabled: false, reason: "GMAIL_REFRESH_TOKEN missing" };
    if (!gmailSender(env)) return { enabled: false, reason: "GMAIL_MAIL_FROM missing" };
    return { enabled: true, reason: null, provider: "gmail" };
  }
  if (!env.RESEND_API_KEY) return { enabled: false, reason: "RESEND_API_KEY missing" };
  if (!env.SWS_MAIL_FROM && !env.RESEND_FROM_EMAIL) return { enabled: false, reason: "SWS_MAIL_FROM missing" };
  return { enabled: true, reason: null, provider: "resend" };
}

export function validateBulkMailerConfig(env = process.env) {
  const state = mailerState(env);
  if (!state.enabled) return { ok: false, reason: state.reason };
  const provider = mailProvider(env);
  const sender = provider === "gmail" ? gmailSender(env) : resendSender(env);
  if (!sender) return { ok: false, reason: "SWS_MAIL_FROM missing" };
  if (provider === "resend" && isSandboxResendSender(sender)) return { ok: false, reason: "sandbox_sender_blocked" };
  return { ok: true, reason: null, sender, provider };
}

export function buildResendPayload({ to, from, subject, text, html }, env = process.env) {
  const recipient = String(to || "").trim();
  if (!isEmail(recipient)) throw new Error("sendMail: explicit valid recipient is required");
  const sender = String(from || resendSender(env)).trim();
  if (!sender) throw new Error("sendMail: from is required");
  if (!subject) throw new Error("sendMail: subject is required");
  if (!text && !html) throw new Error("sendMail: text or html body is required");
  return {
    provider: "resend",
    from: sender,
    to: [recipient],
    subject: String(subject),
    ...(text ? { text: String(text) } : {}),
    ...(html ? { html: String(html) } : {}),
  };
}

function safeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeHeaderValue(value) {
  const safe = safeHeader(value);
  return /^[\x20-\x7E]*$/.test(safe) ? safe : `=?UTF-8?B?${Buffer.from(safe).toString("base64")}?=`;
}

function wrapBase64(value) {
  return Buffer.from(String(value || ""), "utf-8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
}

function base64Url(value) {
  return Buffer.from(String(value), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function buildGmailPayload({ to, from, subject, text, html }, env = process.env) {
  const recipient = String(to || "").trim();
  if (!isEmail(recipient)) throw new Error("sendMail: explicit valid recipient is required");
  const sender = String(from || gmailSender(env)).trim();
  if (!sender) throw new Error("sendMail: from is required");
  if (!subject) throw new Error("sendMail: subject is required");
  if (!text && !html) throw new Error("sendMail: text or html body is required");

  const boundary = "starbhai_sws_alert_alt";
  const plain = text || "";
  const htmlBody = html || `<pre>${String(plain).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>`;
  const message = [
    `From: ${safeHeader(sender)}`,
    `To: ${safeHeader(recipient)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(plain),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(htmlBody),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return {
    provider: "gmail",
    from: sender,
    to: [recipient],
    subject: String(subject),
    ...(text ? { text: String(text) } : {}),
    ...(html ? { html: String(html) } : {}),
    raw: base64Url(message),
  };
}

async function gmailAccessToken(env) {
  const body = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID || "",
    client_secret: env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || "",
    refresh_token: env.GMAIL_REFRESH_TOKEN || "",
    grant_type: "refresh_token",
  });
  let res;
  try {
    res = await fetch(GMAIL_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    return { ok: false, reason: "fetch_failed", error: err?.message || String(err) };
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok || !json?.access_token) {
    return {
      ok: false,
      reason: "gmail_token_error",
      status: res.status,
      error: json?.error_description || json?.error || text || res.statusText,
    };
  }
  return { ok: true, accessToken: json.access_token };
}

async function sendGmailPayload(payload, env) {
  const token = await gmailAccessToken(env);
  if (!token.ok) return { ok: false, skipped: false, provider: "gmail", ...token, payload };
  const userId = encodeURIComponent(env.GMAIL_USER_ID || "me");
  let res;
  try {
    res = await fetch(`${GMAIL_SEND_URL}/${userId}/messages/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: payload.raw }),
    });
  } catch (err) {
    return { ok: false, skipped: false, provider: "gmail", reason: "fetch_failed", error: err?.message || String(err), payload };
  }
  const body = await res.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch {}
  if (!res.ok) {
    return {
      ok: false,
      skipped: false,
      provider: "gmail",
      status: res.status,
      reason: "gmail_error",
      retryable: res.status === 429 || res.status >= 500,
      error: json?.error?.message || json?.message || body || res.statusText,
      payload,
    };
  }
  return { ok: true, skipped: false, provider: "gmail", status: res.status, id: json?.id || null, threadId: json?.threadId || null };
}

export async function sendMail(message, { env = process.env, dryRun = false, rejectSandboxSender = false } = {}) {
  const state = mailerState(env);
  const provider = mailProvider(env);
  let payload;
  try {
    payload = provider === "gmail" ? buildGmailPayload(message, env) : buildResendPayload(message, env);
  } catch (err) {
    return { ok: false, skipped: false, reason: "invalid_message", error: err.message };
  }
  if (dryRun || boolFlag(env.SWS_INPUT_ALERTS_DRY_RUN)) {
    return { ok: true, skipped: true, dry_run: true, provider, reason: "dry_run", payload };
  }
  if (provider === "resend" && rejectSandboxSender && isSandboxResendSender(payload.from)) {
    return { ok: false, skipped: false, reason: "sandbox_sender_blocked", error: "Resend sandbox sender cannot be used for bulk production mail", payload };
  }
  if (!state.enabled) {
    return { ok: true, skipped: true, provider, reason: state.reason, payload };
  }
  if (provider === "gmail") {
    return await sendGmailPayload(payload, env);
  }
  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, skipped: false, reason: "fetch_failed", error: err?.message || String(err), payload };
  }
  const body = await res.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch {}
  if (!res.ok) {
    return {
      ok: false,
      skipped: false,
      status: res.status,
      reason: "resend_error",
      retryable: res.status === 429 || res.status >= 500,
      error: json?.message || body || res.statusText,
    };
  }
  return { ok: true, skipped: false, provider: "resend", status: res.status, id: json?.id || null };
}
