# syntax=docker/dockerfile:1
# Build image for STM32 boards (STM32duino core 2.11.0, LGPL-2.1 / BSD-3-Clause ST HAL, see NOTICE).
# linux/amd64 only: STMicroelectronics:STM32Tools 2.3.1 has no linux-aarch64 build, so the core will
# not install on arm64. On Apple silicon Docker runs it under emulation (a Blue Pill sketch: ~14 s).
#
#   docker build --platform linux/amd64 -t jumper/arduino-stm32:2.11.0-r1 toolchains/arduino-stm32
FROM --platform=linux/amd64 debian:bookworm-slim
ARG CLI=1.5.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 \
 && curl -fsSL https://github.com/arduino/arduino-cli/releases/download/v${CLI}/arduino-cli_${CLI}_Linux_64bit.tar.gz | tar -xz -C /usr/local/bin arduino-cli \
 && rm -rf /var/lib/apt/lists/*
ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/downloads ARDUINO_DIRECTORIES_USER=/opt/arduino/user ARDUINO_UPDATER_ENABLE_NOTIFICATION=false
ARG STM_INDEX=https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json
ENV ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS=${STM_INDEX}
RUN arduino-cli core update-index && arduino-cli core install STMicroelectronics:stm32@2.11.0 \
 && rm -rf /opt/arduino/downloads && arduino-cli core list
ENTRYPOINT ["arduino-cli"]
