#!/usr/bin/env bash
# Diagnostics or emergency operations for the worker managed by backend deploys.
set -euo pipefail

if [[ "$#" != 1 || ! "$1" =~ ^(check|start|stop)$ ]]; then
  echo "Usage: bash ops/house-trader-worker.sh check|start|stop" >&2
  exit 64
fi

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose_worker_flags=(--no-deps)
if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
  compose_worker_flags+=(--pull never)
elif command -v docker-compose >/dev/null; then
  # V1 has no --pull never. The immutable image below is already present
  # locally and referenced by the running API; up also uses --no-build.
  compose=(docker-compose)
else
  echo "Docker Compose is required" >&2
  exit 69
fi
compose+=(--project-directory "$app_dir" --env-file "${ENV_FILE:-/opt/hunch/.env}"
  -f "$app_dir/ops/docker-compose.prod.yml")
worker=house-trader-worker

if [[ "$1" == stop ]]; then
  exec "${compose[@]}" stop "$worker"
fi

running_api_image() {
  docker inspect --type container --format \
    '{{if and .State.Running (not .State.Paused) .State.Health}}{{if eq .State.Health.Status "healthy"}}{{.Image}}{{end}}{{end}}' hunch-api
}

image="$(running_api_image)"
if [[ ! "$image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "A healthy local hunch-api is required to select the worker image" >&2
  exit 69
fi

compose_on_api_image() {
  HUNCH_BACKEND_IMAGE="$image" "${compose[@]}" \
    -f "$app_dir/ops/docker-compose.house-trader-image.yml" "$@"
}

compose_on_api_image run --rm -T "${compose_worker_flags[@]}" "$worker" \
  /bin/sh /app/ops/run-js-runtime.sh apps/api/dist/house-trader-worker.js --check-config </dev/null

if [[ "$1" == start ]]; then
  if [[ "$(running_api_image)" != "$image" ]]; then
    echo "The API image changed during the check; run start again after the release" >&2
    exit 75
  fi
  compose_on_api_image up -d --no-build "${compose_worker_flags[@]}" "$worker"
fi
