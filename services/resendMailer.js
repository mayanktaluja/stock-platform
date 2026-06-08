const RESEND_URL = "https://api.resend.com/emails";

function boolFlag(value) {
  return String(value || "").trim().toLowerCase() === "1" || String(value || "").trim().toLowerCase() === "true";
}

function isEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || "").trim());
}

export function mailerState(env = process.env) {
  if (env.SWS_MAIL_ENABLED === "0") return { enabled: false, reason: "SWS_MAIL_ENABLED=0" };
  if (!env.RESEND_API_KEY) return { enabled: false, reason: "RESEND_API_KEY missing" };
  if (!env.SWS_MAIL_FROM && !env.RESEND_FROM_EMAIL) return { enabled: false, reason: "SWS_MAIL_FROM missing" };
  return { enabled: true, reason: null };
}

export function buildResendPayload({ to, from, subject, text, html }, env = process.env) {
  const recipient = String(to || "").trim();
  if (!isEmail(recipient)) throw new Error("sendMail: explicit valid recipient is required");
  const sender = String(from || env.SWS_MAIL_FROM || env.RESEND_FROM_EMAIL || "").trim();
  if (!sender) throw new Error("sendMail: from is required");
  if (!subject) throw new Error("sendMail: subject is required");
  if (!text && !html) throw new Error("sendMail: text or html body is required");
  return {
    from: sender,
    to: [recipient],
    subject: String(subject),
    ...(text ? { text: String(text) } : {}),
    ...(html ? { html: String(html) } : {}),
  };
}

export async function sendMail(message, { env = process.env, dryRun = false } = {}) {
  const state = mailerState(env);
  let payload;
  try {
    payload = buildResendPayload(message, env);
  } catch (err) {
    return { ok: false, skipped: false, reason: "invalid_message", error: err.message };
  }
  if (dryRun || boolFlag(env.SWS_INPUT_ALERTS_DRY_RUN)) {
    return { ok: true, skipped: true, dry_run: true, reason: "dry_run", payload };
  }
  if (!state.enabled) {
    return { ok: true, skipped: true, reason: state.reason, payload };
  }
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  let json = null;
  try { json = body ? JSON.parse(body) : null; } catch {}
  if (!res.ok) {
    return { ok: false, skipped: false, status: res.status, error: json?.message || body || res.statusText };
  }
  return { ok: true, skipped: false, status: res.status, id: json?.id || null };
}
