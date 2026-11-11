// The fixture test every ESP32-family board part names in mcu.verified (round 10, decision 0006):
// real arduino-esp32 firmware, built by Jumper's runner with the board's simulator FQBN
// (fixtures/esp-boards/build.ts), boots in Espressif's QEMU through the server-side factory with the
// board's part.json mcu block, and its GPIO out, GPIO in with the internal pull-up and Serial work.
// ESP32 DevKitC's I2C0 is proven by qemu-esp.integration.test.ts (same FQBN family).
// Needs Docker and the jumper/qemu-esp image; skipped otherwise, with the reason printed.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { McuBackend } from "@jumper/sim-core";
import { createNodeBackendFactory } from "../node.ts";
import { QEMU_ESP_IMAGE, qemuImageAvailable } from "./launcher.ts";

const available = qemuImageAvailable();
if (!available) console.warn(`skipping ESP board fixtures: Docker is not running or ${QEMU_ESP_IMAGE} is missing (Fix: start Docker Desktop, then pnpm jumper setup esp32)`);

const BOARDS: { id: string; out: string; in: string }[] = [
  { id: "seeed-xiao-esp32s3", out: "GPIO1", in: "GPIO2" },
  { id: "seeed-xiao-esp32c3", out: "GPIO3", in: "GPIO4" },
  { id: "esp32-c3-supermini", out: "GPIO10", in: "GPIO9" },
  { id: "esp32-devkitc", out: "GPIO2", in: "GPIO4" },
  { id: "esp32-s3-devkitc-1", out: "GPIO4", in: "GPIO5" },
];

const partJson = (id: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../parts/src/parts/${id}/part.json`, import.meta.url)), "utf8")) as {
    mcu: Parameters<ReturnType<typeof createNodeBackendFactory>>[0]["mcu"];
  };
const firmware = (id: string) => new Uint8Array(gunzipSync(readFileSync(fileURLToPath(new URL(`../../fixtures/esp-boards/${id}.bin.gz`, import.meta.url)))));

function runMs(be: McuBackend, ms: number) {
  const chunk = Math.round(be.cyclesPerSecond / 1000);
  const end = be.cycles + Math.round((be.cyclesPerSecond * ms) / 1000);
  while (be.cycles < end) be.step(chunk);
}

describe.skipIf(!available)("ESP32-family boards boot real firmware (fixture tests for mcu.verified)", () => {
  const all: McuBackend[] = [];
  afterAll(() => all.forEach((b) => b.dispose?.()));
  const factory = createNodeBackendFactory({ labels: { "jumper.test": "boards" } });

  it.each(BOARDS)("$id: boots, GPIO out toggles, GPIO in reads its INPUT_PULLUP and a button, Serial prints", async ({ id, out, in: inp }) => {
    const spec = partJson(id);
    const be = factory({ partId: "board", type: id, mcu: spec.mcu });
    all.push(be);
    expect(be.kind).toBe("process");
    let serial = "";
    const edges: number[] = [];
    be.onSerial((b) => (serial += String.fromCharCode(b)));
    be.onPinChange((pin, s, cycle) => {
      if (pin === out && s.mode === "output") edges.push((cycle * 1000) / be.cyclesPerSecond);
    });
    const t0 = Date.now();
    await be.prepare!(firmware(id));
    const bootMs = Date.now() - t0;
    be.load(firmware(id)); // same image: a no-op after prepare
    // The circuit's pull-up would hold the input HIGH; here the test is the circuit.
    be.setPinInput(inp, 3.3);
    const w0 = Date.now();
    runMs(be, 1500);
    const wallMs = Date.now() - w0;
    expect(serial).toContain(`boot ${id}`);
    expect(be.readPin(inp).mode).toBe("input_pullup");
    expect(edges.length).toBeGreaterThanOrEqual(8);
    const gaps = edges.slice(2).map((t, i) => t - edges[i + 1]!);
    for (const g of gaps) expect(Math.abs(g - 100)).toBeLessThan(3);
    be.setPinInput(inp, 0);
    runMs(be, 50);
    be.setPinInput(inp, 3.3);
    runMs(be, 50);
    expect(serial).toMatch(/in=0 t=\d+/);
    expect(serial.match(/in=1 t=\d+/g)?.length).toBeGreaterThanOrEqual(2);
    console.log(`${id}: container + boot to t=0 in ${bootMs} ms; 1.5 s virtual in ${wallMs} ms wall (${(1500 / wallMs).toFixed(2)}x real time)`);
    be.dispose!();
  }, 90_000);

  it("an unknown chip says what to fix", () => {
    expect(() => factory({ partId: "b", type: "x", mcu: { backend: "qemu-esp", chip: "esp8266", clockHz: 80e6, vcc: 3.3 } })).toThrow(/does not run.*Fix: correct mcu.chip/);
  });
});
