// Round 13: cameras on real firmware. The esp_camera fixture (fixtures/esp32/esp_camera: Espressif's
// esp32-camera API as a XIAO ESP32-S3 Sense or an ESP32-CAM sketch uses it) runs in QEMU with the
// camera port (patch 0006); Jumper's CameraBus answers esp_camera_init with the pins and renders the
// frames. Checks: detection, JPEG bytes (decoded back to the test image), RGB565 and grayscale sizes
// and pixels, vflip, FB-OVF when a frame outgrows its buffer, capture time on the virtual clock, and
// a pin mismatch failing like a real probe. Needs the native QEMU jb7 (jumper setup esp32) or its
// Docker image; skipped otherwise.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { CameraBus, decodeJpeg, DEFAULT_CAMERA_SETTINGS, renderCameraFrame, renderScene, type CameraPinRole } from "@jumper/sim-core";
import { QemuEspBackend } from "./backend.ts";
import { qemuImageAvailable } from "./launcher.ts";

const FIX = fileURLToPath(new URL("../../fixtures/esp32/", import.meta.url));
const available = qemuImageAvailable() && existsSync(`${FIX}esp_camera.esp32s3.bin.gz`);
if (!available) console.warn("skipping the camera fixture: the ESP32 emulator with the camera port is not installed (Fix: jumper setup esp32)");

const SENSE: Partial<Record<CameraPinRole, string>> = { xclk: "GPIO10", sda: "GPIO40", scl: "GPIO39", vsync: "GPIO38", href: "GPIO47", pclk: "GPIO13", d0: "GPIO15", d1: "GPIO17", d2: "GPIO18", d3: "GPIO16", d4: "GPIO14", d5: "GPIO12", d6: "GPIO11", d7: "GPIO48" };
const ESP32_CAM: Partial<Record<CameraPinRole, string>> = { pwdn: "GPIO32", xclk: "GPIO0", sda: "GPIO26", scl: "GPIO27", vsync: "GPIO25", href: "GPIO23", pclk: "GPIO22", d0: "GPIO5", d1: "GPIO18", d2: "GPIO19", d3: "GPIO21", d4: "GPIO36", d5: "GPIO39", d6: "GPIO34", d7: "GPIO35" };

function run(chip: "esp32s3" | "esp32", pins: Partial<Record<CameraPinRole, string>>, scene = "test-card") {
  const be = new QemuEspBackend({ chip, network: false, flashSizeMB: chip === "esp32s3" ? 8 : 4 });
  const bus = new CameraBus();
  bus.attach("cam", { sensor: "OV2640", cameraCapture: (req) => renderCameraFrame(scene, req) }, pins);
  be.attachCamera(bus);
  let serial = "";
  be.onSerial((b) => (serial += String.fromCharCode(b)));
  be.load(new Uint8Array(gunzipSync(readFileSync(`${FIX}esp_camera.${chip}.bin.gz`))));
  for (let i = 0; i < 6000 && !serial.includes("done") && !/cam init (?!0 )/.test(serial); i++) be.step(be.cyclesPerSecond / 1000);
  // a failed init stops the sketch: give it a moment to print
  for (let i = 0; i < 50; i++) be.step(be.cyclesPerSecond / 1000);
  return { be, bus, serial };
}

const line = (serial: string, what: string) => {
  const m = serial.match(new RegExp(`^${what} len=(\\d+) size=(\\d+)x(\\d+) fmt=(\\d+) head=(\\w+) tail=(\\w+) sum=(\\w+) px=(\\w+) ms=(\\d+)`, "m"));
  if (!m) return undefined;
  return { len: Number(m[1]), w: Number(m[2]), h: Number(m[3]), fmt: Number(m[4]), head: m[5], tail: m[6], px: parseInt(m[8]!, 16), ms: Number(m[9]) };
};

describe.skipIf(!available)("cameras on real esp32-camera firmware (QEMU camera port + CameraBus)", { timeout: 180_000 }, () => {
  const all: QemuEspBackend[] = [];
  afterAll(() => all.forEach((b) => b.dispose()));

  for (const [chip, pins, board] of [["esp32s3", SENSE, "XIAO ESP32-S3 Sense"], ["esp32", ESP32_CAM, "ESP32-CAM"]] as const) {
    it(`${chip} (${board} pins): detects the OV2640, captures JPEG / RGB565 / grayscale from the test image, drops a frame that outgrows its buffer`, () => {
      const { be, bus, serial } = run(chip, pins);
      all.push(be);
      expect(serial).toContain("cam init 0 pid=26");
      const jpeg = line(serial, "jpeg")!;
      expect(jpeg).toMatchObject({ w: 320, h: 240, fmt: 4, head: "ffd8", tail: "ffd9" });
      // the bytes the firmware got are exactly what Jumper rendered for that request
      const want = renderCameraFrame("test-card", { width: 320, height: 240, format: "jpeg", quality: 12, settings: DEFAULT_CAMERA_SETTINGS, xclkHz: 20e6 });
      expect(jpeg.len).toBe(want.data.length);
      expect(bus.stats.last).toMatchObject({ width: 160, height: 120, format: "grayscale" });
      // capture time: one OV2640 frame period at QVGA, 20 MHz XCLK (50 fps)
      expect(jpeg.ms).toBeGreaterThanOrEqual(19);
      expect(jpeg.ms).toBeLessThanOrEqual(22);
      const rgb = line(serial, "rgb565")!;
      expect(rgb).toMatchObject({ len: 96 * 96 * 2, w: 96, h: 96, fmt: 0 });
      const card = renderScene("test-card", 96, 96).rgba;
      const mid = 4 * (48 * 96 + 48);
      expect(rgb.px).toBe(((card[mid]! & 0xf8) << 8) | ((card[mid + 1]! & 0xfc) << 3) | (card[mid + 2]! >> 3));
      expect(serial).toMatch(/^too-big none \d+/m);
      expect(bus.stats.dropped).toBe(1);
      expect(bus.stats.dropWhy).toMatch(/FB-OVF/);
      const gray = line(serial, "gray")!;
      expect(gray).toMatchObject({ len: 160 * 120, w: 160, h: 120, fmt: 3 });
      expect(serial).toContain("done");
      expect(be.stats.cameraFrames).toBe(5);
    });
  }

  it("the JPEG the firmware received decodes back to the test image", () => {
    const f = renderCameraFrame("face", { width: 320, height: 240, format: "jpeg", quality: 12, settings: DEFAULT_CAMERA_SETTINGS, xclkHz: 20e6 });
    const d = decodeJpeg(f.data);
    const src = renderScene("face", 320, 240).rgba;
    let err = 0;
    for (let i = 0; i < src.length; i += 4) err += Math.abs(src[i]! - d.rgba[i]!);
    expect(err / (src.length / 4)).toBeLessThan(6);
  });

  it("pins that do not match the camera's: esp_camera_init fails like a probe on the board, and Jumper says which pin", () => {
    const { be, bus, serial } = run("esp32s3", { ...SENSE, xclk: "GPIO1" });
    all.push(be);
    expect(serial).toMatch(/cam init 261 /); // 0x105 ESP_ERR_NOT_FOUND
    expect(bus.stats.problem).toMatch(/XCLK: the firmware says GPIO10, cam is on GPIO1/);
  });
});
