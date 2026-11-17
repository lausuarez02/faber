// Faber simulation build support (added by the build image, never by the person's sketch).
//  - Wi-Fi: esp_wifi_* are wrapped at link time (-Wl,--wrap) so WiFi.begin() and everything above it
//    (WiFiClient, WiFiClientSecure, HTTPClient, WebSockets, MQTT) run over QEMU's OpenCores Ethernet
//    card, with the Wi-Fi state (join, drop, RSSI, scan) decided by Faber's sandbox network.
//  - TLS: certificates issued by the Faber sandbox CA are accepted in addition to the CAs the sketch
//    sets (mbedtls_x509_crt_verify_restartable is wrapped). The CA comes from the sandbox network
//    when the board joins; it is never in the firmware image.
#pragma once
#define FABER_SIM_SHIM 1
#ifdef __cplusplus
extern "C" {
#endif
/** 1 while joined to the sandbox Wi-Fi. */
int faber_sim_wifi_joined(void);
#ifdef __cplusplus
}
#endif
