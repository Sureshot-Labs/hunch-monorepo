#!/usr/bin/env bash
set -uo pipefail

# Usage:
#   BASE_URL="http://localhost:3001/special/fifa-2026" ./scripts/special-fifa-regression-test.sh
#   BASE_URL="https://api.hunch.trade/special/fifa-2026" ./scripts/special-fifa-regression-test.sh --full
#   LIMIT=25 OFFSETS="0 25" SORTS="featured volume liquidity" ./scripts/special-fifa-regression-test.sh
#   INCLUDE_SEARCH=0 BASE_URL="https://api.hunch.trade/special/fifa-2026" ./scripts/special-fifa-regression-test.sh --full
#
# The script intentionally records curl failures/timeouts as status 000 rows
# instead of stopping the matrix on the first bad endpoint.

OFFSETS_WAS_SET="${OFFSETS+x}"

BASE_URL="${BASE_URL:-http://localhost:3001/special/fifa-2026}"
LIMIT="${LIMIT:-25}"
OFFSETS="${OFFSETS:-0}"
SORTS="${SORTS:-featured volume volume24h liquidity time newest}"
VIEWS="${VIEWS:-events markets}"
SORT_DIR="${SORT_DIR:-auto}"
MAX_TIME_SEC="${MAX_TIME_SEC:-60}"
SLEEP_MS="${SLEEP_MS:-0}"
INCLUDE_SEARCH="${INCLUDE_SEARCH:-1}"

FULL=0
if [[ "${1-}" == "--help" || "${1-}" == "-h" ]]; then
  sed -n '2,9p' "$0"
  exit 0
fi
if [[ "${1-}" == "--full" ]]; then
  FULL=1
fi

if [[ "$FULL" == "1" && -z "$OFFSETS_WAS_SET" ]]; then
  OFFSETS="0 25 50"
fi

case_labels=()
case_queries=()
add_case() {
  case_labels+=("$1")
  case_queries+=("$2")
}

add_case "base" ""
add_case "venue:polymarket" "venue=polymarket"
add_case "venue:kalshi" "venue=kalshi"
add_case "venue:limitless" "venue=limitless"
add_case "section:winner" "section=winner"
add_case "section:group" "section=group"
add_case "section:match_result" "section=match_result"
add_case "section:match_prop" "section=match_prop"
if [[ "$INCLUDE_SEARCH" != "0" ]]; then
  add_case "q:usa" "q=usa"
fi

if [[ "$FULL" == "1" ]]; then
  add_case "section:stage" "section=stage"
  add_case "section:player_award" "section=player_award"
  add_case "section:squad" "section=squad"
  add_case "section:special" "section=special"
  add_case "group:a" "section=group&group_code=a"
  add_case "group:d" "section=group&group_code=d"
  add_case "group:l" "section=group&group_code=l"
  add_case "team_group:a" "team_group_code=a"
  add_case "team_group:d" "team_group_code=d"
  add_case "team_group:l" "team_group_code=l"
  if [[ "$INCLUDE_SEARCH" != "0" ]]; then
    add_case "q:messi" "q=messi"
    add_case "q:ronaldo" "q=ronaldo"
    add_case "q:golden-boot" "q=golden+boot"
  fi
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/special-fifa-matrix.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

header_value() {
  local header_name="$1"
  local header_file="$2"
  awk -v key="$header_name" '
    index(tolower($0), tolower(key) ":") == 1 {
      sub(/\r$/, "")
      sub(/^[^:]*:[[:space:]]*/, "")
      value = $0
    }
    END { print value }
  ' "$header_file"
}

to_ms() {
  awk -v seconds="$1" 'BEGIN { printf "%d", (seconds * 1000) + 0.5 }'
}

sleep_between_requests() {
  if [[ "$SLEEP_MS" =~ ^[0-9]+$ && "$SLEEP_MS" -gt 0 ]]; then
    sleep "$(awk -v ms="$SLEEP_MS" 'BEGIN { printf "%.3f", ms / 1000 }')"
  fi
}

printf "base\t%s\n" "$BASE_URL"
printf "limit\t%s\n" "$LIMIT"
printf "sort_dir\t%s\n" "$SORT_DIR"
printf "max_time_sec\t%s\n" "$MAX_TIME_SEC"
printf "include_search\t%s\n" "$INCLUDE_SEARCH"
printf "mode\t%s\n" "$([[ "$FULL" == "1" ]] && echo full || echo default)"
printf "case\tview\tsort\toffset\tstatus\tms\tbytes\tcache\tcache_status\n"

for view in $VIEWS; do
  for sort in $SORTS; do
    for offset in $OFFSETS; do
      for idx in "${!case_labels[@]}"; do
        label="${case_labels[$idx]}"
        extra="${case_queries[$idx]}"
        qs="limit=${LIMIT}&offset=${offset}&view=${view}&sort=${sort}"
        if [[ -n "$SORT_DIR" && "$SORT_DIR" != "auto" ]]; then
          qs="${qs}&sort_dir=${SORT_DIR}"
        fi
        if [[ -n "$extra" ]]; then
          qs="${qs}&${extra}"
        fi
        url="${BASE_URL}?${qs}"

        headers="${tmp_dir}/headers"
        body="${tmp_dir}/body"
        err="${tmp_dir}/curl.err"
        : >"$headers"
        : >"$body"
        : >"$err"

        if out="$(curl -sS --max-time "$MAX_TIME_SEC" -D "$headers" -o "$body" -w "%{http_code}\t%{time_total}\t%{size_download}" "$url" 2>"$err")"; then
          status="$(printf "%s" "$out" | awk -F '\t' '{ print $1 }')"
          seconds="$(printf "%s" "$out" | awk -F '\t' '{ print $2 }')"
          bytes="$(printf "%s" "$out" | awk -F '\t' '{ print $3 }')"
          cache="$(header_value "x-cache" "$headers")"
          cache_status="$(header_value "x-cache-status" "$headers")"
          printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
            "$label" "$view" "$sort" "$offset" "$status" "$(to_ms "$seconds")" "$bytes" "${cache:-none}" "${cache_status:-none}"
        else
          printf "%s\t%s\t%s\t%s\t000\t0\t0\terror\t%s\n" \
            "$label" "$view" "$sort" "$offset" "$(tr '\n\t' '  ' <"$err" | sed 's/[[:space:]][[:space:]]*/ /g')"
        fi

        sleep_between_requests
      done
    done
  done
done
