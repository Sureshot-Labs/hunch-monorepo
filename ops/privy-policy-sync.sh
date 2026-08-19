#!/usr/bin/env bash
set -euo pipefail

# Apply one reviewed complete Privy policy manifest through the same production
# secret-bundle loader used by API and finance-worker. The TypeScript tool does
# the fingerprint/CAS preflight and requires an explicit confirmation for a
# write; this wrapper only transports the non-secret manifest.

REMOTE_HOST="${REMOTE_HOST:-ubuntu@13.51.155.185}"
SERVICE="${SERVICE:-hunch-api}"
MANIFEST=""
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      MANIFEST="${2:-}"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$MANIFEST" || ! -f "$MANIFEST" ]]; then
  echo "Usage: $0 --manifest <reviewed-policy.json> [--execute --confirm 'SYNC PRIVY POLICY MANIFEST']" >&2
  exit 1
fi

REMOTE_MANIFEST="/tmp/hunch-privy-policy-manifest.json"

quote_args() {
  local output=""
  local argument
  for argument in "$@"; do
    output+=" $(printf '%q' "$argument")"
  done
  printf '%s' "$output"
}

# Preflight the exact local input before any remote write.
test -s "$MANIFEST"
scp "$MANIFEST" "${REMOTE_HOST}:${REMOTE_MANIFEST}"
REMOTE_ARGS="$(quote_args "${ARGS[@]}")"
ssh "$REMOTE_HOST" \
  "docker cp $(printf '%q' "$REMOTE_MANIFEST") $(printf '%q' "${SERVICE}:/tmp/hunch-privy-policy-manifest.json") && \\
   docker exec -i $(printf '%q' "$SERVICE") node /app/packages/config/dist/run-with-secrets.js \\
     /app/apps/api/dist/privy-policy-sync.js \\
     --manifest /tmp/hunch-privy-policy-manifest.json${REMOTE_ARGS}"
