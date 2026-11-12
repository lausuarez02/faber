# The device network

Round 10. How a simulated board reaches APIs, what Jumper decides on its way, and how to test it.
Generic on purpose: a weather API, an AI stream, MQTT telemetry and a webhook are the same thing
to Jumper. Design and decisions: [0007](decisions/0007-device-network-draft.md).

```
 firmware (unmodified WiFi.h / HTTPClient / WiFiClientSecure / WebSockets / PubSubClient sketch)
   │  simulation build: JumperSim Wi-Fi shim + TLS trust shim (toolchains/arduino-esp32, image r3)
 emulated ESP32 / S3 / C3 in QEMU, OpenCores Ethernet card ("open_eth")
   │  Ethernet frames, QEMU -netdev stream (4-byte length + frame) to 127.0.0.1:<framePort>
 netstack (packages/device-net/src/netstack): router 10.0.2.2, DHCP, ARP, ICMP echo, a switch
   between boards, the far end of every TCP flow, the Wi-Fi access point (EtherType 0x88B5)
   │  DNS / NTP datagrams, TCP flows to (fake ip, port)
 DeviceNet gateway: fake-IP DNS, policy (offline | mock | internet + allow), faults, TLS inspect
   with the sandbox CA or passthrough, HTTP / WebSocket / MQTT / raw, mocks → cassette → real host,
   secrets added at the edge, one redacted log
   │
 read_network · Network panel · scenario steps · factory pack notes
```

The gateway and the netstack run in their own worker thread (`DeviceNetHost`), so traffic keeps
flowing while a lockstep emulator holds the main thread; tools read a mirror of the log that
`drain()` fills synchronously.

## The firmware side: write it for the real device

Nothing Jumper-specific goes into a sketch. `WiFi.begin(ssid, pass)`, `WiFi.status()`,
`WiFi.localIP()`, `WiFi.RSSI()`, `WiFi.scanNetworks()`, `WiFiClient`, `WiFiClientSecure` with the
API's real root CA (`setCACert`), the certificate bundle or `setInsecure()`, `HTTPClient`
(streamed bodies with `getStream()`), arduinoWebSockets, PubSubClient / arduino-mqtt and
ArduinoJson all work as they are.

`jumper/arduino-esp32:3.3.12-r3` builds for the simulator by default (`JUMPER_SIM=1`). When the
sketch includes a network header it copies the sketch folder, adds one file that pulls in the
JumperSim library, and links with `-Wl,--wrap=` for:

- **Wi-Fi** (`jumper_sim_wifi.c`): the closed Wi-Fi driver calls (`esp_wifi_init`, `_start`,
  `_connect`, `_scan_*`, `_sta_get_ap_info`, the station netif's `esp_wifi_internal_tx` / rx
  callback, ...) are replaced. The station netif the sketch uses stays the same (its DHCP client,
  `WiFi.localIP()`, the usual `WIFI_EVENT_*` / `IP_EVENT_STA_GOT_IP` events, Arduino's
  auto-reconnect); its frames go out and come in through the emulated Ethernet card. Joining,
  dropping, RSSI and scans are asked of Jumper over the control channel, so Jumper decides.
- **TLS** (`jumper_sim_tls.c`): `mbedtls_x509_crt_verify_restartable` is wrapped. The sketch's own
  trust anchors are tried first, unchanged; only when they reject a chain is it checked against the
  sandbox CA, which the board receives from the sandbox network when it joins (it is not in the
  firmware image). Passthrough hosts present their real certificate and verify with the sketch's
  CAs.

`JUMPER_SIM=0` builds for the device: plain arduino-cli, no shim, no `JUMPER_SIM` define. The
factory pack's `firmware/NETWORK.md` says so.

Not emulated (stated in the fidelity notes): the radio (signal propagation, interference, roaming,
power save, real association timing), soft-AP clients, ESP-NOW, promiscuous mode, WPS, enterprise
auth, Bluetooth. RSSI is a value Jumper sets. A join that fails takes 2 s of virtual time (1 s for
a wrong password), like a scan / handshake would.

## The project side (jumper.json "network")

```json
"network": {
  "mode": "mock",
  "wifi": { "ssid": "JumperNet" },
  "secrets": ["WEATHER_KEY"],
  "allow": [
    { "host": "api.example.com", "secrets": ["WEATHER_KEY"], "headers": { "X-Api-Key": "{{secret:WEATHER_KEY}}" } },
    { "host": "test.mosquitto.org", "ports": [1883] }
  ],
  "cassette": "open-meteo"
}
```

- `mode`: `offline` (Wi-Fi up, nothing answers), `mock` (default; mocks and cassettes answer,
  nothing leaves the machine; `run_tests` always uses it), `internet` (allowed hosts also reach the
  real host; mocks and cassettes still win).
