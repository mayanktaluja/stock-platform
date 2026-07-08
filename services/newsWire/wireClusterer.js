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
//
// KNOWN LIMITATIONS (measured on the real buffer, both PRE-EXISTING to the
// containment work — the plain Jaccard rule exhibits them too):
//
//   1. Entity swap. "…cut off all trade with Spain" vs "…with Mexico" are equal
//      length and share every other token, so j=0.75 and they merge. Catching this
//      needs a proper-noun discriminator, and casing is unusable here because
//      Walter Bloomberg posts in ALL CAPS.
//   2. Press-conference skeletons. "Trump did not repeat criticism of Spain during
//      NATO…" vs "Trump did not mention Greenland during NATO…" lands at exactly
//      j=0.500, the cut. Stopwording the function words (did/during/told) split the
//      third statement of that trio out; this pair still merges. The containment
//      path correctly DECLINES it (0.750 < 0.80) — it survives on Jaccard alone.
//
// Both under-report as one card with a correct source_count, which is the benign
// direction. Fixing them means raising JACCARD_CUT, which costs real merges.

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

function intersectSize(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small) if (large.has(t)) n += 1;
  return n;
}

/**
 * Containment (overlap) coefficient: |A∩B| / min(|A|,|B|).
 *
 * Jaccard divides by the UNION, so it punishes length asymmetry. Measured on the
 * real buffer: a squawk headline ("Trump: Cut off all trade with Spain, all
 * visits.|FJ", 7 tokens) against a wire report of the same event ("President Trump
 * orders US to cut off all trade with Spain…", 20 tokens) scores j=0.46 — below the
 * 0.5 cut — while containment scores 0.86. The short one is a SUBSET of the long
 * one, which is exactly what "same story, terser channel" looks like.
 */
