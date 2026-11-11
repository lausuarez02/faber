# syntax=docker/dockerfile:1
# Build image for the Arduino Nano 33 BLE (nRF52840): arduino:mbed_nano 4.4.1 (Arm Mbed OS,
# Apache-2.0; core LGPL-2.1) on top of the runner image, so sketches get the same pinned Arduino
# libraries as the AVR / RP2040 / STM32 images. Native arm64.
#
#   docker build -t jumper/arduino-mbed-nano:4.4.1-libs3-r1 toolchains/arduino-mbed-nano
#
# Keep the tag in sync with MBED_NANO_IMAGE in services/runner/src/config.ts. Bump -rN on any change.
# The runner keeps the ELF (<sketch>.ino.elf): Renode loads it (packages/sim-backends/src/renode).
ARG BASE_IMAGE=jumper/arduino-runner:1.5.1-avr1.8.8-libs3-r1
FROM ${BASE_IMAGE}
RUN arduino-cli core update-index && arduino-cli core install arduino:mbed_nano@4.4.1 \
 && rm -rf /opt/arduino/downloads && chmod -R a+rX /opt/arduino /root/.arduino15 2>/dev/null; arduino-cli core list
WORKDIR /work
ENTRYPOINT ["arduino-cli"]
CMD ["version"]
