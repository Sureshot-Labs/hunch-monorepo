#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/hunch-monorepo}"
ENV_FILE="${ENV_FILE:-/opt/hunch/.env}"
ARCHIVE="${ARCHIVE:-}"

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

compose=(docker-compose --project-directory "${APP_DIR}" \
  -f "${APP_DIR}/ops/docker-compose.prod.yml" \
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

# Build the new application image while the current stack and infra remain up.
"${compose[@]}" up -d postgres redis
"${compose[@]}" build

# Fail before touching live application containers if Compose built the worker
# from the generic backend runtime instead of the Chromium/FFmpeg target.
if ! "${compose[@]}" run --rm --no-deps --entrypoint /bin/sh \
  social-media-worker -c \
  'test -x /usr/bin/chromium && test -x /usr/bin/ffmpeg && test -x /usr/bin/ffprobe'; then
  echo "social-media-worker image is missing Chromium, FFmpeg, or FFprobe; existing application containers were left running." >&2
  exit 1
fi

# Migrate before touching live application containers. A rejected migration
# leaves the current application image online.
if ! "${compose[@]}" run --rm api \
  node /app/packages/config/dist/run-with-secrets.js \
  /app/packages/db/dist/migrate.js; then
  echo "Migration failed; existing application containers were left running." >&2
  exit 1
fi

# Replace only application containers. Postgres and Redis retain their process
# state and do not reload their datasets during an ordinary backend deploy.
"${compose[@]}" stop "${application_services[@]}" || true
"${compose[@]}" rm -f "${application_services[@]}" || true
"${compose[@]}" up -d --no-build --no-deps --remove-orphans \
  "${application_services[@]}"

# Give the secret loader and worker entrypoint enough time to fail before we
# accept the deployment. A container caught in a restart loop is not healthy.
sleep 3
social_media_worker_id="$("${compose[@]}" ps -q social-media-worker)"
if [[ -z "${social_media_worker_id}" ]] || \
  [[ "$(docker inspect -f '{{.State.Running}}' "${social_media_worker_id}" 2>/dev/null || true)" != "true" ]] || \
  [[ "$(docker inspect -f '{{.RestartCount}}' "${social_media_worker_id}" 2>/dev/null || true)" != "0" ]]; then
  echo "social-media-worker did not start after deployment." >&2
  "${compose[@]}" logs --tail 120 social-media-worker >&2 || true
  exit 1
fi
if ! docker exec "${social_media_worker_id}" /bin/sh -c \
  'test -x /usr/bin/chromium && test -x /usr/bin/ffmpeg && test -x /usr/bin/ffprobe'; then
  echo "social-media-worker is not using the specialized Chromium/FFmpeg runtime." >&2
  exit 1
fi
if [[ -n "${ARCHIVE}" ]]; then
  rm -f "${ARCHIVE}" || true
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
