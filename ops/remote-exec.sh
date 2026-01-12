#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ubuntu@13.48.86.72}"
SERVICE="${SERVICE:-hunch-api}"

usage() {
  cat <<'EOF'
Usage:
  ops/remote-exec.sh <tool> [args...]

Tools:
  polycurl         -> /app/apps/api/dist/polyclob.js
  limitlesscurl    -> /app/apps/api/dist/limitlesscurl.js
  dflowcurl        -> /app/apps/api/dist/dflowcurl.js
  admin:user       -> /app/apps/api/dist/admin-user.js
  admin:points     -> /app/apps/api/dist/admin-points.js
  fees:collect     -> /app/apps/api/dist/collect-fees.js
  rewards:payout   -> /app/apps/api/dist/rewards-payout.js
  migrate          -> /app/packages/db/dist/migrate.js
  run -- <cmd>     -> run an arbitrary command inside hunch-api
  psql "<sql>"     -> run SQL against hunch-postgres using container env

Env overrides:
  REMOTE_HOST=ubuntu@13.48.86.72
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

run_ssh() {
  local cmd="$1"
  ssh "${REMOTE_HOST}" "${cmd}"
}

case "${tool}" in
  polycurl)
    cmd="docker exec -i ${SERVICE} node /app/apps/api/dist/polyclob.js$(quote_args "$@")"
    ;;
  limitlesscurl)
    cmd="docker exec -i ${SERVICE} node /app/apps/api/dist/limitlesscurl.js$(quote_args "$@")"
    ;;
  dflowcurl)
    cmd="docker exec -i ${SERVICE} node /app/apps/api/dist/dflowcurl.js$(quote_args "$@")"
    ;;
  admin:user|admin-user)
    cmd="docker exec -i ${SERVICE} node /app/apps/api/dist/admin-user.js$(quote_args "$@")"
    ;;
  admin:points|admin-points)
    cmd="docker exec -i ${SERVICE} node /app/apps/api/dist/admin-points.js$(quote_args "$@")"
    ;;
  fees:collect|fees-collect)
    cmd="docker exec -i ${SERVICE} node /app/apps/api/dist/collect-fees.js$(quote_args "$@")"
    ;;
  rewards:payout|rewards-payout)
    cmd="docker exec -i ${SERVICE} node /app/apps/api/dist/rewards-payout.js$(quote_args "$@")"
    ;;
  migrate)
    cmd="docker exec -i ${SERVICE} node /app/packages/db/dist/migrate.js$(quote_args "$@")"
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
