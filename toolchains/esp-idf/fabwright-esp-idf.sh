#!/bin/bash
# jumper-esp-idf <target> <flash MB>   build /work/project, write /work/out/merged.bin
# jumper-esp-idf --version
set -o pipefail
export HOME=/tmp
PYENV=$(ls -d "$IDF_TOOLS_PATH"/python_env/idf5.5_py*_env | head -1)
export IDF_PYTHON_ENV_PATH="$PYENV"
export PATH="$PYENV/bin:$IDF_PATH/tools:$PATH"
if [ "$1" = "--version" ]; then
  python "$IDF_PATH/tools/idf.py" --version
  xtensa-esp32-elf-gcc --version | head -1
  exit 0
fi
TARGET="${1:?target}"
FLASH_MB="${2:-4}"
mkdir -p /work/out
cp -r /work/project /tmp/project
cd /tmp/project || exit 2
# QEMU boots DIO flash; the person's sdkconfig.defaults can override anything else.
printf 'CONFIG_ESPTOOLPY_FLASHMODE_DIO=y\nCONFIG_ESPTOOLPY_FLASHSIZE_%sMB=y\n' "$FLASH_MB" > /tmp/sdkconfig.jumper
DEFAULTS="/tmp/sdkconfig.jumper"
[ -f sdkconfig.defaults ] && DEFAULTS="sdkconfig.defaults;/tmp/sdkconfig.jumper"
python "$IDF_PATH/tools/idf.py" -B /tmp/build -DIDF_TARGET="$TARGET" -DSDKCONFIG=/tmp/build/sdkconfig "-DSDKCONFIG_DEFAULTS=$DEFAULTS" build 2>&1
RC=$?
if [ $RC -ne 0 ]; then exit $RC; fi
cd /tmp/build || exit 2
python -m esptool --chip "$TARGET" merge_bin --fill-flash-size "${FLASH_MB}MB" -o /work/out/merged.bin @flash_args 2>&1 || exit 3
cp /tmp/build/*.elf /work/out/ 2>/dev/null
python "$IDF_PATH/tools/idf_size.py" /tmp/build/*.map 2>/dev/null | tail -12
exit 0
