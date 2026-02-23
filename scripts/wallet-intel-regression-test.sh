#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   BASE_URL="http://localhost:3001" ./scripts/wallet-intel-regression-test.sh
#   BASE_URL="https://app.hunch.trade/api/hunch" COOKIE="session=..." ./scripts/wallet-intel-regression-test.sh --full
#   WHALES_URL="https://app.hunch.trade/api/hunch/wallets/whales" \
#   SUMMARY_URL="https://app.hunch.trade/api/hunch/wallets/activity/summary" \
#   ./scripts/wallet-intel-regression-test.sh
#
# Notes:
# - /wallets/whales and /wallets/activity/summary are auth-protected.
# - Provide COOKIE and/or AUTH_HEADER if the target requires auth.
#   Example: AUTH_HEADER="Authorization: Bearer <token>"

BASE_URL="${BASE_URL:-http://localhost:3001}"
WHALES_URL="${WHALES_URL:-${BASE_URL%/}/wallets/whales}"
SUMMARY_URL="${SUMMARY_URL:-${BASE_URL%/}/wallets/activity/summary}"

LIMIT="${LIMIT:-30}"
OFFSETS_SET="${OFFSETS+x}"
OFFSETS="${OFFSETS:-0}"
WINDOW_HOURS="${WINDOW_HOURS:-168}"
TOP_CHANGES="${TOP_CHANGES:-3}"
WINDOW_DAYS="${WINDOW_DAYS:-30}"
MARKET_LIMIT="${MARKET_LIMIT:-5}"

WHALES_SORTS_SET="${WHALES_SORTS+x}"
WHALES_SORTS="${WHALES_SORTS:-last_activity pnl_30d volume_30d exposure_usd trades_30d winrate}"

SUMMARY_SCOPES_SET="${SUMMARY_SCOPES+x}"
SUMMARY_SCOPES="${SUMMARY_SCOPES:-all whales following}"

SUMMARY_SORTS_SET="${SUMMARY_SORTS+x}"
SUMMARY_SORTS="${SUMMARY_SORTS:-last_activity net_change_usd unusual_score}"

COOKIE="${COOKIE:-}"
AUTH_HEADER="${AUTH_HEADER:-}"
EXTRA_CURL_ARGS="${EXTRA_CURL_ARGS:-}"

FULL=0
if [[ "${1-}" == "--full" ]]; then
  FULL=1
fi

if [[ "$FULL" == "1" ]]; then
  if [[ -z "${OFFSETS_SET}" ]]; then
    OFFSETS="0 30 60"
  fi
  if [[ -z "${WHALES_SORTS_SET}" ]]; then
    WHALES_SORTS="last_activity pnl_30d volume_30d exposure_usd trades_30d winrate"
  fi
  if [[ -z "${SUMMARY_SCOPES_SET}" ]]; then
    SUMMARY_SCOPES="all whales following"
  fi
  if [[ -z "${SUMMARY_SORTS_SET}" ]]; then
    SUMMARY_SORTS="last_activity net_change_usd unusual_score"
  fi
fi

whales_case_labels=()
whales_case_queries=()
add_whales_case() {
  whales_case_labels+=("$1")
  whales_case_queries+=("$2")
}

summary_case_labels=()
summary_case_queries=()
add_summary_case() {
  summary_case_labels+=("$1")
  summary_case_queries+=("$2")
}

# Whales: base requested shape + toggles/filters.
add_whales_case "base" "includeSummary=true&includeAttribution=true&windowHours=${WINDOW_HOURS}"
add_whales_case "attr:off" "includeSummary=true&includeAttribution=false&windowHours=${WINDOW_HOURS}"
add_whales_case "summary:off" "includeSummary=false&includeAttribution=true&windowHours=${WINDOW_HOURS}"
add_whales_case "window:24h" "includeSummary=true&includeAttribution=true&windowHours=24"
add_whales_case "window:336h" "includeSummary=true&includeAttribution=true&windowHours=336"

# Summary: base requested shape + toggles/filters.
add_summary_case "base" "includeAttribution=true&windowHours=${WINDOW_HOURS}"
add_summary_case "attr:off" "includeAttribution=false&windowHours=${WINDOW_HOURS}"
add_summary_case "window:24h" "includeAttribution=true&windowHours=24"
add_summary_case "window:336h" "includeAttribution=true&windowHours=336"

