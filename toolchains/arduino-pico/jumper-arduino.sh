#!/bin/sh
# arduino-cli, plus one step for RP2040 builds: after a successful `compile --output-dir DIR`, write
# DIR/<sketch>.ino.hex from DIR/<sketch>.ino.elf with `objcopy -O ihex`, so the firmware artifact is
# Intel HEX like on AVR (flash at 0x10000000, extended linear address records).
arduino-cli "$@"
code=$?
if [ "$code" -ne 0 ] || [ "$1" != "compile" ]; then exit "$code"; fi
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-dir" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] || exit 0
for elf in "$out"/*.elf; do
  [ -f "$elf" ] || continue
  arm-none-eabi-objcopy -O ihex "$elf" "${elf%.elf}.hex" || exit 1
done
exit 0
