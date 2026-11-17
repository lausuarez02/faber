// SPDX-License-Identifier: MIT
// JumperRelay.h: the name FabwrightRelay.h had before the project was renamed from Jumper to
// Fabwright. Kept so sketches that include it keep compiling with the same code; new sketches
// include "FabwrightRelay.h" and use the fabwright* names. It reads fabwright_device.h, or the
// jumper_device.h an older `jumper relay device-header` wrote.
// Copyright (c) Fabwright Authors. MIT License.
#pragma once
#include "FabwrightRelay.h"

#ifndef JUMPER_RELAY_URL
#define JUMPER_RELAY_URL FABWRIGHT_RELAY_URL
#endif
#ifndef JUMPER_DEVICE_TOKEN
#define JUMPER_DEVICE_TOKEN FABWRIGHT_DEVICE_TOKEN
#endif
#ifndef JUMPER_WIFI_SSID
#define JUMPER_WIFI_SSID FABWRIGHT_WIFI_SSID
#endif
#ifndef JUMPER_WIFI_PASSWORD
#define JUMPER_WIFI_PASSWORD FABWRIGHT_WIFI_PASSWORD
#endif
#ifndef JUMPER_RELAY_ROOT_CA
#define JUMPER_RELAY_ROOT_CA FABWRIGHT_RELAY_ROOT_CA
#endif
#define JUMPER_TOKEN_HEADER FABWRIGHT_TOKEN_HEADER

typedef FabwrightRelayEndpoint JumperRelayEndpoint;
inline bool jumperRelayReady() { return fabwrightRelayReady(); }
inline const char* jumperRelayWhy() { return fabwrightRelayWhy(); }
inline String jumperRelayUrl(const char* host, const char* path) { return fabwrightRelayUrl(host, path); }
inline JumperRelayEndpoint jumperRelayEndpoint(const char* host, const char* path) { return fabwrightRelayEndpoint(host, path); }
