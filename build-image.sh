#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: ./build-image.sh [extra docker buildx build arguments]

Environment:
  IMAGE       Image name (default: docker.io/mixa3607/peernoise)
  TAG         Image tag (default: git describe, or dev)
  PUSH        1 to push; default 0 loads into the local Docker daemon
  PLATFORMS   Target platforms (default: linux/amd64)
  DENO_IMAGE  Base image (default: denoland/deno:2.9.6)
  SOURCE_URL  OCI source label (default: origin URL if configured)

Example: PUSH=1 TAG=latest ./build-image.sh
EOF
  exit 0
fi

: "${IMAGE:=docker.io/mixa3607/peernoise}"
: "${TAG:=$(git describe --tags --always --dirty 2>/dev/null || printf 'dev')}"
: "${PUSH:=0}"
: "${PLATFORMS:=linux/amd64}"
: "${DENO_IMAGE:=denoland/deno:2.9.6}"
: "${SOURCE_URL:=$(git config --get remote.origin.url || true)}"

if [[ "$PUSH" != 0 && "$PUSH" != 1 ]]; then
  echo 'PUSH must be 0 or 1' >&2
  exit 1
fi
if [[ "$PUSH" == 0 && "$PLATFORMS" == *,* ]]; then
  echo 'Multi-platform build requires PUSH=1 (local --load supports one platform)' >&2
  exit 1
fi

args=(
  --file Dockerfile
  --tag "${IMAGE}:${TAG}"
  --platform "$PLATFORMS"
  --build-arg "DENO_IMAGE=${DENO_IMAGE}"
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  --label "org.opencontainers.image.title=PeerNoise"
  --label "org.opencontainers.image.version=${TAG}"
  --label "org.opencontainers.image.base.name=${DENO_IMAGE}"
  --progress plain
  --pull
)
revision=$(git rev-parse HEAD 2>/dev/null || true)
if [[ -n "$revision" ]]; then
  args+=(--label "org.opencontainers.image.revision=${revision}")
fi
if [[ -n "$SOURCE_URL" ]]; then
  args+=(--label "org.opencontainers.image.source=${SOURCE_URL}")
fi
if [[ "$PUSH" == 1 ]]; then
  args+=(--push)
else
  args+=(--load)
fi

mkdir -p logs
echo "Building ${IMAGE}:${TAG}; platforms=${PLATFORMS}; push=${PUSH}"
docker buildx build "${args[@]}" "$@" . 2>&1 | tee "logs/build_$(date +%Y%m%d%H%M%S).log"
