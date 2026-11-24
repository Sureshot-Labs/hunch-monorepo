#!/usr/bin/env bash
# Only manage the optional trader. Resolve the immutable image of the healthy API.
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
compose+=(--project-directory "$app_dir" --env-file /opt/hunch/.env
  -f "$app_dir/ops/docker-compose.prod.yml" --profile house-trader)
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

HUNCH_BACKEND_IMAGE="$image" "${compose[@]}" run --rm -T "${compose_worker_flags[@]}" "$worker" \
  /bin/sh /app/ops/run-js-runtime.sh apps/api/dist/house-trader-worker.js --check-config </dev/null

if [[ "$1" == start ]]; then
  if [[ "$(running_api_image)" != "$image" ]]; then
    echo "The API image changed during the check; run start again after the release" >&2
    exit 75
  fi
  HUNCH_BACKEND_IMAGE="$image" "${compose[@]}" up -d --no-build "${compose_worker_flags[@]}" "$worker"
fi
