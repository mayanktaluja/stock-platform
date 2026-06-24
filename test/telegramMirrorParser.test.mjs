/**
 * Run with: node test/telegramMirrorParser.test.mjs
 */

import assert from "node:assert/strict";
import { parseMirrorHtml, stripHtml } from "../services/alerts/telegramMirrorParser.js";

// --- stripHtml ---
assert.equal(stripHtml("<b>Hello</b> <a href='x'>world</a>"), "Hello world");
assert.equal(stripHtml("line1<br/><br/>line2"), "line1 line2");
assert.equal(stripHtml("AT&amp;T up &lt;5%&gt; on &#39;news&#39;"), "AT&T up <5%> on 'news'");
assert.equal(stripHtml("&amp;lt; should not double-decode"), "&lt; should not double-decode");
assert.equal(stripHtml("<i class=\"emoji\" style=\"background-image:url('x')\"><b>🌱</b></i> UPL up"), "🌱 UPL up");

// --- parseMirrorHtml: a realistic two-message fixture (mirrors live t.me/s markup) ---
const html = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="cnbc_tv18/42950" data-view="1">
    <div class="tgme_widget_message_text js-message_text" dir="auto"><b>IndiGo market cap back at ₹2 lakh crore</b><br/><br/>Read: <a href="https://x.com">link</a></div>
    <div class="tgme_widget_message_footer"><time datetime="2026-06-24T10:16:56+00:00">10:16</time></div>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="cnbc_tv18/42951" data-view="1">
    <div class="tgme_widget_message_text js-message_text" dir="auto">Gold slips to ₹1.46 lakh per 10 grams</div>
    <div class="tgme_widget_message_footer"><time datetime="2026-06-24T10:42:19+00:00">10:42</time></div>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="cnbc_tv18/42952"><a class="tgme_widget_message_photo_wrap"></a></div>
</div>`;

const rows = parseMirrorHtml(html);
assert.equal(rows.length, 2); // the media-only third block (no text div) is skipped
assert.equal(rows[0].slug, "cnbc_tv18");
assert.equal(rows[0].id, "42950");
assert.equal(rows[0].text, "IndiGo market cap back at ₹2 lakh crore Read: link");
assert.equal(rows[0].publishedAt, "2026-06-24T10:16:56.000Z");
assert.equal(rows[0].url, "https://t.me/cnbc_tv18/42950");
assert.equal(rows[1].text, "Gold slips to ₹1.46 lakh per 10 grams");
assert.equal(rows[1].id, "42951");

// Empty / junk → [] (never throws).
assert.deepEqual(parseMirrorHtml(""), []);
assert.deepEqual(parseMirrorHtml("<html>no messages here</html>"), []);
assert.deepEqual(parseMirrorHtml(null), []);

console.log("telegramMirrorParser.test.mjs OK");
