// Firmware-side guidance for network projects, for the agent's hints and plan_device. Jumper does
// not ship any of these libraries: the firmware build (arduino-cli in the toolchain image) installs
// them. Licenses checked on 2026-11-11 through the GitHub license API.

export interface NetLibrary {
  name: string;
  use: string;
  license: string;
  repo: string;
  note?: string;
}

export const NET_LIBRARIES: NetLibrary[] = [
  { name: "WiFi / WiFiClientSecure / HTTPClient (arduino-esp32 core)", use: "Wi-Fi, TLS sockets, HTTP(S) requests incl. streaming bodies (http.getStreamPtr())", license: "LGPL-2.1", repo: "espressif/arduino-esp32", note: "part of the core; nothing to install" },
  { name: "arduinoWebSockets (Links2004)", use: "WebSocket client (ws:// and wss://), text and binary frames", license: "LGPL-2.1", repo: "Links2004/arduinoWebSockets" },
  { name: "PubSubClient (knolleary)", use: "MQTT 3.1.1 client, QoS 0 publish, QoS 0/1 subscribe", license: "MIT", repo: "knolleary/pubsubclient", note: "default packet size 256 B: call setBufferSize() for bigger payloads" },
  { name: "arduino-mqtt (256dpi)", use: "MQTT client with QoS 1/2 publish", license: "MIT", repo: "256dpi/arduino-mqtt" },
  { name: "ArduinoJson (bblanchon)", use: "parse and build JSON request / response bodies", license: "MIT", repo: "bblanchon/ArduinoJson" },
  { name: "ArduinoWebsockets (gilmaimon)", use: "another WebSocket client", license: "GPL-3.0", repo: "gilmaimon/ArduinoWebsockets", note: "GPL: makes the firmware GPL when distributed; prefer arduinoWebSockets" },
];

export const NETWORK_HINTS = `Network (any API, any protocol the device speaks over TCP):
- The simulated board joins the sandbox Wi-Fi (SSID from jumper.json network.wifi, default "JumperNet") and gets an address by DHCP. DNS, NTP, TCP and TLS go through Jumper, which decides per project: offline, mock (default; only mocks and recorded cassettes answer) or internet (hosts in network.allow).
- HTTP(S): WiFiClientSecure + HTTPClient. For a streamed answer read http.getStreamPtr() in a loop instead of http.getString(), so a long body never has to fit in RAM.
- TLS: write the sketch for the real device (client.setCACert(<the API's real root CA>), or the ESP32 certificate bundle). Jumper's simulation build also trusts its sandbox CA, so the same source talks to mocks and inspected hosts in the simulator; the device build does not contain that. Never ship setInsecure().
- Wi-Fi: plain WiFi.begin(ssid, password) works in the simulator (a Wi-Fi shim in the simulation build joins the sandbox network over the emulated network card). Handle WiFi.status() != WL_CONNECTED and reconnects: inject_network_fault wifi_drop and weak_signal rehearse them.
- WebSocket: arduinoWebSockets (LGPL-2.1): webSocket.beginSSL(host, 443, path); binary frames arrive in the WStype_BIN event, already split into frames, so a stream of chunks is just many events.
- MQTT: PubSubClient (MIT) for publish QoS 0 and subscribe; arduino-mqtt (MIT) when publishes need QoS 1. Keep loop() calling client.loop().
- Keys: never put an API key in the sketch. Declare it in jumper.json network.secrets (name only), put the value in the project's .env, and either send the header as "Bearer {{secret:NAME}}" from the firmware or let network.allow[].headers add it. Jumper replaces it at the edge and shows [secret:NAME] everywhere. On the real device the key lives in a relay the person runs or deploys (jumper relay init: a Node server or a Cloudflare Worker made from the same network config).
- API calls that need a key: write them through the relay so the same firmware works in the simulator and on the device: #include "JumperRelay.h", client.setCACert(JUMPER_RELAY_ROOT_CA), http.begin(client, jumperRelayUrl("api.example.com", "/v1/...")), http.addHeader(JUMPER_TOKEN_HEADER, JUMPER_DEVICE_TOKEN), WiFi.begin(JUMPER_WIFI_SSID, JUMPER_WIFI_PASSWORD); check jumperRelayReady() first (print jumperRelayWhy() when false). WebSocket clients: jumperRelayEndpoint(host, path) gives host / port / tls / path. The simulation build points it at the sandbox relay (same allow list, token check and limits; mocks answer); the device gets its relay URL, token and Wi-Fi from jumper_device.h (jumper relay device-header, git-ignored). The host must be in network.allow.
- Test it: mocks in network/mocks.json (add_mock_api), scenario steps {"request": {"host": ..., "path": ...}} and faults (inject_network_fault wifi_drop / latency / http_error / timeout / dns_fail). read_network shows every request with status, bytes and timing.`;

/** For plan_device: what a network feature adds to the plan, independent of the API. */
export function planNetworkSteps(apiHosts: string[]): string[] {
  return [
    `Declare the network in jumper.json: mode "mock" for tests${apiHosts.length ? `, allow ${apiHosts.join(", ")} for live runs` : ""}, secrets by name only.`,
    "Mock each API the device calls (add_mock_api), including its error answers, before writing firmware against it.",
    "Firmware: Wi-Fi join with retry, HTTP(S) / WebSocket / MQTT through the libraries in the hints, the API's real root CA (the simulation build also trusts the sandbox CA by itself).",
    "Scenario tests: assert the requests ({\"request\": ...}) and rehearse wifi_drop, latency and http_error.",
    "Factory pack: the hosts, ports and secrets the real device needs, and relay/ (the API relay that holds the keys; the device gets a revocable token).",
  ];
}
