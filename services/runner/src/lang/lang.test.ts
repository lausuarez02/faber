// Round 10 (languages): the pieces that need no Docker: image formats, the language registry, the
// MicroPython syntax check and traceback mapping, platformio.ini parsing, and MicroPython booting on
// rp2040js for every RP2040 board it is pinned for.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRp2040Backend, rp2040BoardOf } from "@jumper/sim-backends";
import { I2cBus } from "@jumper/sim-core";
import { buildFirmware } from "../build.ts";
import { REPO_ROOT } from "../config.ts";
import { parsePlatformioIni } from "./build-platformio.ts";
import { espPartitions, flashToIntelHex, padFlash, uf2ToFlash } from "./images.ts";
import { buildLittleFs } from "./littlefs.ts";
import { checkSyntax, composeMicroPython, MICROPYTHON_FIRMWARE, microPythonErrors, pickMicroPythonFirmware, USB_MAIN_FILE } from "./micropython.ts";
import { CHIPS, LANGUAGES, languagesFor, supportOf } from "./registry.ts";

describe("language registry", () => {
  it("every verified entry names a test file that exists, and every planned one says why", () => {
    for (const lang of Object.values(LANGUAGES)) {
      for (const [chip, s] of Object.entries(lang.chips)) {
        expect(CHIPS as readonly string[], `${lang.id}/${chip}`).toContain(chip);
        if (s.status === "verified") expect(existsSync(join(REPO_ROOT, s.test ?? "missing")), `${lang.id}/${chip}: ${s.test}`).toBe(true);
        else expect(s.why, `${lang.id}/${chip}`).toBeTruthy();
      }
    }
  });

  it("says which languages each chip runs", () => {
    expect(languagesFor("rp2040")).toEqual(expect.arrayContaining(["arduino", "micropython"]));
    expect(languagesFor("atmega328p")).not.toContain("micropython");
    expect(supportOf("micropython", "atmega328p").why).toMatch(/2 KB RAM/);
    expect(supportOf("zephyr", "rp2040").why).toMatch(/not been tried/);
  });
});

describe("image formats", () => {
  it("UF2 to a flash image and back out as Intel HEX that skips erased rows", () => {
    const block = new Uint8Array(512);
    const v = new DataView(block.buffer);
    v.setUint32(0, 0x0a324655, true);
    v.setUint32(4, 0x9e5d5157, true);
    v.setUint32(12, 0x1000_0100, true);
    v.setUint32(16, 4, true);
    v.setUint32(508, 0x0ab16f30, true);
    block.set([1, 2, 3, 4], 32);
    const flash = uf2ToFlash(block, 0x1000_0000, 4096);
    expect([...flash.subarray(0x100, 0x104)]).toEqual([1, 2, 3, 4]);
    const hex = flashToIntelHex(flash, 0x1000_0000);
    expect(hex.split("\n")[0]).toBe(":020000041000EA");
    expect(hex).toContain(":2001000001020304");
    expect(hex.trim().endsWith(":00000001FF")).toBe(true);
    expect(() => uf2ToFlash(new Uint8Array(512), 0, 4096)).toThrow(/not UF2/);
  });

  it("reads the ESP-IDF partition table of the pinned MicroPython ESP32 layout from a real-format entry", () => {
    const flash = padFlash(new Uint8Array(0), 0, 2);
    const e = new DataView(flash.buffer, 0x8000, 32);
    e.setUint16(0, 0x50aa, true);
    flash[0x8002] = 1;
    flash[0x8003] = 0x81;
    e.setUint32(4, 0x200000, true);
    e.setUint32(8, 0x1f0000, true);
    flash.set(new TextEncoder().encode("vfs"), 0x8000 + 12);
    flash.fill(0, 0x8000 + 15, 0x8000 + 28);
    expect(espPartitions(flash)).toEqual([{ label: "vfs", type: 1, subtype: 0x81, offset: 0x200000, size: 0x1f0000 }]);
  });

  it("littlefs refuses files in folders, with the fix", async () => {
    await expect(buildLittleFs(new Map([["lib/x.py", new Uint8Array(1)]]), { blockSize: 4096, blockCount: 16 })).rejects.toThrow(/inside a folder.*Fix: put the module next to main.py/);
  });
});

