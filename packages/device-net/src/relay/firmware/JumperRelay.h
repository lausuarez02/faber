// SPDX-License-Identifier: MIT
// JumperRelay.h: the name FaberRelay.h had before the project was renamed from Jumper to
// Faber. Kept so sketches that include it keep compiling with the same code; new sketches
// include "FaberRelay.h" and use the faber* names. It reads faber_device.h, or the
// jumper_device.h an older `jumper relay device-header` wrote.
// Copyright (c) Faber Authors. MIT License.
#pragma once
#include "FaberRelay.h"

#ifndef JUMPER_RELAY_URL
#define JUMPER_RELAY_URL FABER_RELAY_URL
#endif
#ifndef JUMPER_DEVICE_TOKEN
#define JUMPER_DEVICE_TOKEN FABER_DEVICE_TOKEN
#endif
#ifndef JUMPER_WIFI_SSID
#define JUMPER_WIFI_SSID FABER_WIFI_SSID
#endif
#ifndef JUMPER_WIFI_PASSWORD
#define JUMPER_WIFI_PASSWORD FABER_WIFI_PASSWORD
#endif
#ifndef JUMPER_RELAY_ROOT_CA
#define JUMPER_RELAY_ROOT_CA FABER_RELAY_ROOT_CA
#endif
#define JUMPER_TOKEN_HEADER FABER_TOKEN_HEADER

typedef FaberRelayEndpoint JumperRelayEndpoint;
inline bool jumperRelayReady() { return faberRelayReady(); }
inline const char* jumperRelayWhy() { return faberRelayWhy(); }
inline String jumperRelayUrl(const char* host, const char* path) { return faberRelayUrl(host, path); }
inline JumperRelayEndpoint jumperRelayEndpoint(const char* host, const char* path) { return faberRelayEndpoint(host, path); }
