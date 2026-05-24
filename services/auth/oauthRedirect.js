const OAUTH_CALLBACK_PATH = "/api/auth/google/callback";

export const PRIMARY_PLATFORM_ORIGIN = "https://stocks.starbhai.com";
export const LEGACY_PLATFORM_ORIGIN = "https://stock-platform-gamma.vercel.app";
export const LOCAL_PLATFORM_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:4011",
];

export const PLATFORM_ORIGINS = [
  PRIMARY_PLATFORM_ORIGIN,
  LEGACY_PLATFORM_ORIGIN,
  ...LOCAL_PLATFORM_ORIGINS,
];

const PLATFORM_ORIGIN_SET = new Set(PLATFORM_ORIGINS);
const CALLBACK_URI_SET = new Set(
  PLATFORM_ORIGINS.map((origin) => `${origin}${OAUTH_CALLBACK_PATH}`),
);

function firstHeaderValue(value) {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  if (typeof value !== "string") return "";
  return value.split(",")[0].trim();
}

function normalizeHost(value) {
  const host = firstHeaderValue(value).toLowerCase();
  if (!host) return "";
  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(host)) return "";
  return host;
}

function normalizeProtocol(value, fallbackProtocol) {
  const proto = firstHeaderValue(value).toLowerCase();
  if (proto === "http" || proto === "https") return proto;
  return fallbackProtocol === "https" ? "https" : "http";
}

export function getRequestOrigin(req, fallbackProtocol = "http") {
  const host = normalizeHost(req?.headers?.["x-forwarded-host"] || req?.headers?.host);
  if (!host) return "";
  const proto = normalizeProtocol(req?.headers?.["x-forwarded-proto"], fallbackProtocol);
  return `${proto}://${host}`;
}

export function callbackUriForOrigin(origin) {
  if (!PLATFORM_ORIGIN_SET.has(origin)) return "";
  return `${origin}${OAUTH_CALLBACK_PATH}`;
}

export function selectOAuthRedirectUri(req, fallbackRedirectUri = "", fallbackProtocol = "http") {
  const origin = getRequestOrigin(req, fallbackProtocol);
  return callbackUriForOrigin(origin) || fallbackRedirectUri;
}

export function isAllowedOAuthRedirectUri(value, fallbackRedirectUri = "") {
  if (typeof value !== "string" || !value) return false;
  if (CALLBACK_URI_SET.has(value)) return true;
  return !!fallbackRedirectUri && value === fallbackRedirectUri;
}
