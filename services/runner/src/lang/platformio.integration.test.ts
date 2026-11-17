// PlatformIO (pio run in fabwright/platformio) building an Uno project that Fabwright runs on avr8js:
// blink on D13, serial, and an I2C write to a part at 0x3C with Wire. Needs Docker and the image.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAvrBackend } from "@fabwright/sim-backends";
import { I2cBus } from "@fabwright/sim-core";
import { buildFirmware } from "../build.ts";
import { imagePresent } from "./docker-guard.ts";
import { PLATFORMIO_IMAGE } from "./toolchain.ts";

const available = imagePresent(PLATFORMIO_IMAGE.image);

describe.skipIf(!available)("PlatformIO (atmelavr)", { timeout: 600_000 }, () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("builds an Uno env; the hex blinks D13, prints, and writes I2C; errors map to src/ file:line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fabwright-pio-"));
    dirs.push(dir);
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    write("platformio.ini", "[env:uno]\nplatform = atmelavr@5.3.0\nboard = uno\nframework = arduino\n");
    write("src/main.cpp", '#include <Arduino.h>\n#include <Wire.h>\nvoid setup() {\n  Serial.begin(115200);\n  pinMode(13, OUTPUT);\n  Wire.begin();\n  Wire.beginTransmission(0x3C);\n  Wire.write(0x80);\n  Wire.write(0xAF);\n  Serial.println(Wire.endTransmission() == 0 ? "i2c ok" : "i2c nack");\n}\nvoid loop() {\n  digitalWrite(13, !digitalRead(13));\n  Serial.println("tick");\n  delay(100);\n}\n');
    const r = await buildFirmware({ sketchDir: dir, language: "platformio", chip: "atmega328p", displayPrefix: "firmware/" });
    expect(r.ok, r.logTail).toBe(true);
    expect(r.size?.flashMax).toBe(32256);
    const be = createAvrBackend({});
    const bus = new I2cBus("i2c0", () => be.cycles);
    const writes: number[] = [];
    bus.attach("oled", { i2cAddress: () => 0x3c, i2cConnect: () => true, i2cWrite: (b) => (writes.push(b), true), i2cRead: () => 0, i2cStop: () => {} });
    be.attachI2c?.(bus);
    let serial = "";
    let edges = 0;
    be.onSerial((b) => (serial += String.fromCharCode(b)));
    be.onPinChange((pin, s) => pin === "D13" && s.mode === "output" && edges++);
    be.load(r.hex!);
    for (let ms = 0; ms < 600; ms++) be.step(16_000);
    expect(serial).toContain("i2c ok");
    expect(serial).toContain("tick");
    expect(edges).toBeGreaterThanOrEqual(4);
    expect(writes).toEqual([0x80, 0xaf]);

    write("src/main.cpp", "#include <Arduino.h>\nvoid setup() { pinMode(13, OUTPUT) }\nvoid loop() {}\n");
    const bad = await buildFirmware({ sketchDir: dir, language: "platformio", chip: "atmega328p", displayPrefix: "firmware/" });
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ file: "firmware/src/main.cpp", line: 2, severity: "error" })]));
  });

});
