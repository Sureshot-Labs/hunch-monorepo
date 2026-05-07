#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/hunch-monorepo}"
ENV_FILE="${ENV_FILE:-/opt/hunch/.env}"
ARCHIVE="${ARCHIVE:-}"
IMAGE_ARCHIVE="${IMAGE_ARCHIVE:-}"
HUNCH_BACKEND_IMAGE="${HUNCH_BACKEND_IMAGE:-}"

if [[ -z "${HUNCH_BACKEND_IMAGE}" ]]; then
  echo "HUNCH_BACKEND_IMAGE is required" >&2
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

project_name="hunch-monorepo"

# Ensure external network for edge proxy exists (required by nginx).
if ! docker network inspect hunch-edge >/dev/null 2>&1; then
  docker network create hunch-edge
fi

export HUNCH_BACKEND_IMAGE

"${compose[@]}" down --remove-orphans || true
stale_containers=$(docker ps -aq --filter "label=com.docker.compose.project=${project_name}")
if [[ -n "${stale_containers}" ]]; then
  docker rm -f ${stale_containers}
fi

# Bring up infra only so we can migrate without exposing app containers yet.
"${compose[@]}" up -d postgres redis
"${compose[@]}" run --rm api node /app/packages/db/dist/migrate.js

"${compose[@]}" up -d --no-build

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
