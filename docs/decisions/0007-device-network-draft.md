# 0007: Device network, the generic layer

Status: round 9 draft, **built end to end in round 10** (branch `round10/net`, see "Round 10" at
the end) · 2026-11-11 · package `packages/device-net` · user guide [docs/network.md](../network.md)

The person wants emulated boards to reach APIs "in an easy way", as a foundation:
"it's about having the fundamentals of being able to add an api or something to the requests in
an easy way, then from there we can for example do the ai voice, but i don't want to custom build
something for the voice". So this round builds no voice code. A weather API, an AI stream, MQTT
telemetry and a webhook all go through the same gateway as ordinary traffic.

## What exists today (main)

- `services/ai-gateway` + `packages/session/src/network.ts`: a sandbox network for the ESP-01 AT
  part with one built-in host (`ai.fabwright/v1/pet`) and its own `set_ai_mode` / `read_network_log`
  / `run_live`. It works at the level of AT commands and is specific to the pet. The new layer
  replaces its insides (see Migration); the agent-facing names stay close.

## Design

```
 emulated chip (QEMU open_eth / Renode / ESP-01 AT part / test harness)
        │ Ethernet frames or AT sockets
 backend adapter (netstack sidecar, slirp guestfwd, AT part)  ← per emulator, no policy here
        │ DNS/NTP datagrams + TCP flows to (fake ip, port)     FABWRIGHT-FLOW/1 over a local socket
 DeviceNet gateway (packages/device-net, Node, Apache-2.0)    ← all policy, one place
   DNS (fake IPs 198.18/15) · policy (offline | mock | internet+allow) · faults
   TLS: inspect with the sandbox CA, or passthrough
   HTTP / WebSocket / MQTT / raw → mocks → cassette → real host (secrets injected here)
   NetLog (redacted) → read_network tool, Network panel, scenario asserts, factory notes
```

1. **Transport-level boundary.** Backends hand the gateway what the device does: UDP datagrams
   (`udp(ip, port, bytes)`, DNS on 53 and SNTP on 123 answered here) and TCP flows
   (`connect({ip, port})` in process, or `attach(socket, dst)` / the `FABWRIGHT-FLOW/1` socket
   protocol across processes). No chip knowledge, no API knowledge.
2. **Fake-IP DNS.** Every name the policy allows gets a stable address in 198.18.0.0/15 (the n-th
   name is 198.18.0.n, so runs are deterministic). A later flow to that address maps back to the
   name, which works for HTTP, TLS, MQTT or any raw protocol without guessing from SNI or Host.
   Refused names get NXDOMAIN and a `blocked` log entry with why and fix.
3. **Modes per project** (`fabwright.json` `network`):
   - `offline`: Wi-Fi up, nothing answers (rehearse "no internet").
   - `mock` (default, always used by `run_tests`): only mocks and cassettes answer.
   - `internet`: hosts in `allow` also reach the real host; mocks and cassettes still win.
4. **TLS.** `inspect` (default): the gateway terminates TLS with a per-machine sandbox CA
   (proposed location `~/.fabwright/sandbox-ca`, never in a project or export; ECDSA P-256, 5 years; leaf per host, cached, 30 days) and re-encrypts
   upstream with real verification. Needed for mocks, logs of paths, secrets and cassettes. The
   simulation build trusts the CA (`#ifdef FABWRIGHT_SIM`, `client.setCACert(FABWRIGHT_SANDBOX_CA)`).
   `passthrough`: bytes go end to end with the real certificate; only host, port, bytes and timing
   are known, and no secrets can be added (config refuses the combination).
5. **Protocols by sniffing the first bytes** after TLS: HTTP (incl. WebSocket upgrade), MQTT
   (first byte 0x10), otherwise raw (internet-only, byte counts).
6. **Mocks**, generic, in `network/mocks.json` (committed):
   - HTTP: `{host, method?, path (exact or prefix*), response: {status, headers, body | body_b64 | chunks: [{data|b64|bytes, delay_ms}], delay_ms}}`. `chunks` streams with chunked encoding.
   - WebSocket: `{kind: "ws", host, path, on_open: [frames], on_message: [{match, send: [{text|b64|bytes, delay_ms, repeat}], close}]}`.
   - MQTT: `{kind: "mqtt", host, on_publish: [{topic (wildcards), reply: [{topic, payload}]}], retained: [...]}`; one broker per mock host, shared by all boards in the run (two boards can talk).
   - `*.mock.js` (scripted handlers) is deferred: it means running project code in the gateway, which
     needs a sandbox (worker + no fs/net). JSON covers the cases above.
