// Round 13: cameras in the plan and the design checks (no emulator needed): plan_device picks a board
// with a camera for "camera / see / photo" wishes, check_design catches a board that cannot run a
// camera, unwired or mismatched camera pins, PSRAM, and camera + Wi-Fi bursts against the battery.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Project } from "@faber/project-format";
import { registry } from "@faber/parts";
import { checkDesign, planDevice, ProjectSession } from "../src/index.ts";
import { sketchCameraPins } from "../src/drc-camera.ts";

const AI_THINKER = `#include "esp_camera.h"
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
void setup() {
  camera_config_t config;
  config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM; config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM; config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM; config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM; config.pin_pwdn = PWDN_GPIO_NUM; config.pin_reset = RESET_GPIO_NUM;
  config.frame_size = FRAMESIZE_UXGA; config.fb_location = CAMERA_FB_IN_PSRAM;
  esp_camera_init(&config);
}
void loop() {}
`;

/** An ESP32 DevKitC with an OV2640 wired the AI-Thinker ESP32-CAM way. */
function devkitWithCamera(skip: string[] = []): Project {
  const map: Record<string, string> = { D0: "GPIO5", D1: "GPIO18", D2: "GPIO19", D3: "GPIO21", D4: "GPIO36", D5: "GPIO39", D6: "GPIO34", D7: "GPIO35", XCLK: "GPIO0", PCLK: "GPIO22", VSYNC: "GPIO25", HREF: "GPIO23", SIOD: "GPIO26", SIOC: "GPIO27", PWDN: "GPIO32", "3V3": "3V3", GND: "GND" };
  const wires = Object.entries(map)
    .filter(([p]) => !skip.includes(p))
    .map(([p, g], i) => ({ id: `w${i}`, from: { part: "cam", pin: p }, to: { part: "esp", pin: g } }));
  return { format: "faber/1", name: "t", parts: [{ id: "esp", type: "esp32-devkitc", x: 0, y: 0 }, { id: "cam", type: "ov2640-camera", x: 300, y: 0 }], wires, scenarios: [], firmware: { board: "esp", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.bin", build: { tool: "arduino-cli", fqbn: "esp32:esp32:esp32" } } } as unknown as Project;
}
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("plan_device: cameras", () => {
  it("a wish to see picks a board with the camera built in, no camera / mic / charger modules, and says what the bursts cost", () => {
    const p = planDevice("a keychain that has a camera so it can see and send what it sees to an api, and a microphone", {}, registry);
    expect(p.bom[0]!.type).toBe("seeed-xiao-esp32s3-sense");
    expect(p.bom[0]!.why).toMatch(/camera built in/);
    const types = p.bom.map((l) => l.type);
    expect(types).not.toContain("ov2640-camera");
    expect(types).not.toContain("esp01-wifi");
    expect(types).not.toContain("sound-sensor");
    expect(types).not.toContain("tp4056-charger");
    expect(p.battery?.note).toMatch(/up to about 380 mA in bursts/);
    expect(p.cannot_check.join(" ")).toMatch(/picture quality/);
  });

  it("an asked-for ESP32 gets the OV2640 module and the wiring advice; an Uno is told it cannot", () => {
    const esp = planDevice("photos with an esp32", { board: "esp32-devkitc" }, registry);
    expect(esp.bom.map((l) => l.type)).toContain("ov2640-camera");
    expect(esp.warnings.join(" ")).toMatch(/16 signals/);
    const uno = planDevice("an arduino that takes photos", { board: "arduino-uno" }, registry);
    expect(uno.warnings.join(" ")).toMatch(/cannot run a camera/);
    // "see the time" is not a camera
    expect(planDevice("a clock so I can see the time", {}, registry).bom.map((l) => l.type)).not.toContain("ov2640-camera");
  });
});

describe("check_design: cameras", () => {
  it("reads camera_config_t pins through #defines", () => {
    expect(sketchCameraPins(AI_THINKER)).toMatchObject({ xclk: 0, sda: 26, scl: 27, d0: 5, d7: 35, pwdn: 32, reset: -1 });
  });

  it("an ESP32 DevKitC with an OV2640 wired like the sketch: no camera errors; PSRAM is the problem", () => {
    const issues = checkDesign(devkitWithCamera(), registry, AI_THINKER);
    expect(codes(issues)).not.toContain("camera-pins");
    expect(codes(issues)).not.toContain("camera-unwired");
    const ps = issues.find((i) => i.code === "camera-psram");
    expect(ps?.message).toMatch(/no PSRAM/);
    expect(ps?.message).toMatch(/Fix:/);
  });

  it("unwired data lines and pins that differ from the sketch are errors that name the pin", () => {
    const unwired = checkDesign(devkitWithCamera(["D3", "PCLK"]), registry, AI_THINKER);
    expect(unwired.find((i) => i.code === "camera-unwired")?.message).toMatch(/cam\.PCLK, cam\.D3/);
    const moved = AI_THINKER.replace("#define XCLK_GPIO_NUM 0", "#define XCLK_GPIO_NUM 15");
    expect(checkDesign(devkitWithCamera(), registry, moved).find((i) => i.code === "camera-pins")?.message).toMatch(/pin_xclk = 15, but cam's XCLK is on GPIO0/);
  });

  it("a board without a camera interface is an error", () => {
    const p: Project = { format: "faber/1", name: "t", parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }, { id: "cam", type: "ov2640-camera", x: 300, y: 0 }], wires: [], scenarios: [], firmware: { board: "uno", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" } } } as unknown as Project;
    expect(checkDesign(p, registry, "").find((i) => i.code === "camera-board")?.severity).toBe("error");
  });

  it("the Sense: its own pins pass, PSRAM off in the build is a warning, a small cell against camera + Wi-Fi bursts", () => {
    const sense = (fqbn: string, capacity: number): Project =>
      ({ format: "faber/1", name: "t", parts: [{ id: "sense", type: "seeed-xiao-esp32s3-sense", x: 0, y: 0 }, { id: "bat", type: "lipo-battery", x: 200, y: 0, props: { capacity } }], wires: [{ id: "w1", from: { part: "bat", pin: "POS" }, to: { part: "sense", pin: "BAT" } }, { id: "w2", from: { part: "bat", pin: "NEG" }, to: { part: "sense", pin: "GND.2" } }], scenarios: [], firmware: { board: "sense", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.bin", build: { tool: "arduino-cli", fqbn } } }) as unknown as Project;
    const src = `#include "esp_camera.h"\n#include <WiFi.h>\nvoid setup(){ camera_config_t c; c.pin_xclk = 10; c.pin_sccb_sda = 40; c.pin_sccb_scl = 39; c.pin_d0 = 15; c.pin_d7 = 48; c.pin_vsync = 38; c.pin_href = 47; c.pin_pclk = 13; c.fb_location = CAMERA_FB_IN_PSRAM; esp_camera_init(&c);} void loop(){}`;
    const small = checkDesign(sense("esp32:esp32:XIAO_ESP32S3", 150), registry, src);
    expect(codes(small)).not.toContain("camera-pins");
    expect(small.find((i) => i.code === "camera-psram")?.message).toMatch(/PSRAM turned off.*PSRAM=opi/);
    const bat = small.find((i) => i.code === "camera-battery")!;
    expect(bat.severity).toBe("warning");
    expect(bat.message).toMatch(/380 mA in bursts.*150 mAh.*Fix: a cell of 400 mAh/);
    const big = checkDesign(sense("esp32:esp32:XIAO_ESP32S3:PSRAM=opi", 1000), registry, src);
    expect(codes(big)).not.toContain("camera-psram");
    expect(big.find((i) => i.code === "camera-battery")?.severity).toBe("info");
  });
});

describe("set_camera_frame without a camera", () => {
  it("says to place one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "faber-cam-none-"));
    const s = new ProjectSession({ dir, actor: "test" });
    try {
      await s.call("new_project", { template: "uno" });
      await expect(s.call("set_camera_frame", { scene: "face" })).rejects.toThrow(/no camera.*seeed-xiao-esp32s3-sense/is);
      await expect(s.call("write_scenario", { id: "c", steps: [{ camera_frame: "face" }] })).rejects.toThrow(/no camera/i);
    } finally {
      s.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
