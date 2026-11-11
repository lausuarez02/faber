#!/bin/sh
# jumper-platformio [env]   build /work/project, copy firmware.hex / firmware.elf / firmware.bin of
#                           that env (default: the first one) to /work/out
# jumper-platformio --version
export HOME=/tmp
if [ "$1" = "--version" ]; then pio --version; exit 0; fi
cp -r /work/project /tmp/project || exit 2
cd /tmp/project || exit 2
ENV_ARG=""
[ -n "$1" ] && ENV_ARG="-e $1"
# Offline: platforms and packages come from the image. A platformio.ini that names another
# platform fails here with PlatformIO's own "Unknown platform" message (mapped by Jumper).
pio run $ENV_ARG 2>&1
RC=$?
[ $RC -ne 0 ] && exit $RC
mkdir -p /work/out
ENV_DIR=$(ls -d .pio/build/*/ | head -1)
[ -n "$1" ] && ENV_DIR=".pio/build/$1/"
cp "$ENV_DIR"firmware.hex "$ENV_DIR"firmware.elf "$ENV_DIR"firmware.bin /work/out/ 2>/dev/null
pio run $ENV_ARG -t size 2>/dev/null | grep -E "^(RAM|Flash):" 
exit 0
