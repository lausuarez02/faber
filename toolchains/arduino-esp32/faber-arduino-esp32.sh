#!/bin/sh
# Thin wrapper around arduino-cli for ESP32 builds. Any arguments go to arduino-cli unchanged,
# except for `compile` in a simulation build (the default, FABER_SIM=1):
#   - -DFABER_SIM=1 is defined for the sketch (and -DJUMPER_SIM=1, its name before the rename).
#   - When the sketch uses the network (WiFi.h, HTTPClient, NetworkClientSecure, WebSockets, MQTT
#     libraries, esp_wifi.h, ...), the FaberSim library is linked in and the Wi-Fi driver and
#     mbedTLS chain verification are wrapped (-Wl,--wrap=...), so the unmodified sketch joins Faber's
#     sandbox Wi-Fi over the emulated Ethernet card and trusts the sandbox CA. The sketch folder is
#     copied first (the shim adds one file); the person's files are never touched.
#   - When the sketch uses Espressif's esp32-camera driver (esp_camera.h), the FaberCamera library is
#     linked in and the driver's API is wrapped (esp_camera_init, esp_camera_fb_get, ...), so frames
#     come from Faber's camera port in the emulator (QEMU patch 0004). Round 13.
#   - When the sketch deep-sleeps (calls esp_deep_sleep / esp_deep_sleep_start), the FaberSleep library
#     is linked in and the sleep API is wrapped, so Faber wakes the board on its timer or wake pins
#     and RTC memory, the clock and the wake cause survive. Round 15.
#   The sketch must be the last argument (as Faber's runner passes it).
# FABER_SIM=0 builds for the real device: plain arduino-cli, no shim, no define.
#
# After a successful `compile ... --output-dir DIR`, makes sure DIR/<sketch>.ino.merged.bin exists
# (arduino-esp32 3.x writes it itself; older cores need esptool merge-bin) and pads it to the
# flash size so QEMU accepts it (2, 4, 8 or 16 MB).
set -e
SIMLIB=/opt/arduino/user/libraries/FaberSim
CAMLIB=/opt/arduino/user/libraries/FaberCamera
SLPLIB=/opt/arduino/user/libraries/FaberSleep
CAMERA_INCLUDES='esp_camera|esp_camera_af'
NETWORK_INCLUDES='WiFi|WiFiMulti|WiFiClient|WiFiClientSecure|WiFiUdp|WiFiServer|WiFiGeneric|NetworkClientSecure|NetworkClient|Network|HTTPClient|HTTPUpdate|WebServer|WebSocketsClient|WebSockets|WebSocketsServer|ArduinoWebsockets|PubSubClient|MQTT|MQTTClient|ArduinoMqttClient|AsyncMqttClient|ESPmDNS|AsyncUDP|esp_wifi|esp_http_client|esp_websocket_client|mqtt_client'

if [ "$1" = "compile" ] && [ "${FABER_SIM:-1}" != "0" ]; then
  n=$#
  i=0
  SKETCH=""
  for a do
    i=$((i + 1))
    shift
    if [ "$i" -eq "$n" ] && [ -e "$a" ]; then SKETCH="$a"; continue; fi
    set -- "$@" "$a"
  done
  DIR="$SKETCH"
  [ -f "$DIR" ] && DIR=$(dirname "$DIR")
  uses() { [ -n "$DIR" ] && grep -rqsE "#[[:space:]]*include[[:space:]]*[<\"]($1)\.h[>\"]" "$DIR" --include='*.ino' --include='*.cpp' --include='*.c' --include='*.h' --include='*.hpp'; }
  NET=0; CAM=0; SLP=0
  uses "$NETWORK_INCLUDES" && NET=1
  uses "$CAMERA_INCLUDES" && CAM=1
  [ -n "$DIR" ] && grep -rqsE "esp_deep_sleep(_start|_try_to_start)?[[:space:]]*\(" "$DIR" --include='*.ino' --include='*.cpp' --include='*.c' --include='*.h' --include='*.hpp' && SLP=1
  DEFINES="-DFABER_SIM=1 -DJUMPER_SIM=1" # JUMPER_SIM: the name sketches written before the rename test
  case "$*" in *PSRAM=opi*|*PSRAM=enabled*) DEFINES="$DEFINES -DBOARD_HAS_PSRAM"; [ "$CAM" = 1 ] && DEFINES="$DEFINES -DFABER_SIM_PSRAM_FALLBACK=1";; esac
  if [ "$NET" = 1 ] || [ "$CAM" = 1 ] || [ "$SLP" = 1 ]; then
    COPY="$(mktemp -d /tmp/jsim.XXXXXX)/$(basename "$DIR")"
    cp -R "$DIR" "$COPY"
    WRAPS=""
    if [ "$NET" = 1 ]; then
      printf '// Added by Faber for the simulation build only (not in your project).\n#include <FaberSim.h>\n' > "$COPY/zz_faber_sim_shim.cpp"
      WRAPS="$WRAPS $(grep -ho '__wrap_[A-Za-z0-9_]*' "$SIMLIB"/src/*.c | sort -u | sed 's/^__wrap_/-Wl,--wrap=/' | tr '\n' ' ')"
      echo "faber: simulation build, Wi-Fi shim on (WiFi.begin() joins the Faber sandbox network over the emulated Ethernet card)"
    fi
    if [ "$CAM" = 1 ]; then
      printf '// Added by Faber for the simulation build only (not in your project).\n#include <FaberCamera.h>\n' > "$COPY/zz_faber_camera_shim.cpp"
      WRAPS="$WRAPS $(grep -ho '__wrap_[A-Za-z0-9_]*' "$CAMLIB"/src/*.c | sort -u | sed 's/^__wrap_/-Wl,--wrap=/' | tr '\n' ' ')"
      echo "faber: simulation build, camera shim on (esp_camera_fb_get() gets frames from Faber; the device build uses the real esp32-camera driver)"
    fi
    if [ "$SLP" = 1 ]; then
      printf '// Added by Faber for the simulation build only (not in your project).\n#include <FaberSleep.h>\n' > "$COPY/zz_faber_sleep_shim.cpp"
      WRAPS="$WRAPS $(grep -ho '__wrap_[A-Za-z0-9_]*' "$SLPLIB"/src/*.c | sort -u | sed 's/^__wrap_/-Wl,--wrap=/' | tr '\n' ' ')"
      echo "faber: simulation build, deep-sleep shim on (Faber wakes the board on its timer or wake pins)"
    fi
    set -- "$@" --build-property "build.defines=${DEFINES}" --build-property "compiler.c.elf.extra_flags=${WRAPS}" "$COPY"
  else
    set -- "$@" --build-property "build.defines=${DEFINES}" ${SKETCH:+"$SKETCH"}
  fi
fi

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
echo "faber: flash image $(basename "$MERGED") $(stat -c %s "$MERGED") bytes"
