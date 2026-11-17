import { describe, expect, it } from "vitest";
import { GROUND, base64ToBytes } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { i2cWires, serialLines, unoBench } from "../../lib/firmwareBench.ts";
import { Hd44780, charOf, createBackpack } from "./model.ts";

const def = need(registry.get("lcd1602-i2c"), "lcd1602-i2c");

/** Write one byte to the HD44780 through the backpack like LiquidCrystal_PCF8574 does. */
function sendByte(write: (b: number) => void, value: number, rs: boolean, bl = true) {
  for (const nib of [value >> 4, value & 0x0f]) {
    const base = (nib << 4) | (rs ? 1 : 0) | (bl ? 8 : 0);
    write(base | 4);
    write(base);
  }
}

function initLcd(write: (b: number) => void) {
  for (const n of [3, 3, 3, 2]) {
    write((n << 4) | 4 | 8);
    write((n << 4) | 8);
  }
  sendByte(write, 0x28, false); // 4-bit, 2 lines
  sendByte(write, 0x0c, false); // display on
  sendByte(write, 0x01, false); // clear
  sendByte(write, 0x06, false); // entry: increment
}

describe("lcd1602-i2c: HD44780 behind a PCF8574", () => {
  it("answers at 0x27 by default and the address prop", () => {
    const b = mount(def, { id: "lcd", wiring: { VCC: "v", GND: GROUND } });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    expect(b.model.i2c!.i2cAddress()).toBe(0x27);
    b.setProp("address", "0x3F");
    expect(b.model.i2c!.i2cAddress()).toBe(0x3f);
    expect(b.model.i2c!.i2cConnect(false, false)).toBe(true);
  });

  it("4-bit init, text on both lines, cursor and shift", () => {
    const lcd = new Hd44780();
    const pack = createBackpack(lcd, () => true, () => 0x27);
    initLcd(pack.write);
    for (const ch of "Hi!") sendByte(pack.write, ch.charCodeAt(0), true);
    sendByte(pack.write, 0x80 | 0x40, false); // line 2
    for (const ch of "line two") sendByte(pack.write, ch.charCodeAt(0), true);
    const row = (r: number) => Array.from({ length: 16 }, (_, c) => charOf(lcd.codeAt(r, c))).join("");
    expect(row(0)).toBe("Hi!             ");
    expect(row(1)).toBe("line two        ");
    expect(lcd.cursorCell()).toEqual({ row: 1, col: 8 });
    sendByte(pack.write, 0x18, false); // shift display left
    expect(row(0)).toBe("i!              ");
    expect(pack.state.backlight).toBe(true);
  });

  it("stores custom characters in CGRAM", () => {
    const lcd = new Hd44780();
    const pack = createBackpack(lcd, () => true, () => 0x27);
    initLcd(pack.write);
    sendByte(pack.write, 0x40 | 8, false); // CGRAM char 1
    for (const r of [1, 2, 4, 8, 16, 8, 4, 2]) sendByte(pack.write, r, true);
    expect([...lcd.cgram.slice(8, 16)]).toEqual([1, 2, 4, 8, 16, 8, 4, 2]);
    sendByte(pack.write, 0x80, false);
    sendByte(pack.write, 1, true);
    expect(charOf(lcd.codeAt(0, 0))).toBe("▯");
  });

  it("explains a module without power", () => {
    const b = mount(def, { id: "lcd" });
    b.solve();
    expect(b.model.i2c!.i2cConnect(false, false)).toBe(false);
    expect(b.model.diagnostics!()[0]!.code).toBe("i2c-module-unpowered");
    expect(b.model.visualState()).toMatchObject({ on: false, backlight: false, line0: " ".repeat(16) });
  });
});

describe("lcd1602-i2c: real firmware (LiquidCrystal_PCF8574)", { timeout: 120_000 }, () => {
  it("shows the title, the custom heart and the seconds", () => {
    const sim = unoBench({ parts: [{ id: "lcd", type: "lcd1602-i2c", x: 0, y: 0 }], wires: i2cWires("lcd"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(2600);
    expect(serialLines(sim)[0]).toBe("LCD ready");
    const s = sim.partState("lcd")!;
    expect(s.line0).toBe("Hi, Faber ▯     ");
    expect(s.line1).toBe("t=2s            ");
    expect(s.backlight).toBe(true);
    expect([...base64ToBytes(String(s.cgram)).slice(0, 8)]).toEqual([0, 10, 31, 31, 14, 4, 0, 0]);
    expect(sim.diagnostics().filter((d) => d.severity !== "info")).toEqual([]);
  });

  it("the sketch reports a missing LCD at the wrong address", () => {
    const sim = unoBench({ parts: [{ id: "lcd", type: "lcd1602-i2c", x: 0, y: 0, props: { address: "0x3F" } }], wires: i2cWires("lcd"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(200);
    expect(serialLines(sim)[0]).toBe("LCD not found at 0x27: check wiring and address");
  });

  it("works with the LiquidCrystal_I2C API (Faber's Apache-2.0 implementation)", () => {
    const sim = unoBench({ parts: [{ id: "lcd", type: "lcd1602-i2c", x: 0, y: 0 }], wires: i2cWires("lcd"), hex: "./example-liquidcrystal-i2c.hex", base: import.meta.url });
    sim.runFor(1400);
    expect(serialLines(sim)[0]).toBe("LCD ready");
    expect(sim.partState("lcd")).toMatchObject({ line0: "Hello, world!   ", line1: "   Faber LCD    ", backlight: true, on: true });
  });
});
