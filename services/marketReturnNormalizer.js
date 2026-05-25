const RETURN_KEYS = ["1D", "7D", "1M", "3M", "1Y"];

const AUDIT_ALIASES = {
  "1D": ["returns_1d", "return_1d"],
  "7D": ["returns_7d", "return_7d"],
  "1M": ["returns_1m", "return_1m"],
  "3M": ["returns_3m", "return_3m"],
  "1Y": ["returns_1y", "return_1y"],
};

function setFromBucket(out, bucket) {
  if (!bucket || typeof bucket !== "object") return;
  for (const key of RETURN_KEYS) {
    if (out[key] != null) continue;
    const v = Number(bucket[key]);
    if (Number.isFinite(v)) out[key] = v;
  }
}

function setFromAudit(out, audit) {
  const inputs = audit && audit.inputs_used;
  if (!inputs || typeof inputs !== "object") return;
  for (const key of RETURN_KEYS) {
    if (out[key] != null) continue;
    for (const alias of AUDIT_ALIASES[key]) {
      const v = Number(inputs[alias]);
      if (Number.isFinite(v)) {
        out[key] = v;
        break;
      }
    }
  }
}

export function normaliseMarketReturns({ deep, card, data } = {}) {
  const out = {};
  setFromBucket(out, deep && deep.overview && deep.overview.returns_pct);
  setFromBucket(out, card && card.returns_pct);
  setFromBucket(out, data && data.returns_pct);
  setFromAudit(out, card && card.audit_trail);
  return Object.keys(out).length ? out : null;
}

export function enrichMarketCardReturns(card, returnsPct) {
  if (!card || !returnsPct || !Object.keys(returnsPct).length) return card || null;
  return { ...card, returns_pct: { ...returnsPct } };
}

