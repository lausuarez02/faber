# See and say (XIAO ESP32-S3 Sense)

Press the button: it takes a picture, asks a vision model what it sees, asks a text-to-speech model
to say the answer, and plays it. The default prompt asks for a cheeky one-line roast of whatever is in
front of the camera; change `PROMPT` in `firmware/main.ino` for anything else.

There is no "see and say" feature in Jumper. This is a project built from general parts and general
capabilities: a camera ([docs/cameras.md](../../docs/cameras.md)), I2S audio out
([docs/audio.md](../../docs/audio.md)), and API calls through the device network and the relay
([docs/api-relay.md](../../docs/api-relay.md)).

## Parts and wiring

| Part | Id | Wiring | Price (part data) |
| --- | --- | --- | --- |
| Seeed XIAO ESP32-S3 Sense | `sense` | Its camera (OV2640) is on the Sense board's own GPIOs; Wi-Fi built in; 8 MB PSRAM | $13.99 |
| GC9A01 1.28" round screen | `eyes` | VCC, LED and RST → 3V3, GND → GND, SCK → D8 (GPIO7), MOSI → D10 (GPIO9), CS → D5 (GPIO6), DC → D4 (GPIO5) | $5.50 |
| MAX98357A I2S amplifier | `amp` | VIN → 5V, GND → GND, BCLK → D1 (GPIO2), LRC → D2 (GPIO3), DIN → D3 (GPIO4); GAIN unconnected (9 dB) | $2.50 |
| Speaker 8 Ω 0.5 W, 20 mm | `spk` | + → OUT+, − → OUT− | $0.70 |
| 6 mm push button | `btn` | D0 (GPIO1) to GND, `INPUT_PULLUP` | $0.15 |

D6 and D7 (GPIO43 / 44) are left free on purpose: in Jumper's simulation build they are UART0, which
carries `Serial` (on the real board `Serial` is USB), so using them there silences the Serial panel.

`check_design` gives one warning, `amp-speaker-overpower`: the amplifier can push about 1.5 W into the
0.5 W speaker at full scale. The firmware scales every sample by `VOLUME` (0.5), which keeps API audio
under the safe 57 %. Keep it there, or strap GAIN lower.

## What it does

1. `setup()`: screen on (a face), I2S at 24 kHz 16-bit mono, the camera in JPEG at 320 × 240 with the
   frame buffer in PSRAM, Wi-Fi, then `ready`.
2. A press: `esp_camera_fb_get()` → `photo <n> bytes 320x240`.
3. Vision: the JPEG goes base64 into an OpenAI-compatible chat-completions request (`image_url` with a
   `data:image/jpeg;base64,...` URL) and the answer's `choices[0].message.content` comes back →
   `said: <text>`, shown under the face.
4. Speech: the text goes to an OpenAI-compatible `/v1/audio/speech` request with
   `"response_format": "pcm"` (raw 16-bit mono PCM at 24 kHz). The audio is streamed into I2S as it
   arrives, scaled by `VOLUME` → `played <n> bytes`.
5. Errors are printed and shown (`vision error 503`, `speech error ...`); the speech API is not called
   when the vision API failed.

Both calls go to `jumperRelayUrl(host, path)` with the device's token (`JumperRelay.h`). No API key is
ever in the firmware.

## In Jumper (offline)

`pnpm jumper test -p examples/see-and-say`, 2/2:

- `see-and-say`: the `face` test scene, a press, the photo, a 200 from the vision API, the sentence, a
  200 from the speech API, the amplifier playing, the speaker sounding, all 29,760 bytes played, the
  camera's frame counter and the screen not blank.
- `vision-down`: the vision API answers 503; the firmware says so and never calls the speech API.

`packages/session/test/see-and-say.test.ts` runs the same through the session and also checks that both
calls went through the relay (vision from the mock, speech from the cassette), that the run's recording
peaks at the firmware's volume, and that the device build has no relay settings in it.

What is real and what is not in the simulator:

