#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ubuntu@13.51.155.185}"
APP_DIR="${APP_DIR:-/home/ubuntu/hunch-monorepo}"
ENV_FILE="${ENV_FILE:-/opt/hunch/.env}"
PROJECT_NAME="${PROJECT_NAME:-hunch-monorepo}"
SERVICES="${SERVICES:-api indexer-polymarket indexer-limitless indexer-dflow ai-worker finance-worker signal-bot social-media-worker}"
BACKEND_IMAGE="${BACKEND_IMAGE:-}"
HUNCH_SOCIAL_MEDIA_WORKER_IMAGE="${HUNCH_SOCIAL_MEDIA_WORKER_IMAGE:-}"
RESTART_NGINX="${RESTART_NGINX:-1}"
VERIFY="${VERIFY:-1}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:3001/health}"

REMOTE_CMD=$(cat <<'EOF'
set -euo pipefail

compose_file="${APP_DIR}/ops/docker-compose.prod.yml"

if [ ! -f "${compose_file}" ]; then
  echo "Missing compose file: ${compose_file}" >&2
  exit 1
fi

if [ ! -r "${ENV_FILE}" ]; then
  echo "Env file is not readable by $(whoami): ${ENV_FILE}" >&2
  echo "Fix ownership/mode first, for example: sudo chown ubuntu:ubuntu ${ENV_FILE} && sudo chmod 600 ${ENV_FILE}" >&2
  exit 1
fi

compose() {
  docker-compose --project-directory "${APP_DIR}" \
    -f "${compose_file}" \
    --env-file "${ENV_FILE}" \
    "$@"
}

if ! docker network inspect hunch-edge >/dev/null 2>&1; then
  docker network create hunch-edge
fi
if ! docker network inspect hunch-internal >/dev/null 2>&1; then
  docker network create hunch-internal
fi

find_backend_image() {
  if [ -n "${BACKEND_IMAGE}" ]; then
    echo "${BACKEND_IMAGE}"
    return 0
  fi

  for container in hunch-api hunch-indexer-polymarket hunch-indexer-limitless hunch-indexer-dflow hunch-ai-worker hunch-finance-worker hunch-signal-bot; do
    image_id="$(docker inspect -f '{{.Image}}' "${container}" 2>/dev/null || true)"
    if [ -n "${image_id}" ]; then
      echo "${image_id}"
      return 0
    fi
  done

  latest_backend="$(
    docker images hunch-backend \
      --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
      | sort -k2,3r \
      | awk 'NR == 1 { print $1 }'
  )"
  if [ -n "${latest_backend}" ]; then
    echo "${latest_backend}"
    return 0
  fi

  echo "Could not find an existing backend image. Set BACKEND_IMAGE=hunch-backend:<tag>." >&2
  return 1
}

social_media_worker_selected=0
backend_service_selected=0
for service in ${SERVICES}; do
  if [ "${service}" = "social-media-worker" ]; then
    social_media_worker_selected=1
  else
    backend_service_selected=1
  fi
done

if [ "${backend_service_selected}" = "1" ]; then
  backend_image="$(find_backend_image)"
  echo "Using backend image: ${backend_image}"
fi

find_social_media_worker_image() {
  if [ -n "${HUNCH_SOCIAL_MEDIA_WORKER_IMAGE}" ]; then
    echo "${HUNCH_SOCIAL_MEDIA_WORKER_IMAGE}"
    return 0
  fi

  image_id="$(docker inspect -f '{{.Image}}' hunch-social-media-worker 2>/dev/null || true)"
  if [ -n "${image_id}" ]; then
    echo "${image_id}"
    return 0
  fi

  for repository in hunch-social-media-worker "${PROJECT_NAME}_social-media-worker"; do
    latest_image="$(
      docker images "${repository}" \
        --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
        | sort -k2,3r \
        | awk 'NR == 1 { print $1 }'
    )"
    if [ -n "${latest_image}" ]; then
      echo "${latest_image}"
      return 0
    fi
  done

  echo "Could not find the specialized social-media-worker image. Set HUNCH_SOCIAL_MEDIA_WORKER_IMAGE=hunch-social-media-worker:<tag>." >&2
  return 1
}