if [[ "$FULL" == "1" ]]; then
  add_whales_case "cat:crypto" "categories=crypto"
  add_whales_case "cat:politics" "categories=politics"
  add_whales_case "tag:whale" "tags=whale"
  add_whales_case "tag:whale+fresh(all)" "tags=whale,fresh&tagMode=all"
  add_whales_case "primary:whale" "primary=whale"
  add_whales_case "label:high_conviction" "labels=high_conviction"
  add_whales_case "label:hc+mv(all)" "labels=high_conviction,market_mover&labelMode=all"
  add_whales_case "windowDays:90" "windowDays=90"
  add_whales_case "marketLimit:10" "marketLimit=10"

  add_summary_case "cat:crypto" "categories=crypto"
  add_summary_case "cat:politics" "categories=politics"
  add_summary_case "tag:whale" "tags=whale"
  add_summary_case "tag:whale+fresh(all)" "tags=whale,fresh&tagMode=all"
  add_summary_case "primary:whale" "primary=whale"
  add_summary_case "label:high_conviction" "labels=high_conviction"
  add_summary_case "label:hc+mv(all)" "labels=high_conviction,market_mover&labelMode=all"
fi

request_probe() {
  local url="$1"
  local out status time ms

  local cmd=(
    curl
    -s
    -o
    /dev/null
    -w
    "%{http_code} %{time_total}"
  )
  if [[ -n "$COOKIE" ]]; then
    cmd+=(-H "Cookie: ${COOKIE}")
  fi
  if [[ -n "$AUTH_HEADER" ]]; then
    cmd+=(-H "${AUTH_HEADER}")
  fi
  if [[ -n "$EXTRA_CURL_ARGS" ]]; then
    # shellcheck disable=SC2206
    local extra=( $EXTRA_CURL_ARGS )
    cmd+=("${extra[@]}")
  fi
  cmd+=("$url")

  out="$("${cmd[@]}")"
  status="${out%% *}"
  time="${out##* }"
  ms="$(awk -v t="$time" 'BEGIN { printf "%d", (t*1000)+0.5 }')"
  printf "%s\t%s" "$status" "$ms"
}

query_has_param() {
  local query="$1"
  local key="$2"
  [[ "$query" == *"${key}="* ]]
}

printf "whales_url\t%s\n" "$WHALES_URL"
printf "summary_url\t%s\n" "$SUMMARY_URL"
printf "limit\t%s\n" "$LIMIT"
printf "window_hours\t%s\n" "$WINDOW_HOURS"
printf "top_changes\t%s\n" "$TOP_CHANGES"
printf "auth_cookie\t%s\n" "$([[ -n "$COOKIE" ]] && echo "set" || echo "unset")"
printf "auth_header\t%s\n" "$([[ -n "$AUTH_HEADER" ]] && echo "set" || echo "unset")"
printf "endpoint\tcase\tscope\tsort\toffset\tstatus\tms\n"

for sort in $WHALES_SORTS; do
  for offset in $OFFSETS; do
    for idx in "${!whales_case_labels[@]}"; do
      label="${whales_case_labels[$idx]}"
      extra="${whales_case_queries[$idx]}"
      qs="limit=${LIMIT}&offset=${offset}&topChanges=${TOP_CHANGES}&sort=${sort}"
      if ! query_has_param "$extra" "windowDays"; then
        qs="${qs}&windowDays=${WINDOW_DAYS}"
      fi
      if ! query_has_param "$extra" "marketLimit"; then
        qs="${qs}&marketLimit=${MARKET_LIMIT}"
      fi
      if [[ -n "$extra" ]]; then
        qs="${qs}&${extra}"
      fi
      url="${WHALES_URL}?${qs}"
      probe="$(request_probe "$url")"
      status="${probe%%$'\t'*}"
      ms="${probe##*$'\t'}"
      printf "wallets/whales\t%s\t-\t%s\t%s\t%s\t%s\n" "$label" "$sort" "$offset" "$status" "$ms"
    done
  done
done

for scope in $SUMMARY_SCOPES; do
  for sort in $SUMMARY_SORTS; do
    for offset in $OFFSETS; do
      for idx in "${!summary_case_labels[@]}"; do
        label="${summary_case_labels[$idx]}"
        extra="${summary_case_queries[$idx]}"
        qs="scope=${scope}&topChanges=${TOP_CHANGES}&limit=${LIMIT}&offset=${offset}&sort=${sort}"
        if [[ -n "$extra" ]]; then
          qs="${qs}&${extra}"
        fi
        url="${SUMMARY_URL}?${qs}"
        probe="$(request_probe "$url")"
        status="${probe%%$'\t'*}"
        ms="${probe##*$'\t'}"
        printf "wallets/activity/summary\t%s\t%s\t%s\t%s\t%s\t%s\n" "$label" "$scope" "$sort" "$offset" "$status" "$ms"
      done
    done
  done
done
