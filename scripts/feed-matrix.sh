#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   BASE_URL="http://localhost:3001/feed" ./scripts/feed-matrix.sh
#   BASE_URL="https://api.hunch.trade/feed" ./scripts/feed-matrix.sh
#   LIMIT=25 OFFSETS="0 25 50" ./scripts/feed-matrix.sh

BASE_URL="${BASE_URL:-http://localhost:3001/feed}"
LIMIT="${LIMIT:-25}"
OFFSETS="${OFFSETS:-0 25 50}"
SORTS="${SORTS:-trending trending_v2 totalvol liquidity openinterest time change24h}"
VIEWS="${VIEWS:-default events markets}"
SORT_DIR="${SORT_DIR:-desc}"

printf "base\t%s\n" "$BASE_URL"
printf "limit\t%s\n" "$LIMIT"
printf "sort_dir\t%s\n" "$SORT_DIR"
printf "view\tsort\toffset\tstatus\tms\n"

for view in $VIEWS; do
  for sort in $SORTS; do
    for offset in $OFFSETS; do
      if [[ "$view" == "default" ]]; then
        url="${BASE_URL}?limit=${LIMIT}&offset=${offset}&sort=${sort}&sort_dir=${SORT_DIR}"
      else
        url="${BASE_URL}?limit=${LIMIT}&offset=${offset}&view=${view}&sort=${sort}&sort_dir=${SORT_DIR}"
      fi
      out="$(curl -s -o /dev/null -w "%{http_code} %{time_total}" "$url")"
      status="${out%% *}"
      time="${out##* }"
      ms="$(node -e "console.log(Math.round(parseFloat(process.argv[1])*1000))" "$time")"
      printf "%s\t%s\t%s\t%s\t%s\n" "$view" "$sort" "$offset" "$status" "$ms"
    done
  done
done
