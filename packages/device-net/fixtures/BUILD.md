# Device network firmware fixtures

Real ESP32-family sketches written for the real device (no Jumper code in them), built with the
simulation image so the Wi-Fi and TLS shims are linked in. The merged flash images are committed
gzipped and run by `test/firmware.integration.test.ts` (Docker + `jumper/qemu-esp`).

| Sketch | Image | What it does |
| --- | --- | --- |
| `net-probe/net-probe.ino` | `net-probe.esp32s3.merged.bin.gz` | Wi-Fi join, HTTPS GET with the ISRG Root X1 CA set (mock), a blocked host, HTTPS to an allowed host that gets a secret header at the edge, PubSubClient MQTT publish + subscribe; then reports Wi-Fi status changes and fetches again after each reconnect |
| `wifi-https/wifi-https.ino` | (not committed) | Wi-Fi scan + join, HTTPS GET, RSSI every second; the first smoke test of the shims |

Build (Docker; the r3 image is `toolchains/arduino-esp32/Dockerfile.sim` on top of r2):

```sh
docker build -t jumper/arduino-esp32:3.3.12-r3 -f toolchains/arduino-esp32/Dockerfile.sim toolchains/arduino-esp32
mkdir -p /tmp/np && docker run --rm \
  -v "$PWD/packages/device-net/fixtures/net-probe:/work/sketch/net-probe:ro" -v /tmp/np:/work/out \
  jumper/arduino-esp32:3.3.12-r3 compile --fqbn esp32:esp32:esp32s3:FlashMode=dio --output-dir /work/out /work/sketch/net-probe
gzip -9 -c /tmp/np/net-probe.ino.merged.bin > packages/device-net/fixtures/net-probe.esp32s3.merged.bin.gz
```

Toolchain: arduino-cli 1.5.1, esp32:esp32 3.3.12 (ESP-IDF 5.5.5), PubSubClient 2.8.0. The output
says `jumper: simulation build, Wi-Fi shim on`. `JUMPER_SIM=0` builds the same sketch for a real
board without the shims.
