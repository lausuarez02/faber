# syntax=docker/dockerfile:1
# Reproducible Arduino build image for Jumper firmware.
# Multi-arch: builds natively on linux/amd64 and linux/arm64 (Apple Silicon).
#   docker build -t jumper/arduino-cli:1.5.1-avr1.8.8-libs2 toolchains/arduino
# The -libsN suffix counts the pinned library set below (LIBRARIES.md). Bump N when it changes.
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

# Pinned libraries for display, sensor and RTC parts. Licenses and why each one: LIBRARIES.md.
# Adding libraries does not change sketches that do not include them (Blink stays byte-identical).
RUN arduino-cli lib update-index \
 && arduino-cli lib install --no-deps \
      "Adafruit BusIO@1.17.4" \
      "Adafruit GFX Library@1.13.0" \
      "Adafruit SSD1306@2.5.17" \
      "Adafruit Unified Sensor@1.1.15" \
      "Adafruit BME280 Library@2.3.0" \
      "Adafruit MPU6050@2.2.9" \
      "RTClib@2.1.4" \
      "LiquidCrystal_PCF8574@2.3.0" \
      "MPU6050@1.4.5" \
      "U8g2@2.36.19" \
      "Adafruit ILI9341@1.7.0" \
      "Adafruit ST7735 and ST7789 Library@1.12.0" \
 && rm -rf /opt/arduino/downloads \
 && chmod -R a+rX /opt/arduino \
 && arduino-cli lib list

# Jumper's own Apache-2.0 LiquidCrystal_I2C (the API of the popular library, whose upstream has no
# license). Lives in toolchains/arduino/libraries/.
COPY libraries/LiquidCrystal_I2C /opt/arduino/user/libraries/LiquidCrystal_I2C
RUN chmod -R a+rX /opt/arduino/user/libraries/LiquidCrystal_I2C

WORKDIR /work
ENTRYPOINT ["arduino-cli"]
CMD ["version"]
