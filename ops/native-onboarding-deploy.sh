#!/usr/bin/env bash
# Shared opt-in selection/readiness for server, prebuilt and no-build releases.
# Sourcing this file defines functions only; it never starts a worker.

native_onboarding_flag() {
  local flag_name="$1" flag_value
  case "${flag_name}" in
    HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED|HUNCH_APNS_DELIVERY_ENABLED) ;;
    *) echo "Unsupported native worker setting." >&2; return 64 ;;
  esac
  if [[ -n "${!flag_name+x}" ]]; then
    flag_value="${!flag_name}"
  else
    flag_value="$(awk -v key="${flag_name}" '
      $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {
        value=$0; sub("^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=[[:space:]]*", "", value)
        sub(/[[:space:]]+#.*$/, "", value); sub(/[[:space:]]+$/, "", value)
      } END { print value }
    ' "${ENV_FILE:-/opt/hunch/.env}")" || return
  fi
  case "${flag_value}" in
    '"true"'|"'true'") flag_value=true ;;
    '"false"'|"'false'") flag_value=false ;;
  esac
  case "${flag_value}" in
    true|false) printf '%s\n' "${flag_value}" ;;
    '') printf 'false\n' ;;
    *) echo "${flag_name} must be true or false; no services were changed." >&2; return 64 ;;
  esac
}

native_onboarding_enabled() {
  [[ "$(native_onboarding_flag HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED)" == true ]]
}

native_onboarding_owned_container() {
  local native_labels expected_project
  if ! docker inspect hunch-native-onboarding-worker >/dev/null 2>&1; then
    return 1
  fi
  expected_project="${COMPOSE_PROJECT_NAME:-${PROJECT_NAME:-$(basename "${APP_DIR:-/home/ubuntu/hunch-monorepo}")}}"
  native_labels="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "com.docker.compose.project"}}' hunch-native-onboarding-worker)" || return
  if [[ "${native_labels}" != "native-onboarding-worker ${expected_project}" ]]; then
    echo "Refusing to manage an unexpected container named hunch-native-onboarding-worker." >&2
    return 64
  fi
}

native_onboarding_preflight() {
  local enabled delivery_enabled owned=0
  enabled="$(native_onboarding_flag HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED)" || return
  delivery_enabled=false
  if [[ "${enabled}" == true ]]; then
    delivery_enabled="$(native_onboarding_flag HUNCH_APNS_DELIVERY_ENABLED)" || return
  fi
  if native_onboarding_owned_container; then owned=1; else
    local ownership_status=$?
    if [[ "${ownership_status}" != 1 ]]; then return "${ownership_status}"; fi
  fi
  if [[ "${enabled}" == true && -n "${1:-}" ]]; then
    # Offline image-content check only; no secrets, network or worker execution.
    docker run --rm --network none --read-only --entrypoint node "$1" -e \
      'for (const file of ["native-push-worker.js","native-onboarding-health.js"]) require("node:fs").accessSync("/app/apps/api/dist/"+file)' || {
        echo "Selected image lacks native worker/readiness support; existing services were left untouched." >&2
        return 1
      }
  fi
  echo "Native worker selection: enabled=${enabled}, APNs=${delivery_enabled}, existing_owned_container=${owned}."
}

native_onboarding_stop_disabled() {
  local enabled ownership_status
  enabled="$(native_onboarding_flag HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED)" || return
  if [[ "${enabled}" == true ]]; then return; fi
  # Recheck exact ownership immediately before stopping the explicitly disabled
  # optional service. No broad labels/globs, deletion or infrastructure restart.
  if native_onboarding_owned_container; then
    docker stop --time 30 hunch-native-onboarding-worker >/dev/null
  else
    ownership_status=$?
    if [[ "${ownership_status}" != 1 ]]; then return "${ownership_status}"; fi
  fi
}

native_onboarding_verify() {
  local enabled delivery_enabled state native_image expected_image attempt
  enabled="$(native_onboarding_flag HUNCH_NATIVE_ONBOARDING_WORKER_ENABLED)" || return
  if [[ "${enabled}" != true ]]; then return; fi
  delivery_enabled="$(native_onboarding_flag HUNCH_APNS_DELIVERY_ENABLED)" || return
  if [[ -n "${1:-}" ]]; then
    expected_image="$(docker image inspect "$1" --format '{{.Id}}')" || return
  else
    expected_image="$(docker inspect -f '{{.Image}}' hunch-api)" || return
  fi
  for attempt in {1..30}; do
    state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.RestartCount}}' hunch-native-onboarding-worker 2>/dev/null || true)"
    if [[ "${state}" == 'running healthy 0' ]]; then
      native_image="$(docker inspect -f '{{.Image}}' hunch-native-onboarding-worker)" || return
      if [[ "${native_image}" != "${expected_image}" ]]; then
        echo "Native worker is not running the selected backend image." >&2
        return 1
      fi
      local readiness_command=(docker exec hunch-native-onboarding-worker node /app/apps/api/dist/native-onboarding-health.js)
      if [[ "${delivery_enabled}" == true ]]; then readiness_command+=(--require-delivery); fi
      if ! "${readiness_command[@]}"; then
        echo "Native worker progressed, but requested delivery/readiness is unavailable. Statistics keep running; correct configuration and recreate only this worker." >&2
        return 1
      fi
      echo "native-onboarding-worker is progressing on the selected backend image."
      return
    fi
    sleep 2
  done
  echo "Native worker did not become ready; inspect sanitized native worker stage diagnostics. Other application services were not stopped by this check." >&2
  return 1
}
