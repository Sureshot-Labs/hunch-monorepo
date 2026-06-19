#!/usr/bin/env bash
set -o pipefail

# Production market cleanup orchestration.
#
# Venue ownership is intentional here:
# - active status repair supports: kalshi, polymarket, limitless
# - source retention supports: polymarket, limitless
# - unified retention is venue-agnostic and defaults to all venues
#
# When adding a venue, update this file, the corresponding TS script allowlists,
# the source cleanup path if source tables exist, and run dry-runs before cron.

LOCK_FILE="${LOCK_FILE:-/tmp/hunch-market-cleanup.lock}"
CONTAINER="${CONTAINER:-hunch-api}"
DOCKER_BIN="${DOCKER_BIN:-/usr/bin/docker}"
NODE_BIN="${NODE_BIN:-node}"
RUN_WITH_SECRETS="${RUN_WITH_SECRETS:-/app/packages/config/dist/run-with-secrets.js}"
API_DIST_DIR="${API_DIST_DIR:-/app/apps/api/dist}"

MARKET_VENUES="${MARKET_VENUES:-kalshi polymarket limitless}"
REPAIR_VENUES="${REPAIR_VENUES:-${MARKET_VENUES}}"
SOURCE_RETENTION_VENUES="${SOURCE_RETENTION_VENUES:-polymarket limitless}"

REPAIR_CUTOFF_DAYS="${REPAIR_CUTOFF_DAYS:-1}"
REPAIR_SAMPLE="${REPAIR_SAMPLE:-20}"
REPAIR_API_TIMEOUT_SEC="${REPAIR_API_TIMEOUT_SEC:-15}"

KALSHI_REPAIR_LIMIT="${KALSHI_REPAIR_LIMIT:-50000}"
KALSHI_REPAIR_CONCURRENCY="${KALSHI_REPAIR_CONCURRENCY:-2}"
KALSHI_REPAIR_STATEMENT_TIMEOUT_SEC="${KALSHI_REPAIR_STATEMENT_TIMEOUT_SEC:-600}"

POLYMARKET_REPAIR_LIMIT="${POLYMARKET_REPAIR_LIMIT:-10000}"
POLYMARKET_REPAIR_CONCURRENCY="${POLYMARKET_REPAIR_CONCURRENCY:-4}"
POLYMARKET_REPAIR_STATEMENT_TIMEOUT_SEC="${POLYMARKET_REPAIR_STATEMENT_TIMEOUT_SEC:-300}"

LIMITLESS_REPAIR_LIMIT="${LIMITLESS_REPAIR_LIMIT:-10000}"
LIMITLESS_REPAIR_CONCURRENCY="${LIMITLESS_REPAIR_CONCURRENCY:-1}"
LIMITLESS_REPAIR_STATEMENT_TIMEOUT_SEC="${LIMITLESS_REPAIR_STATEMENT_TIMEOUT_SEC:-300}"

RETENTION_CUTOFF_DAYS="${RETENTION_CUTOFF_DAYS:-90}"
RETENTION_LIMIT="${RETENTION_LIMIT:-50000}"
RETENTION_SAMPLE="${RETENTION_SAMPLE:-20}"
RETENTION_STATEMENT_TIMEOUT_SEC="${RETENTION_STATEMENT_TIMEOUT_SEC:-900}"

SOURCE_RETENTION_CUTOFF_DAYS="${SOURCE_RETENTION_CUTOFF_DAYS:-90}"
SOURCE_RETENTION_LIMIT="${SOURCE_RETENTION_LIMIT:-50000}"
SOURCE_RETENTION_SAMPLE="${SOURCE_RETENTION_SAMPLE:-20}"
SOURCE_RETENTION_STATEMENT_TIMEOUT_SEC="${SOURCE_RETENTION_STATEMENT_TIMEOUT_SEC:-3600}"

EXECUTE=0
NO_FLOCK=0
RUN_UNIFIED_RETENTION=1
RUN_REPAIR=1
RUN_SOURCE_RETENTION=1
ORIGINAL_ARGS=("$@")

usage() {
  cat <<'EOF'
Usage:
  ops/market-maintenance.sh [--execute] [--dry-run] [options]

Runs the production market maintenance sequence:
  1. live-validated ACTIVE status repair by venue
  2. unified terminal market retention
  3. source market/event retention by venue

Safety:
  Dry-run is the default. --execute passes the required confirm flags to the
  underlying scripts. A flock lock is taken by default. Individual stage
  failures do not block later stages; the wrapper exits nonzero if any failed.

Options:
  --execute                  Run write paths.
  --dry-run                  Force dry-run mode.
  --no-flock                 Skip the wrapper flock.
  --skip-repair              Skip active status repair.
  --skip-unified-retention   Skip unified retention passes.
  --skip-source-retention    Skip source retention.
  --help                     Show this message.

Useful env overrides:
  REPAIR_VENUES="kalshi polymarket limitless"
  SOURCE_RETENTION_VENUES="polymarket limitless"
  REPAIR_CUTOFF_DAYS=1
  RETENTION_CUTOFF_DAYS=90
  SOURCE_RETENTION_CUTOFF_DAYS=90
  CONTAINER=hunch-api
  LOCK_FILE=/tmp/hunch-market-cleanup.lock

Cron example:
  15 5 * * * /usr/bin/flock -n /tmp/hunch-market-cleanup.lock /home/ubuntu/hunch-monorepo/ops/market-maintenance.sh --execute --no-flock >> /opt/hunch-data/logs/market-maintenance.log 2>&1
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      EXECUTE=1
      ;;
    --dry-run)
      EXECUTE=0
      ;;
    --no-flock)
      NO_FLOCK=1
      ;;
    --skip-repair)
      RUN_REPAIR=0
      ;;
    --skip-unified-retention)
      RUN_UNIFIED_RETENTION=0
      ;;
    --skip-source-retention)
      RUN_SOURCE_RETENTION=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ ${NO_FLOCK} -eq 0 && -z "${HUNCH_MARKET_MAINTENANCE_LOCKED:-}" ]] && command -v flock >/dev/null 2>&1; then
  exec flock -n "${LOCK_FILE}" env HUNCH_MARKET_MAINTENANCE_LOCKED=1 "$0" "${ORIGINAL_ARGS[@]}"
