import type { Usage } from "./hints.ts";
import { CAMERA_STARTER_INO } from "./templates.ts";

/**
 * Round 13 (camera): get_part usage for the camera parts. Cameras are a general capability:
 * Espressif's esp32-camera driver (esp_camera.h) on an ESP32 / ESP32-S3; in Faber's simulation
 * build its API is answered by Faber (frames from a scene, an image or the webcam).
 */
const SHOW = 'What it sees in the simulator: set_camera_frame {"scene": "face"} or {"image": "tests/cat.jpg"} (live, not saved), in tests {"camera_frame": "face"}; the person can drop a picture or use the webcam in the Inspector. State: camera_frames, camera_size ("320×240 JPEG"), camera_on, camera_preview (the last picture, drawn in the lens). Check with {"expect_part": "<id>.camera_frames", "op": ">=", "value": 1, "within_ms": 2000}.';

export const CAMERA_HINTS: Record<string, Usage> = {
  "seeed-xiao-esp32s3-sense": {
    wiring: "The camera, microphone and microSD are on the Sense board: nothing to wire. camera_config_t: pin_pwdn -1, pin_reset -1, pin_xclk 10, pin_sccb_sda 40, pin_sccb_scl 39, pin_d7 48, pin_d6 11, pin_d5 12, pin_d4 14, pin_d3 16, pin_d2 18, pin_d1 17, pin_d0 15, pin_vsync 38, pin_href 47, pin_pclk 13, xclk 20 MHz. Frame buffers in PSRAM (fb_location CAMERA_FB_IN_PSRAM; the FQBN needs PSRAM=opi). Mic: PDM CLK GPIO42, DATA GPIO41 (I2S PDM RX). microSD: CS GPIO21 (also the user LED) on D8 / D9 / D10. A LiPo goes on the BAT pads underneath (the board charges it).",
    example: CAMERA_STARTER_INO,
    controls: SHOW,
  },
  "ov2640-camera": {
    wiring: "3V3 → the board's 3V3 (never 5 V), GND → GND, and the 16 signals to free GPIOs of an ESP32 / ESP32-S3, with the same numbers in camera_config_t: SIOD (pin_sccb_sda), SIOC (pin_sccb_scl), XCLK, PCLK, VSYNC, HREF, D0..D7 (pin_d0..pin_d7 = sensor Y2..Y9), PWDN (or -1 and tie it to GND), RESET (or -1 and tie it to 3V3). ESP32: the ESP32-CAM layout (XCLK 0, SIOD 26, SIOC 27, D0..D7 = 5, 18, 19, 21, 36, 39, 34, 35, VSYNC 25, HREF 23, PCLK 22, PWDN 32) avoids the flash pins; keep the wires short (the pixel bus runs at 10 to 20 MHz). Without PSRAM: fb_location CAMERA_FB_IN_DRAM, fb_count 1, QVGA or smaller.",
    connect: ["ov2640camera1.3V3 -> esp.3V3", "ov2640camera1.GND -> esp.GND", "ov2640camera1.XCLK -> esp.GPIO0", "ov2640camera1.SIOD -> esp.GPIO26", "ov2640camera1.SIOC -> esp.GPIO27", "ov2640camera1.D0 -> esp.GPIO5", "ov2640camera1.D1 -> esp.GPIO18", "ov2640camera1.D2 -> esp.GPIO19", "ov2640camera1.D3 -> esp.GPIO21", "ov2640camera1.D4 -> esp.GPIO36", "ov2640camera1.D5 -> esp.GPIO39", "ov2640camera1.D6 -> esp.GPIO34", "ov2640camera1.D7 -> esp.GPIO35", "ov2640camera1.VSYNC -> esp.GPIO25", "ov2640camera1.HREF -> esp.GPIO23", "ov2640camera1.PCLK -> esp.GPIO22", "ov2640camera1.PWDN -> esp.GPIO32"],
    controls: SHOW,
  },
};
