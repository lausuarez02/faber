# syntax=docker/dockerfile:1
# Fabwright build image for PlatformIO projects (firmware.language "platformio"), round 10.
#
#   docker build -t fabwright/platformio:6.2.0-avr5.3.0-r1 toolchains/platformio
#
# PlatformIO Core (Apache-2.0) pinned, with the atmelavr platform (Apache-2.0) and the packages a
# build for the Arduino Uno / Nano needs (avr-gcc, the Arduino AVR core) installed at image build
# time, so builds run offline. Other platforms are planned (docs/firmware-languages.md says why).
FROM python:3.12.12-slim-bookworm

ARG PIO_VERSION=6.2.0
ARG AVR_PLATFORM=atmelavr@5.3.0
ENV PLATFORMIO_CORE_DIR=/opt/platformio \
    PLATFORMIO_SETTING_ENABLE_TELEMETRY=No \
    PLATFORMIO_SETTING_CHECK_PLATFORMIO_INTERVAL=36500 \
    PLATFORMIO_SETTING_CHECK_PRUNE_SYSTEM_THRESHOLD=0 \
    PLATFORMIO_NO_ANSI=1

RUN pip install --no-cache-dir "platformio==${PIO_VERSION}"

# Warm build: installs the platform, toolchain and framework the Uno / Nano envs use.
COPY warm /tmp/warm
RUN pio pkg install -g --platform "${AVR_PLATFORM}" \
 && pio run -d /tmp/warm \
 && rm -rf /tmp/warm /root/.cache \
 && chmod -R a+rwX ${PLATFORMIO_CORE_DIR}

COPY fabwright-platformio.sh /usr/local/bin/fabwright-platformio
RUN chmod a+rx /usr/local/bin/fabwright-platformio
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/fabwright-platformio"]
CMD ["--version"]
