# syntax=docker/dockerfile:1
# Faber build image for ESP32-family boards (ESP32, ESP32-S3, ESP32-C3), round 9 spike.
# The AVR runner image (arduino-cli 1.5.1 + pinned libraries) plus Espressif's arduino-esp32 core, pinned.
# arduino-esp32 is LGPL-2.1, ESP-IDF inside it Apache-2.0 (see NOTICE). Firmware built with it is user-side code.
#
#   docker build -t faber/arduino-esp32:3.3.12-r2 toolchains/arduino-esp32
#
# The wrapper writes <sketch>.ino.merged.bin (bootloader + partitions + boot_app0 + app, 4 MB, via
# esptool merge-bin): the image qemu-system-xtensa / qemu-system-riscv32 boot with -drive file=...,if=mtd.
ARG BASE_IMAGE=faber/arduino-runner:1.5.1-avr1.8.8-libs3-r1
FROM ${BASE_IMAGE}

# Pinned core release 3.3.12 (esp32-core-3.3.12.zip, 51102895 bytes; arduino-cli checks its SHA-256
# from the index). Toolchains: esp-x32 2601 (xtensa), esp-rv32 2601 (riscv32), esptool_py 5.3.1.
ARG ESP32_CORE=esp32:esp32@3.3.12
ARG ESP32_INDEX=https://espressif.github.io/arduino-esp32/package_esp32_index.json

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

# The download is ~1.5 GB across many archives; a transient "unexpected EOF" broke an earlier attempt,
# so retry (arduino-cli resumes from its staging cache and verifies every checksum).
RUN arduino-cli config init --overwrite --additional-urls "${ESP32_INDEX}" \
 && arduino-cli core update-index \
 && for i in 1 2 3 4 5; do arduino-cli core install "${ESP32_CORE}" && break; echo "retry $i"; sleep 5; done \
 && arduino-cli core list | grep -q 'esp32:esp32 *3.3.12' \
 && P=/opt/arduino/data/packages/esp32/tools \
 && rm -rf /opt/arduino/downloads /opt/arduino/staging \
      $P/esp32c5-libs $P/esp32c6-libs $P/esp32h2-libs $P/esp32p4-libs $P/esp32p4_es-libs $P/esp32s2-libs \
      $P/xtensa-esp-elf-gdb $P/riscv32-esp-elf-gdb $P/openocd-esp32 $P/dfu-util \
 && chmod -R a+rX /opt/arduino /root/.arduino15 2>/dev/null; \
    arduino-cli core list

ENV ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS=${ESP32_INDEX}
# FaberEth: networking in the emulator (ESP-IDF's OpenCores MAC driver, Apache-2.0, + Faber glue).
COPY libraries/FaberEth /opt/arduino/user/libraries/FaberEth
COPY faber-arduino-esp32.sh /usr/local/bin/faber-arduino-esp32
RUN chmod a+rx /usr/local/bin/faber-arduino-esp32
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/faber-arduino-esp32"]
CMD ["version"]
