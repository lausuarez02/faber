# syntax=docker/dockerfile:1
# jumper/qemu-esp: Espressif's QEMU fork (GPL-2.0, run as a separate process, see NOTICE) for
# ESP32 / ESP32-S3 (qemu-system-xtensa) and ESP32-C3 (qemu-system-riscv32), plus Jumper's bridge
# patch: a working GPIO block whose pins (and the ESP32's I2C0 bus) are mirrored over a chardev.
#
#   docker build -t jumper/qemu-esp:9.2.2-20260417-jb4 toolchains/qemu-esp
ARG QEMU_TAG=esp-develop-9.2.2-20260417
FROM debian:bookworm-slim AS build
ARG QEMU_TAG
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential ninja-build python3 python3-venv pkg-config flex bison \
      libglib2.0-dev libpixman-1-dev libslirp-dev libgcrypt20-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${QEMU_TAG} https://github.com/espressif/qemu /src
WORKDIR /src
COPY 0001-jumper-bridge.patch /tmp/
RUN git apply /tmp/0001-jumper-bridge.patch
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