describe("MicroPython build pieces", () => {
  it("mpy-cross finds syntax and indentation errors at their line", async () => {
    expect(await checkSyntax("main.py", "print(1)\n")).toBeUndefined();
    expect(await checkSyntax("a.py", "x = 1\ndef f(:\n  pass\n")).toMatchObject({ line: 2, message: expect.stringMatching(/SyntaxError/) });
    expect(await checkSyntax("b.py", "if 1:\nprint(2)\n")).toMatchObject({ line: 2 });
  });

  it("maps a traceback to the innermost project file", () => {
    const text = 'x\r\nTraceback (most recent call last):\r\n  File "main.py", line 4, in <module>\r\n  File "main.py", line 3, in <module>\r\n  File "util.py", line 2, in half\r\nZeroDivisionError: divide by zero\r\n>>> ';
    expect(microPythonErrors(text, new Set(["main.py", "util.py"]))).toEqual([
      expect.objectContaining({ file: "firmware/util.py", line: 2, message: "ZeroDivisionError: divide by zero" }),
    ]);
    expect(microPythonErrors('Traceback (most recent call last):\n  File "<stdin>", line 1, in <module>\nNameError: x\n', new Set(["main.py"]))[0]).toEqual(expect.objectContaining({ message: "NameError: x" }));
  });

  it("picks the board's build, and says why when a chip has none", () => {
    expect(pickMicroPythonFirmware({ chip: "rp2040", board: "seeed-xiao-rp2040" }).id).toBe("SEEED_XIAO_RP2040");
    expect(pickMicroPythonFirmware({ chip: "rp2040", board: "waveshare-rp2040-zero" }).id).toBe("RPI_PICO");
    expect(() => pickMicroPythonFirmware({ chip: "atmega328p" })).toThrow(/2 KB of RAM.*Fix:/s);
    expect(() => pickMicroPythonFirmware({ chip: "rp2040", spec: "ESP32_GENERIC" })).toThrow(/built for esp32.*Fix:/s);
  });

  it("PlatformIO refuses a platform its image does not carry before touching Docker, saying why and what to use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jumper-pio-"));
    writeFileSync(join(dir, "platformio.ini"), "[env:esp]\nplatform = espressif32\nboard = esp32dev\nframework = arduino\n");
    await expect(buildFirmware({ sketchDir: dir, language: "platformio" })).rejects.toThrow(/only has atmelavr.*Fix:/s);
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses platformio.ini envs with [env] defaults", () => {
    expect(parsePlatformioIni("[env]\nframework = arduino\n\n[env:uno]\nplatform = atmelavr@5.3.0 ; pinned\nboard = uno\n[platformio]\ndefault_envs = uno\n")).toEqual([{ framework: "arduino", name: "uno", platform: "atmelavr@5.3.0", board: "uno" }]);
  });
});

// Every RP2040 board MicroPython is pinned for boots the real firmware with a main.py from the
// littlefs image, runs Pin and hardware I2C on the board's bus pins, and reports the filesystem size
// the layout assumes. The XIAO build is downloaded on first use (cached); skipped offline.
const RP2040_FIRMWARE = MICROPYTHON_FIRMWARE.filter((f) => f.chip === "rp2040");
describe("MicroPython on rp2040js", { timeout: 120_000 }, () => {
  for (const fw of RP2040_FIRMWARE) {
    const board = fw.boards[0]!;
    it(`${fw.id} on ${board}: main.py runs, GPIO toggles, I2C reaches 0x3C, littlefs is 352 blocks`, async (ctx) => {
      const bus = rp2040BoardOf(board)!.bus.i2c;
      const sda = Number(bus.sda.slice(2));
      const scl = Number(bus.scl.slice(2));
      const id = (sda >> 1) & 1;
      const main = `import os, time
from machine import Pin, I2C
p = Pin(15, Pin.OUT)
for i in range(3):
    p.toggle()
    time.sleep_ms(10)
i2c = I2C(${id}, sda=Pin(${sda}), scl=Pin(${scl}))
print("scan", i2c.scan())
i2c.writeto(0x3C, bytes([0x80, 0xAF]))
print("fs", os.statvfs("/")[2], sorted(os.listdir("/")))
`;
      let out;
      try {
        out = await composeMicroPython({ chip: "rp2040", board, files: new Map([["main.py", main], ["helper.py", "X = 1\n"]]) });
      } catch (e) {
        if (/download/.test((e as Error).message)) return ctx.skip();
        throw e;
      }
      const be = createRp2040Backend({ board: board as "raspberry-pi-pico" });
      const i2c = new I2cBus("i2c0", () => be.cycles);
      const writes: number[] = [];
      i2c.attach("oled", { i2cAddress: () => 0x3c, i2cConnect: () => true, i2cWrite: (b) => (writes.push(b), true), i2cRead: () => 0, i2cStop: () => {} });
      be.attachI2c!(i2c);
      let serial = "";
      const edges: number[] = [];
      be.onSerial((b) => (serial += String.fromCharCode(b)));
      be.onPinChange((pin, s) => pin === "GP15" && s.mode === "output" && edges.push(s.value));
      be.load(out.hex!);
      for (let ms = 0; ms < 400 && !serial.includes(">>>"); ms++) be.step(125_000);
      expect(serial).toContain("scan [60]");
      expect(serial).toContain(`fs 352 ['helper.py', '${USB_MAIN_FILE}', 'main.py']`);
      expect(edges).toEqual([0, 1, 0, 1]); // Pin(15, Pin.OUT) drives low first, then three toggles
      expect(writes).toEqual([0x80, 0xaf]);
    });
  }
});
