// Market Wire — cross-channel story clustering (Phase 2).
//
// The buffer holds the same wire seen on N channels as N separate lines
// (FinancialJuice, Walter Bloomberg, Insider Paper all post the same Fed
// headline within seconds). This collapses near-duplicate messages into one
// cluster with a distinct-source count — the corroboration signal that later
// drives ranking and the on-card "3 sources" chip.
//
// Deterministic token-set Jaccard, greedy single-pass agglomeration. Zero-cost
// (no LLM, no embeddings) and catches reworded near-dups the existing 40-char
// prefix dedup (server.js:4128) misses. An embedding upgrade can drop in behind
// the same clusterMessages() signature later; Jaccard stays the always-available
// floor.
//
// [H3] The cluster KEY is anchored to the earliest-publishedAt member's stable
// id — NOT the representative and NOT a min-over-hashes. sha256 is ~uniform, so
// a min-over-hashes would let a new corroborating source silently re-key a
// still-fresh story; anchoring on earliest-publishedAt means later-arriving
// members never displace the key. The key stays stable the whole time a story
// is fresh and ranked; it only changes once the anchor ages out of the window,
// by which point recency-decay has already sunk the story out of view.

import { createHash } from "node:crypto";

// Small, deliberately conservative stopword set — enough to stop function words
// from inflating Jaccard overlap between unrelated headlines, not so aggressive
// that it strips signal. Directional words (up/down/rise/fall) are kept: they
// carry market meaning and two versions of the same story share them anyway.
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "at", "by", "is",
  "are", "was", "were", "be", "been", "as", "with", "from", "that", "this", "it",
  "its", "has", "have", "had", "will", "after", "over", "amid", "into", "out",
  "than", "then", "but", "not", "no", "new", "says", "say", "said", "reports",
  "report", "breaking", "update", "via", "per", "about",
]);

/** Normalize a message body to a Set of comparable tokens. */
export function normalizeTokens(text) {
  const out = new Set();
  if (!text) return out;
  const cleaned = String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ") // drop URLs
    .replace(/[^a-z0-9\s]/g, " "); // drop punctuation + emoji, keep alphanumerics
  for (const tok of cleaned.split(/\s+/)) {
    if (!tok || tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** Jaccard similarity of two token Sets: |A∩B| / |A∪B|. */
export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function memberId(m) {
  // Stable per-member id, namespaced by channel so the same routerKey on two
  // channels yields two ids (they must not collapse).
  return createHash("sha256").update(`${m.channel || ""}|${m.routerKey || m.text || ""}`).digest("hex");
}

function tsOf(m) {
  const t = m?.publishedAt ? new Date(m.publishedAt).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * clusterMessages(records, opts) → { clusters, stats }
 *
 * Each cluster:
 *   { key, representative, members[], source_count, breaking, symbols,
 *     categories, first_seen, last_seen }
 *
 * - threshold: Jaccard cutoff to join a cluster (default 0.5).
 * - minTokens: below this token count on either side, require a stricter 0.8 so
 *   terse one-liners don't over-merge on a couple of shared words.
 */
export function clusterMessages(records, { threshold = 0.5, minTokens = 4 } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && r.text);
  // Deterministic order: earliest first, tie-break by stable member id. This
  // makes the anchor (cluster opener) reproducible regardless of buffer order.
  list.sort((a, b) => (tsOf(a) - tsOf(b)) || memberId(a).localeCompare(memberId(b)));

  const clusters = []; // { anchorTokens, members: [] }
  for (const rec of list) {
    const tokens = normalizeTokens(rec.text);
    let best = null;
    let bestSim = 0;
    for (const c of clusters) {
      const sim = jaccard(tokens, c.anchorTokens);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    const terse = tokens.size < minTokens || (best && best.anchorTokens.size < minTokens);
    const cut = terse ? Math.max(threshold, 0.8) : threshold;
    if (best && bestSim >= cut) {
      best.members.push(rec);
    } else {
      clusters.push({ anchorTokens: tokens, members: [rec] });
    }
  }

  const built = clusters.map((c) => finalizeCluster(c.members));
  let singletons = 0;
  for (const c of built) if (c.members.length === 1) singletons += 1;
  return { clusters: built, stats: { messages: list.length, clusters: built.length, singletons } };
}

function finalizeCluster(members) {
  // Anchor = earliest-publishedAt member (tie-break by stable id). Key is derived
  // from the anchor so it survives new members arriving (H3).
  const anchor = members.reduce((a, b) => {
    const dt = tsOf(a) - tsOf(b);
    if (dt !== 0) return dt < 0 ? a : b;
    return memberId(a) <= memberId(b) ? a : b;
  });
  const key = memberId(anchor).slice(0, 16);

  // Representative for display = newest member (freshest phrasing), tie-break
  // by longest text (most complete headline).
  const representative = members.reduce((a, b) => {
    const dt = tsOf(b) - tsOf(a);
    if (dt !== 0) return dt > 0 ? b : a;
    return (b.text || "").length > (a.text || "").length ? b : a;
  }).text;

  const channels = new Set();
  const symbols = new Set();
  const categories = new Set();
  let breaking = false;
  let first = Infinity;
  let last = -Infinity;
  for (const m of members) {
    if (m.channel) channels.add(m.channel);
    for (const s of m.symbols || []) symbols.add(s);
    if (m.category) categories.add(m.category);
    if (m.breaking) breaking = true;
    const t = tsOf(m);
    if (t && t < first) first = t;
    if (t && t > last) last = t;
  }
  return {
    key,
    representative,
    members,
    source_count: channels.size,
    breaking,
    symbols: [...symbols],
    categories: [...categories],
    first_seen: Number.isFinite(first) ? new Date(first).toISOString() : null,
    last_seen: Number.isFinite(last) ? new Date(last).toISOString() : null,
  };
}

export default { normalizeTokens, jaccard, clusterMessages };