7. **Cassettes** (`network/cassettes/<name>.json`, committed): `internet` + `record: true` records
   each real exchange (request key = method + host + path + body hash; headers kept as names only;
   hop and identifying response headers dropped; everything redacted). `mock` mode replays them in
   order, so a test that hit a real API runs offline and identically.
8. **Secrets.** `network.secrets: ["OPENAI_API_KEY"]` (names only, `UPPER_SNAKE`). Values come from
   the environment or the project's git-ignored `.env`, on the person's machine. A host gets a secret
   only if its allow entry lists it. Two ways to use one, both expanded at the gateway:
   `allow[].headers: {"Authorization": "Bearer {{secret:OPENAI_API_KEY}}"}`, or the firmware itself
   sends the literal `{{secret:NAME}}` (the same request works against a real relay that does the
   same substitution). The config refuses literal keys in headers and undeclared secrets, with
   field, why and fix. The `Redactor` replaces values with `[secret:NAME]` in every log entry, tool
   output and cassette, and masks them (same length, `*`) in bytes going back to the device, also
   when a value is split across stream chunks (holds back only bytes that could start a secret, and
   releases them after 30 ms so a live stream never stalls).
9. **Faults** (`inject_network_fault`): `wifi_drop` (open flows reset, DNS fails), `latency`,
   `http_error` (status, host/path, count), `timeout` (accept, never answer), `dns_fail`, `clear`.
10. **Visibility.** One `NetLog`: dns, http (method, host, path, status, source = mock / cassette /
    internet / fault / sandbox, bytes, ms, redacted headers, secret names used), ws and mqtt
    sessions (frame / packet counts, bytes, the first 11 samples and the last), connect
    (passthrough / raw / TLS failures), udp, blocked (why + fix), fault. `read_network` returns it
    with mode, allow list, mock list and active faults. The Network panel renders the same entries
    (subscribe with `onEvent`). Scenario step `{"request": {host, path?, method?, status?, count?}}`
    → `checkRequest`, which on failure says what the device did instead (or why it was blocked).
11. **Factory pack**: `factoryNetworkNotes(config)`: hosts and ports the real device needs, secret
    names, the three honest options for keys on a real device (relay you run, recommended;
    short-lived tokens from the relay or provider; key in firmware, readable from flash, prototype
    only), and that the real firmware must use real root CAs.

## How emulators plug in (the part this spike did not run end to end)

Checked in `fabwright/qemu-esp:9.2.2-20260417-prebuilt` (Espressif QEMU 9.2.2): NIC models `open_eth`;
netdev backends `user` (slirp), `stream`, `dgram`, `socket`, `tap`, ... Options:

| Option | How | Verdict |
| --- | --- | --- |
| A. slirp `user` + `restrict=on` + `guestfwd` | DNS gives one gateway IP; `guestfwd=tcp:10.0.2.100:<port>-cmd:...` per port; host recovered from SNI / Host | Quick to try, but loses the host for MQTT / raw, one rule per port, and slirp DNS goes to the container resolver. Fallback only. |
| B. `-netdev stream` (raw Ethernet frames) → a small netstack sidecar → `FABWRIGHT-FLOW/1` | The sidecar (Go, gVisor netstack, Apache-2.0, as gvisor-tap-vsock does) answers ARP/DHCP, forwards UDP 53/123 and every TCP flow with its real destination to the gateway | **Chosen.** Same path for QEMU (ESP32, C3, S3, Linux boards) and Renode (its TAP / switch can feed frames), keeps fake-IP DNS, no per-port rules. |
| C. ESP-01 AT part (existing) | `SandboxNetwork.open()` becomes a thin adapter over `DeviceNet.connect` | Keeps today's AT path, just changes what answers. |

