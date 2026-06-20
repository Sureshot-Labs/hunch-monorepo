#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   BASE_URL="http://localhost:3001/feed" ./scripts/feed-regression-test.sh
#   BASE_URL="http://localhost:3001/feed" ./scripts/feed-regression-test.sh --full
#   LIMIT=25 OFFSETS="0 25 50" SORTS="trending change24h" ./scripts/feed-regression-test.sh

BASE_URL="${BASE_URL:-http://localhost:3001/feed}"
LIMIT="${LIMIT:-25}"
OFFSETS="${OFFSETS:-0}"
SORTS="${SORTS:-trending trending_v2 change24h}"
VIEWS="${VIEWS:-events markets}"
SORT_DIR="${SORT_DIR:-desc}"

FULL=0
if [[ "${1-}" == "--full" ]]; then
  FULL=1
fi

if [[ "$FULL" == "1" ]]; then
  OFFSETS="${OFFSETS:-0 25 50}"
  SORTS="${SORTS:-trending trending_v2 totalvol liquidity openinterest time change24h}"
fi

case_labels=()
case_queries=()
add_case() {
  case_labels+=("$1")
  case_queries+=("$2")
}

add_case "base" ""
add_case "end24" "end_within_hours=24"
add_case "age24" "age_within_hours=24"
add_case "newest" "filter=newest"
add_case "endingsoon" "filter=endingsoon"

if [[ "$FULL" == "1" ]]; then
  add_case "venue:kalshi" "venue=kalshi"
  add_case "venue:polymarket" "venue=polymarket"
  add_case "venue:limitless" "venue=limitless"
  add_case "cat:crypto" "categories=crypto"
  add_case "cat:politics" "categories=politics"
  add_case "prob:0.1-0.9" "min_prob=0.1&max_prob=0.9"
  add_case "spread:0.1" "max_spread=0.1"
  add_case "minliq:1000" "min_liquidity=1000"
  add_case "minvol:1000" "min_volume24hr=1000"
  add_case "q:bitcoin" "q=bitcoin"
  add_case "q:morocc" "q=Morocc"
  add_case "q:france" "q=France"
  add_case "q:donald-trump" "q=Donald%20Trump"
  add_case "q:elon-musk" "q=Elon%20Musk"
  add_case "q:bitcoin-up" "q=Bitcoin%20up"
fi

printf "base\t%s\n" "$BASE_URL"
printf "limit\t%s\n" "$LIMIT"
printf "sort_dir\t%s\n" "$SORT_DIR"
printf "case\tview\tscope\tsort\toffset\tstatus\tms\n"

for view in $VIEWS; do
  if [[ "$view" == "markets" ]]; then
    scopes=("" "event_scope=single" "event_scope=grouped")
  else
    scopes=("")
  fi
  for scope in "${scopes[@]}"; do
    for sort in $SORTS; do
      for offset in $OFFSETS; do
        for idx in "${!case_labels[@]}"; do
          label="${case_labels[$idx]}"
          extra="${case_queries[$idx]}"
          qs="limit=${LIMIT}&offset=${offset}&sort=${sort}&sort_dir=${SORT_DIR}"
          if [[ "$view" == "markets" ]]; then
            qs="${qs}&view=markets"
          fi
          if [[ -n "$scope" ]]; then
            qs="${qs}&${scope}"
          fi
          if [[ -n "$extra" ]]; then
            qs="${qs}&${extra}"
          fi
          url="${BASE_URL}?${qs}"
          out="$(curl -s -o /dev/null -w "%{http_code} %{time_total}" "$url")"
          status="${out%% *}"
          time="${out##* }"
          ms="$(node -e "console.log(Math.round(parseFloat(process.argv[1])*1000))" "$time")"
          printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$label" "$view" "${scope:-default}" "$sort" "$offset" "$status" "$ms"
        done
      done
    done
  done
done
