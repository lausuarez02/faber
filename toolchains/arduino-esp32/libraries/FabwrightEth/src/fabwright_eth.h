// Fabwright: Ethernet for ESP32-family firmware running in Fabwright's QEMU (OpenCores MAC, "open_eth").
#pragma once
#include "esp_netif.h"
#ifdef __cplusplus
extern "C" {
#endif
// Starts the emulated Ethernet interface (DHCP). Returns NULL on real hardware (no OpenCores MAC there).
esp_netif_t *fabwright_eth_begin(void);
// True when the emulated OpenCores MAC is present (QEMU started with a network card).
int fabwright_eth_present(void);
// Installs the Ethernet driver with this MAC address and no netif (the Wi-Fi shim feeds frames to
// the Wi-Fi station netif itself). Not started. Returns NULL without an emulated MAC.
void *fabwright_eth_install(const uint8_t mac[6]);
#ifdef __cplusplus
}
#endif
