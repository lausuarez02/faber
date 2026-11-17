#!/bin/sh
# arduino-cli, plus one step for Seeed nRF52 builds: after a successful `compile --output-dir DIR`,
# write DIR/<sketch>.ino.sim.hex (MBR + SoftDevice + app, what Fabwright's simulator boots) and
# DIR/<sketch>.ino.uf2 (the app, for the board's UF2 bootloader).
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
python3 /usr/local/bin/fabwright-sim-hex.py "$out" || exit 1
exit 0
