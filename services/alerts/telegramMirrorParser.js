/**
 * Parse Telegram's PUBLIC channel web preview (https://t.me/s/<slug>) into
 * message rows. Plain HTTPS + regex — no MTProto, no session, no dependency.
 * This is the reliable ingestion path for the news router when a persistent
 * MTProto connection can't be held.
 *
 * Each message lives in a `tgme_widget_message_wrap` block containing
 *   data-post="<slug>/<id>"            → permalink id
 *   <div class="tgme_widget_message_text …">BODY</div>  → HTML body
 *   <time datetime="ISO">              → timestamp
 *
 * Pure/deterministic; returns [] on unparseable input (never throws).
 */

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return _; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => ENTITIES[m] || m)
    .replace(/&amp;/g, "&"); // decode &amp; LAST to avoid double-decoding
}

/** HTML message body → plain text. Keeps emoji (inside <b> tags), drops markup. */
export function stripHtml(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, ""), // strip all remaining tags (emoji chars survive)
  ).replace(/\s+/g, " ").trim();
}

function safeIso(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * parseMirrorHtml(html, slug?) → [{ slug, id, text, publishedAt, url }]
 * `slug` is unused for parsing (the real slug comes from data-post) but kept for
 * call-site symmetry. Messages with no text body (media-only) are skipped.
 */
export function parseMirrorHtml(html) {
  const out = [];
  // Split into per-message chunks on the wrapper class so the text/time regexes
  // can't bleed across adjacent messages.
  const chunks = String(html || "").split("tgme_widget_message_wrap");
  for (const ch of chunks) {
    const post = ch.match(/data-post="([^"/]+)\/(\d+)"/);
    if (!post) continue;
    const textM = ch.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!textM) continue; // media-only / no text → skip
    const text = stripHtml(textM[1]);
    if (!text) continue;
    const timeM = ch.match(/datetime="([^"]+)"/);
    const slug = post[1];
    const id = post[2];
    out.push({ slug, id, text, publishedAt: safeIso(timeM && timeM[1]), url: `https://t.me/${slug}/${id}` });
  }
  return out;
}
