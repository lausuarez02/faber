# syntax=docker/dockerfile:1
# Build image for the Arduino Nano 33 BLE (nRF52840): arduino:mbed_nano 4.4.1 (Arm Mbed OS,
# Apache-2.0; core LGPL-2.1) on top of the AVR runner base. Native arm64.
#
#   docker build -t jumper/arduino-mbed-nano:4.4.1-r1 toolchains/arduino-mbed-nano
ARG BASE_IMAGE=jumper/arduino-cli:1.5.1-avr1.8.8
FROM ${BASE_IMAGE}
RUN arduino-cli core update-index && arduino-cli core install arduino:mbed_nano@4.4.1 \
 && rm -rf /opt/arduino/downloads && arduino-cli core list
