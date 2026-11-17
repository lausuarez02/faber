# Device network firmware fixtures

Real ESP32-family sketches written for the real device (no Fabwright code in them), built with the
simulation image so the Wi-Fi and TLS shims are linked in. The merged flash images are committed
gzipped and run by `test/firmware.integration.test.ts` (Docker + `fabwright/qemu-esp`).

| Sketch | Image | What it does |
| --- | --- | --- |
| `net-probe/net-probe.ino` | `net-probe.esp32s3.merged.bin.gz` | Wi-Fi join, HTTPS GET with the ISRG Root X1 CA set (mock), a blocked host, HTTPS to an allowed host that gets a secret header at the edge, PubSubClient MQTT publish + subscribe; then reports Wi-Fi status changes and fetches again after each reconnect |
| `audio-stream/audio-stream.ino` | `audio-stream.esp32s3.merged.bin.gz` | Round 13: Wi-Fi join, then HTTP GETs of raw 16-bit PCM and of a WAV (header skipped) from a mock API, streamed into I2S (ESP_I2S, XIAO D1 / D2 / D3) as they arrive; run by `test/audio-stream.integration.test.ts` (needs QEMU jb6) |
| `wifi-https/wifi-https.ino` | (not committed) | Wi-Fi scan + join, HTTPS GET, RSSI every second; the first smoke test of the shims |

Build (Docker; the r3 image is `toolchains/arduino-esp32/Dockerfile.sim` on top of r2):

```sh
docker build -t fabwright/arduino-esp32:3.3.12-r3 -f toolchains/arduino-esp32/Dockerfile.sim toolchains/arduino-esp32
mkdir -p /tmp/np && docker run --rm \
  -v "$PWD/packages/device-net/fixtures/net-probe:/work/sketch/net-probe:ro" -v /tmp/np:/work/out \
  fabwright/arduino-esp32:3.3.12-r3 compile --fqbn esp32:esp32:esp32s3:FlashMode=dio --output-dir /work/out /work/sketch/net-probe
gzip -9 -c /tmp/np/net-probe.ino.merged.bin > packages/device-net/fixtures/net-probe.esp32s3.merged.bin.gz
```

Toolchain: arduino-cli 1.5.1, esp32:esp32 3.3.12 (ESP-IDF 5.5.5), PubSubClient 2.8.0. The output
says `fabwright: simulation build, Wi-Fi shim on`. `FABWRIGHT_SIM=0` builds the same sketch for a real
board without the shims.

`audio-stream` (round 13) is built the same way (`node_modules/.bin/tsx packages/device-net/fixtures/build.ts audio-stream`,
natively with `fabwright setup esp32` when Docker is down); it uses only the core's WiFi, HTTPClient and ESP_I2S.
