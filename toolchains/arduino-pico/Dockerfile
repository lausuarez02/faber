# syntax=docker/dockerfile:1
# Jumper build image for RP2040 boards (Raspberry Pi Pico, Seeed XIAO RP2040, Waveshare RP2040-Zero).
# The AVR runner image (arduino-cli 1.5.1 and every pinned library from toolchains/arduino/LIBRARIES.md)
# plus Earle Philhower's arduino-pico core, pinned. The core is LGPL-2.1 like arduino:avr and the
# Raspberry Pi pico-sdk inside it is BSD-3-Clause (see NOTICE). Firmware built with it is user-side code.
#
#   docker build -t jumper/arduino-pico:6.3.1-r1 toolchains/arduino-pico
#
# Keep the tag in sync with PICO_IMAGE in services/runner/src/config.ts. Bump -rN on any change here.
ARG BASE_IMAGE=jumper/arduino-runner:1.5.1-avr1.8.8-libs2-r1
FROM ${BASE_IMAGE}

# Pinned core release (2026-10-23). arduino-cli checks the archive's SHA-256 from the index:
# rp2040-6.3.1.zip SHA-256 6fa7a30671d3b08f77be41b92079fd83b0b98c375ff4f4a46d01132b69024485,
# toolchain pqt-gcc 5.0.0-9576866 (GCC 14, arm-none-eabi).
ARG PICO_CORE=rp2040:rp2040@6.3.1
ARG PICO_INDEX=https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json

# The core's build recipes run small Python scripts (linker-script substitution, UF2 conversion).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

RUN arduino-cli config init --overwrite --additional-urls "${PICO_INDEX}" \
 && arduino-cli core update-index \
 && arduino-cli core install "${PICO_CORE}" \
 && rm -rf /opt/arduino/downloads \
      /opt/arduino/data/packages/rp2040/tools/pqt-gcc-riscv \
      /opt/arduino/data/packages/rp2040/tools/pqt-openocd \
 && chmod -R a+rX /opt/arduino /root/.arduino15 2>/dev/null; \
    arduino-cli core list

# Non-root builds (docker run --user) do not read /root/.arduino15, so name the index here too.
ENV ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS=${PICO_INDEX}

# arduino-pico writes .elf/.bin/.uf2. Jumper's firmware artifact is always Intel HEX (decision 0003, C1):
# the wrapper converts the ELF after a successful compile (absolute 0x10000000 flash addresses).
RUN ln -s "$(ls -d /opt/arduino/data/packages/rp2040/tools/pqt-gcc/*/bin)/arm-none-eabi-objcopy" /usr/local/bin/arm-none-eabi-objcopy \
 && arm-none-eabi-objcopy --version | head -1
COPY jumper-arduino.sh /usr/local/bin/jumper-arduino
RUN chmod a+rx /usr/local/bin/jumper-arduino

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/jumper-arduino"]
CMD ["version"]
