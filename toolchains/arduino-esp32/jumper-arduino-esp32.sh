#!/bin/sh
# Thin wrapper around arduino-cli for ESP32 builds. Any arguments go to arduino-cli unchanged.
# After a successful `compile ... --output-dir DIR`, makes sure DIR/<sketch>.ino.merged.bin exists
# (arduino-esp32 3.x writes it itself; older cores need esptool merge-bin) and pads it to the
# flash size so QEMU accepts it (2, 4, 8 or 16 MB).
set -e
arduino-cli "$@"
[ "$1" = "compile" ] || exit 0
OUT=""; prev=""
for a in "$@"; do
  [ "$prev" = "--output-dir" ] && OUT="$a"
  case "$a" in --output-dir=*) OUT="${a#--output-dir=}";; esac
  prev="$a"
done
[ -n "$OUT" ] || exit 0
APP=$(ls "$OUT"/*.ino.bin 2>/dev/null | head -1)
[ -n "$APP" ] || exit 0
MERGED="${APP%.bin}.merged.bin"
if [ ! -f "$MERGED" ]; then
  ESPTOOL=$(ls -d /opt/arduino/data/packages/esp32/tools/esptool_py/*/esptool 2>/dev/null | head -1)
  "$ESPTOOL" --chip auto merge-bin -o "$MERGED" --pad-to-size 4MB \
    0x1000 "${APP%.bin}.bootloader.bin" 0x8000 "${APP%.bin}.partitions.bin" 0x10000 "$APP"
fi
SIZE=$(stat -c %s "$MERGED")
if [ "$SIZE" -lt 4194304 ]; then truncate -s 4M "$MERGED"; fi
echo "jumper: flash image $(basename "$MERGED") $(stat -c %s "$MERGED") bytes"
