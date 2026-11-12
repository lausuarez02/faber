# syntax=docker/dockerfile:1
# jumper/qemu-esp: Espressif's QEMU fork (GPL-2.0, run as a separate process, see NOTICE) for
# ESP32 / ESP32-S3 (qemu-system-xtensa) and ESP32-C3 (qemu-system-riscv32), plus Jumper's bridge
# patch: a working GPIO block whose pins (and the ESP32's I2C0 bus) are mirrored over a chardev.
#
#   docker build -t jumper/qemu-esp:9.2.2-20260417-jb6 toolchains/qemu-esp
#
# Patches (applied in order; the combined source is branch jumper-jb6 of the spike QEMU repo):
#   0001 GPIO/UART0/I2C0 bridge + lockstep (jb2)
#   0002 GPIO matrix + interrupts, LEDC, GP-SPI, RMT, ADC, UART1/2, I2C on S3/C3 and I2C1 (round 10, esp-periph)
#   0003 pad pull-up / pull-down tracking (IO_MUX, RTC_IO), lockstep waits for Jumper after a pull change (round 10, esp-app)
#   0004 I2S: ESP32 I2S0/I2S1 with their DMA, S3 I2S0/I2S1 and C3 I2S0 through GDMA; TX/RX frames as ST/SR (round 13, audio)
#   0005 OpenCores Ethernet: an RX frame waits in QEMU's queue for a free descriptor instead of being dropped (round 13)
# Bridge protocol v6 = all of the above. Protocol: hw/gpio/esp32_gpio.c, packages/sim-backends/src/qemu-esp/protocol.ts.
ARG QEMU_TAG=esp-develop-9.2.2-20260417
FROM debian:bookworm-slim AS build
ARG QEMU_TAG
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential ninja-build python3 python3-venv pkg-config flex bison \
      libglib2.0-dev libpixman-1-dev libslirp-dev libgcrypt20-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${QEMU_TAG} https://github.com/espressif/qemu /src
WORKDIR /src
COPY 0001-jumper-bridge.patch 0002-jumper-peripherals.patch 0003-jumper-pads.patch 0004-jumper-i2s.patch 0005-jumper-eth-rx.patch /tmp/
RUN git apply /tmp/0001-jumper-bridge.patch && git apply /tmp/0002-jumper-peripherals.patch && git apply /tmp/0003-jumper-pads.patch \
 && git apply /tmp/0004-jumper-i2s.patch && git apply /tmp/0005-jumper-eth-rx.patch
RUN ./configure --prefix=/opt/qemu --target-list=xtensa-softmmu,riscv32-softmmu \
      --enable-gcrypt --enable-slirp --disable-sdl --disable-gtk --disable-vnc --disable-capstone \
      --disable-docs --disable-tools --disable-user --disable-werror \
 && make -j"$(nproc)" install \
 && strip /opt/qemu/bin/qemu-system-*

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libpixman-1-0 libslirp0 libgcrypt20 zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/qemu /opt/qemu
ENV PATH=/opt/qemu/bin:$PATH
RUN qemu-system-xtensa --version && qemu-system-riscv32 -M help | grep -q esp32c3
CMD ["qemu-system-xtensa", "--version"]
