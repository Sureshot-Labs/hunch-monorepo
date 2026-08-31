#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/hunch-monorepo}"
ENV_FILE="${ENV_FILE:-/opt/hunch/.env}"
ARCHIVE="${ARCHIVE:-}"
IMAGE_ARCHIVE="${IMAGE_ARCHIVE:-}"
HUNCH_BACKEND_IMAGE="${HUNCH_BACKEND_IMAGE:-}"
HUNCH_SOCIAL_MEDIA_WORKER_IMAGE="${HUNCH_SOCIAL_MEDIA_WORKER_IMAGE:-}"
REDIS_SAVE_POLICY="${REDIS_SAVE_POLICY:-300 1}"

if [[ -z "${HUNCH_BACKEND_IMAGE}" ]]; then
  echo "HUNCH_BACKEND_IMAGE is required" >&2
  exit 1
fi
if [[ -z "${HUNCH_SOCIAL_MEDIA_WORKER_IMAGE}" ]]; then
  echo "HUNCH_SOCIAL_MEDIA_WORKER_IMAGE is required" >&2
  exit 1
fi

if [[ -n "${ARCHIVE}" ]]; then
  if [[ ! -f "${ARCHIVE}" ]]; then
    echo "Archive not found: ${ARCHIVE}" >&2
    exit 1
  fi
  WORK_DIR="$(mktemp -d)"
  tar -xzf "${ARCHIVE}" -C "${WORK_DIR}"
  SRC_DIR="${WORK_DIR}/hunch-monorepo"
  if [[ ! -d "${SRC_DIR}" ]]; then
    SRC_DIR="${WORK_DIR}"
  fi
  if [[ -d "${APP_DIR}" ]]; then
    BACKUP_DIR="${APP_DIR}.prev.$(date +%s)"
    mv "${APP_DIR}" "${BACKUP_DIR}"
    echo "Backed up repo to ${BACKUP_DIR}"
  fi
  mkdir -p "${APP_DIR}"
  (cd "${SRC_DIR}" && tar -cf - .) | (cd "${APP_DIR}" && tar -xf -)
  rm -rf "${WORK_DIR}"
  echo "Repo updated from ${ARCHIVE}"
fi

if [[ -n "${IMAGE_ARCHIVE}" ]]; then
  if [[ ! -f "${IMAGE_ARCHIVE}" ]]; then
    echo "Image archive not found: ${IMAGE_ARCHIVE}" >&2
    exit 1
  fi
  echo "Loading image ${HUNCH_BACKEND_IMAGE} from ${IMAGE_ARCHIVE}"
  gunzip -c "${IMAGE_ARCHIVE}" | docker load
fi

compose=(docker-compose --project-directory "${APP_DIR}" \
  -f "${APP_DIR}/ops/docker-compose.prod.yml" \
  -f "${APP_DIR}/ops/docker-compose.prebuilt.yml" \
  --env-file "${ENV_FILE}")

application_services=(
  api
  indexer-polymarket
  indexer-limitless
  indexer-dflow
  ai-worker
  finance-worker
  signal-bot
  social-media-worker
  nginx
)

# Ensure external network for edge proxy exists (required by nginx).
if ! docker network inspect hunch-edge >/dev/null 2>&1; then
  docker network create hunch-edge
fi
if ! docker network inspect hunch-internal >/dev/null 2>&1; then
  docker network create hunch-internal
fi

export HUNCH_BACKEND_IMAGE
export HUNCH_SOCIAL_MEDIA_WORKER_IMAGE

# Start or retain infra and migrate before touching the live application
# containers. If migration fails, the currently deployed API and workers stay
# online on their existing image.
"${compose[@]}" up -d --no-recreate postgres redis
redis_container_id="$("${compose[@]}" ps -q redis)"
if [[ -z "${redis_container_id}" ]]; then
  echo "Redis container is missing after startup." >&2
  exit 1
fi
redis_ready=0
for _ in {1..180}; do
  if [[ "$(docker exec "${redis_container_id}" redis-cli --raw ping 2>/dev/null || true)" == "PONG" ]]; then
    redis_ready=1
    break
  fi
  sleep 2
done
if [[ "${redis_ready}" != "1" ]]; then
  echo "Redis did not finish loading within 360 seconds." >&2
  exit 1
fi
if [[ "$(docker exec "${redis_container_id}" redis-cli --raw config set save "${REDIS_SAVE_POLICY}")" != "OK" ]]; then
  echo "Failed to apply Redis save policy: ${REDIS_SAVE_POLICY}" >&2
  exit 1
fi
if ! "${compose[@]}" run --rm --no-deps api \
  node /app/packages/config/dist/run-with-secrets.js \
  /app/packages/db/dist/migrate.js; then
  echo "Migration failed; existing application containers were left running." >&2
  exit 1
fi

# Replace only application containers after the database is ready. Postgres and
# Redis stay up, so a backend deploy cannot trigger a long Redis dataset reload.
"${compose[@]}" stop "${application_services[@]}" || true
"${compose[@]}" rm -f "${application_services[@]}" || true
"${compose[@]}" up -d --no-build --no-deps --remove-orphans \
  "${application_services[@]}"

if [[ -n "${ARCHIVE}" ]]; then
  rm -f "${ARCHIVE}" || true
fi
if [[ -n "${IMAGE_ARCHIVE}" ]]; then
  rm -f "${IMAGE_ARCHIVE}" || true
fi

echo "Deploy complete."

# Optional cleanup to reclaim disk (keeps images used in last 3h by default).
# Run it detached so a slow prune cannot turn a successful deploy into an SSH failure.
if [[ "${DOCKER_PRUNE:-1}" == "1" ]]; then
  DOCKER_PRUNE_UNTIL="${DOCKER_PRUNE_UNTIL:-3h}"
  DOCKER_PRUNE_LOG="${DOCKER_PRUNE_LOG:-/tmp/hunch-backend-docker-prune.log}"
  echo "Scheduling Docker image prune (older than ${DOCKER_PRUNE_UNTIL}); log: ${DOCKER_PRUNE_LOG}"
  nohup docker image prune -af --filter "until=${DOCKER_PRUNE_UNTIL}" >"${DOCKER_PRUNE_LOG}" 2>&1 &
fi
