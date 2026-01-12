#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="$(basename "${ROOT_DIR}")"
PARENT_DIR="$(dirname "${ROOT_DIR}")"

REMOTE_HOST="${REMOTE_HOST:-ubuntu@13.48.86.72}"
APP_DIR="${APP_DIR:-/home/ubuntu/hunch-monorepo}"
ENV_FILE="${ENV_FILE:-/opt/hunch/.env}"
REMOTE_ARCHIVE_DIR="${REMOTE_ARCHIVE_DIR:-/tmp}"

ARCHIVE_NAME="${REPO_NAME}-$(date +%Y%m%d%H%M%S).tar.gz"
ARCHIVE_PATH="${ARCHIVE_PATH:-/tmp/${ARCHIVE_NAME}}"
REMOTE_ARCHIVE="${REMOTE_ARCHIVE_DIR}/${ARCHIVE_NAME}"
REMOTE_SCRIPT="${REMOTE_ARCHIVE_DIR}/hunch-deploy-ec2.sh"
GIT_REF="${GIT_REF:-HEAD}"

cleanup() {
  rm -f "${ARCHIVE_PATH}"
}
trap cleanup EXIT

if ! git -C "${ROOT_DIR}" diff --quiet || ! git -C "${ROOT_DIR}" diff --cached --quiet; then
  echo "Warning: working tree has uncommitted changes; git archive will ignore them." >&2
fi

echo "Creating archive ${ARCHIVE_PATH} from git ref ${GIT_REF}"
git -C "${ROOT_DIR}" archive --format=tar.gz --output "${ARCHIVE_PATH}" "${GIT_REF}"

echo "Uploading ${ARCHIVE_NAME} to ${REMOTE_HOST}:${REMOTE_ARCHIVE}"
scp "${ARCHIVE_PATH}" "${REMOTE_HOST}:${REMOTE_ARCHIVE}"

echo "Uploading deploy script to ${REMOTE_HOST}:${REMOTE_SCRIPT}"
scp "${ROOT_DIR}/ops/deploy-ec2.sh" "${REMOTE_HOST}:${REMOTE_SCRIPT}"

echo "Running remote deploy"
ssh "${REMOTE_HOST}" \
  "chmod +x '${REMOTE_SCRIPT}' && ARCHIVE='${REMOTE_ARCHIVE}' APP_DIR='${APP_DIR}' ENV_FILE='${ENV_FILE}' '${REMOTE_SCRIPT}'"

echo "Cleaning up remote archive"
ssh "${REMOTE_HOST}" "rm -f '${REMOTE_ARCHIVE}' '${REMOTE_SCRIPT}'"

echo "Deploy complete."
