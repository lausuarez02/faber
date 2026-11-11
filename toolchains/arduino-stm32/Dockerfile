# syntax=docker/dockerfile:1
# Build image for STM32 boards (Blue Pill F103C8, Black Pill F411CE, Nucleo-F401RE): STM32duino core
# 2.11.0 (LGPL-2.1 core, BSD-3-Clause ST HAL / CMSIS, see NOTICE) plus the same pinned Arduino
# libraries as the AVR / RP2040 images (toolchains/arduino/LIBRARIES.md), copied from the runner image.
#
# linux/amd64 only: STMicroelectronics:STM32Tools 2.3.1 has no linux-aarch64 build, so the core does
# not install on arm64. On Apple silicon Docker runs it under emulation (Rosetta / QEMU): a Blue Pill
# sketch builds in about 14 s cold, an SSD1306 sketch in about 40 s (measured round 10, M4 Max).
#
#   docker build --platform linux/amd64 -t jumper/arduino-stm32:2.11.0-libs3-r1 toolchains/arduino-stm32
#
# Keep the tag in sync with STM32_IMAGE in services/runner/src/config.ts. Bump -rN on any change.
# The runner keeps the ELF (<sketch>.ino.elf): Renode loads it (packages/sim-backends/src/renode).
ARG LIBS_IMAGE=jumper/arduino-runner:1.5.1-avr1.8.8-libs3-r1
# The libraries are sources: take them from the runner image built for this machine.
FROM --platform=$BUILDPLATFORM ${LIBS_IMAGE} AS libs

FROM --platform=linux/amd64 debian:bookworm-slim
ARG CLI=1.5.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 \
 && curl -fsSL https://github.com/arduino/arduino-cli/releases/download/v${CLI}/arduino-cli_${CLI}_Linux_64bit.tar.gz | tar -xz -C /usr/local/bin arduino-cli \
 && rm -rf /var/lib/apt/lists/*
ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/downloads ARDUINO_DIRECTORIES_USER=/opt/arduino/user ARDUINO_UPDATER_ENABLE_NOTIFICATION=false ARDUINO_BUILD_CACHE_PATH=/tmp/arduino-cache
ARG STM_INDEX=https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json
ENV ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS=${STM_INDEX}
RUN arduino-cli core update-index && arduino-cli core install STMicroelectronics:stm32@2.11.0 \
 && rm -rf /opt/arduino/downloads && arduino-cli core list
COPY --from=libs /opt/arduino/user/libraries /opt/arduino/user/libraries
RUN chmod -R a+rX /opt/arduino && arduino-cli lib list
WORKDIR /work
ENTRYPOINT ["arduino-cli"]
CMD ["version"]
