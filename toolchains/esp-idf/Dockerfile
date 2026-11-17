# syntax=docker/dockerfile:1
# Fabwright build image for ESP-IDF projects (firmware.language "esp-idf"), round 10.
#
#   docker build -t fabwright/esp-idf:5.5.5-r1 toolchains/esp-idf
#
# Built FROM the arduino-esp32 image on purpose: arduino-esp32 3.3.12 is built on ESP-IDF v5.5.5
# and ships the exact cross compilers v5.5.5 pins in tools/tools.json (xtensa-esp-elf and
# riscv32-esp-elf esp-14.2.0_20260121), so this image adds only the IDF sources (a shallow clone of
# the public v5.5.5 tag with its submodules) and IDF's Python environment, and shares the 6.5 GB of
# compilers with the Arduino image instead of downloading them again.
#
# ESP-IDF is Apache-2.0; some components it fetches are other licences (see NOTICE). Firmware built
# here is the person's code.
#
# The wrapper builds /work/project into /work/out/merged.bin: bootloader + partition table + app
# merged with esptool and padded to the flash size, the image Fabwright's QEMU backend boots.
ARG BASE_IMAGE=fabwright/arduino-esp32:3.3.12-r2
FROM ${BASE_IMAGE}

ARG IDF_VERSION=v5.5.5
ENV IDF_PATH=/opt/esp-idf \
    IDF_TOOLS_PATH=/opt/esp-idf-tools \
    IDF_COMPONENT_MANAGER=0 \
    IDF_CCACHE_ENABLE=0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake ninja-build python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${IDF_VERSION} --recurse-submodules --shallow-submodules -j 8 \
      https://github.com/espressif/esp-idf.git ${IDF_PATH} \
 && rm -rf ${IDF_PATH}/.git ${IDF_PATH}/docs ${IDF_PATH}/examples/*/*/*/build \
 && find ${IDF_PATH} -name .git -prune -exec rm -rf {} +

# IDF's own Python environment (pinned by its constraints file for v5.5).
RUN python3 ${IDF_PATH}/tools/idf_tools.py install-python-env \
 && rm -rf /root/.cache/pip

# The compilers already in the base image, under the names IDF looks for.
ENV PATH=/opt/arduino/data/packages/esp32/tools/esp-x32/2601/bin:/opt/arduino/data/packages/esp32/tools/esp-rv32/2601/bin:${PATH}

COPY fabwright-esp-idf.sh /usr/local/bin/fabwright-esp-idf
RUN chmod a+rx /usr/local/bin/fabwright-esp-idf \
 && chmod -R a+rX ${IDF_PATH} ${IDF_TOOLS_PATH} \
 && ls ${IDF_TOOLS_PATH}/python_env
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/fabwright-esp-idf"]
CMD ["--version"]
