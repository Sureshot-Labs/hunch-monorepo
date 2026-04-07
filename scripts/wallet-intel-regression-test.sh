#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   BASE_URL="http://localhost:3001" ./scripts/wallet-intel-regression-test.sh
#   BASE_URL="https://app.hunch.trade/api/hunch" COOKIE="session=..." ./scripts/wallet-intel-regression-test.sh --full
#   BASE_URL="https://app.hunch.trade/api/hunch" \
#   COOKIE_FILE="/tmp/hunch.cookies" \
#   HUNCH_WALLET="0xd829f31579e3129a551c9ab3980efa8e5e041131" \
#   INCLUDE_SPARKLINE=1 \
#   ./scripts/wallet-intel-regression-test.sh --full
#   WHALES_URL="https://app.hunch.trade/api/hunch/wallets/whales" \
#   SUMMARY_URL="https://app.hunch.trade/api/hunch/wallets/activity/summary" \
#   SIGNALS_URL="https://app.hunch.trade/api/hunch/wallets/activity/signals" \
#   ./scripts/wallet-intel-regression-test.sh
#
# Notes:
# - Public tracker/signal cases can run without auth.
# - User-context scopes like `following` still require auth.
# - Provide COOKIE / COOKIE_FILE and/or AUTH_HEADER to exercise auth-bound
#   scopes. Example: AUTH_HEADER="Authorization: Bearer <token>"

BASE_URL="${BASE_URL:-http://localhost:3001}"
WHALES_URL="${WHALES_URL:-${BASE_URL%/}/wallets/whales}"
SUMMARY_URL="${SUMMARY_URL:-${BASE_URL%/}/wallets/activity/summary}"
SIGNALS_URL="${SIGNALS_URL:-${BASE_URL%/}/wallets/activity/signals}"

LIMIT="${LIMIT:-30}"
OFFSETS_SET="${OFFSETS+x}"
OFFSETS="${OFFSETS:-0}"
WINDOW_HOURS="${WINDOW_HOURS:-168}"
TOP_CHANGES="${TOP_CHANGES:-3}"
WINDOW_DAYS="${WINDOW_DAYS:-30}"
MARKET_LIMIT="${MARKET_LIMIT:-5}"
INCLUDE_SPARKLINE="${INCLUDE_SPARKLINE:-0}"

WHALES_SORTS_SET="${WHALES_SORTS+x}"
WHALES_SORTS="${WHALES_SORTS:-last_activity pnl_30d volume_30d exposure_usd trades_30d winrate}"

SUMMARY_SCOPES_SET="${SUMMARY_SCOPES+x}"
SUMMARY_SCOPES="${SUMMARY_SCOPES:-all whales following}"

SUMMARY_SORTS_SET="${SUMMARY_SORTS+x}"
SUMMARY_SORTS="${SUMMARY_SORTS:-last_activity net_change_usd unusual_score}"

SIGNAL_SCOPES_SET="${SIGNAL_SCOPES+x}"
SIGNAL_SCOPES="${SIGNAL_SCOPES:-all active following}"

COOKIE="${COOKIE:-}"
COOKIE_FILE="${COOKIE_FILE:-}"
AUTH_HEADER="${AUTH_HEADER:-}"
HUNCH_WALLET="${HUNCH_WALLET:-}"
EXTRA_CURL_ARGS="${EXTRA_CURL_ARGS:-}"

if [[ -z "$COOKIE" && -n "$COOKIE_FILE" ]]; then
  if [[ ! -f "$COOKIE_FILE" ]]; then
    echo "COOKIE_FILE does not exist: $COOKIE_FILE" >&2
    exit 1
  fi
  COOKIE="$(tr -d '\r\n' < "$COOKIE_FILE")"
fi

HAS_AUTH=0
if [[ -n "$COOKIE" || -n "$AUTH_HEADER" ]]; then
  HAS_AUTH=1
fi

if [[ "$HAS_AUTH" != "1" ]]; then
  if [[ -z "${SUMMARY_SCOPES_SET}" ]]; then
    SUMMARY_SCOPES="all whales"
  fi
  if [[ -z "${SIGNAL_SCOPES_SET}" ]]; then
    SIGNAL_SCOPES="all active"
  fi
