// Jumper: Ethernet for ESP32-family firmware running in Jumper's QEMU (OpenCores MAC, "open_eth").
#pragma once
#include "esp_netif.h"
#ifdef __cplusplus
extern "C" {
#endif
// Starts the emulated Ethernet interface (DHCP). Returns NULL on real hardware (no OpenCores MAC there).
esp_netif_t *jumper_eth_begin(void);
#ifdef __cplusplus
}
#endif