The gateway's side of B is built and tested (`serveFlows`, real local TCP socket). The sidecar and
an ESP-IDF / Arduino firmware with `open_eth` in QEMU are the next step (the esp32 track owns the
firmware). Checked in `fabwright/arduino-esp32:3.3.12-r1`: `ETH.h` has no OpenETH PHY and the
prebuilt ESP32 libs' `sdkconfig.h` has no `CONFIG_ETH_USE_OPENETH` (0 matches in dio_qspi and
qio_qspi), so a stock Arduino sketch cannot use QEMU's `open_eth`. Options: rebuild the Arduino
libs with OpenETH (esp32-arduino-lib-builder) for the simulation build only, or an ESP-IDF build.
Real Wi-Fi is not emulated by Espressif QEMU either way; in simulation `WiFi.begin()` has to be
mapped onto the Ethernet link (a sim-only shim), which is a fidelity gap to state in the report.

## Firmware side (hints + plan_device, `src/hints.ts`)

Fabwright ships none of these; the toolchain image installs what a sketch uses. Licenses checked
2026-11-11 through the GitHub license API:

| Library | Use | License |
| --- | --- | --- |
| arduino-esp32 core (WiFi, WiFiClientSecure, HTTPClient) | Wi-Fi, TLS, HTTP(S), streamed bodies via `getStreamPtr()` | LGPL-2.1 |
| Links2004/arduinoWebSockets | WebSocket client, text + binary frames | LGPL-2.1 |
| knolleary/pubsubclient | MQTT 3.1.1, QoS 0 publish | MIT |
| 256dpi/arduino-mqtt | MQTT with QoS 1/2 publish | MIT |
| bblanchon/ArduinoJson | JSON | MIT |
| gilmaimon/ArduinoWebsockets | WebSocket client | GPL-3.0 (avoid; hints say so) |

## Licenses of what Fabwright ships here

`ws` (MIT), `@peculiar/x509` (MIT) and its tree (`@peculiar/asn1-*` MIT, `asn1js` BSD-3,
`pvtsutils` / `pvutils` / `tsyringe` MIT, `reflect-metadata` Apache-2.0, `tslib` 0BSD). DNS, MQTT,
WebSocket frame reading and the mock server are our own code. QEMU (GPL-2.0) stays a separate
process in its own container, disclosed in NOTICE as today. A gVisor-based sidecar would be
Apache-2.0.

## Migration of the pet AI (later round)

`ai.fabwright/v1/pet` becomes an ordinary HTTP mock (deterministic replies), and "live" becomes
`internet` mode with an allow entry for the model provider and a `{{secret:...}}` header; `run_live`
stays as "run at real time" for any internet-mode project. `read_network_log` maps to
`read_network`; `set_ai_mode` becomes a convenience that edits `network.mode`.

## Verified in this spike (real runs, M4 Max, Node 24.13.1, vitest 5.1.0)

- `pnpm typecheck` → exit 0. `npx vitest run` in `packages/device-net` → 14/14 passed, ~2.1 s, 3
  consecutive runs identical.
- HTTPS GET to a mocked API through sandbox DNS + TLS inspect: 10 ms first (new leaf cert), 2.2 ms
  cached.
- Chunked HTTP body streamed as produced (10 chunks, 40 ms apart, arrive spread over > 250 ms).
- WebSocket mock stream: 50 binary frames of 3200 B (any binary payload), scripted 20 ms apart,
  arrive in order over 1031 to 1071 ms (980 ms scripted), ~150 KiB/s; log keeps counts, bytes and
  12 samples.
- MQTT mock broker: CONNECT / SUBSCRIBE with retained config / PUBLISH QoS 1 with PUBACK / rule
  reply on another topic, all summarized in the log.
- Blocked host: NXDOMAIN at DNS and reset at TCP (direct IP), each with why and fix; offline and
  mock modes say why too.
- Secret injected at the edge (template header and firmware-sent template); upstream received the
  real value; device, log, `read_network` output, cassette file and factory notes never contain it;
  a secret aimed at a host not given it → 502 with why / fix.
- Cassette recorded in internet mode, replayed in mock mode with the upstream gone, same body.
- WebSocket forwarded to an allowed (local) upstream with the secret injected and frames summarized.
- Faults: http_error count 1, latency 300 ms, timeout (no answer, logged), wifi_drop (open
  WebSocket closed, DNS fails, restored after clear).
