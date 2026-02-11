#!/usr/bin/env bash
set -euo pipefail

# Compare local Kalshi market statuses against DFlow /markets/batch statuses.
# Requires:
#   - local DB access via pnpm psql:local
#   - dflowcurl script configured with DFLOW_API_KEY
#   - jq
#
# Usage:
#   ./scripts/dflow-status-consistency.sh
#   ./scripts/dflow-status-consistency.sh --sample-size 300 --batch-size 100

SAMPLE_SIZE="${SAMPLE_SIZE:-200}"
BATCH_SIZE="${BATCH_SIZE:-100}"
ONLY_ACTIVE="${ONLY_ACTIVE:-1}"
OUT_DIR="${OUT_DIR:-/tmp}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
WORK_DIR="${OUT_DIR%/}/dflow-status-consistency-${STAMP}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sample-size)
      SAMPLE_SIZE="${2:-}"
      shift 2
      ;;
    --batch-size)
      BATCH_SIZE="${2:-}"
      shift 2
      ;;
    --only-active)
      ONLY_ACTIVE="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Compare local Kalshi statuses vs DFlow statuses for sampled tickers.

Options:
  --sample-size <n>   Number of local tickers to sample (default: 200)
  --batch-size <n>    DFlow batch request size (default: 100)
  --only-active <0|1> Sample only local ACTIVE rows (default: 1)
  --out-dir <path>    Output directory root (default: /tmp)
EOF
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
LOCAL_TSV="${WORK_DIR}/local.tsv"
LOCAL_JSON="${WORK_DIR}/local.json"
REMOTE_JSON="${WORK_DIR}/remote.jsonl"
REMOTE_MERGED_JSON="${WORK_DIR}/remote-merged.json"
REPORT_JSON="${WORK_DIR}/status-diff.json"
REPORT_TSV="${WORK_DIR}/status-diff.tsv"

WHERE_CLAUSE="m.venue = 'kalshi' and m.venue_market_id is not null"
if [[ "$ONLY_ACTIVE" == "1" ]]; then
  WHERE_CLAUSE="${WHERE_CLAUSE} and m.status = 'ACTIVE'"
fi

pnpm -C "$REPO_DIR" psql:local -- -At -F $'\t' -c "
  select m.venue_market_id, m.status, coalesce(to_char(m.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '')
  from unified_markets m
  where ${WHERE_CLAUSE}
  order by m.updated_at asc nulls first
  limit ${SAMPLE_SIZE};
" > "$LOCAL_TSV"

if [[ ! -s "$LOCAL_TSV" ]]; then
  echo "No local rows selected. Nothing to compare."
  exit 0
fi

jq -Rn '
  [inputs
    | split("\t")
    | {ticker: .[0], local_status: .[1], local_updated_at: (if .[2] == "" then null else .[2] end)}
  ]' "$LOCAL_TSV" > "$LOCAL_JSON"

TICKERS=()
while IFS= read -r ticker; do
  [[ -n "$ticker" ]] || continue
  TICKERS+=("$ticker")
done < <(jq -r '.[].ticker' "$LOCAL_JSON")

batch=()
batch_index=0
for ticker in "${TICKERS[@]}"; do
  batch+=("$ticker")
  if [[ "${#batch[@]}" -ge "$BATCH_SIZE" ]]; then
    batch_index=$((batch_index + 1))
    jq -n --argjson tickers "$(printf '%s\n' "${batch[@]}" | jq -R . | jq -s .)" '{tickers:$tickers}' > "${WORK_DIR}/body-${batch_index}.json"
    raw="$(pnpm -C "$REPO_DIR/apps/api" dflowcurl /api/v1/markets/batch --method POST --body @"${WORK_DIR}/body-${batch_index}.json")"
    json="$(printf '%s\n' "$raw" | sed -n '/^{/,$p')"
    printf '%s\n' "$json" >> "$REMOTE_JSON"
    batch=()
  fi
done

if [[ "${#batch[@]}" -gt 0 ]]; then
  batch_index=$((batch_index + 1))
  jq -n --argjson tickers "$(printf '%s\n' "${batch[@]}" | jq -R . | jq -s .)" '{tickers:$tickers}' > "${WORK_DIR}/body-${batch_index}.json"
  raw="$(pnpm -C "$REPO_DIR/apps/api" dflowcurl /api/v1/markets/batch --method POST --body @"${WORK_DIR}/body-${batch_index}.json")"
  json="$(printf '%s\n' "$raw" | sed -n '/^{/,$p')"
  printf '%s\n' "$json" >> "$REMOTE_JSON"
fi

jq -s '
  [.[].payload.markets[]?]
' "$REMOTE_JSON" > "$REMOTE_MERGED_JSON"

jq -n \
  --slurpfile local "$LOCAL_JSON" \
  --slurpfile remote "$REMOTE_MERGED_JSON" '
  def map_remote_status:
    ( . // "" | ascii_downcase ) as $s
    | if ($s == "archived") then "ARCHIVED"
      elif ($s == "finalized" or $s == "finalised" or $s == "determined" or $s == "settled" or $s == "resolved") then "SETTLED"
      elif ($s == "closed" or $s == "expired" or $s == "halted" or $s == "suspended" or $s == "inactive" or $s == "paused" or $s == "cancelled" or $s == "canceled" or $s == "void") then "CLOSED"
      else "ACTIVE"
      end;

  (($remote[0] // []) | map({key: .ticker, value: {remote_raw_status: .status, remote_status: (.status | map_remote_status)}}) | from_entries) as $rmap
  | (($local[0] // [])
      | map(select(.ticker != null and .ticker != ""))
      | map(. + ($rmap[.ticker] // {remote_raw_status: null, remote_status: null}))
      | map(. + {status_mismatch: (.remote_status != null and .local_status != .remote_status)})
    ) as $joined
  | {
      totals: {
        sampled: ($joined | length),
        remote_found: ($joined | map(select(.remote_status != null)) | length),
        mismatches: ($joined | map(select(.status_mismatch == true)) | length)
      },
      mismatches: ($joined | map(select(.status_mismatch == true))),
      all: $joined
    }
' > "$REPORT_JSON"

jq -r '
  ["ticker","local_status","remote_status","remote_raw_status","local_updated_at"],
  (.mismatches[] | [.ticker, .local_status, .remote_status, (.remote_raw_status // ""), (.local_updated_at // "")])
  | @tsv
' "$REPORT_JSON" > "$REPORT_TSV"

echo "Output directory: $WORK_DIR"
echo "Summary:"
jq '.totals' "$REPORT_JSON"

echo
echo "Mismatch sample:"
head -n 21 "$REPORT_TSV" || true
