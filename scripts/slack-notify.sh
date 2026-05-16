#!/usr/bin/env bash
#
# Tiny shared Slack notifier. Reads SLACK_WEBHOOK_URL from env, takes a single
# message string as $1, POSTs `{ "text": "<message>" }` to the webhook.
#
# Designed for nightly-script trap handlers (P3.3 of the SEBI-RA roadmap):
# silent no-op when the env var is unset (so interactive runs don't error),
# 10s curl timeout so a network stall in the trap can't hang the launchd job
# indefinitely, never exits non-zero (the caller's trap is already firing on
# an error — we must not mask the real exit code).
#
# Usage:
#   bash scripts/slack-notify.sh ":warning: SWS nightly failed at $(date) exit=$rc"
#
# Env:
#   SLACK_WEBHOOK_URL  Slack incoming-webhook URL. Unset = silent no-op.
#
# Exit code:
#   Always 0. A trap caller relies on $? from the failing command, not this
#   helper; emitting a non-zero exit here would clobber that.

set -u

MSG="${1:-}"

# No webhook configured → silent no-op. This is the common case during
# interactive local runs (developer doesn't have/need a webhook).
if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  exit 0
fi

# Nothing to send → silent no-op (don't post empty messages).
if [ -z "${MSG}" ]; then
  exit 0
fi

# Hand-build the JSON payload. The message may contain quotes / newlines /
# backslashes that would break a printf-built JSON string, so we let `node`
# do the escaping when it's available; fall back to a sed-based escape if
# node is missing (slack-notify must work even on a stripped-down host).
if command -v node >/dev/null 2>&1; then
  PAYLOAD=$(MSG="${MSG}" node --input-type=module -e '
    const msg = process.env.MSG || "";
    process.stdout.write(JSON.stringify({ text: msg }));
  ' 2>/dev/null)
fi

# Fallback escaper if node isn't on $PATH or produced empty output.
if [ -z "${PAYLOAD:-}" ]; then
  ESCAPED=$(printf '%s' "${MSG}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk 'BEGIN{ORS="\\n"} {print}' \
    | sed 's/\\n$//')
  PAYLOAD="{\"text\":\"${ESCAPED}\"}"
fi

# 10s overall timeout (connect + transfer). --silent suppresses curl's own
# progress meter; --show-error keeps an HTTP-level failure visible in the
# launchd log so the operator notices a misconfigured webhook URL.
# We deliberately swallow curl's exit code: the caller's trap is firing on a
# real script error, and a webhook-post failure should not clobber that.
curl --silent --show-error --max-time 10 \
  -X POST \
  -H 'Content-Type: application/json' \
  --data "${PAYLOAD}" \
  "${SLACK_WEBHOOK_URL}" >/dev/null 2>&1 || true

exit 0
