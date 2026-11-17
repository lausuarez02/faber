# The API relay: the real device reaches APIs without a key in it

Round 13. In the simulator, Faber's sandbox adds API keys at the edge ([network.md](network.md)). A
real device needs the same thing: somewhere that holds the keys and adds them, so the firmware never
carries one. The relay is that place, generated from the same `faber.json` `network` config, and
generic: it knows hosts, secret names and header templates, never which API or what the device does.

```
device ── https://<relay>/<api host>/<path> + X-Device-Token ──▶ relay ── + API key ──▶ https://<api host>/<path>
                                                                  │
                                                  allow list, token check, limits, a log line without secrets
```

## What it does

| Check / feature | How |
| --- | --- |
| Which device | `X-Device-Token`. The relay stores only SHA-256 hashes (`RELAY_DEVICE_TOKENS=name:hash,...`); a token reaches only the relay. Revoke = remove its name. 401 with why / fix otherwise. |
| Which hosts | `network.allow` (hosts, wildcards, ports). Anything else: 403 `host-not-allowed`. TLS-passthrough hosts are not relayed (403 `host-not-relayed`: the device calls them directly). |
| Keys | `allow[].headers` templates (`"Bearer {{secret:NAME}}"`) and `{{secret:NAME}}` sent by the firmware, only to hosts that list NAME; never over plain HTTP (403 `secret-over-http`). Values: the relay's `.env` or `wrangler secret put NAME`. |
| Where a host is sent | Round 14: an allow entry with `"to"` (a service the person runs, e.g. `{"host": "glimpse.local", "local": true, "to": "http://127.0.0.1:7821"}`) goes to that address on the relay too, as it does in the simulator; the device keeps calling the host's name. A loopback or home-network `to` works when the relay runs on that computer / network; a Cloudflare relay needs the service's public https URL in `relay.config.mjs`. 502 `upstream-unreachable` names the address and that fix. |
| Limits per device | `network.relay`: `requests_per_minute` (60), `max_request_kb` (1024), `max_response_kb` (32768), `max_stream_seconds` (300). 429 with `Retry-After`, 413, a stream cut at the limit. |
| Streaming | Answers stream as they arrive (chunked, SSE, audio); chunked uploads stream up; WebSockets pass through (Node: piped byte for byte; Worker: bridged frame by frame), keys added to the upgrade request. |
| Logs | One JSON line per request: device, method, host, path, query keys (no values), status, bytes, ms, secret names used. Values of keys and the token never appear; an API that echoes a key back has it masked (`*`, same length) on the way to the device (HTTP bodies and headers). |

Code: `packages/device-net/src/relay/relay-core.mjs` (Fetch API, no dependencies), `node-server.mjs`
(`server.mjs` in the pack), `worker.mjs` (`worker.js`), `firmware/FaberRelay.h`; the generator is
`packages/device-net/src/relay.ts`. All MIT, so a person can deploy and change them freely.

## The same rules in the simulator

The simulation build adds a `faber_device.h` with `FABER_RELAY_URL "https://relay.sandbox.faber"`
and a simulation token. The sandbox gateway answers that host with the relay core's own `authorize()`
(token, rate, allow list, ports, size), then serves the target exactly like a direct request: mocks,
cassettes, faults, internet mode, secrets at the edge, the Network log (entries marked `via: "relay"`).
So the firmware that gets a 200 from a mock through the sandbox relay gets the same request through
the real relay, and a host off the list is refused with the same 403 in both.

Verified with a real XIAO ESP32-S3 build in QEMU (`packages/session/test/relay-firmware.integration.test.ts`):
the sketch posts through `faberRelayUrl("api.example.com", ...)`, gets the mock's answer (200), and
`evil.example.org` gets `403 host-not-allowed`; a person's `faber_device.h` in the folder never reaches
the image.

## Use it

