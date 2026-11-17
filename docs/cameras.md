# Cameras

Round 13. A camera is a general capability, like I2C or the device network: any part with a
`camera` block in its part.json (a board with one built in, a module wired to a board) gives the
firmware pictures through Espressif's **esp32-camera** driver (`esp_camera.h`), the same source on
the board and in Fabwright. Nothing is built for one use: a doorbell, a plant-watcher or a keychain
that comments on what it sees are projects made from the camera, the device network (to send a
picture to an API) and audio out.

## Parts

| Part | What | Camera pins |
| --- | --- | --- |
| `seeed-xiao-esp32s3-sense` | XIAO ESP32-S3 + Sense board: OV2640 (newer batches OV3660), PDM microphone, microSD, 8 MB octal PSRAM, Li-ion charger. About 21 × 17.8 × 15 mm, $13.99 | built in: XCLK 10, SIOD 40, SIOC 39, Y9..Y2 = 48, 11, 12, 14, 16, 18, 17, 15, VSYNC 38, HREF 47, PCLK 13 |
| `ov2640-camera` | OV2640 module, 3.3 V, 2 × 9 header (the ESP32-CAM's 24-pin flex module is the same sensor and signals) | wired: any free GPIOs of an ESP32 / ESP32-S3 |

`plan_device` picks the Sense for "camera", "photo", "it can see", "look at me" wishes (no camera,
microphone, Wi-Fi or charger module needed); an ESP32 asked for by name gets the OV2640 module and
the wiring advice; a board without a camera interface (AVR, RP2040, ESP32-C3) gets a warning.

## How it runs: emulated, shimmed, not

| Layer | Status |
| --- | --- |
| The firmware (sketch, esp32-camera calls, converters such as `frame2jpg`) | **emulated**: real compiled arduino-esp32 firmware in Espressif's QEMU |
| The camera interface (ESP32 I2S camera mode, S3 LCD_CAM, DMA, XCLK, PCLK / VSYNC / HREF, SCCB registers) | **not emulated**: QEMU has no model of it |
| `esp_camera_init` / `esp_camera_fb_get` / `esp_camera_fb_return` / `esp_camera_sensor_get` / `sensor_t` settings / `esp_camera_deinit` / `reconfigure` | **shimmed** in the simulation build only (`toolchains/arduino-esp32/libraries/FabwrightCamera`, `-Wl,--wrap`); the device build links Espressif's driver unchanged |
| The frames | **rendered by Fabwright** (`packages/sim-core/src/camera.ts`) at the size and pixel format the sketch asked for |
| PSRAM | **emulated** on boards that declare it (`mcu.psram`; the Sense's 8 MB octal PSRAM through QEMU's SPI PSRAM model) |

What the shim does like the real driver: the pins in `camera_config_t` are checked against where
the camera is (built in, or the GPIOs a module is wired to): any difference fails like a real probe
(`ESP_ERR_NOT_FOUND`) and Fabwright says which pin. The sensor answers with its PID (OV2640 0x26) and
largest frame size. Frame buffers are allocated at init (`fb_count`, PSRAM or DRAM; too big:
`ESP_ERR_NO_MEM`; a board with PSRAM the emulator lacks falls back to DRAM in the simulator only),
must be returned with `esp_camera_fb_return` (else `fb_get` waits 4 s and returns NULL, as on the
board), and a frame larger than its buffer is dropped (FB-OVF, with why and the fix). Formats:
JPEG (Fabwright's baseline encoder, 4:2:2 like the OV2640, quality from `jpeg_quality` 0..63), RGB565
(big-endian, as the sensor sends it), grayscale, YUV422 (YUYV), RGB888 (B, G, R). Settings applied
to the frame: frame size, pixel format, quality, mirror, flip, brightness, contrast, saturation, AE
level, special effects, colour bars. `set_reg` keeps values but changes nothing; NVS save / load is
not supported.

Timing (virtual clock): `esp_camera_init` takes about 300 ms; a capture takes one sensor frame
period at the XCLK the sketch set (OV2640 at 24 MHz: 60 fps up to CIF, 30 up to SVGA, 15 above;
20 MHz: 20 / 40 / 80 ms). Estimates, not measured on a board.

## Where the frames come from

- a **test scene**: `test-card` (default: colour bars, a gray ramp, a circle and an arrow that shows
  mirror / flip), `color-bars`, `face`, `gradient`, `checker`, `black`, `white`, `dark-room`;
- a **still image** in the project (PNG, or a baseline JPEG), cover-cropped to the frame;
- the **webcam** in the browser (Inspector → Camera → Use my webcam).

Who sets it:

| Who | How |
| --- | --- |
| An agent | `set_camera_frame {"scene": "face"}` or `{"image": "tests/cat.jpg"}` (`"part"` with several cameras). Live, never saved in fabwright.json; survives reset and the next runs |
| A test | the scenario step `{"camera_frame": "face"}` or `{"camera_frame": {"image": "tests/cat.jpg"}, "part": "cam1"}`; each test starts from the test card. Check with `{"expect_part": "sense.camera_frames", "op": ">=", "value": 1, "within_ms": 2000}` or the firmware's serial output |
| The person | the Inspector's camera section: a scene, Show a picture (any image the browser opens, sent as a JPEG), drop an image on it, or the webcam |

The webcam opens only when the person turns it on (the browser asks for permission), shows a red
indicator in the Inspector and a pill at the bottom of the app while it is open, sends a 320 × 240
JPEG every 0.7 s to the simulator on this computer (nowhere else), and closes when turned off, after
3 minutes, when the page is hidden or another project opens.

The canvas draws the last picture in the part's lens (a 96-px JPEG preview in the part's state,
`camera_preview`); a red dot shows while the camera takes pictures (`camera_on`). The Device view
draws the lens in the case's lens hole, ringed red while the camera is on.

## Bridge protocol (QEMU patch 0006)

`toolchains/qemu-esp/0006-fabwright-camera.patch` adds `hw/misc/fabwright_camera.c` to the ESP32 and
ESP32-S3 machines: registers at `0x21100000` (next to Espressif's virtual RGB panel at
`0x21000000`) and a 4 MB frame window at `0x22000000`. Writing the command register sends one
blocking line to Fabwright and copies the answer to the result registers; a capture then fetches the
frame into the window in 4 KB chunks. Added to the bridge (version 6 unchanged, nothing removed):

```
QEMU → Fabwright                                 Fabwright → QEMU
CC <ns> <cmd> <a0> … <a7>   camera command    Q <hex>   up to 8 little-endian words
CD <offset> <n>             frame bytes        Q <hex>   the bytes
```

cmd 1 init (a0..a3 the pins, 8 bits each, 0xff = none; a4 XCLK Hz; a5 format | frame size << 8 |
quality << 16 | fb_count << 24; a6 fb location | grab mode << 8; a7 JPEG buffer size) → status
(0 ok, 1 not detected, 2 not supported, 3 frame size), PID, MID, VER, largest frame size, SCCB
address, init µs. cmd 2 capture (a0 format, a1 width, a2 height, a3 quality, a4 settings bits,
a5 buffer capacity, a6 frame size) → status, length, width, height, format, capture µs, sequence.
cmd 3 deinit. `CC` and `CD` are blocking lines (`BLOCKING_PREFIXES`). The native QEMU tag is
`9.2.2-20260417-jb7` (patches 0001-0006, with the I2S device of 0004; `fabwright setup esp32` builds it next to older tags); the Docker image of that
tag is not built yet.

## Design checks

`check_design` adds: `camera-board` (the board cannot run esp32-camera), `camera-unwired` (a
module signal is not on a GPIO), `camera-pins` (`camera_config_t`, read through `#define`s, differs
from where the camera is), `camera-psram` (frame buffers in PSRAM on a board without it, or PSRAM
off in the FQBN) and `camera-battery` (the camera and Wi-Fi bursts, up to about 380 mA on the Sense,
against what the cell gives at 1C, with a battery-life estimate). The plan's battery note gives the
burst current and picks a cell that can give it.

Round 14: `camera-indicator` (warning, any project with a camera): nothing on the device shows when
the camera is about to take or is taking a picture (no LED, no screen, and the firmware does not drive
`LED_BUILTIN`). Fix: an LED on a free GPIO lit while capturing, the screen, or the board's LED; a
spoken or on-screen countdown with a way to cancel helps too. Tests: `{"expect_capture": "cam"}` and
`preceded_by` ([behaviour-tests.md](behaviour-tests.md)); the part state has `camera_last_ms`.

## Cases

The lens is a mechanical feature of kind `camera` with `fov_deg`. The case engine exposes it by
default and cuts a round **lens** opening of the lens diameter plus the view cone through the wall
(`2 × (standoff + wall) × tan(fov / 2)`), so the wall stays out of the picture. LEDs (an indicator
that the camera is on) use the existing `led` kind with `expose: true`.

## Tests

| What | Where |
| --- | --- |
| JPEG / PNG codecs, formats, scenes, CameraBus (pins, sizes) | `packages/sim-core/src/camera.test.ts` |
| Real firmware: the `esp_camera` fixture on the ESP32-S3 (Sense pins) and the ESP32 (ESP32-CAM pins): detection, JPEG bytes equal to Fabwright's render, RGB565 pixel, grayscale, FB-OVF, capture time, a wrong pin | `packages/sim-backends/src/qemu-esp/camera.integration.test.ts` |
| The Sense boots its board fixture with octal PSRAM | `packages/sim-backends/src/qemu-esp/boards.integration.test.ts` |
| Session: template build with the shim, frames, set_camera_frame (scene, PNG, JPEG), errors, the camera_frame test, the device build without the shim | `packages/session/test/camera-session.test.ts` |
| plan_device and check_design | `packages/session/test/camera-design.test.ts` |
| Lens holes | `packages/enclosure/test/camera-hole.test.ts` |
| The page: preview in the lens, the Inspector's scene changes the next run | `apps/web/e2e/camera.spec.ts` |

## Not done

- The camera interface itself is not emulated (no DVP timing, DMA or SCCB traffic).
- No noise, exposure, white balance or lens effects; frame rates are estimates.
- The Docker images (`fabwright/qemu-esp:…-jb7`, the arduino-esp32 image with FabwrightCamera) are
  not built: Docker on the development machine is broken. Native only.
- The Sense's PDM microphone: the I2S receive path now works (patch 0004, PDM RX on the S3 is verified with a fixture source); a live browser microphone into it is not done.
- `esp_camera_save_to_nvs` / `load_from_nvs` return `ESP_ERR_NOT_SUPPORTED` in the simulator.
- Nothing was bought or run on a real XIAO ESP32-S3 Sense or OV2640.

## With audio and APIs

A camera is one general part; a device that sees and speaks is a project. `examples/see-and-say`
(XIAO ESP32-S3 Sense + GC9A01 + MAX98357A + speaker + button) captures a JPEG on a press, POSTs it to a
vision API through the relay ([api-relay.md](api-relay.md)), sends the answer to a speech API and plays
the audio over I2S ([audio.md](audio.md)). Its tests run offline (a mock and a cassette) on the real
firmware in QEMU with the camera port and the I2S device together (jb7).
