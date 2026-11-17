#!/usr/bin/env bash
# Build every part example sketch (packages/parts/src/parts/<id>/example*.ino) with the pinned
# toolchain image and write the golden .hex next to it (<name>.hex). The part tests run them.
#
#   toolchains/arduino/build-part-examples.sh            # all parts
#   toolchains/arduino/build-part-examples.sh ssd1306-oled-i2c bme280
#
# arduino-cli wants <dir>/<dir>.ino, so each sketch is copied to toolchains/arduino/.cache first.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export FABER_ARDUINO_IMAGE="${FABER_ARDUINO_IMAGE:-faber/arduino-cli:1.5.1-avr1.8.8-libs3}"
FQBN="${FABER_FQBN:-arduino:avr:uno}"
CACHE="$REPO/toolchains/arduino/.cache/sketches"
PARTS=("$@")
if [[ ${#PARTS[@]} -eq 0 ]]; then
  PARTS=()
  for d in "$REPO"/packages/parts/src/parts/*/; do
    compgen -G "$d/example*.ino" >/dev/null && PARTS+=("$(basename "$d")")
  done
fi
for part in "${PARTS[@]}"; do
  dir="$REPO/packages/parts/src/parts/$part"
  for ino in "$dir"/example*.ino; do
    [[ -f "$ino" ]] || { echo "no example*.ino in $dir" >&2; exit 1; }
    name="$(basename "$ino" .ino)"
    sk="$CACHE/${part}--${name}"
    rm -rf "$sk" && mkdir -p "$sk"
    cp "$ino" "$sk/${part}--${name}.ino"
    "$REPO/scripts/build-firmware.sh" "$sk" "$FQBN" "$sk/build" >/dev/null
    cp "$sk/build/${part}--${name}.ino.hex" "$dir/${name}.hex"
    echo "built packages/parts/src/parts/$part/${name}.hex ($(wc -c <"$dir/${name}.hex") bytes)"
  done
done
