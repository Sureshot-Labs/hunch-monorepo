#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/ai-topics-matrix.sh
#   ./scripts/ai-topics-matrix.sh --mode wide
#   ./scripts/ai-topics-matrix.sh --mode random --random-runs 8
#   OUT_DIR=/tmp/ai-topics ./scripts/ai-topics-matrix.sh --mode both
#
# Env overrides:
#   WIDE_LIMITS="50 100 200"
#   RANDOM_LIMIT=200
#   RANDOM_RUNS=5
#   ORDER_BY_WIDE=trending

MODE="both"
WIDE_LIMITS="${WIDE_LIMITS:-50 100 200}"
RANDOM_LIMIT="${RANDOM_LIMIT:-200}"
RANDOM_RUNS="${RANDOM_RUNS:-5}"
ORDER_BY_WIDE="${ORDER_BY_WIDE:-trending}"
SHOW_TOP="${SHOW_TOP:-1000}"
QUIET="${QUIET:-1}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
OUT_DIR="${OUT_DIR:-/tmp/ai-topics-matrix-${STAMP}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --wide-limits)
      WIDE_LIMITS="${2:-}"
      shift 2
      ;;
    --random-limit)
      RANDOM_LIMIT="${2:-}"
      shift 2
      ;;
    --random-runs)
      RANDOM_RUNS="${2:-}"
      shift 2
      ;;
    --order-by-wide)
      ORDER_BY_WIDE="${2:-}"
      shift 2
      ;;
    --show-top)
      SHOW_TOP="${2:-}"
      shift 2
      ;;
    --verbose)
      QUIET="0"
      shift 1
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Run ai:topics:dry-run in matrix modes and emit JSON artifacts + summary.

Options:
  --mode <wide|random|both>     Which matrix set to run (default: both)
  --wide-limits "<csv/space>"   Wide matrix limits (default: "50 100 200")
  --random-limit <n>            Row limit per random run (default: 200)
  --random-runs <n>             Number of random runs per sampling mode (default: 5)
  --order-by-wide <mode>        Wide order mode (default: trending)
  --show-top <n>                topTopics count saved in each JSON (default: 1000)
  --verbose                     Print full ai:topics:dry-run stdout for each case
  --out-dir <path>              Output directory (default: /tmp/ai-topics-matrix-<utcstamp>)
EOF
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$MODE" != "wide" && "$MODE" != "random" && "$MODE" != "both" ]]; then
  echo "--mode must be one of: wide, random, both" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for summary output" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

run_case() {
  local name="$1"
  shift
  local out_file="${OUT_DIR}/${name}.json"
  echo "[ai-topics-matrix] running ${name}"
  if [[ "$QUIET" == "1" ]]; then
    pnpm -C "$REPO_DIR" -F api run ai:topics:dry-run -- \
      --json \
      --show-top "$SHOW_TOP" \
      --show-queries 0 \
      --out "$out_file" \
      "$@" >/dev/null
  else
    pnpm -C "$REPO_DIR" -F api run ai:topics:dry-run -- \
      --json \
      --show-top "$SHOW_TOP" \
      --show-queries 0 \
      --out "$out_file" \
      "$@"
  fi
}

if [[ "$MODE" == "wide" || "$MODE" == "both" ]]; then
  for limit in $WIDE_LIMITS; do
    run_case "wide_global_${limit}" \
      --sampling global \
      --order-by "$ORDER_BY_WIDE" \
      --limit "$limit"
    run_case "wide_pervenue_${limit}" \
      --sampling per-venue \
      --order-by "$ORDER_BY_WIDE" \
      --limit "$limit"
  done
fi

if [[ "$MODE" == "random" || "$MODE" == "both" ]]; then
  for i in $(seq 1 "$RANDOM_RUNS"); do
    run_case "random_global_${RANDOM_LIMIT}_run${i}" \
      --sampling global \
      --order-by random \
      --limit "$RANDOM_LIMIT"
    run_case "random_pervenue_${RANDOM_LIMIT}_run${i}" \
      --sampling per-venue \
      --order-by random \
      --limit "$RANDOM_LIMIT"
  done
fi

echo
echo "[ai-topics-matrix] outputs: ${OUT_DIR}"
echo "[ai-topics-matrix] summary"
printf "file\trows\tuniqueSearch\tunknownTopics\tunknownMarkets\tplaceholderTopics\tcallsDayAfterCache\ttierA/B/C\tsearchStale6h\tsearchStale24h\n"

for file in "${OUT_DIR}"/*.json; do
  jq -r --arg file "$(basename "$file")" '
    (.topTopics | map(select(.entity == "unknown"))) as $unknown |
    (.topTopics | map(select(.entity | test("^(other|person|candidate|party|actor|leader|company)$|^person-|^candidate-")))) as $placeholder |
    [
      $file,
      (.totals.rowsUsed // 0),
      (.totals.uniqueSearchTopics // 0),
      ($unknown | length),
      ($unknown | map(.marketCount) | add // 0),
      ($placeholder | length),
      (.searchPlan.estimatedCalls.dailyAfterCacheToolCalls // .searchPlan.estimatedCalls.dailyAfterCache // 0),
      ((.searchPlan.tierCounts.A // 0 | tostring) + "/" +
       (.searchPlan.tierCounts.B // 0 | tostring) + "/" +
       (.searchPlan.tierCounts.C // 0 | tostring)),
      ((.searchPlan.queryExamples // []) | map(select(.sampleMarketUpdatedAt != null and ((now - (.sampleMarketUpdatedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) > (6 * 3600)))) | length),
      ((.searchPlan.queryExamples // []) | map(select(.sampleMarketUpdatedAt != null and ((now - (.sampleMarketUpdatedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) > (24 * 3600)))) | length)
    ] | @tsv
  ' "$file"
done | sort
