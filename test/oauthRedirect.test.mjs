import test from "node:test";
import assert from "node:assert/strict";

import {
  callbackUriForOrigin,
  getRequestOrigin,
  isAllowedOAuthRedirectUri,
  selectOAuthRedirectUri,
} from "../services/auth/oauthRedirect.js";

function req(headers) {
  return { headers };
}

test("OAuth redirect picks stocks.starbhai.com callback on branded host", () => {
  const redirectUri = selectOAuthRedirectUri(
    req({
      host: "stocks.starbhai.com",
      "x-forwarded-proto": "https",
    }),
    "https://stock-platform-gamma.vercel.app/api/auth/google/callback",
    "https",
  );

  assert.equal(
    redirectUri,
    "https://stocks.starbhai.com/api/auth/google/callback",
  );
});

test("OAuth redirect keeps legacy gamma callback working", () => {
  const redirectUri = selectOAuthRedirectUri(
    req({
      host: "stock-platform-gamma.vercel.app",
      "x-forwarded-proto": "https",
    }),
    "https://stocks.starbhai.com/api/auth/google/callback",
    "https",
  );

  assert.equal(
    redirectUri,
    "https://stock-platform-gamma.vercel.app/api/auth/google/callback",
  );
});

test("OAuth redirect falls back for unknown hosts without expanding allowlist", () => {
  const fallback = "https://stocks.starbhai.com/api/auth/google/callback";
  const redirectUri = selectOAuthRedirectUri(
    req({
      host: "preview.example.com",
      "x-forwarded-proto": "https",
    }),
    fallback,
    "https",
  );

  assert.equal(redirectUri, fallback);
  assert.equal(
    isAllowedOAuthRedirectUri("https://evil.example.com/api/auth/google/callback", fallback),
    false,
  );
});

test("OAuth request origin honours forwarded host and protocol safely", () => {
  assert.equal(
    getRequestOrigin(req({
      "x-forwarded-host": "stocks.starbhai.com, proxy.internal",
      "x-forwarded-proto": "https, http",
    })),
    "https://stocks.starbhai.com",
  );
  assert.equal(
    callbackUriForOrigin("https://stocks.starbhai.com"),
    "https://stocks.starbhai.com/api/auth/google/callback",
  );
});
