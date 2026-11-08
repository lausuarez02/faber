# syntax=docker/dockerfile:1
# Reproducible Arduino build image for Jumper firmware.
# Multi-arch: builds natively on linux/amd64 and linux/arm64 (Apple Silicon).
#   docker build -t jumper/arduino-cli:1.5.1-avr1.8.8 toolchains/arduino
# Versions are pinned; bump them together and record the change in examples/*/firmware/BUILD.md.
FROM debian:bookworm-20251020-slim

ARG ARDUINO_CLI_VERSION=1.5.1
ARG ARDUINO_AVR_CORE=arduino:avr@1.8.8
ARG ARDUINO_CLI_SHA256_AMD64=28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b
ARG ARDUINO_CLI_SHA256_ARM64=1e69e077479f300614d4551334e0a33f08ee40b04315d83b8e7e0e94f0d0ee62
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) asset=Linux_64bit; sum="$ARDUINO_CLI_SHA256_AMD64" ;; \
      arm64) asset=Linux_ARM64; sum="$ARDUINO_CLI_SHA256_ARM64" ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    f="arduino-cli_${ARDUINO_CLI_VERSION}_${asset}.tar.gz"; \
    curl -fsSLo "/tmp/$f" "https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/$f"; \
    echo "$sum  /tmp/$f" | sha256sum -c -; \
    tar -xzf "/tmp/$f" -C /usr/local/bin arduino-cli; \
    rm "/tmp/$f"; \
    arduino-cli version

ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data \
    ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/downloads \
    ARDUINO_DIRECTORIES_USER=/opt/arduino/user \
    ARDUINO_UPDATER_ENABLE_NOTIFICATION=false \
    ARDUINO_BUILD_CACHE_PATH=/tmp/arduino-cache

RUN arduino-cli core update-index \
 && arduino-cli core install "${ARDUINO_AVR_CORE}" \
 && rm -rf /opt/arduino/downloads \
 && chmod -R a+rX /opt/arduino \
 && arduino-cli core list

WORKDIR /work
ENTRYPOINT ["arduino-cli"]
CMD ["version"]
