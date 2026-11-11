#!/bin/sh
# Rebuilds the ESP32-family golden fixtures (merged 4 MB flash images, gzipped) with the pinned
# build image. Usage: build.sh [sketch ...] (default: all). Needs Docker.
#   IMAGE=jumper/arduino-esp32:3.3.12-r2 packages/sim-backends/fixtures/esp32/build.sh esp_io
set -e
D=$(cd "$(dirname "$0")" && pwd)
IMAGE=${IMAGE:-jumper/arduino-esp32:3.3.12-r2}
SKETCHES=${*:-$(cd "$D" && ls -d esp_*/ | tr -d /)}
for s in $SKETCHES; do
  for chip in esp32 esp32s3 esp32c3; do
    W=$(mktemp -d)
    cp -r "$D/$s" "$W/$s"
    cp "$D/esp_pins.h" "$W/$s/"
    docker run --rm -v "$W:/work" "$IMAGE" compile --fqbn "esp32:esp32:$chip:FlashMode=dio" \
      --output-dir "/work/out" "/work/$s" > "$W/log.txt" 2>&1 || { cat "$W/log.txt"; exit 1; }
    gzip -9 -n -c "$W/out/$s.ino.merged.bin" > "$D/$s.$chip.bin.gz"
    rm -rf "$W"
    echo "$s.$chip.bin.gz"
  done
done