fi

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
    SUMMARY_SCOPES="$([[ "$HAS_AUTH" == "1" ]] && echo "all whales following" || echo "all whales")"
  fi
  if [[ -z "${SUMMARY_SORTS_SET}" ]]; then
    SUMMARY_SORTS="last_activity net_change_usd unusual_score"
  fi
  if [[ -z "${SIGNAL_SCOPES_SET}" ]]; then
    SIGNAL_SCOPES="$([[ "$HAS_AUTH" == "1" ]] && echo "all active following" || echo "all active")"
  fi
fi

scope_requires_auth() {
  local scope="$1"
  [[ "$scope" == "following" ]]
}

emit_skip() {
  local endpoint="$1"
  local label="$2"
  local scope="$3"
  local sort="$4"
  local offset="$5"
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$endpoint" "$label" "$scope" "$sort" "$offset" "SKIP:no_auth" "0"
}

whales_case_labels=()
whales_case_queries=()
add_whales_case() {
  local query="$2"
  local include_sparkline_normalized
  include_sparkline_normalized="$(printf '%s' "${INCLUDE_SPARKLINE}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${include_sparkline_normalized}" == "1" || "${include_sparkline_normalized}" == "true" ]]; then
    query="includeSparkline=true${query:+&${query}}"
  fi
  whales_case_labels+=("$1")
  whales_case_queries+=("$query")
}

summary_case_labels=()
summary_case_queries=()
add_summary_case() {
  local query="$2"
  local include_sparkline_normalized
  include_sparkline_normalized="$(printf '%s' "${INCLUDE_SPARKLINE}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${include_sparkline_normalized}" == "1" || "${include_sparkline_normalized}" == "true" ]]; then
    query="includeSparkline=true${query:+&${query}}"
  fi
  summary_case_labels+=("$1")
  summary_case_queries+=("$query")
}

signals_case_labels=()
signals_case_queries=()
add_signals_case() {
  signals_case_labels+=("$1")
  signals_case_queries+=("$2")
}

# Whales: base requested shape + toggles/filters.
add_whales_case "base" "includeSummary=true&includeAttribution=true&windowDays=${WINDOW_DAYS}&windowHours=${WINDOW_HOURS}"
add_whales_case "attr:off" "includeSummary=true&includeAttribution=false&windowDays=${WINDOW_DAYS}&windowHours=${WINDOW_HOURS}"
add_whales_case "summary:off" "includeSummary=false&includeAttribution=true&windowDays=${WINDOW_DAYS}&windowHours=${WINDOW_HOURS}"
add_whales_case "window:24h" "includeSummary=true&includeAttribution=true&windowDays=1&windowHours=24"
add_whales_case "window:336h" "includeSummary=true&includeAttribution=true&windowDays=14&windowHours=336"

# Summary: base requested shape + toggles/filters.
add_summary_case "base" "includeAttribution=true&windowHours=${WINDOW_HOURS}"
add_summary_case "attr:off" "includeAttribution=false&windowHours=${WINDOW_HOURS}"
add_summary_case "window:24h" "includeAttribution=true&windowHours=24"
add_summary_case "window:336h" "includeAttribution=true&windowHours=336"

