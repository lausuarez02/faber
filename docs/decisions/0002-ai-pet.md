# 0002 — An AI pet on a colour screen: TFT, Wi-Fi and the sandbox network

Status: accepted · 2026-11-09

The goal: a tamagotchi with an AI inside and a colour screen, whose firmware would run unchanged on
real hardware, with tests that stay deterministic. Three questions: which screen, how the board
reaches a language model, and which board.

## Screen: ILI9341 (and ST7735), emulated at the controller

The 2.8in 320x240 ILI9341 SPI module is the cheapest colour screen in every Arduino kit and the one
Adafruit_ILI9341 / Adafruit_GFX / TFT_eSPI tutorials use. We emulate the controller, not the
library: `packages/parts/src/lib/mipiPanel.ts` implements the MIPI-DCS command set those libraries
send (CASET / PASET windows with wrap, RAMWR, MADCTL rotation and mirroring, RGB/BGR order, COLMOD
16 and 18 bit, sleep, display on/off, inversion, reset, register reads through the ILI9341's 0xD9
index). The same class serves the ST7735 (1.8in 128x160) with a different geometry and rotation
table, so it was cheap to add.

The frame is 150 KB, too big for `visualState()` (which the canvas reads every frame), so a colour
display exposes it through a new optional `PartModel.framebuffer()` → `ColorFrame` (RGB565 in viewer
orientation, a version counter), and `Simulation.framebuffer(partId)`. Renderers diff against the
last frame they painted and `putImageData` only the changed rectangle (`apps/web/src/renderers/tft`),
so several views can read the same part. `visualState` keeps cheap scalars for tests (`lit`,
`bright`, `rotation`, `frame`).

Two simulator details mattered: libraries toggle D/C and CS faster than the 5 ms threshold where the
Simulation starts solving PWM-like pins on duty-averaged values, so a part could no longer read
their level from the circuit. `PartContext.digital(pin)` now returns the live GPIO level when a board
pin drives the net (directly or through resistors), and SPI chip-select uses it too.

## AI inside: an ESP-01 with the AT firmware, talking to a sandbox network

| Option | For | Against |
| --- | --- | --- |
| **ESP-01 (ESP8266, Espressif AT firmware) on a UART** | The classic "Uno + Wi-Fi" combo, a few dollars, any sketch that works with it here works on the bench | 3.3 V part, 115200-baud default, half-duplex SoftwareSerial pitfalls |
| An ESP32 / ESP8266 as the main board | Wi-Fi built in, plenty of RAM | A new CPU backend (Xtensa) Jumper does not have |
| A "magic" AI part with a pin protocol | Easy to simulate | Does not exist; firmware would be useless on hardware |
| Arduino Uno R4 WiFi / Nano 33 IoT | Real boards with Wi-Fi | ARM backends missing; their Wi-Fi coprocessors use their own protocols |

**Choice: ESP-01S with the AT firmware, behaviourally emulated** (`packages/parts/src/parts/esp01-wifi`).
The board sends the same AT commands it would send to a real module (`AT+CWJAP`, `AT+CIPSTART`,
`AT+CIPSEND`, …) over SoftwareSerial; the part decodes and encodes the UART bit by bit on the board's
pins (cycle-exact, through `ctx.watch` and `ctx.schedule`), answers with the AT 1.7 text in the same
order with typical delays, and delivers `+IPD,<len>:` data. Its TCP/TLS links go to a **sandbox
network** the host passes in (`SimulationOptions.services.network`, types in
`packages/sim-core/src/network.ts`). Being bit-exact surfaced real-world behaviour for free: the
factory 115200 baud is garbage to a 9600 receiver, the boot ROM prints at 74880, and SoftwareSerial
garbles a reply that arrives while the sketch is still transmitting. The reference sketch handles all
three, as it must on a bench.

The sandbox network (`services/ai-gateway`) has one open access point, **JumperNet**, a DNS table and
HTTP hosts. `ai.jumper` serves the pet:

```
GET /v1/pet?a=talk&f=40&j=70&e=80&n=Pip HTTP/1.0      (a = talk|feed|play|sleep|lonely|hello)
→ HTTP/1.0 200 OK, Content-Length, Connection: close, body "happy|Yum! That hit the spot"
```

The body is `<mood>|<text>`, mood in happy / hungry / sleepy / sad / excited, text at most 60
printable ASCII characters: a 2 KB board parses it with `strchr`, no JSON library. The gateway
sanitises whatever a model returns into that shape. The whole HTTP response is about 100 bytes, so
it fits SoftwareSerial's 64-byte buffer when the sketch reads while it arrives.

