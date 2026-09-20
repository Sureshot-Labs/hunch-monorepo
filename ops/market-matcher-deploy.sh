#!/usr/bin/env bash
set -euo pipefail

container=hunch-market-matcher
case "${1:-}" in
  adopt)
    # First rollout only: Compose cannot claim an existing standalone name.
    # Validate the exact known process before stopping it; never remove a
    # differently owned container merely because its name happens to match.
    if ! docker inspect "${container}" >/dev/null 2>&1; then
      exit 0
    fi
    service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "${container}")"
    project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "${container}")"
    expected_project="${COMPOSE_PROJECT_NAME:-${PROJECT_NAME:-$(basename "${APP_DIR:-/home/ubuntu/hunch-monorepo}")}}"
    if [[ "${service}" == market-matcher && "${project}" == "${expected_project}" ]]; then
      exit 0
    fi
    image="$(docker inspect -f '{{.Config.Image}}' "${container}")"
    command="$(docker inspect -f '{{json .Config.Cmd}}' "${container}")"
    if [[ -n "${service}" && "${service}" != '<no value>' ]] || \
       [[ -n "${project}" && "${project}" != '<no value>' ]] || \
       [[ "${image}" != hunch-backend:* ]] || \
       [[ "${command}" != '["node","packages/config/dist/run-with-secrets.js","apps/market-matcher/dist/main.js","run"]' ]]; then
      echo "Refusing to replace an unexpected container named ${container}." >&2
      exit 1
    fi
    echo "Moving the verified standalone matcher into Compose."
    docker stop --time 120 "${container}" >/dev/null
    docker rm "${container}" >/dev/null
    ;;
  verify)
    # Readiness is the worker loop's heartbeat, not a second secret-loaded job.
    for _ in {1..60}; do
      state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.RestartCount}}' "${container}" 2>/dev/null || true)"
      if [[ "${state}" == 'running healthy 0' ]]; then
        matcher_image="$(docker inspect -f '{{.Image}}' "${container}")"
        api_image="$(docker inspect -f '{{.Image}}' hunch-api)"
        if [[ "${matcher_image}" != "${api_image}" ]]; then
          echo "Matcher and API are not running the same backend image." >&2
          exit 1
        fi
        echo "market-matcher is healthy on the API backend image."
        exit 0
      fi
      sleep 2
    done
    echo "market-matcher failed readiness after deployment (${state})." >&2
    docker logs --tail 60 "${container}" >&2 || true
    exit 1
    ;;
  *) echo "Usage: $0 adopt|verify" >&2; exit 64 ;;
esac