# Signals: base requested shape + signal-specific filters/toggles.
add_signals_case "base" "includeAttribution=true&windowHours=${WINDOW_HOURS}"
add_signals_case "attr:off" "includeAttribution=false&windowHours=${WINDOW_HOURS}"
add_signals_case "window:24h" "includeAttribution=true&windowHours=24"
add_signals_case "window:336h" "includeAttribution=true&windowHours=336"
add_signals_case "mm:exclude" "includeAttribution=true&excludeMmLike=true&windowHours=${WINDOW_HOURS}"
add_signals_case "severity:high" "includeAttribution=true&severity=high&windowHours=${WINDOW_HOURS}"
add_signals_case "type:late" "includeAttribution=true&signalType=longshot_large_late&windowHours=${WINDOW_HOURS}"
add_signals_case "late:very" "includeAttribution=true&lateBucket=very_late&windowHours=${WINDOW_HOURS}"

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

  add_signals_case "cat:crypto" "includeAttribution=true&categories=crypto&windowHours=${WINDOW_HOURS}"
  add_signals_case "cat:politics" "includeAttribution=true&categories=politics&windowHours=${WINDOW_HOURS}"
  add_signals_case "tag:whale" "includeAttribution=true&tags=whale&windowHours=${WINDOW_HOURS}"
  add_signals_case "tag:whale+fresh(all)" "includeAttribution=true&tags=whale,fresh&tagMode=all&windowHours=${WINDOW_HOURS}"
  add_signals_case "primary:whale" "includeAttribution=true&primary=whale&windowHours=${WINDOW_HOURS}"
  add_signals_case "label:high_conviction" "includeAttribution=true&labels=high_conviction&windowHours=${WINDOW_HOURS}"
  add_signals_case "label:hc+mv(all)" "includeAttribution=true&labels=high_conviction,market_mover&labelMode=all&windowHours=${WINDOW_HOURS}"
  add_signals_case "reason:late_entry" "includeAttribution=true&displayReasons=late_entry&windowHours=${WINDOW_HOURS}"
  add_signals_case "reason:late+longshot(all)" "includeAttribution=true&displayReasons=late_entry,longshot_odds&signalReasonMode=all&windowHours=${WINDOW_HOURS}"
  add_signals_case "threshold:tight" "includeAttribution=true&minScore=0.7&maxOdds=0.15&minStakeUsd=500&minIdleDays=14&maxPriorMarkets=1&minPayoutUsd=2500&windowHours=${WINDOW_HOURS}"
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
  if [[ -n "$HUNCH_WALLET" ]]; then
    cmd+=(-H "x-hunch-wallet: ${HUNCH_WALLET}")
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
printf "signals_url\t%s\n" "$SIGNALS_URL"
printf "limit\t%s\n" "$LIMIT"
printf "window_hours\t%s\n" "$WINDOW_HOURS"
printf "top_changes\t%s\n" "$TOP_CHANGES"
printf "include_sparkline\t%s\n" "$INCLUDE_SPARKLINE"
printf "auth_cookie\t%s\n" "$([[ -n "$COOKIE" ]] && echo "set" || echo "unset")"
printf "auth_cookie_file\t%s\n" "$([[ -n "$COOKIE_FILE" ]] && echo "$COOKIE_FILE" || echo "unset")"
printf "auth_header\t%s\n" "$([[ -n "$AUTH_HEADER" ]] && echo "set" || echo "unset")"
printf "auth_enabled\t%s\n" "$([[ "$HAS_AUTH" == "1" ]] && echo "yes" || echo "no")"
printf "hunch_wallet\t%s\n" "$([[ -n "$HUNCH_WALLET" ]] && echo "set" || echo "unset")"
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
  if scope_requires_auth "$scope" && [[ "$HAS_AUTH" != "1" ]]; then
    for sort in $SUMMARY_SORTS; do
      for offset in $OFFSETS; do
        for idx in "${!summary_case_labels[@]}"; do
          label="${summary_case_labels[$idx]}"
          emit_skip "wallets/activity/summary" "$label" "$scope" "$sort" "$offset"
        done
      done
    done
    continue
  fi
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

for scope in $SIGNAL_SCOPES; do
  if scope_requires_auth "$scope" && [[ "$HAS_AUTH" != "1" ]]; then
    for offset in $OFFSETS; do
      for idx in "${!signals_case_labels[@]}"; do
        label="${signals_case_labels[$idx]}"
        emit_skip "wallets/activity/signals" "$label" "$scope" "-" "$offset"
      done
    done
    continue
  fi
  for offset in $OFFSETS; do
    for idx in "${!signals_case_labels[@]}"; do
      label="${signals_case_labels[$idx]}"
      extra="${signals_case_queries[$idx]}"
      qs="scope=${scope}&limit=${LIMIT}&offset=${offset}"
      if [[ -n "$extra" ]]; then
        qs="${qs}&${extra}"
      fi
      url="${SIGNALS_URL}?${qs}"
      probe="$(request_probe "$url")"
      status="${probe%%$'\t'*}"
      ms="${probe##*$'\t'}"
      printf "wallets/activity/signals\t%s\t%s\t-\t%s\t%s\t%s\n" "$label" "$scope" "$offset" "$status" "$ms"
    done
  done
done
