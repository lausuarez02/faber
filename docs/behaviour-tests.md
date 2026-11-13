# Testing behaviour over time: random moments, cameras, speech, offline queues

Round 14. A device that acts "at random", talks before it does something, takes pictures and
uploads them later is tested with ordinary scenarios. Nothing here is about one device: a pet that
wakes at random, a doorbell camera, a plant logger that queues readings offline all use the same
steps. Worked example (real firmware in QEMU):
[`packages/session/test/random-photo.integration.test.ts`](../packages/session/test/random-photo.integration.test.ts).

## Randomness that repeats

The ESP32 emulator seeds the chip's hardware random number generator (QEMU `-seed`), so
`esp_random()` and Arduino's `random()` (without `randomSeed`) return the same sequence for one seed.

| Where | How |
| --- | --- |
| Tests | Every scenario is seeded from its id (`run_tests` always repeats). `"seed": 7` on the scenario (write_scenario) picks another sequence. |
| Live | `run {"ms": 10000, "seed": 7}` (a new seed restarts at 0 ms), `{"seed": null}` random again. |
| Reboots | A reboot inside a run (`reset_board`, a power cycle) moves on to seed + 1, + 2 ...: a real chip does not replay its numbers after a reset. `run {reset: true}` / a new test start over from the seed. |

AVR and RP2040 firmware is deterministic already (avr-libc's `random()` and the Pico core's
`rand()` are seeded the same every boot unless the sketch seeds them from a pin).

## Time

- Virtual time is what the firmware sees (`millis()`, `delay()`, FreeRTOS ticks). A firmware that
  mostly waits runs about 10x faster than real time on the ESP32 emulator (25 virtual s in about
  7 s here), so "every 10 minutes" is a `run_ms` / `within_ms` of 600000 that takes about a minute.
  Raise the scenario's `timeout_ms` (default 60000) for long tests.
- Wall-clock time comes from NTP: the sandbox answers NTP itself (`pool.ntp.org`, `time.google.com`
  and other time servers resolve in mock mode too). `"clock": "2031-05-01T08:00:00Z"` on a scenario,
  the step `{"set_clock": "2026-12-24T09:00:00Z"}`, or `run {"clock": ...}` set what it answers from
  then on, advancing with virtual time. Default: this computer's clock.
- There is no "skip ahead" that jumps over firmware execution: the firmware runs every virtual
  millisecond (that is what makes the timing real). Make waits configurable in firmware when a test
  would need hours.

## Steps

| Step | What it checks |
| --- | --- |
| `{"said": "picture in 10", "within_ms": 30000}` | Words a talking part played (a DFPlayer clip) **or the text the firmware sent to a speech API** (a request whose path looks like speech / tts / synthesize, field `input`, `text`, `input.text` or `ssml`; OpenAI, Google, ElevenLabs shapes). The time is when the request was made. |
| `{"expect_capture": "cam", "within_ms": 60000}` | The camera took a picture (each `esp_camera_fb_get`), counted since the last matched `expect_capture`. `true` instead of a part id: any camera. `"count": 3` for several. |
| `{"expect_capture": true, "absent": true, "within_ms": 12000}` | No picture from this step on (e.g. after a cancel press). |
| `"preceded_by": {"said" \| "serial" \| "capture" \| "request": ..., "min_ms", "max_ms"}` | On `expect_capture` and `request`: the named event happened between min_ms and max_ms before. `{"expect_capture": "cam", "preceded_by": {"said": "picture in 10", "min_ms": 9000, "max_ms": 11000}}` proves the countdown was spoken 10 s before the picture; `{"request": {...}, "preceded_by": {"capture": true, "max_ms": 15000}}` that an upload followed a picture. A failure says when each event happened. |
| `{"press": "btn", "hold_ms": 200}` after a `said` / `expect_serial` | A press inside a window: the said step waits for the announcement, the press lands right after it. |
| `{"request": {"host", "method", "path", "status", "content_type", "body_contains", "body_json", "min_bytes"}, "within_ms"}` | What the request carried. `body_json` matches JSON, form and multipart fields by dot path (`"messages.0.role"`), with `"x*"` (starts with) and `"?"` (present, not empty); a multipart file part has `<name>.filename`, `<name>.content_type`, `<name>.bytes`. `read_network` shows every request's `content_type` and `body` (fields, parts, the start of a text body; secrets redacted). |
| `{"network_fault": {"kind": "wifi_drop"}}` ... `{"network_fault": {"kind": "clear"}}` | Wi-Fi goes down (the firmware sees it disconnect, DNS and connections fail) and comes back (WiFi.reconnect / auto-reconnect joins again). |
| `{"reset_board": true}` | Reboots the board now (reset button / power cycle): virtual time, the parts, the logs go on; **what the firmware wrote to flash stays** (LittleFS, SPIFFS, NVS / Preferences). |
| `{"set_clock": "..."}` | NTP's answer from now on, and (round 15) what RTC parts such as the DS3231 read. |

