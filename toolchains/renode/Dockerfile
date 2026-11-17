# syntax=docker/dockerfile:1
# Fabwright's Renode image: Renode 1.17.0 portable (MIT, Antmicro, https://renode.io), linux arm64,
# runs offline. The Renode backend (packages/sim-backends/src/renode) starts one container per
# simulated board and talks to it over the monitor, ExternalControl and UART sockets.
#
#   docker build -t fabwright/renode:1.17.0-r1 toolchains/renode
#
# Keep the tag in sync with RENODE_IMAGE in packages/sim-backends/src/renode/machine.ts. Bump -rN on any change.
# On an x86_64 host use the linux-portable-dotnet build instead (same version, its own SHA-256).
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libicu72 libstdc++6 ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
ADD https://github.com/renode/renode/releases/download/v1.17.0/renode-1.17.0.linux-arm64-portable.tar.gz /tmp/r.tgz
RUN echo "e9051578411441bfb47b77de0381cfba3badce03663367fab561472fd7807f1f  /tmp/r.tgz" | sha256sum -c - \
 && mkdir -p /opt/renode && tar -xzf /tmp/r.tgz -C /opt/renode --strip-components=1 && rm /tmp/r.tgz \
 && ln -s /opt/renode/renode /usr/local/bin/renode
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
# Warm Renode's download cache (the SVD files some platforms fetch from dl.antmicro.com) so runs need no network.
RUN for p in cpus/stm32f103 cpus/stm32f4 cpus/stm32f072 cpus/stm32f0 cpus/stm32g0 cpus/stm32l072 cpus/stm32l151 \
      cpus/stm32l552 cpus/stm32f746 cpus/stm32h743 cpus/stm32wba52 cpus/nrf52840 boards/arduino_nano_33_ble \
      boards/nucleo_h753zi boards/stm32f4_discovery-kit; do \
      printf 'mach create\nmachine LoadPlatformDescription @platforms/%s.repl\nquit\n' "$p" > /tmp/w.resc; \
      (cd /opt/renode && timeout 120 renode --disable-gui --console /tmp/w.resc > /dev/null 2>&1) || true; \
    done; rm -f /tmp/w.resc; ls /root/.config/renode/cached_binaries
WORKDIR /work
ENTRYPOINT ["renode"]