| Piece | In Jumper |
| --- | --- |
| Firmware | The real arduino-esp32 build, run in Espressif's QEMU (emulated CPU, flash, PSRAM). |
| Camera | The esp32-camera calls are answered by Jumper's shim (simulation build only); frames are clean renders of a test scene, a picture or the webcam. The camera interface hardware is not emulated. |
| Screen | SPI from the real Adafruit GC9A01A driver to Jumper's GC9A01 model. |
| Audio | The real ESP_I2S driver and DMA, through QEMU's I2S device, into the MAX98357A model; the page plays what the run played. |
| Wi-Fi + HTTPS | The real WiFi / HTTPClient / TLS code; the radio is not emulated (Wi-Fi rides an emulated Ethernet card). |
| APIs | `network/mocks.json` answers the vision call (a hand-written OpenAI-style answer). `network/cassettes/speech.json` answers the speech call with a generated voice-like chirp. Neither was recorded from a real provider; `scripts/make-network.mjs` writes both. |

The cassette matches the speech request's exact body. If you change the model, voice or the vision
answer, run `node examples/see-and-say/scripts/make-network.mjs` (after editing it) or record a new one.

## With real APIs

Any vision LLM and any TTS work. The firmware speaks the OpenAI-compatible shapes. Point the four
defines at the provider, and list the hosts in the project's network:

| Define | What it is |
| --- | --- |
| `VISION_HOST`, `VISION_PATH`, `VISION_MODEL` | An endpoint that takes OpenAI-style chat completions with an image (`image_url` data URL). Many hosted and local LLM servers offer this. |
| `SPEECH_HOST`, `SPEECH_PATH`, `SPEECH_MODEL`, `SPEECH_VOICE`, `SPEECH_RATE` | An endpoint that takes OpenAI-style `/audio/speech` and returns raw PCM. Set `SPEECH_RATE` to the rate it returns (24000 for OpenAI's `pcm`). |

A provider with its own request shape (another vision API, or a TTS API that takes a voice id in the
path and its own key header) needs `describe()` or `say()` changed: the body and the parsing, nothing
else. Check the provider's docs for the exact fields; the hosts and paths here are placeholders.

### Where the keys live: the relay

The keys never go on the device. The relay holds them and adds them to each request
([docs/api-relay.md](../../docs/api-relay.md)):

```sh
# 1. the hosts and which key each gets (names only; values never go in jumper.json)
jumper call set_network '{"secrets": ["VISION_API_KEY", "SPEECH_API_KEY"], "allow": [
  {"host": "<vision host>", "secrets": ["VISION_API_KEY"], "headers": {"Authorization": "Bearer {{secret:VISION_API_KEY}}"}},
  {"host": "<speech host>", "secrets": ["SPEECH_API_KEY"], "headers": {"Authorization": "Bearer {{secret:SPEECH_API_KEY}}"}}]}' -p see-and-say
# 2. the relay folder, a token for this device, the keys in .env (VISION_API_KEY=..., SPEECH_API_KEY=...)
jumper relay init -p see-and-say
jumper relay token add star-1 -p see-and-say
jumper relay serve -p see-and-say          # or deploy relay/ to Cloudflare Workers (relay/README.md)
# 3. RELAY_URL, WIFI_SSID, WIFI_PASSWORD in .env, then the git-ignored header the device build reads
jumper relay device-header -p see-and-say
```

The relay checks the device token, allows only the listed hosts, adds the keys, applies the limits in
`network.relay` (20 requests a minute, 256 KB up, 4 MB down, 60 s per stream here), and logs each call
without keys. The device keeps only its own token (revocable) and the Wi-Fi password, in its flash.

Cost: each press is one vision call (a 320 × 240 JPEG is a small image for most providers) and one TTS
call for one sentence. The rate limit caps the worst case at 20 presses a minute; check the providers'
prices per call.

## Real hardware: not verified

Nothing in this example has been built on a real board yet. Battery life, speaker loudness, how long a
press takes over real Wi-Fi, and the camera's picture quality are untested. The camera, Wi-Fi radio and
real APIs have only been simulated here.
