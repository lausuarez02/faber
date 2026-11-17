#!/usr/bin/env bash
# Build an Arduino sketch with the pinned Faber toolchain image (toolchains/arduino/Dockerfile).
#
#   scripts/build-firmware.sh <sketchDir> <fqbn> <outDir>
#   scripts/build-firmware.sh examples/blink/firmware/blink arduino:avr:uno examples/blink/firmware/build
#
# The image is built on first use (native arch: arm64 on Apple Silicon, amd64 elsewhere).
# Outputs <sketch>.ino.hex (+ .elf etc.) into <outDir>. Paths must be inside the repo.
# Env: FABER_ARDUINO_IMAGE overrides the image tag; FABER_DOCKER_PLATFORM forces e.g. linux/amd64.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <sketchDir> <fqbn> <outDir>" >&2
  exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${FABER_ARDUINO_IMAGE:-faber/arduino-cli:1.5.1-avr1.8.8-libs3}"
PLATFORM_ARGS=()
if [[ -n "${FABER_DOCKER_PLATFORM:-}" ]]; then PLATFORM_ARGS=(--platform "$FABER_DOCKER_PLATFORM"); fi

abs() { (cd "$1" && pwd); }
SKETCH="$(abs "$1")"
FQBN="$2"
mkdir -p "$3"
OUT="$(abs "$3")"

case "$SKETCH/" in "$REPO"/*) ;; *) echo "sketchDir must be inside $REPO" >&2; exit 2 ;; esac
case "$OUT/" in "$REPO"/*) ;; *) echo "outDir must be inside $REPO" >&2; exit 2 ;; esac

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop (or install arduino-cli 1.5.1 + arduino:avr@1.8.8 locally)." >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building toolchain image $IMAGE ..." >&2
  docker build ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} -t "$IMAGE" "$REPO/toolchains/arduino"
fi

REL_SKETCH="${SKETCH#"$REPO"/}"
REL_OUT="${OUT#"$REPO"/}"

docker run --rm ${PLATFORM_ARGS[@]+"${PLATFORM_ARGS[@]}"} \
  --user "$(id -u):$(id -g)" \
  -v "$REPO":/work -w /work \
  "$IMAGE" compile --fqbn "$FQBN" --output-dir "/work/$REL_OUT" --warnings default "/work/$REL_SKETCH"

echo "built: $REL_OUT" >&2
ls -l "$OUT" >&2
