# syntax=docker/dockerfile:1
# Build image for the Seeed XIAO nRF52840 (and Sense): Seeed's nRF52 core (Seeeduino:nrf52 1.1.13,
# the Adafruit nRF52 core with Seeed's variants; core LGPL-2.1, Nordic nrfx / SoftDevice headers
# under Nordic's license, TinyUSB MIT, FreeRTOS MIT; see NOTICE) on top of the runner image, so
# sketches get the same pinned Arduino libraries. Native arm64. The entrypoint (faber-arduino.sh)
# also writes <sketch>.ino.sim.hex (Nordic's MBR + S140 SoftDevice + the app: what Faber's Renode
# simulator boots) and <sketch>.ino.uf2 (what the board's UF2 bootloader takes over USB).
#
#   docker build -t faber/arduino-nrf52:1.1.13-libs3-r2 toolchains/arduino-nrf52
#
# Keep the tag in sync with NRF52_IMAGE in services/runner/src/config.ts. Bump -rN on any change.
ARG BASE_IMAGE=faber/arduino-runner:1.5.1-avr1.8.8-libs3-r1
FROM ${BASE_IMAGE}
ARG SEEED_INDEX=https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
# The core's build recipe packages a DFU zip with adafruit-nrfutil and writes the UF2 with uf2conv.py.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv python-is-python3 \
 && python3 -m venv /opt/nrfutil && /opt/nrfutil/bin/pip install --no-cache-dir adafruit-nrfutil==0.5.3.post16 \
 && ln -s /opt/nrfutil/bin/adafruit-nrfutil /usr/local/bin/adafruit-nrfutil \
 && rm -rf /var/lib/apt/lists/*
RUN arduino-cli config init --overwrite --additional-urls "${SEEED_INDEX}" \
 && arduino-cli core update-index \
 && arduino-cli core install Seeeduino:nrf52@1.1.13 \
 && rm -rf /opt/arduino/downloads && chmod -R a+rX /opt/arduino /root/.arduino15 2>/dev/null; arduino-cli core list
ENV ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS=${SEEED_INDEX}
COPY faber-sim-hex.py /usr/local/bin/faber-sim-hex.py
COPY faber-arduino.sh /usr/local/bin/faber-arduino
RUN chmod a+rx /usr/local/bin/faber-arduino /usr/local/bin/faber-sim-hex.py
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/faber-arduino"]
CMD ["version"]
