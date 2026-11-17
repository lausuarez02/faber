# syntax=docker/dockerfile:1
# Faber build runner image: the pinned toolchain (toolchains/arduino, which already carries the display
# and sensor libraries in toolchains/arduino/LIBRARIES.md) plus the robot libraries below. Firmware built with these libraries is user-side code
# (see NOTICE): each library keeps its own license.
#
#   docker build -t faber/arduino-runner:1.5.1-avr1.8.8-libs3-r1 services/runner/docker
#
# Bump the tags in services/runner/src/config.ts together with any change here.
ARG BASE_IMAGE=faber/arduino-cli:1.5.1-avr1.8.8-libs3
FROM ${BASE_IMAGE}

# Pinned. License (checked 2026-11-09): Servo 1.3.0 LGPL-2.1 (same as the Arduino AVR core).
# The SSD1306/GFX/BusIO lines are no-ops when the base image already has those exact versions.
RUN arduino-cli lib update-index \
 && arduino-cli lib install --no-deps "Servo@1.3.0" "Adafruit BusIO@1.17.4" "Adafruit GFX Library@1.13.0" "Adafruit SSD1306@2.5.17" \
 && rm -rf /opt/arduino/downloads \
 && chmod -R a+rX /opt/arduino \
 && arduino-cli lib list

WORKDIR /work
ENTRYPOINT ["arduino-cli"]
CMD ["version"]
