import { describe, expect, it } from "vitest";
import { colorFrameAverage } from "@faber/sim-core";
import { exampleSim } from "../../lib/exampleSim.ts";
import { serialLines } from "../../lib/firmwareBench.ts";
import { CMD, MipiPanel } from "../../lib/mipiPanel.ts";
import { GC9A01_PANEL } from "./model.ts";

describe("gc9a01-round-tft: controller", () => {
  const draw = (p: MipiPanel, x: number, y: number, color: number) => {
    p.byte(CMD.CASET, 0);
    for (const b of [0, x, 0, x]) p.byte(b, 1);
    p.byte(CMD.PASET, 0);
    for (const b of [0, y, 0, y]) p.byte(b, 1);
    p.byte(CMD.RAMWR, 0);
    p.byte(color >> 8, 1);
    p.byte(color & 0xff, 1);
  };

  it("is upright in its native orientation with MADCTL = BGR (rotation 0)", () => {
    const p = new MipiPanel(GC9A01_PANEL);
    p.byte(CMD.COLMOD, 0);
    p.byte(0x05, 1);
    p.byte(CMD.MADCTL, 0);
    p.byte(0x08, 1);
    expect(p.rotation).toBe(0);
    draw(p, 200, 100, 0xf800);
    // BGR bit set on a BGR glass: red stays red, at x 200, y 100.
    expect(p.data[100 * 240 + 200]).toBe(0xf800);
  });

  it("never shows pixels outside the round glass", () => {
    const p = new MipiPanel(GC9A01_PANEL);
    p.byte(CMD.COLMOD, 0);
    p.byte(0x05, 1);
    draw(p, 0, 0, 0xffff);
    draw(p, 120, 120, 0xffff);
    expect(p.data[0]).toBe(0);
    expect(p.data[120 * 240 + 120]).toBe(0xffff);
    expect(p.pixelsWritten).toBe(2);
    expect(p.onGlass(120, 1)).toBe(true);
    expect(p.onGlass(5, 5)).toBe(false);
  });

  it("needs INVON for true colours (the glass is inverted)", () => {
    const p = new MipiPanel(GC9A01_PANEL);
    expect(p.framebuffer(true).inverted).toBe(true);
    p.byte(CMD.INVON, 0);
    expect(p.framebuffer(true).inverted).toBe(false);
  });
});

describe("gc9a01-round-tft: real firmware (Adafruit_GFX + a 60-line GC9A01 driver, example.ino)", () => {
  it("draws the blocks, the circle and text, upright, with the corners dark", () => {
    const sim = exampleSim("gc9a01-round-tft", [{ id: "tft", type: "gc9a01-round-tft", x: 0, y: 0 }], [
      ["tft.VCC", "uno.5V"],
      ["tft.GND", "uno.GND.1"],
      ["tft.CS", "uno.D10"],
      ["tft.DC", "uno.D9"],
      ["tft.RST", "uno.D8"],
      ["tft.MOSI", "uno.D11"],
      ["tft.SCK", "uno.D13"],
      ["tft.LED", "uno.5V"],
    ]);
    sim.runFor(3000);
    expect(serialLines(sim)).toContain("GC9A01 drawn");
    const f = sim.framebuffer("tft")!;
    expect([f.width, f.height, f.on, f.inverted]).toEqual([240, 240, true, false]);
    expect(colorFrameAverage(f, 65, 55, 40, 30)).toBe("#FF0000");
    expect(colorFrameAverage(f, 135, 55, 40, 30)).toBe("#00FF00");
    expect(colorFrameAverage(f, 110, 160, 20, 20)).toBe("#0000FF");
    // The white square at (0,0) is off the glass.
    expect(colorFrameAverage(f, 0, 0, 20, 20)).toBe("#000000");
    const s = sim.partState("tft")!;
    expect(s).toMatchObject({ on: true, rotation: 0, inverted: true, width: 240, height: 240 });
    expect(Number(s.bright)).toBeGreaterThan(200);
  }, 120_000);
});
