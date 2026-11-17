# Audio: I2S out and in, on any board that has it

Round 13. Sound is a general capability: a board's I2S bus, the I2S parts on it (an amplifier and a
speaker, a microphone), and the page playing what a run played. A device that says what an API
returns is a project built from these, Wi-Fi + HTTP + I2S + an amplifier (see
[examples/see-and-say](../examples/see-and-say/README.md)). It is not a voice feature.

## Which boards

| Board family | I2S in Fabwright | How |
| --- | --- | --- |
| ESP32, ESP32-S3, ESP32-C3 | **emulated**, verified on real firmware | QEMU's I2S device (patch `0004-fabwright-i2s.patch`): the controllers, their DMA (ESP32's own, S3 / C3 GDMA), the sample rate from the clock registers, the EOF interrupts that pace `write()`. Details: [esp32-peripherals.md](esp32-peripherals.md#i2s-round-13-track-audio-emulated-verified-on-real-firmware). |
| RP2040 (Pico, XIAO RP2040, RP2040-Zero) | **no** | RP2040 I2S runs on PIO, which is not turned into audio. Use an ESP32-family board for I2S audio. |
| STM32, nRF52 | **no** | Not modelled. |
| AVR (Uno, Nano) | – | No I2S on the chip. Use a DFPlayer-style module for sound. |

[boards.md](boards.md) has the per-board I2S column with the test behind each cell.

## Parts

| Part | Role | In the simulator |
| --- | --- | --- |
| `max98357a` | I2S DAC + 3 W class-D amplifier | Plays the bus's frames. State: `playing`, `level` (RMS of the samples, 0..1), `sampleRate`, `outVrms`. GAIN: floating 9 dB, GND 12 dB, VIN 6 dB, 100 kΩ to GND 15 dB, 100 kΩ to VIN 3 dB. |
| `speaker`, `speaker-15mm`, `speaker-20mm` | Speakers on an amplifier's outputs | `sounding` and the power they get. |
| `inmp441` | I2S MEMS microphone | A source on the bus: the firmware's I2S reads return its samples. |
| `seeed-xiao-esp32s3-sense` | The Sense board's PDM microphone (GPIO42 / 41) | A board-level PDM source; PDM RX on the S3 returns it as PCM. |

The canvas draws a level bar under any part that reports `playing` and `level`.

## The page plays what the board played

Each `run` that played I2S audio writes a WAV of it to `.fabwright/audio/run-<seq>.wav` (the last 20 are
kept). The run's `audio` field and the log entry name it, and it is served at `GET /api/audio/<file>`.
The followed page plays it with WebAudio, in step with the frames. It never plays under a test driver,
in a hidden tab or when the page is muted. The recording is mono 16 kHz of the I2S stream, without the
amplifier's gain or channel choice or the speaker's response; replays are silent.

## Design checks

| Code | What it catches |
| --- | --- |
| `amp-speaker-overpower` | Watts the amplifier can push into the speaker at full scale against its rating, with the safe level in % and dBFS and the fixes (scale samples, strap GAIN lower, a bigger speaker). Example: a 0.5 W 20 mm speaker on a 5 V MAX98357A gets about 1.53 W at full scale: keep samples at or below 57 % (−5 dBFS). |
| `amp-no-speaker` | An amplifier with nothing on its outputs. |
| `amp-out-shorted` | OUT+ or OUT− tied to ground, a supply or a board pin (the outputs are bridge-tied). |
| `amp-speaker-impedance` | A speaker below the amplifier's minimum load. |

## Audio from an API

Stream it, do not buffer it: open the request, read what has arrived, write whole samples to I2S. Raw
PCM (with or without content length) and WAV (skip the 44-byte header) both work. Verified on real
firmware: `packages/device-net/test/audio-stream.integration.test.ts` streams raw PCM and a chunked WAV
from a mock API into I2S on an ESP32-S3, and every sample arrives at the right pitch and level.
`examples/see-and-say` does it through the relay over HTTPS ([api-relay.md](api-relay.md)).

Use `http.useHTTP10(true)` with `HTTPClient` when reading the raw stream: `getStreamPtr()` hands out the
socket, so a chunked HTTP/1.1 body would carry its chunk-size lines into the audio.

Decoders and their licences:

| Option | Licence | Note |
| --- | --- | --- |
| Raw PCM / WAV over HTTP or WebSocket | none needed | the simplest; most TTS APIs can return PCM (the WebSockets library is LGPL-2.1) |
| ESP_I2S `playMP3()` (libhelix, in arduino-esp32) | RPSL / RCSL | verified on the S3; keep its notices if you ship it |
| minimp3 | CC0 | fine to bundle |
| ESP32-audioI2S, ESP8266Audio, arduino-audio-tools | GPL-3.0 | not shipped by Fabwright |

## Limits

- Frames cross to Fabwright, not BCLK / WS edges. No slave mode, A-law / u-law or bit-order swaps.
- The emulated CPU runs at 125 MIPS, slower than a 240 MHz chip: computing every sample in a loop can
  run dry in the emulator where the chip might not. Use a table or stream from the network.
- Network timing is wall-clock: on a loaded machine a stream can pause in virtual time.
- The browser microphone does not feed an `inmp441` or the Sense's mic yet.
- Nothing here was compared with real hardware: loudness, distortion and current are model figures.
