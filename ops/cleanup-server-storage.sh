#!/usr/bin/env bash
set -euo pipefail

APPLY=0
BACKUP_DIR="/home/ubuntu"
KEEP_BACKUPS=2
TMP_DIR="/tmp"
ARCHIVE_MIN_AGE_HOURS=24
DOCKER_UNTIL="3h"
SKIP_DOCKER=0

usage() {
  cat <<'EOF'
Usage: cleanup-server-storage.sh [options]

Safely cleans deploy artifacts on a production host:
  - old hunch-monorepo.prev.* and hunch-app.prev.* directories;
  - stale backend/frontend deploy archives in /tmp;
  - Docker images not referenced by any container.

The default mode is a dry-run. Pass --apply to delete.

Options:
  --apply                    Perform the cleanup.
  --keep-backups N           Keep the newest N backups per app (default: 2).
  --backup-dir PATH          Backup parent directory (default: /home/ubuntu).
  --tmp-dir PATH             Deploy archive directory (default: /tmp).
  --archive-min-age-hours N  Only remove archives older than N hours (default: 24).
  --docker-until DURATION    Docker prune age filter (default: 3h).
  --skip-docker              Do not inspect or prune Docker images.
  -h, --help                 Show this help.

Examples:
  ./ops/cleanup-server-storage.sh
  ./ops/cleanup-server-storage.sh --apply
  ./ops/cleanup-server-storage.sh --apply --docker-until 24h
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      ;;
    --keep-backups)
      KEEP_BACKUPS="${2:-}"
      shift
      ;;
    --backup-dir)
      BACKUP_DIR="${2:-}"
      shift
      ;;
    --tmp-dir)
      TMP_DIR="${2:-}"
      shift
      ;;
    --archive-min-age-hours)
      ARCHIVE_MIN_AGE_HOURS="${2:-}"
      shift
      ;;
    --docker-until)
      DOCKER_UNTIL="${2:-}"
      shift
      ;;
    --skip-docker)
      SKIP_DOCKER=1
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

if [[ ! "${KEEP_BACKUPS}" =~ ^[0-9]+$ ]]; then
  echo "--keep-backups must be a non-negative integer" >&2
  exit 1
fi

if [[ ! "${ARCHIVE_MIN_AGE_HOURS}" =~ ^[0-9]+$ ]]; then
  echo "--archive-min-age-hours must be a non-negative integer" >&2
  exit 1
fi

canonicalize_cleanup_dir() {
  local target_dir="$1"

  if [[ "${target_dir}" != /* || ! -d "${target_dir}" ]]; then
    echo "Cleanup directory must be an existing absolute non-root path: ${target_dir}" >&2
    exit 1
  fi

  target_dir="$(cd -- "${target_dir}" && pwd -P)"
  if [[ "${target_dir}" == "/" ]]; then
    echo "Refusing to use the filesystem root as a cleanup directory" >&2
    exit 1
  fi

  printf '%s\n' "${target_dir}"
}

BACKUP_DIR="$(canonicalize_cleanup_dir "${BACKUP_DIR}")"
TMP_DIR="$(canonicalize_cleanup_dir "${TMP_DIR}")"

if [[ ${SKIP_DOCKER} -eq 0 ]] && ! command -v docker >/dev/null 2>&1; then
  echo "docker is required unless --skip-docker is passed" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_CLEANER="${SCRIPT_DIR}/cleanup-backups.sh"

if [[ ! -f "${BACKUP_CLEANER}" ]]; then
  echo "Backup cleaner not found: ${BACKUP_CLEANER}" >&2
  exit 1
fi

backup_args=(--keep "${KEEP_BACKUPS}" --dir "${BACKUP_DIR}")
if [[ ${APPLY} -eq 1 ]]; then
  backup_args=(--apply "${backup_args[@]}")
fi

echo "Deploy backup cleanup"
bash "${BACKUP_CLEANER}" "${backup_args[@]}"

archive_min_age_minutes=$((ARCHIVE_MIN_AGE_HOURS * 60))
archive_targets=()
while IFS= read -r -d '' archive_path; do
  archive_targets+=("${archive_path}")
done < <(
  find "${TMP_DIR}" -mindepth 1 -maxdepth 1 -type f \
    \( \
      -name 'hunch-monorepo-*.tar.gz' \
      -o -name 'Hunch_App-*.tar.gz' \
      -o -name 'hunch-app-*.tar.gz' \
      -o -name 'hunch-backend-image-*.tar.gz' \
      -o -name 'hunch-web-image-*.tar.gz' \
    \) \
    -mmin "+${archive_min_age_minutes}" \
    -print0
)

echo "Stale deploy archives: ${#archive_targets[@]} (older than ${ARCHIVE_MIN_AGE_HOURS}h)"
for archive_path in "${archive_targets[@]}"; do
  if [[ ${APPLY} -eq 1 ]]; then
    rm -f -- "${archive_path}"
    echo "Removed ${archive_path}"
  else
    echo "Would remove ${archive_path}"
  fi
done

if [[ ${SKIP_DOCKER} -eq 0 ]]; then
  echo "Docker image usage before cleanup"
  docker system df
  if [[ ${APPLY} -eq 1 ]]; then
    docker image prune -af --filter "until=${DOCKER_UNTIL}"
  else
    echo "Would prune Docker images unused by any container and older than ${DOCKER_UNTIL}."
  fi
fi

if [[ ${APPLY} -eq 0 ]]; then
  echo "Dry-run complete. Re-run with --apply to delete."
fi

df -h "${BACKUP_DIR}"