### The offline queue, end to end

```json
{ "id": "offline-queue-posts-later", "timeout_ms": 120000, "steps": [
  { "expect_serial": "wifi ok", "within_ms": 15000 },
  { "network_fault": { "kind": "wifi_drop" } },
  { "expect_capture": true, "within_ms": 40000 },
  { "expect_serial": "queued 1", "within_ms": 3000 },
  { "request": { "host": "api.social.test", "path": "/v1/posts" }, "absent": true, "within_ms": 2000 },
  { "reset_board": true },
  { "expect_serial": "queue 1", "within_ms": 5000 },
  { "network_fault": { "kind": "clear" } },
  { "request": { "host": "api.social.test", "method": "POST", "path": "/v1/posts", "status": 201,
                 "content_type": "multipart/form-data", "body_json": { "photo.content_type": "image/jpeg" } },
    "within_ms": 30000 }
] }
```

## APIs: mocks from OpenAPI, and real services on this computer

- **Any API from its OpenAPI 3 file**: `add_mock_api {"mock": {"kind": "openapi", "host":
  "api.social.test", "spec": "network/social.openapi.yaml"}}` (JSON or YAML in the project). Every
  operation answers its example (or one built from its schema, the same every run), path parameters
  fill same-named fields, `"responses": {"createPost": {"status": 503}}` fixes an answer. Each request
  is checked against its operation (method, path under the server's base path, Content-Type, required
  body, the JSON schema, multipart parts and their types, query and path parameters): one that does not
  fit gets 400 with the problems, the log entry says why and the fix, and a `request` step with
  `"status": 201` fails with it. An unknown path gets 404 listing the operations.
- **A real service you run here** (a dev server, the social network's backend): opt ONE host in,
  `set_network {"allow": [{"host": "api.social.test", "local": true, "to": "http://127.0.0.1:7821"}]}`.
  The device keeps calling its own name (`https://api.social.test/...`, TLS ends at the sandbox, the
  service gets plain HTTP with the original Host header). It works in mock mode too (nothing leaves
  this computer), so `run_tests` can call it; mocks still answer first. `.local` names (mDNS, e.g.
  `http://mystar.local/`) are answered for opted-in hosts.
- **Safety model**: nothing on this computer or the LAN is reachable unless a host opts in. A host in
  `allow` that resolves to a loopback, private, link-local or CGNAT address is refused in every mode
  without `"local": true` (so a public name pointing at 127.0.0.1 cannot reach your services); `to`
  requires `"local": true`; wildcards (`*.example.com`) can use neither. Every refusal says what, why
  and the fix.
- Tests run the simulation synchronously: a local service must run in its own process (as it would),
  not on the event loop of the process that runs the tests.

## Design checks that go with it

- `camera-indicator` (warning): a camera part with no LED, no screen and no `LED_BUILTIN` in the
  firmware. People near a camera should see when it is about to take, or is taking, a picture.
- `battery-life` (warning under `power.target_hours`, info when met): battery life from duty cycles
  (`estimate_power`, `set_power {"target_hours", "duty"}`); see [power.md](power.md#battery-life-from-duty-cycles-round-14).

## Not covered

The microSD card is not emulated (LittleFS / SPIFFS / NVS on the flash are). The speech is checked as
the text sent to the API (and the I2S audio played, see [audio.md](audio.md)), not as sound. Wi-Fi
radio behaviour (roaming, power save timing) is not emulated; `wifi_drop` is a clean link loss.

## Sleeping devices (round 15)

A board that calls `esp_deep_sleep_start()` sleeps in the simulator: no firmware runs, so
`{"run_ms": 86400000}` passes a day in seconds, and it wakes on its timer or a wake pin with RTC
memory, the clock and the wake cause kept. Check it with `{"expect_part": "<board>.asleep", "op": "==", "value": true}`
and open a lid with `{"set": "lid.magnet", "value": "away"}`. Guide: [low-power.md](low-power.md).
