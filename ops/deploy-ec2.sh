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

project_name="hunch-monorepo"

"${compose[@]}" down --remove-orphans || true
stale_containers=$(docker ps -aq --filter "label=com.docker.compose.project=${project_name}")
if [[ -n "${stale_containers}" ]]; then
  docker rm -f ${stale_containers}
fi
"${compose[@]}" build

# Bring up infra only so we can migrate without exposing app containers yet.
"${compose[@]}" up -d postgres redis
"${compose[@]}" run --rm api node /app/packages/db/dist/migrate.js

"${compose[@]}" up -d
echo "Deploy complete."