- `wifi`: the network the sandbox plays. A sketch asking for another SSID finds no access point
  (reason 201); `password` (optional) rehearses a wrong one (reason 15); `rssi` sets the starting
  signal. Leave `wifi` out and any SSID joins.
- `secrets`: names only. Values come from the environment or the project's `.env` (git-ignored),
  on the person's machine. A host gets a secret only if its allow entry lists it; the value is
  added at the gateway (`headers` templates, or `{{secret:NAME}}` sent by the firmware) and shows as
  `[secret:NAME]` in every log entry, tool answer, cassette and export, and masked in bytes going
  back to the device. A literal key in `headers` is refused with the fix.
- Mocks: `network/mocks.json` (HTTP with streamed chunks, WebSocket frames, an MQTT broker), see
  `add_mock_api`. Cassettes: `network/cassettes/<name>.json`, recorded in internet mode with
  `record: true` (or `packages/device-net/scripts/record-cassette.mts`), replayed in mock mode.

## The real device: the API relay (round 13)

The simulator adds keys at the sandbox; a real device calls the project's **API relay** instead, made
from this same `network` config (allow list, secret names, header templates, `network.relay` limits):
a Node server or a Cloudflare Worker that holds the keys, accepts one revocable token per device and
streams answers back. Firmware written with `JumperRelay.h` calls `relay.sandbox.jumper` in the
simulator (the sandbox applies the relay's own checks) and the person's relay on the device. Guide:
[api-relay.md](api-relay.md).

## Agent tools

| Tool | What it does |
| --- | --- |
| `set_network` | Change jumper.json "network" (undoable), applied live. Says which secrets are missing on this machine and returns the factory notes. |
| `add_mock_api` | Add or replace a mock, live and in network/mocks.json. |
| `try_request` | One HTTP(S) request from inside the sandbox, exactly as a device would make it. Check a mock or an allow entry before firmware exists. |
| `read_network` | The log (Wi-Fi, DHCP, DNS, HTTP, WS / MQTT sessions with frame counts and samples, blocked with why / fix), mode, allow list, mocks, faults, secrets (set / missing, never values), boards on the LAN. |
| `inject_network_fault` | `wifi_drop`, `weak_signal`, `latency`, `http_error`, `timeout`, `dns_fail`, `clear`. |

Scenario steps: `{"request": {"host", "path"?, "method"?, "status"?, "count"?, "kind"?}, "within_ms"}`
(also `"absent": true`), counted from the scenario's own start; `{"network_fault": {"kind": ...}}`.

HTTP for the web app: `GET /api/network`, `POST /api/network/fault`, `POST /api/network/try`
(apps/cli/src/routes/network.ts). The Network panel (rail → Network, phone menu → Network) shows the
same entries, the Wi-Fi state, the secrets by name, fault buttons and a Try box.

## Emulators: plugging a board in

```ts
const net = await session.networkFor(1);                     // { framePort, mac }
new QemuEspBackend({ chip: "esp32s3", network: net });       // -netdev stream → the netstack
```

`network: true` keeps QEMU's own NAT (no policy, nothing logged); `false` has no card. Each board on
one run gets its own MAC (QEMU's eFuse has none; the shim then uses the card's). Two boards on the
same network share the MQTT mock broker and can reach each other on the LAN (10.0.2.15, .16, ...).

Renode: not connected. The boards Jumper runs in Renode (Blue Pill, Nano 33 BLE) have no network
interface; Renode's own route is a Switch plus a TAP (needs privileges in the container) or an
emulated Ethernet peripheral on a board that has one (STM32F4 / F7). The netstack takes Ethernet
frames from any source, so a Renode frame bridge would be the only new piece.

## Determinism

Mock and cassette answers are the same every run, and the scenario steps check outcomes. Timing is
not bit-exact: frames cross a socket while QEMU is parked in lockstep, gateway delays (`delay_ms`,
`latency`) are wall-clock, and the emulator runs at about 0.7 to 2x real time.

## Streaming downloads (round 13)

A device that reads slowly (it plays audio while it downloads, say) used to stall a streamed body
for good or for seconds: frames that arrived together while QEMU was parked overflowed the Ethernet
driver's few RX buffers (each drop cost the sender a 1 s retransmission timeout), and a zero-window
probe byte the device kept was never accounted for, so its ACKs looked bogus and nothing more was
sent. Now QEMU's OpenCores Ethernet holds a frame until the driver frees a buffer (patch
`toolchains/qemu-esp/0005-jumper-eth-rx.patch`, what an access point's buffering looks like to the
device) and the netstack's probe takes its sequence number. Checked by
`packages/device-net/test/audio-stream.integration.test.ts` (PCM and a chunked WAV played as they
arrive, no gaps) and the zero-window unit test in `test/netstack.test.ts`. Firmware should still
buffer a little before it starts playing: a real network has jitter too.
