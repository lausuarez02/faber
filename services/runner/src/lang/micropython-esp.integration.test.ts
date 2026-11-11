// MicroPython on the ESP32 family in Jumper's QEMU: the official firmware + a littlefs image with
// main.py, booted through the bridge. Needs Docker and jumper/qemu-esp; skipped otherwise.
import { afterAll, describe, expect, it } from "vitest";
import { I2cBus } from "@jumper/sim-core";
import { QemuEspBackend } from "@jumper/sim-backends/qemu-esp";
import { imagePresent } from "./docker-guard.ts";
import { composeMicroPython } from "./micropython.ts";

const available = imagePresent("jumper/qemu-esp:9.2.2-20260417-jb2");

function run(be: QemuEspBackend, ms: number) {
  const end = be.cycles + Math.round((be.cyclesPerSecond * ms) / 1000);
  while (be.cycles < end) be.step(Math.round(be.cyclesPerSecond / 100));
}

describe.skipIf(!available)("MicroPython in QEMU (ESP32 family)", { timeout: 180_000 }, () => {
  const backends: QemuEspBackend[] = [];
  afterAll(() => backends.forEach((b) => b.close()));

  for (const [chip, led] of [["esp32", 2], ["esp32c3", 8]] as const) {
    it(`${chip}: main.py from littlefs blinks GPIO${led}${chip === "esp32" ? " and talks I2C0 to a part at 0x3C" : ""}`, async () => {
      const i2cCode = chip === "esp32" ? `from machine import I2C\ni2c = I2C(0, scl=Pin(22), sda=Pin(21))\nprint("scan", i2c.scan())\ni2c.writeto(0x3C, bytes([0x80, 0xAF]))\n` : "";
      const main = `from machine import Pin\nimport time\nled = Pin(${led}, Pin.OUT)\n${i2cCode}for i in range(4):\n    led.toggle()\n    print("blink", i)\n    time.sleep_ms(100)\nprint("done")\n`;
      const out = await composeMicroPython({ chip, files: new Map([["main.py", main]]) });
      const be = new QemuEspBackend({ chip, network: false });
      backends.push(be);
      const bus = new I2cBus("i2c0", () => be.cycles);
      const writes: number[] = [];
      bus.attach("oled", { i2cAddress: () => 0x3c, i2cConnect: () => true, i2cWrite: (b) => (writes.push(b), true), i2cRead: () => 0, i2cStop: () => {} });
      be.attachI2c(bus);
      let serial = "";
      const edges: number[] = [];
      be.onSerial((b) => (serial += String.fromCharCode(b)));
      be.onPinChange((pin, s) => pin === `GPIO${led}` && s.mode === "output" && edges.push(s.value));
      be.load(out.binary!);
      run(be, 4000);
      expect(serial).toContain("blink 3");
      expect(serial).toContain("done");
      expect(serial).not.toContain("Performing initial setup"); // the filesystem Jumper wrote mounted as is
      expect(edges.filter((v, i) => i === 0 || v !== edges[i - 1]).length).toBeGreaterThanOrEqual(4);
      if (chip === "esp32") {
        expect(serial).toContain("scan [60]");
        expect(writes).toEqual([0x80, 0xaf]);
      }
      // The REPL on UART0.
      for (const c of "print(6 * 7)\r") be.writeSerial(c.charCodeAt(0));
      run(be, 300);
      expect(serial).toContain("42");
    });
  }
});
