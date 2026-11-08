#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ubuntu@13.51.155.185}"
APP_DIR="${APP_DIR:-/home/ubuntu/hunch-monorepo}"
ENV_FILE="${ENV_FILE:-/opt/hunch/.env}"
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/native-onboarding-deploy.sh"
native_helper_functions="$(declare -f native_onboarding_flag native_onboarding_enabled native_onboarding_owned_container native_onboarding_preflight native_onboarding_stop_disabled native_onboarding_verify)"

REMOTE_CMD=$(cat <<'EOF'
set -euo pipefail

compose=(docker-compose --project-directory "${APP_DIR}" -f "${APP_DIR}/ops/docker-compose.prod.yml" --env-file "${ENV_FILE}")
restart_services=(postgres redis api indexer-polymarket indexer-limitless indexer-dflow ai-worker market-matcher finance-worker signal-bot social-media-worker nginx)
native_worker_enabled="$(native_onboarding_flag HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED)"
if [[ "${native_worker_enabled}" == true ]]; then
  compose+=(--profile native-onboarding)
  restart_services+=(native-onboarding-worker)
fi
native_onboarding_preflight

if ! docker network inspect hunch-edge >/dev/null 2>&1; then
  docker network create hunch-edge
fi
if ! docker network inspect hunch-internal >/dev/null 2>&1; then
  docker network create hunch-internal
fi

APP_DIR="${APP_DIR}" bash "${APP_DIR}/ops/market-matcher-deploy.sh" adopt

"${compose[@]}" down --remove-orphans

leftover=$(docker ps -a --filter "label=com.docker.compose.project=hunch-monorepo" -q || true)
if [ -n "${leftover}" ]; then
  docker rm -f ${leftover}
fi

# Explicit targets prevent ambient COMPOSE_PROFILES (including '*') from
# overriding the native service's persistent opt-in selection.
"${compose[@]}" up -d "${restart_services[@]}"

bash "${APP_DIR}/ops/market-matcher-deploy.sh" verify
native_onboarding_verify
EOF
)
REMOTE_CMD="${native_helper_functions}"$'\n'"${REMOTE_CMD}"

ssh "${REMOTE_HOST}" \
  "APP_DIR='${APP_DIR}' ENV_FILE='${ENV_FILE}' bash -s" <<<"${REMOTE_CMD}"

echo "Restart complete."
