#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="$(basename "${ROOT_DIR}")"

REMOTE_HOST="${REMOTE_HOST:-ubuntu@13.51.155.185}"
APP_DIR="${APP_DIR:-/home/ubuntu/hunch-monorepo}"
ENV_FILE="${ENV_FILE:-/opt/hunch/.env}"
REMOTE_ARCHIVE_DIR="${REMOTE_ARCHIVE_DIR:-/tmp}"
PLATFORM="${PLATFORM:-linux/arm64}"
GIT_REF="${GIT_REF:-HEAD}"

GIT_SHA="${GIT_SHA:-$(git -C "${ROOT_DIR}" rev-parse --short "${GIT_REF}")}" 
HUNCH_BACKEND_IMAGE="${HUNCH_BACKEND_IMAGE:-hunch-backend:${GIT_SHA}}"

ARCHIVE_NAME="${REPO_NAME}-$(date +%Y%m%d%H%M%S).tar.gz"
ARCHIVE_PATH="${ARCHIVE_PATH:-/tmp/${ARCHIVE_NAME}}"
REMOTE_ARCHIVE="${REMOTE_ARCHIVE_DIR}/${ARCHIVE_NAME}"
REMOTE_SCRIPT="${REMOTE_ARCHIVE_DIR}/hunch-deploy-ec2-prebuilt.sh"

IMAGE_ARCHIVE_NAME="hunch-backend-image-${GIT_SHA}.tar.gz"
IMAGE_ARCHIVE_PATH="${IMAGE_ARCHIVE_PATH:-/tmp/${IMAGE_ARCHIVE_NAME}}"
REMOTE_IMAGE_ARCHIVE="${REMOTE_ARCHIVE_DIR}/${IMAGE_ARCHIVE_NAME}"

cleanup() {
  rm -f "${ARCHIVE_PATH}" "${IMAGE_ARCHIVE_PATH}"
}
trap cleanup EXIT

if ! git -C "${ROOT_DIR}" diff --quiet || ! git -C "${ROOT_DIR}" diff --cached --quiet; then
  echo "Warning: working tree has uncommitted changes; git archive will ignore them." >&2
fi

echo "Building ${HUNCH_BACKEND_IMAGE} for ${PLATFORM}"
docker buildx build --platform "${PLATFORM}" \
  -f "${ROOT_DIR}/ops/Dockerfile.app" \
  -t "${HUNCH_BACKEND_IMAGE}" \
  --load \
  "${ROOT_DIR}"

echo "Saving image to ${IMAGE_ARCHIVE_PATH}"
docker save "${HUNCH_BACKEND_IMAGE}" | gzip > "${IMAGE_ARCHIVE_PATH}"

echo "Creating repo archive ${ARCHIVE_PATH} from git ref ${GIT_REF}"
git -C "${ROOT_DIR}" archive --format=tar.gz --output "${ARCHIVE_PATH}" "${GIT_REF}"

echo "Uploading repo archive to ${REMOTE_HOST}:${REMOTE_ARCHIVE}"
scp "${ARCHIVE_PATH}" "${REMOTE_HOST}:${REMOTE_ARCHIVE}"

echo "Uploading image archive to ${REMOTE_HOST}:${REMOTE_IMAGE_ARCHIVE}"
scp "${IMAGE_ARCHIVE_PATH}" "${REMOTE_HOST}:${REMOTE_IMAGE_ARCHIVE}"

echo "Uploading deploy script to ${REMOTE_HOST}:${REMOTE_SCRIPT}"
scp "${ROOT_DIR}/ops/deploy-ec2-prebuilt.sh" "${REMOTE_HOST}:${REMOTE_SCRIPT}"

echo "Running remote deploy"
ssh "${REMOTE_HOST}" \
  "chmod +x '${REMOTE_SCRIPT}' && ARCHIVE='${REMOTE_ARCHIVE}' IMAGE_ARCHIVE='${REMOTE_IMAGE_ARCHIVE}' HUNCH_BACKEND_IMAGE='${HUNCH_BACKEND_IMAGE}' APP_DIR='${APP_DIR}' ENV_FILE='${ENV_FILE}' '${REMOTE_SCRIPT}'"

echo "Cleaning up remote archives"
if ! ssh "${REMOTE_HOST}" "rm -f '${REMOTE_ARCHIVE}' '${REMOTE_IMAGE_ARCHIVE}' '${REMOTE_SCRIPT}'"; then
  echo "Warning: remote archive cleanup failed; deploy already completed." >&2
fi

# Optional local cleanup (remove the image we just built).
if [[ "${LOCAL_IMAGE_CLEANUP:-1}" == "1" ]]; then
  docker image rm "${HUNCH_BACKEND_IMAGE}" >/dev/null 2>&1 || true
fi
if [[ "${LOCAL_BUILDER_PRUNE:-0}" == "1" ]]; then
  docker builder prune -f >/dev/null 2>&1 || true
fi

echo "Deploy complete."
