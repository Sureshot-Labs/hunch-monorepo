#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ubuntu@13.51.155.185}"
APP_DIR="${APP_DIR:-/home/ubuntu/hunch-monorepo}"
ENV_FILE="${ENV_FILE:-/opt/hunch/.env}"

REMOTE_CMD=$(cat <<'EOF'
set -euo pipefail

docker-compose --project-directory "${APP_DIR}" \
  -f "${APP_DIR}/ops/docker-compose.prod.yml" \
  --env-file "${ENV_FILE}" down --remove-orphans

leftover=$(docker ps -a --filter "label=com.docker.compose.project=hunch-monorepo" -q || true)
if [ -n "${leftover}" ]; then
  docker rm -f ${leftover}
fi

docker-compose --project-directory "${APP_DIR}" \
  -f "${APP_DIR}/ops/docker-compose.prod.yml" \
  --env-file "${ENV_FILE}" up -d
EOF
)

ssh "${REMOTE_HOST}" \
  "APP_DIR='${APP_DIR}' ENV_FILE='${ENV_FILE}' bash -lc '${REMOTE_CMD}'"

echo "Restart complete."
