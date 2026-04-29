// Feature-flagged selection between the v1 SWS action engine
// (scoreBandAction in swsHoldingEngine.js) and the v2 conviction engine
// (services/swsConvictionEngine.js). Mirrors scorerMode.js.
//
//   RECOMMENDER_VERSION=v1          — v1 only.
//   RECOMMENDER_VERSION=v2-shadow   — v1 authoritative + v2 attached.  (default)
//   RECOMMENDER_VERSION=v2-primary  — v2 authoritative.
//
// IMPORTANT: env resolution is LAZY. server.js loads dotenv after its own
// imports hoist, so reading process.env at module-load time would catch a
// stale value (always default). Every call to the predicate functions /
// getRecommenderMode() re-reads the env so .env / runtime overrides take
// effect for the actual scoreHolding call path.

const VALID_MODES = new Set(["v1", "v2-shadow", "v2-primary"]);

function _resolveMode() {
  const raw = process.env.RECOMMENDER_VERSION || "v2-shadow";
  if (!VALID_MODES.has(raw)) {
    console.warn(`[swsRecommenderMode] Unknown RECOMMENDER_VERSION="${raw}". Falling back to "v2-shadow".`);
    return "v2-shadow";
  }
  return raw;
}

// Re-emit the resolved mode on first call so runtime mode is visible in
// logs even when the boot diagnostic raced dotenv. Fires exactly once.
let _runtimeLogged = false;
function _logOnce() {
  if (_runtimeLogged) return;
  _runtimeLogged = true;
  process.stderr.write(`[swsRecommenderMode] active: ${_resolveMode()}\n`);
}

// Canonical API — call at request-handler time, not at module import.
export function getRecommenderMode() { _logOnce(); return _resolveMode(); }
export const isV2Shadow = () => { _logOnce(); return _resolveMode() === "v2-shadow"; };
export const isV2Primary = () => { _logOnce(); return _resolveMode() === "v2-primary"; };
export const isV1Only = () => { _logOnce(); return _resolveMode() === "v1"; };
