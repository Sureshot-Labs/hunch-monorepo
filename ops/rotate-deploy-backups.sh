#!/usr/bin/env bash
set -euo pipefail

# Only timestamped sibling copies of this deployment are eligible.
# Dry-run by default; deployment invokes --apply after successful startup.
APP_DIR="${1:?Usage: rotate-deploy-backups.sh APP_DIR [--apply]}"
MODE="${2:---dry-run}"
[[ "$MODE" == "--apply" || "$MODE" == "--dry-run" ]] || exit 1
[[ "$APP_DIR" == /* && -d "$APP_DIR" && ! -L "$APP_DIR" ]] || exit 1
APP_DIR="$(cd "$APP_DIR" && pwd -P)"
[[ "$APP_DIR" != "/" && "$APP_DIR" != *$'\n'* && "$APP_DIR" != *$'\t'* ]] || exit 1

shopt -s nullglob
candidates=()
for candidate in "${APP_DIR}.prev."*; do
  suffix="${candidate#"${APP_DIR}.prev."}"
  [[ "$suffix" =~ ^[0-9]+$ && -d "$candidate" && ! -L "$candidate" ]] || continue
  candidates+=("$suffix"$'\t'"$candidate")
done
(( ${#candidates[@]} > 3 )) || exit 0
sorted="$(printf '%s\n' "${candidates[@]}" | LC_ALL=C sort -nr)"
count=0
while IFS=$'\t' read -r timestamp candidate; do
  count=$((count + 1))
  (( count > 3 )) || continue
  echo "Old deploy copy: $candidate"
  if [[ "$MODE" == "--apply" ]]; then
    [[ -d "$candidate" && ! -L "$candidate" ]] || exit 1
    rm -rf -- "$candidate"
  fi
done <<< "$sorted"