### Who answers: a provider chain with a deterministic default

1. `ANTHROPIC_API_KEY` set → the Anthropic Messages API, model `claude-haiku-5-5`, effort low.
2. Else the `claude` CLI on PATH → `claude -p --model claude-haiku-5-5 --output-format json` with
   the persona as system prompt, no tools, no MCP, no session, 25 s timeout (the logged-in account).
3. Else, and **always in tests, CI, scenarios and any run faster than real time**: the **mock**, a
   seeded table of pet lines picked by a hash of the request and a counter, with a virtual latency of
   400 to 799 ms that is a pure function of the same inputs. `run {reset}` resets the counter, so a
   re-run gives the same replies at the same virtual times.

Live calls are rate limited (one per 1.5 s, 20 per minute; over the limit the pet gets a 429 with a
pet-readable body) and identical questions are cached for 15 s. A failed live call is reported as
502/504 with the provider's message in the network log; it is never silently replaced by a mock
answer. Keys are read from the environment at call time and never logged.

Latency is virtual time: in mock mode it is the computed figure; in live mode (`run_live` in the
session, or the browser at 1x with Live on) the simulation runs at real time, the firmware waits
like it would on a bench, and the reply is delivered at the first poll after the call returns, so
the virtual latency is the real one (2 to 4 s with the CLI).

The same gateway runs as a real HTTP server (`node services/ai-gateway/bin/ai-gateway.mjs`, port
8787), so the sketch works on a real board by pointing `AI_HOST` at the computer's LAN address. The
browser cannot run the CLI, so its Live mode forwards to that server.

## Board: the Uno is enough

We considered adding the Mega 2560 (8 KB RAM, hardware Serial1 for the ESP). The reference sketch
uses 25.1 KB of flash (77 %) and 841 bytes of globals (41 %) on the Uno: Adafruit_ILI9341 has no
framebuffer, the reply buffer is 64 bytes and the request is built on the stack. The Uno also matches
what most kits contain. The Mega stays on the list for sketches that need more (an LLM reply with
history, JSON), together with a hardware-UART path for the ESP part (today it needs GPIO edges, so
it does not work on the Uno's D0/D1, which Jumper reserves for the USB console anyway).

## What is emulated and what is not

In `fidelity.json` of each part, summarised:

- **Emulated:** the AT command protocol a sketch uses, bit timing on the UART, baud changes, echo,
  busy and error replies, +IPD framing, auto-reconnect after a Wi-Fi loss; the TFT command set,
  rotation, colour order, sleep / reset, backlight.
- **Approximate:** AT command delays (typical figures), TLS handshake time (a fixed 950 ms),
  colours (no gamma), power (constant 80 mA for the ESP, 80 mA for the TFT).
- **Not emulated:** RF, real association, packet loss, TLS certificate checks and CPU cost, ESP
  current peaks that brown out a weak 3.3 V supply, transparent mode / AT+HTTPCLIENT, panel refresh
  and tearing, touch controllers.

## Real-device checklist

1. Power the ESP-01 from a 3.3 V regulator that gives 300 mA (AMS1117-3.3 with 10 µF + 100 nF), not
   the Uno's 3V3 pin; common ground.
2. 1 kΩ / 2 kΩ divider from the Uno's D3 to the ESP's RX.
3. Set the module to 9600 baud once (the sketch does it with `AT+UART_DEF` when it finds 115200).
4. `WIFI_SSID`, `WIFI_PASS`, and `AI_HOST` = the LAN IP of the computer running the gateway; open
   port 8787 in its firewall; `AI_PORT 8787`.
5. A 2.8in module with 3.3 V logic needs a level shifter on CS/DC/RST/MOSI/SCK (the Adafruit
   breakout has one).
6. Check `AT+GMR`: AT 1.7.x firmware answers like the sandbox; very old 0.9.x answers differently.

## Update 2026-11-10 (round 5, decision 0003)

The persona test (`jumper-evals/personas/REPORT.md`, b1, u3) showed the pet could not hear the
person: the protocol had no message field and Live needed a terminal. Now `m=` (URL-encoded, 60
characters max) carries what the person said to the model, the web app's Network panel has a
"Say something to the pet" box that attaches it to the pet's next request (no firmware change), and
`jumper serve` starts the gateway itself. The mock stays deterministic: it quotes the message in a
canned line, so tests can see the words arrived without a model.