fi

FAILED=0

timestamp() {
  date -u "+%Y-%m-%dT%H:%M:%SZ"
}

resolve_docker_bin() {
  if [[ -x "${DOCKER_BIN}" ]]; then
    printf '%s\n' "${DOCKER_BIN}"
    return 0
  fi
  command -v docker
}

run_api_script() {
  local script="$1"
  shift

  if [[ "${HUNCH_MARKET_MAINTENANCE_IN_CONTAINER:-0}" == "1" || -f "${RUN_WITH_SECRETS}" ]]; then
    "${NODE_BIN}" "${RUN_WITH_SECRETS}" "${API_DIST_DIR}/${script}" "$@"
    return $?
  fi

  local docker_bin
  docker_bin="$(resolve_docker_bin)" || {
    echo "docker not found; set HUNCH_MARKET_MAINTENANCE_IN_CONTAINER=1 when running inside the app container" >&2
    return 127
  }
  "${docker_bin}" exec "${CONTAINER}" "${NODE_BIN}" "${RUN_WITH_SECRETS}" "${API_DIST_DIR}/${script}" "$@"
}

run_step() {
  local label="$1"
  shift

  echo
  echo "=== ${label} $(timestamp) ==="
  "$@"
  local status=$?
  if [[ ${status} -ne 0 ]]; then
    echo "FAILED ${label} exit=${status}" >&2
    FAILED=1
  else
    echo "OK ${label}"
  fi
}

delete_args=()
update_args=()
mode="dry-run"
if [[ ${EXECUTE} -eq 1 ]]; then
  delete_args=(--execute --confirm-delete)
  update_args=(--execute --confirm-update)
  mode="execute"
fi

echo "[market-maintenance] start mode=${mode}"
echo "[market-maintenance] repair venues: ${REPAIR_VENUES}"
echo "[market-maintenance] source retention venues: ${SOURCE_RETENTION_VENUES}"

run_unified_retention() {
  run_step "unified retention" run_api_script market-retention-selector.js \
    "${delete_args[@]}" \
    --cutoff-days="${RETENTION_CUTOFF_DAYS}" \
    --limit="${RETENTION_LIMIT}" \
    --sample="${RETENTION_SAMPLE}" \
    --statement-timeout-sec="${RETENTION_STATEMENT_TIMEOUT_SEC}"
}

repair_settings_for_venue() {
  local venue="$1"
  case "${venue}" in
    kalshi)
      printf '%s %s %s\n' "${KALSHI_REPAIR_LIMIT}" "${KALSHI_REPAIR_CONCURRENCY}" "${KALSHI_REPAIR_STATEMENT_TIMEOUT_SEC}"
      ;;
    polymarket)
      printf '%s %s %s\n' "${POLYMARKET_REPAIR_LIMIT}" "${POLYMARKET_REPAIR_CONCURRENCY}" "${POLYMARKET_REPAIR_STATEMENT_TIMEOUT_SEC}"
      ;;
    limitless)
      printf '%s %s %s\n' "${LIMITLESS_REPAIR_LIMIT}" "${LIMITLESS_REPAIR_CONCURRENCY}" "${LIMITLESS_REPAIR_STATEMENT_TIMEOUT_SEC}"
      ;;
    *)
      printf '%s %s %s\n' "10000" "2" "300"
      ;;
  esac
}

if [[ ${RUN_REPAIR} -eq 1 ]]; then
  read -r -a repair_venues <<< "${REPAIR_VENUES}"
  for venue in "${repair_venues[@]}"; do
    read -r limit concurrency statement_timeout_sec < <(repair_settings_for_venue "${venue}")
    run_step "active status repair ${venue}" run_api_script market-active-status-repair.js \
      "${update_args[@]}" \
      --venue="${venue}" \
      --cutoff-days="${REPAIR_CUTOFF_DAYS}" \
      --limit="${limit}" \
      --sample="${REPAIR_SAMPLE}" \
      --statement-timeout-sec="${statement_timeout_sec}" \
      --concurrency="${concurrency}" \
      --api-timeout-sec="${REPAIR_API_TIMEOUT_SEC}"
  done
fi

if [[ ${RUN_UNIFIED_RETENTION} -eq 1 ]]; then
  run_unified_retention
fi

if [[ ${RUN_SOURCE_RETENTION} -eq 1 ]]; then
  read -r -a source_retention_venues <<< "${SOURCE_RETENTION_VENUES}"
  for venue in "${source_retention_venues[@]}"; do
    run_step "source retention ${venue}" run_api_script market-source-retention.js \
      "${delete_args[@]}" \
      --venue="${venue}" \
      --cutoff-days="${SOURCE_RETENTION_CUTOFF_DAYS}" \
      --limit="${SOURCE_RETENTION_LIMIT}" \
      --sample="${SOURCE_RETENTION_SAMPLE}" \
      --statement-timeout-sec="${SOURCE_RETENTION_STATEMENT_TIMEOUT_SEC}"
  done
fi

echo
echo "[market-maintenance] done mode=${mode} failed=${FAILED}"
exit "${FAILED}"