- TLS handshake refused by the device (untrusted CA) is logged with the fix.
- `FABWRIGHT-FLOW/1` flow server over a real local TCP socket: DNS then HTTPS, 10 to 28 ms.
- Real internet (manual script, `fabwright-spikes/network/live/live-check.mts`): inspect
  `https://example.com/` → 200, 577 B, 77 ms; passthrough `https://api.github.com/zen` → 200, 72 ms,
  real Sectigo certificate seen by the device.

## Not verified / gaps

- No emulated chip has used it yet: the netstack sidecar (option B) and an `open_eth` firmware in
  QEMU are not built. mbedTLS inside QEMU ESP32 talking to the sandbox CA is unproven.
- Time is wall clock. Delays (`delay_ms`, latency) must move to the simulation's virtual clock
  (`Clock` is injectable already) so `run_tests` is deterministic at any speed; while QEMU runs at
  real time the two coincide.
- Not wired into `packages/session` (tool routing, `project-format` schema for `network`, the
  Network panel in `apps/web`, the scenario `{"request": ...}` step). Tool schemas and handlers
  exist in `src/tools.ts`.
- MQTT: no QoS 2, no will, no `{{secret:}}` in the CONNECT password yet; MQTT over WebSocket goes
  through the WS path (not summarized as MQTT).
- UDP other than DNS / NTP is refused (no CoAP, no raw UDP to the internet). IPv6 not handled
  (AAAA gets an empty answer).
- HTTP/1.1 only towards the device (fine for microcontrollers); upstream HTTP/2-only services fail.
- A secret split across two stream chunks that arrive more than 30 ms apart can reach the device
  unmasked (the held prefix is released). Logs and cassettes are unaffected.
- `*.mock.js` scripted mocks deferred (needs a sandbox for project code).
- Cassette matching ignores query order and headers; non-deterministic request bodies (timestamps)
  will miss unless the mock path is used.

## An AI voice example later, built only on this

A project declares `network.secrets: ["OPENAI_API_KEY"]` and an allow entry for the provider with a
`{{secret:...}}` header (or a relay host). The firmware records from an I2S mic part, opens a
WebSocket (arduinoWebSockets) or a streaming HTTPS POST, sends audio as binary frames and plays the
binary frames that come back through an I2S DAC part. Tests use a `ws` mock whose `on_message`
answers with recorded audio frames (`b64` / `bytes`, `delay_ms`), or a cassette of a real session;
`checkRequest` asserts the request; `latency` and `wifi_drop` rehearse bad networks. Nothing in the
gateway knows it is audio.

## Round 10: what was built (branch `round10/net`)

The plan above, with two changes found on the way:

- **The netstack is TypeScript, not a Go / gVisor sidecar.** Only the far side of TCP is needed
  (the device always connects out) and QEMU's stream netdev is a reliable, ordered link, so a small
  stack in `packages/device-net/src/netstack` (Ethernet, ARP, IPv4, ICMP echo, UDP, a DHCP server,
  server-side TCP with window, retransmission and zero-window probing, an L2 switch between boards)
  does the job in one process with the gateway, with no extra toolchain or container. It runs with
  the gateway in a worker thread (`DeviceNetHost`), so frames keep flowing while a lockstep emulator
  blocks the main thread.
- **Firmware trusts the sandbox CA without any `#ifdef`.** The simulation build wraps
  `mbedtls_x509_crt_verify_restartable`: the sketch's own CAs first, then the sandbox CA, which
  the board receives from the netstack when it joins. Sketches set the real root CA and stay
  identical for the device. Wi-Fi is a link-time shim of the `esp_wifi_*` driver API (the station
  netif is kept; its frames use the emulated Ethernet card), controlled by Fabwright over EtherType
  0x88B5: join / refuse (unknown SSID 201, wrong password 15), drop (beacon timeout 200), RSSI,
  scans.

Also built: fabwright.json `network` in the project schema, tools `read_network`, `add_mock_api`,
`inject_network_fault` (+ `weak_signal`), `set_network`, `try_request`; scenario steps `request`
and `network_fault` (run_tests forces mock mode); firmware/NETWORK.md in the factory pack; the
Network panel (`GET /api/network`, fault buttons, a Try box); gateway delays and log times on the
simulation's virtual clock; `QemuEspBackend {network: {framePort, mac}}`; examples
`esp32-api-demo` (real recorded Open-Meteo cassette, mock MQTT broker) and `esp32-ws-stream`.
Renode is not connected: its boards here have no network interface (see docs/network.md).