```sh
faber call set_network '{"secrets": ["API_KEY"], "allow": [{"host": "api.example.com", "secrets": ["API_KEY"],
  "headers": {"Authorization": "Bearer {{secret:API_KEY}}"}}]}' -p my-device
faber relay init -p my-device                 # relay/: server.mjs, worker.js, wrangler.toml, README, FaberRelay.h
faber relay token add my-device-1 -p my-device # raw token → .env DEVICE_TOKEN, hash → .env RELAY_DEVICE_TOKENS
faber relay serve -p my-device                # on this computer (port 8787), or deploy relay/ (below)
# .env: RELAY_URL=..., WIFI_SSID=..., WIFI_PASSWORD=...
faber relay device-header -p my-device         # firmware/<sketch>/faber_device.h (git-ignored)
```

Cloudflare Workers (wrangler is the person's install; Faber does not ship it):

```sh
cd relay && npx wrangler login
npx wrangler secret put RELAY_DEVICE_TOKENS && npx wrangler secret put API_KEY
npx wrangler deploy
```

`relay/` is also in the factory pack (`export_manufacturing`) and in the build kit download, and the
kit's **Connect** section walks a person through keys, relay, tokens, Wi-Fi, a check and cost.

## Firmware

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include "FaberRelay.h"

NetworkClientSecure client;
void setup() {
  if (!faberRelayReady()) { Serial.println(faberRelayWhy()); return; }
  WiFi.begin(FABER_WIFI_SSID, FABER_WIFI_PASSWORD);
  client.setCACert(FABER_RELAY_ROOT_CA);
  HTTPClient http;
  http.begin(client, faberRelayUrl("api.example.com", "/v1/..."));
  http.addHeader(FABER_TOKEN_HEADER, FABER_DEVICE_TOKEN);
  int code = http.POST(body);
}
```

- `FaberRelay.h` (MIT) is added by the build when the sketch includes it and its folder has none;
  `faber relay device-header` also writes it next to the sketch for builds outside Faber.
- WebSocket clients: `faberRelayEndpoint(host, path)` gives `{host, port, tls, path}`.
- `FABER_RELAY_ROOT_CA` defaults to a small bundle of public roots (ISRG Root X1 / X2, GTS Root R1 / R4,
  GlobalSign Root CA; workers.dev chains to GTS Root R4, checked 2026-11-12); `--ca file.pem` replaces it.

### Wi-Fi credentials: the default and why

The default is a **git-ignored header made from `.env`** (`faber_device.h`: relay URL, device token,
Wi-Fi SSID and password). It works on every board and core, needs no extra library, and keeps the
values out of the repository, the simulator build, the factory pack and the kit (Faber's runner drops
`faber_device.h` from every build it makes; the firmware there says `faberRelayReady()` is false).
The cost: the token and the Wi-Fi password are in that device's flash, readable by anyone holding it.
That is why the token is per device, reaches only the relay, and is revocable; the API keys are never
on the device.

A first-boot captive portal (for example WiFiManager, MIT) is the better choice for a device given to
someone else on another network. Faber does not generate one yet: the Wi-Fi radio is not emulated
(soft-AP clients are a stated gap in [network.md](network.md)), so it could not be tested here.

## Honest limits

- The Node relay and the Worker's code are tested with real HTTP / WebSocket traffic (Node) and with
  the Worker module run in Node against a `fetch` mock and a fake `WebSocketPair` (wrangler is not
  installed here). Nothing was deployed to Cloudflare in this round.
- The Worker's rate limit is per instance (Cloudflare runs several), so it is a guard against a runaway
  device, not an exact quota.
- MQTT and other raw TCP are not relayed (MQTT over WebSocket is). Keys in a URL query or a JSON body
  are not filled in; use a header. Secrets echoed inside WebSocket frames are not masked.
- The sandbox relay checks a content length after reading the body; a chunked upload over the limit is
  refused at the end, not cut mid-stream as the real relay does.

## An example that uses it

`examples/see-and-say` sends a camera picture to a vision API and the answer to a speech API, both
through `faberRelayUrl()`, and streams the speech (raw PCM, `http.useHTTP10(true)`) into I2S. Its
network config lists both hosts with a secret each (`Authorization: Bearer {{secret:...}}`) and tighter
relay limits; its README walks through `faber relay init / token add / serve / device-header` for it.
The sandbox relay answers the vision call from a mock and the speech call from a cassette, so the tests
pass offline (`packages/session/test/see-and-say.test.ts`).
