#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ubuntu@13.51.155.185}"
SERVICE="${SERVICE:-hunch-api}"

usage() {
  cat <<'EOF'
Usage:
  ops/remote-exec.sh <tool> [args...]

Tools:
  polycurl         -> /app/apps/api/dist/polyclob.js via run-with-secrets
  limitlesscurl    -> /app/apps/api/dist/limitlesscurl.js via run-with-secrets
  dflowcurl        -> /app/apps/api/dist/dflowcurl.js via run-with-secrets
  admin:user       -> /app/apps/api/dist/admin-user.js via run-with-secrets
  admin:points     -> /app/apps/api/dist/admin-points.js via run-with-secrets
  fees:collect     -> /app/apps/api/dist/collect-fees.js via run-with-secrets
  rewards:payout   -> /app/apps/api/dist/rewards-payout.js via run-with-secrets
  migrate          -> /app/packages/db/dist/migrate.js via run-with-secrets
  run -- <cmd>     -> run an arbitrary command inside hunch-api
  psql "<sql>"     -> run SQL against hunch-postgres using container env

Env overrides:
  REMOTE_HOST=ubuntu@13.51.155.185
  SERVICE=hunch-api
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

tool="$1"
shift || true

quote_args() {
  local out=""
  for arg in "$@"; do
    out+=" $(printf '%q' "$arg")"
  done
  printf '%s' "$out"
}

node_with_secrets() {
  local target="$1"
  shift || true
  printf 'docker exec -i %s node /app/packages/config/dist/run-with-secrets.js %s%s' \
    "${SERVICE}" \
    "${target}" \
    "$(quote_args "$@")"
}

run_ssh() {
  local cmd="$1"
  ssh "${REMOTE_HOST}" "${cmd}"
}

case "${tool}" in
  polycurl)
    cmd="$(node_with_secrets /app/apps/api/dist/polyclob.js "$@")"
    ;;
  limitlesscurl)
    cmd="$(node_with_secrets /app/apps/api/dist/limitlesscurl.js "$@")"
    ;;
  dflowcurl)
    cmd="$(node_with_secrets /app/apps/api/dist/dflowcurl.js "$@")"
    ;;
  admin:user|admin-user)
    cmd="$(node_with_secrets /app/apps/api/dist/admin-user.js "$@")"
    ;;
  admin:points|admin-points)
    cmd="$(node_with_secrets /app/apps/api/dist/admin-points.js "$@")"
    ;;
  fees:collect|fees-collect)
    cmd="$(node_with_secrets /app/apps/api/dist/collect-fees.js "$@")"
    ;;
  rewards:payout|rewards-payout)
    cmd="$(node_with_secrets /app/apps/api/dist/rewards-payout.js "$@")"
    ;;
  migrate)
    cmd="$(node_with_secrets /app/packages/db/dist/migrate.js "$@")"
    ;;
  run)
    if [[ $# -lt 1 ]]; then
      echo "run requires a command after --" >&2
      exit 1
    fi
    cmd="docker exec -i ${SERVICE}$(quote_args "$@")"
    ;;
  psql)
    if [[ $# -lt 1 ]]; then
      echo "psql requires a SQL string" >&2
      exit 1
    fi
    sql="$1"
    cmd="docker exec -i hunch-postgres sh -lc $(printf '%q' "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"$sql\"")"
    ;;
  *)
    echo "Unknown tool: ${tool}" >&2
    usage
    exit 1
    ;;
esac

run_ssh "${cmd}"
