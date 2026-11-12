// SPDX-License-Identifier: MIT
// JumperRelay.h: reach any API through your own relay, with no API key in the firmware.
// Copyright (c) Jumper Authors. MIT License.
//
//   #include "JumperRelay.h"
//   http.begin(client, jumperRelayUrl("api.example.com", "/v1/forecast?lat=1"));
//   http.addHeader(JUMPER_TOKEN_HEADER, JUMPER_DEVICE_TOKEN);
//   // the relay adds the API key (relay.config.mjs) and streams the answer back
//
// The values come from jumper_device.h:
//   - in Jumper's simulator, the build adds one with the sandbox relay (the simulator plays the relay
//     with the same rules: allow list, token, limits) and a simulation token;
//   - for your own device, `jumper relay device-header` writes it into the sketch folder from your
//     .env (RELAY_URL, DEVICE_TOKEN, WIFI_SSID, WIFI_PASSWORD). It is git-ignored, and Jumper's own
//     builds (simulator, factory pack, build kit) never compile it, so a shared firmware file never
//     carries your token or Wi-Fi password.
// Without jumper_device.h, jumperRelayReady() is false: print why instead of calling out.
#pragma once
#include <Arduino.h>

#if __has_include("jumper_device.h")
#include "jumper_device.h"
#endif

#ifndef JUMPER_RELAY_URL
#define JUMPER_RELAY_URL ""
#endif
#ifndef JUMPER_DEVICE_TOKEN
#define JUMPER_DEVICE_TOKEN ""
#endif
#ifndef JUMPER_WIFI_SSID
#define JUMPER_WIFI_SSID ""
#endif
#ifndef JUMPER_WIFI_PASSWORD
#define JUMPER_WIFI_PASSWORD ""
#endif
// Optional: the root CA (PEM) of the relay's HTTPS certificate, for client.setCACert().
// jumper relay device-header --ca <file.pem> sets it; the simulator trusts its own sandbox CA.

#define JUMPER_TOKEN_HEADER "X-Device-Token"

/** True when the build has a relay and a device token (jumper_device.h). */
inline bool jumperRelayReady() { return sizeof(JUMPER_RELAY_URL) > 1 && sizeof(JUMPER_DEVICE_TOKEN) > 1; }

/** Why jumperRelayReady() is false, in words to print on Serial. */
inline const char* jumperRelayWhy() {
  if (jumperRelayReady()) return "relay configured";
  return "no relay in this build: run `jumper relay device-header` in the project (it writes jumper_device.h "
         "from your .env), then build and flash from the sketch folder";
}

/** <RELAY_URL>/<host><path>: the relay calls https://<host><path> with the keys added. */
inline String jumperRelayUrl(const char* host, const char* path) {
  String u = JUMPER_RELAY_URL;
  while (u.endsWith("/")) u.remove(u.length() - 1);
  u += '/';
  u += host;
  if (path == nullptr || path[0] != '/') u += '/';
  if (path != nullptr) u += path;
  return u;
}

/** The relay split up, for clients that take host, port and path apart (WebSocket, MQTT over WS). */
struct JumperRelayEndpoint {
  String host;
  uint16_t port;
  bool tls;
  /** The path for <host><path> through the relay, e.g. "/api.example.com/v1/stream". */
  String path;
};

inline JumperRelayEndpoint jumperRelayEndpoint(const char* host, const char* path) {
  JumperRelayEndpoint e;
  String u = JUMPER_RELAY_URL;
  e.tls = u.startsWith("https://");
  int start = u.indexOf("://");
  start = start < 0 ? 0 : start + 3;
  int slash = u.indexOf('/', start);
  String hp = slash < 0 ? u.substring(start) : u.substring(start, slash);
  String prefix = slash < 0 ? String("") : u.substring(slash);
  while (prefix.endsWith("/")) prefix.remove(prefix.length() - 1);
  int colon = hp.indexOf(':');
  e.host = colon < 0 ? hp : hp.substring(0, colon);
  e.port = colon < 0 ? (e.tls ? 443 : 80) : (uint16_t)hp.substring(colon + 1).toInt();
  e.path = prefix + "/" + host + ((path != nullptr && path[0] == '/') ? "" : "/") + (path != nullptr ? path : "");
  return e;
}
