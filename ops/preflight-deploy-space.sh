#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--remote" ]]; then
  shift
  upload_bytes="$1"; repo_bytes="$2"; image_bytes="$3"
  archive_dir="$4"; app_dir="$5"
  docker_dir="$(docker info --format '{{.DockerRootDir}}')"
  [[ "$docker_dir" == /* ]] || { echo "Cannot determine Docker storage directory" >&2; exit 1; }
  # Group allocations by filesystem: /tmp, checkout and Docker may share a disk.
  devices=(); available=(); locations=()
  paths=("$archive_dir" /tmp "$(dirname "$app_dir")" "$docker_dir")
  sizes=("$upload_bytes" "$repo_bytes" "$repo_bytes" "$((image_bytes * 2))")
  for i in 0 1 2 3; do
    path="${paths[$i]}"
    [[ "$path" == /* ]] || exit 1
    while [[ ! -d "$path" ]]; do path="$(dirname "$path")"; done
    device="$(stat -c %d -- "$path")"
    free_kb="$(df -Pk -- "$path" | awk 'END {print $4}')"
    [[ "$free_kb" =~ ^[0-9]+$ ]] || exit 1
    devices[$i]="$device"
    available[$i]=$((free_kb * 1024))
    locations[$i]="$path"
  done
  failed=0
  for i in 0 1 2 3; do
    seen=0
    for ((j=0; j<i; j++)); do
      if [[ "${devices[$j]}" == "${devices[$i]}" ]]; then seen=1; fi
    done
    (( seen == 0 )) || continue
    total=0
    for j in 0 1 2 3; do
      if [[ "${devices[$j]}" == "${devices[$i]}" ]]; then
        total=$((total + ${sizes[$j]}))
      fi
    done
    # Modest headroom for metadata and concurrent writes, not a disk-% gate.
    need=$((total + 512 * 1024 * 1024))
    echo "Deploy disk preflight: ${locations[$i]} needs estimated $need bytes; available ${available[$i]} bytes"
    if (( ${available[$i]} < need )); then
      echo "Insufficient space for deploy artifacts and unpacking; nothing uploaded or stopped." >&2
      failed=1
    fi
  done
  exit "$failed"
fi

remote_host="${1:?REMOTE_HOST required}"
archive_dir="${2:?REMOTE_ARCHIVE_DIR required}"
app_dir="${3:?APP_DIR required}"
repo_archive="${4:?repo archive required}"
image_archive="${5:?image archive required}"
upload_bytes=$(( $(wc -c < "$repo_archive") + $(wc -c < "$image_archive") ))
# Stream-count gzip output: unlike gzip -l this also works beyond 4 GiB.
repo_bytes="$(gzip -dc -- "$repo_archive" | wc -c)"
image_bytes="$(gzip -dc -- "$image_archive" | wc -c)"
printf -v remote_command 'bash -s -- --remote %q %q %q %q %q' \
  "$upload_bytes" "$repo_bytes" "$image_bytes" "$archive_dir" "$app_dir"
ssh "$remote_host" "$remote_command" < "${BASH_SOURCE[0]}"