export function containment(a, b) {
  if (!a.size || !b.size) return 0;
  const m = Math.min(a.size, b.size);
  return m ? intersectSize(a, b) / m : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boilerplate stripping — run on RAW text, before lowercasing, so channel casing
// and @handles are still distinguishable.
//
// These tokens are pure channel branding. Left in, they dilute every similarity
// score: "JUST IN:" contributes `just`, "|FJ" contributes `fj`, and a trailing
// "Follow @X for more news" can add half a dozen tokens to one side of a pair.
// ─────────────────────────────────────────────────────────────────────────────
const URL_RE = /https?:\/\/\S+/gi;
const SHORTENER_RE = /\b[a-z0-9-]+\.(?:co|ly|it|gl|me|io)\/\S+/gi; // t.co/… bit.ly/… (no scheme)
const HANDLE_RE = /@[A-Za-z0-9_]+/g;                               // @WalterBloomberg, @WatcherGuru
const FOLLOW_RE = /\bfollow\b[^.]{0,40}?\bfor more news\b.*$/is;   // Insider Paper's trailer
const CHANNEL_SUFFIX_RE = /\|\s*[A-Za-z]{1,8}\s*$/;                // …|FJ
const LEAD_MARKER_RE = /^[\s\W]*(?:just\s+in|breaking(?:\s+news)?|developing|urgent|alert|exclusive|update|watch|flash|live)\b\s*[:\-–—]*\s*/i;

/**
 * Strip channel branding. NOTE we deliberately do NOT strip a trailing
 * "Sources: …" / "Reads: …" clause — a regex for that silently truncates
 * "Sources: Fed to cut rates in March, says Reuters" down to "Sources". The
 * stopword pass in clusterTokens handles those words instead, keeping the payload.
 * Cashtags ($AAPL) are also left alone: they are real tickers.
 */
export function stripBoilerplate(text) {
  let s = String(text || "");
  s = s.replace(URL_RE, " ").replace(SHORTENER_RE, " ").replace(HANDLE_RE, " ");
  s = s.replace(FOLLOW_RE, " ").replace(CHANNEL_SUFFIX_RE, " ");
  // "BREAKING: Trump:" nests — loop, but bounded so a pathological input can't spin.
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(LEAD_MARKER_RE, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

// Words that survive stripBoilerplate but carry no story signal.
//
// The function words matter more than they look. A press-conference readout emits
// a fleet of near-identical skeletons — "Trump did not repeat criticism of Spain
// during NATO…", "Trump did not mention Greenland during NATO…" — and `did` /
// `during` / `told` inflate their overlap until three distinct facts collapse into
// one card. (`not`, `says`, `after` were already stopwords; these are the leftovers.)
const CLUSTER_EXTRA_STOPWORDS = new Set([
  "just", "read", "reads", "source", "sources", "news",
  "did", "does", "do", "during", "told", "would", "could", "should",
  "also", "still", "while", "before", "now",
]);

/**
 * Tokenizer for CLUSTERING only.
 *
 * `normalizeTokens` is deliberately left untouched: services/alerts/nearDupGate.js
 * imports it to decide whether to SUPPRESS a live Telegram send. Widening that net
 * as a side effect of a website change would be exactly the wrong trade — a missed
 * alert costs far more than a duplicated card. Clustering gets its own tokenizer.
 */
export function clusterTokens(text) {
  const out = normalizeTokens(stripBoilerplate(text));
  for (const w of CLUSTER_EXTRA_STOPWORDS) out.delete(w);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contradiction veto.
//
// "Fed cuts rates" vs "Fed hikes rates" scores j=0.545 and MERGES under a bare
// Jaccard rule. For a market feed that is not a cosmetic bug: it fuses two opposite
// events into one card and inflates its corroboration count. Containment makes it
// worse (the short one is a near-subset). So the veto is HARD — score 0, never
// merged, on either similarity path.
//
// It is fail-OPEN: an unlisted word can never cause a false veto, because a veto
// requires opposing poles to appear in BOTH difference sets.
// ─────────────────────────────────────────────────────────────────────────────
const ANTONYM_AXES = [
  [["cut", "cuts", "lower", "lowers", "reduce", "reduces", "slash", "slashes"],
   ["hike", "hikes", "raise", "raises", "lift", "lifts", "tighten", "tightens"]],
  [["up", "rise", "rises", "rose", "gain", "gains", "jump", "jumps", "surge", "surges", "climb", "climbs", "soar", "soars", "rally"],
   ["down", "fall", "falls", "fell", "drop", "drops", "slip", "slips", "plunge", "plunges", "slump", "slumps", "tumble", "tumbles"]],
  [["beat", "beats", "tops", "topped"], ["miss", "misses", "missed"]],
  [["approve", "approves", "approved", "backs", "backed", "clears", "cleared"],
   ["reject", "rejects", "rejected", "block", "blocks", "blocked", "halts", "halted"]],
];
// A fifth axis (hold/steady/keeps vs cut/hike) was tried and REMOVED: it
// false-vetoes "Fed holds rates steady" against "Fed keeps rates unchanged, no cut",
// where `cut` is commentary rather than the event. Only direct same-slot antonym
// swaps are safe.

const NUM_RE = /^\d+$/;
const hasAny = (set, words) => words.some((w) => set.has(w));

/**
 * Non-null ⇒ these two token sets describe OPPOSING events; never merge them.
 * Returns the reason ("antonym" | "numeric") for logging/tests, else null.
 */
export function contradicts(a, b) {
  const dA = new Set([...a].filter((t) => !b.has(t)));
  const dB = new Set([...b].filter((t) => !a.has(t)));
  for (const [poleA, poleB] of ANTONYM_AXES) {
    if ((hasAny(dA, poleA) && hasAny(dB, poleB)) || (hasAny(dA, poleB) && hasAny(dB, poleA))) return "antonym";
  }
  // Disagreeing magnitudes: "25 bps" vs "50 bps". Only fires when BOTH sides carry
  // a number the other lacks, so "Nifty up 1%" vs "Nifty rises 1.2%" (shared "1") is safe.
  const nA = [...dA].filter((t) => NUM_RE.test(t));
  const nB = [...dB].filter((t) => NUM_RE.test(t));
  if (nA.length && nB.length && !nA.some((x) => nB.includes(x))) return "numeric";
  return null;
}

// Thresholds. CONTAINMENT_MIN_ASYMMETRY is the guard that keeps containment honest:
// the whole justification for it is LENGTH ASYMMETRY, so it is only licensed when
// asymmetry actually exists. Equal-length pairs — where containment degenerates into
// a symmetric measure and short headlines over-merge — stay on Jaccard.
export const JACCARD_CUT = 0.5;
export const TERSE_CUT = 0.8;
export const TERSE_MIN_TOKENS = 4;
// 0.8, not 0.75. Calibrated on the real buffer: every TRUE cross-channel merge
// scores >= 0.857 (Trump/Spain 0.857-1.000, Spanish-PM 1.000, NATO-allies 0.917),
// while the worst FALSE merge — two different statements from the same NATO
// presser — scores exactly 0.750. The cut sits in that 0.107-wide dead zone.
export const CONTAINMENT_CUT = 0.8;
export const CONTAINMENT_MIN_TOKENS = 5;
export const CONTAINMENT_MIN_OVERLAP = 5;
export const CONTAINMENT_MIN_ASYMMETRY = 2;

/**
 * Score one pair and report the cut it must clear. → { score, cut, mode }
 * mode: "veto" | "terse" | "containment" | "jaccard"
 */
export function pairScore(a, b, { jaccardCut = JACCARD_CUT, terseMinTokens = TERSE_MIN_TOKENS } = {}) {
  if (contradicts(a, b)) return { score: 0, cut: 1, mode: "veto" };
  const j = jaccard(a, b);
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const m = small.size;
  const inter = intersectSize(a, b);
  if (m < terseMinTokens) return { score: j, cut: TERSE_CUT, mode: "terse" };
  if (m >= CONTAINMENT_MIN_TOKENS
      && inter >= CONTAINMENT_MIN_OVERLAP
      && (large.size - small.size) >= CONTAINMENT_MIN_ASYMMETRY) {
    const c = inter / m;
    if (c >= CONTAINMENT_CUT) return { score: Math.max(j, c), cut: CONTAINMENT_CUT, mode: "containment" };
  }
  return { score: j, cut: jaccardCut, mode: "jaccard" };
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
export function clusterMessages(records, { threshold = JACCARD_CUT, minTokens = TERSE_MIN_TOKENS } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && r.text);
  // Deterministic order: earliest first, tie-break by stable member id. This
  // makes the anchor (cluster opener) reproducible regardless of buffer order.
  list.sort((a, b) => (tsOf(a) - tsOf(b)) || memberId(a).localeCompare(memberId(b)));

  const clusters = []; // { anchorTokens, members: [] }
  for (const rec of list) {
    const tokens = clusterTokens(rec.text);
    // Each candidate is compared against each cluster's ANCHOR tokens (never a
    // growing centroid), so there is no transitive chaining. Strict `>` keeps the
    // earliest cluster on a tie, which is what makes the result order-independent.
    let best = null;
    let bestSim = 0;
    let bestCut = 1;
    for (const c of clusters) {
      const { score, cut } = pairScore(tokens, c.anchorTokens, { jaccardCut: threshold, terseMinTokens: minTokens });
      if (score > bestSim) { bestSim = score; bestCut = cut; best = c; }
    }
    if (best && bestSim >= bestCut) {
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

export default { normalizeTokens, clusterTokens, stripBoilerplate, jaccard, containment, contradicts, pairScore, clusterMessages };
