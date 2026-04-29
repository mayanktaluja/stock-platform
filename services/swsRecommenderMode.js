// Feature-flagged selection between the v1 SWS action engine
// (scoreBandAction in swsHoldingEngine.js) and the v2 conviction engine
// (services/swsConvictionEngine.js). Mirrors scorerMode.js.
//
//   RECOMMENDER_VERSION=v1          — v1 only. v2 layers stay attached
//                                     as shadow data (PR 1/2 outputs);
//                                     v2 verdict is not computed.
//   RECOMMENDER_VERSION=v2-shadow   — v1 authoritative. v2 verdict is
//                                     computed and attached as
//                                     `holding.sws.v2_recommendation`
//                                     for divergence monitoring.    (default)
//   RECOMMENDER_VERSION=v2-primary  — v2 authoritative. v1 attached as
//                                     `holding.sws.v1_legacy` for trace.

const VALID_MODES = new Set(["v1", "v2-shadow", "v2-primary"]);
const RAW = process.env.RECOMMENDER_VERSION || "v2-shadow";
export const RECOMMENDER_MODE = VALID_MODES.has(RAW) ? RAW : "v2-shadow";

if (!VALID_MODES.has(RAW)) {
  console.warn(`[swsRecommenderMode] Unknown RECOMMENDER_VERSION="${RAW}". Falling back to "v2-shadow".`);
}
// Bootstrap diagnostic to stderr (not stdout) so smoke-tests that emit
// JSON on stdout don't get polluted.
process.stderr.write(`[swsRecommenderMode] active: ${RECOMMENDER_MODE}\n`);

export const isV2Shadow = () => RECOMMENDER_MODE === "v2-shadow";
export const isV2Primary = () => RECOMMENDER_MODE === "v2-primary";
export const isV1Only = () => RECOMMENDER_MODE === "v1";
