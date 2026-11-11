// Round 10: an ESP32-family board through the session, the path agents, the CLI and the canvas use:
// place a Seeed XIAO ESP32-S3 + LED + resistor + button, write a sketch, build with the REAL
// toolchain (jumper/arduino-esp32, the board's simulator FQBN), run it in Espressif's QEMU (Docker),
// see the LED toggle and Serial, press the button, run a scenario, export with esptool instructions.
// Needs Docker with jumper/qemu-esp and jumper/arduino-esp32; skipped otherwise (the reason is printed).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ESP32_IMAGE } from "@jumper/runner";
import { QEMU_ESP_IMAGE } from "@jumper/sim-backends/node";
import { ProjectSession } from "../src/index.ts";

const has = (img: string) => spawnSync("docker", ["image", "inspect", img], { stdio: "ignore", timeout: 15_000 }).status === 0;
const ready = has(QEMU_ESP_IMAGE) && has(ESP32_IMAGE);
if (!ready) console.warn(`skipping the ESP32 session test: Docker is not running or ${QEMU_ESP_IMAGE} / ${ESP32_IMAGE} is missing (Fix: start Docker Desktop, then pnpm jumper setup esp32)`);

export const XIAO_BLINK_BUTTON = `// XIAO ESP32-S3: an LED on D0 blinks; a button on D1 (to GND) lights the user LED while pressed.
const int LED = D0;
const int BUTTON = D1;
void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("ready");
}
bool on = false;
unsigned long last = 0;
int was = HIGH;
void loop() {
  if (millis() - last >= 250) {
    last = millis();
    on = !on;
    digitalWrite(LED, on);
    Serial.println(on ? "LED on" : "LED off");
  }
  int b = digitalRead(BUTTON);
  if (b != was) {
    was = b;
    digitalWrite(LED_BUILTIN, b);
    Serial.println(b == LOW ? "pressed" : "released");
  }
  delay(2);
}
`;

const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

describe.skipIf(!ready)("ESP32 boards through the session (real build, real QEMU)", { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "jumper-esp32-session-"));
  const s = new ProjectSession({ dir, actor: "test" });
  afterAll(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds a XIAO ESP32-S3 sketch with the simulator FQBN into firmware/main.bin", async () => {
    await call(s, "new_project", { template: "xiao-esp32s3" });
    await call(s, "place_part", { type: "led", id: "led1" });
    await call(s, "place_part", { type: "resistor", id: "r1", props: { resistance: 220 } });
    await call(s, "place_part", { type: "pushbutton", id: "btn" });
    await call(s, "connect", { from: "xiao.GPIO1", to: "r1.1" });
    await call(s, "connect", { from: "r1.2", to: "led1.A" });
    await call(s, "connect", { from: "led1.C", to: "xiao.GND" });
    await call(s, "connect", { from: "xiao.GPIO2", to: "btn.1a" });
    await call(s, "connect", { from: "btn.2a", to: "xiao.GND" });
    await call(s, "write_file", { path: "firmware/main.ino", content: XIAO_BLINK_BUTTON });
    const b = await call(s, "build");
    expect(b.ok, JSON.stringify(b)).toBe(true);
    expect(b.artifact).toBe("firmware/main.bin");
    expect(b.simulator_build).toMatch(/XIAO_ESP32S3:CDCOnBoot=cdc,FlashMode=dio/);
    expect(existsSync(join(dir, "firmware/main.bin"))).toBe(true);
    expect(s.firmwareState()).toBe("fresh");
  });

  it("runs in QEMU: serial, the LED blinking every 250 ms, the board pull-up holding the button HIGH", async () => {
    const t0 = Date.now();
    const r = await call(s, "run", { ms: 1200 });
    console.log(`first run (QEMU boot included): 1200 ms virtual in ${Date.now() - t0} ms wall, ${r.speed}`);
    expect(r.serial).toContain("ready");
    expect(r.serial.match(/LED on/g)?.length).toBeGreaterThanOrEqual(2);
    expect(r.serial).not.toContain("pressed");
    expect(r.pins.GPIO2).toMatch(/^input_pullup H/);
    const a = await call(s, "run", { ms: 125 });
    const c = await call(s, "run", { ms: 250 });
    expect([a.parts.led1.on, c.parts.led1.on].sort()).toEqual([false, true]);
  });

  it("a button press reaches the firmware and lights the user LED (active low)", async () => {
    await call(s, "interact", { part: "btn", action: "press" });
    const r = await call(s, "run", { ms: 50 });
    expect(r.serial).toContain("pressed");
    expect(r.parts.xiao.led_user).toBe(1);
    await call(s, "interact", { part: "btn", action: "release" });
    const r2 = await call(s, "run", { ms: 50 });
    expect(r2.serial).toContain("released");
    expect(r2.parts.xiao.led_user).toBe(0);
  });

  it("runs a scenario with a button step", async () => {
    await call(s, "write_scenario", {
      id: "button",
      steps: [{ expect_serial: "ready", within_ms: 1500 }, { press: "btn" }, { expect_serial: "pressed", within_ms: 200 }, { release: "btn" }, { expect_serial: "released", within_ms: 200 }],
    });
    const t = await call(s, "run_tests", { name: "button" });
    expect(t.failed, JSON.stringify(t.results ?? t)).toBe(0);
  });

  it("export writes firmware.bin built for the REAL board (Serial on USB) with an esptool line", async () => {
    const e = await call(s, "export", {});
    expect(e.files).toContain("firmware.bin");
    expect(e.flash).toMatch(/^esptool --chip esp32s3 --port <port> --baud 921600 write_flash 0x0 .*firmware\.bin$/);
    expect(e.firmware_note).toMatch(/esp32:esp32:XIAO_ESP32S3; the simulator ran esp32:esp32:XIAO_ESP32S3:CDCOnBoot=cdc,FlashMode=dio/);
    const bin = readFileSync(join(e.dir, "firmware.bin"));
    expect(bin[0]).toBe(0xe9); // the ESP image magic of the bootloader at 0x0
  });
});
