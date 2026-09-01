#!/usr/bin/env bash
set -euo pipefail

KEEP=5
APPLY=0
TARGET_DIR="/home/ubuntu"

usage() {
  cat <<'EOF'
Usage: cleanup-backups.sh [--apply] [--keep N] [--dir /path]

Removes old deploy backup directories matching:
  hunch-monorepo.prev.*
  hunch-app.prev.*

Defaults:
  --keep 5        Keep the most recent 5 backups per pattern.
  --dir /home/ubuntu
  (dry-run unless --apply is passed)

Examples:
  ./cleanup-backups.sh
  ./cleanup-backups.sh --keep 10
  ./cleanup-backups.sh --apply --keep 5
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      ;;
    --keep)
      KEEP="${2:-}"
      shift
      ;;
    --dir)
      TARGET_DIR="${2:-}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -z "${KEEP}" || ! "${KEEP}" =~ ^[0-9]+$ ]]; then
  echo "--keep must be a non-negative integer" >&2
  exit 1
fi

if [[ ! -d "${TARGET_DIR}" ]]; then
  echo "Target dir does not exist: ${TARGET_DIR}" >&2
  exit 1
fi

if [[ "${TARGET_DIR}" != /* ]]; then
  echo "--dir must be an absolute path" >&2
  exit 1
fi

TARGET_DIR="$(cd -- "${TARGET_DIR}" && pwd -P)"
if [[ "${TARGET_DIR}" == "/" ]]; then
  echo "Refusing to use the filesystem root as the backup directory" >&2
  exit 1
fi

patterns=("hunch-monorepo.prev." "hunch-app.prev.")

for prefix in "${patterns[@]}"; do
  dirs=()
  while IFS= read -r backup_dir; do
    backup_name="${backup_dir##*/}"
    if [[ "${backup_name}" =~ ^${prefix//./\\.}[0-9]+$ ]]; then
      dirs+=("${backup_dir}")
    fi
  done < <(
    find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 -type d \
      -name "${prefix}[0-9]*" -print \
      | sort -r
  )

  if [[ ${#dirs[@]} -le ${KEEP} ]]; then
    continue
  fi
  remove_count=$(( ${#dirs[@]} - KEEP ))
  echo "Found ${#dirs[@]} backups for ${prefix}*; would remove ${remove_count} (keeping ${KEEP})."
  for d in "${dirs[@]:${KEEP}}"; do
    if [[ ${APPLY} -eq 1 ]]; then
      rm -rf -- "${d}"
      echo "Removed ${d}"
    else
      echo "Would remove ${d}"
    fi
  done
done

if [[ ${APPLY} -eq 0 ]]; then
  echo "Dry-run complete. Re-run with --apply to delete."
fi