if [ "${social_media_worker_selected}" = "1" ]; then
  social_media_worker_image="$(find_social_media_worker_image)"
  echo "Using social media worker image: ${social_media_worker_image}"
  if ! docker image inspect "${social_media_worker_image}" >/dev/null 2>&1; then
    echo "Refusing to recreate services: specialized image ${social_media_worker_image} is not available locally." >&2
    exit 1
  fi
  if ! docker run --rm --network none --entrypoint /bin/sh \
    "${social_media_worker_image}" -c \
    'test -x /usr/bin/chromium && test -x /usr/bin/ffmpeg && test -x /usr/bin/ffprobe'; then
    echo "Refusing to recreate services: ${social_media_worker_image} is not the specialized Chromium/FFmpeg runtime." >&2
    exit 1
  fi
  docker tag "${social_media_worker_image}" "${PROJECT_NAME}_social-media-worker:latest"
fi

for service in ${SERVICES}; do
  if [ "${service}" = "social-media-worker" ]; then
    continue
  fi
  docker tag "${backend_image}" "${PROJECT_NAME}_${service}:latest"
done

for service in ${SERVICES}; do
  container="hunch-${service}"
  ids="$(docker ps -aq --filter "name=${container}" || true)"
  if [ -n "${ids}" ]; then
    echo "Removing existing container(s) for ${container}"
    docker rm -f ${ids}
  fi
done

echo "Starting services without build: ${SERVICES}"
compose up -d --no-build --no-deps ${SERVICES}

if [ "${social_media_worker_selected}" = "1" ]; then
  # Reject a process that starts briefly and then enters Docker's restart loop.
  sleep 3
  social_media_worker_id="$(compose ps -q social-media-worker)"
  if [ -z "${social_media_worker_id}" ] || \
    [ "$(docker inspect -f '{{.State.Running}}' "${social_media_worker_id}" 2>/dev/null || true)" != "true" ] || \
    [ "$(docker inspect -f '{{.RestartCount}}' "${social_media_worker_id}" 2>/dev/null || true)" != "0" ]; then
    echo "social-media-worker did not start after no-build recreation." >&2
    compose logs --tail 120 social-media-worker >&2 || true
    exit 1
  fi
  if ! docker exec "${social_media_worker_id}" /bin/sh -c \
    'test -x /usr/bin/chromium && test -x /usr/bin/ffmpeg && test -x /usr/bin/ffprobe'; then
    echo "social-media-worker is not using the specialized Chromium/FFmpeg runtime." >&2
    exit 1
  fi
fi

if [ "${RESTART_NGINX}" = "1" ]; then
  if docker ps -aq --filter "name=^/hunch-nginx$" | grep -q .; then
    echo "Restarting hunch-nginx to refresh upstream DNS"
    docker restart hunch-nginx >/dev/null
  else
    echo "Starting nginx without build"
    compose up -d --no-build --no-deps nginx
  fi
fi

if [ "${VERIFY}" = "1" ]; then
  echo "Waiting for API health: ${API_HEALTH_URL}"
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "${API_HEALTH_URL}" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done
  if [ "${ok}" != "1" ]; then
    echo "API health check failed: ${API_HEALTH_URL}" >&2
    docker logs --tail 120 hunch-api 2>&1 || true
    exit 1
  fi
fi

docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' \
  | grep -E 'hunch-(api|indexer|ai-worker|finance-worker|signal-bot|social-media-worker|nginx|postgres|redis|web)' || true
EOF
)

ssh "${REMOTE_HOST}" \
  "APP_DIR='${APP_DIR}' ENV_FILE='${ENV_FILE}' PROJECT_NAME='${PROJECT_NAME}' SERVICES='${SERVICES}' BACKEND_IMAGE='${BACKEND_IMAGE}' HUNCH_SOCIAL_MEDIA_WORKER_IMAGE='${HUNCH_SOCIAL_MEDIA_WORKER_IMAGE}' RESTART_NGINX='${RESTART_NGINX}' VERIFY='${VERIFY}' API_HEALTH_URL='${API_HEALTH_URL}' bash -s" \
  <<<"${REMOTE_CMD}"

echo "No-build service recreate complete."
