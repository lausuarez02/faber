import { describe, expect, it } from "vitest";
import { colorFrameAverage } from "@fabwright/sim-core";
import { serialLines, unoBench } from "../../lib/firmwareBench.ts";
import { CMD, MADCTL, MipiPanel } from "../../lib/mipiPanel.ts";
import { ST7735_PANEL } from "./model.ts";

describe("st7735-tft: controller", () => {
  it("rotation 0 of a black-tab panel (MX | MY, RGB) is upright portrait", () => {
    const p = new MipiPanel(ST7735_PANEL);
    p.byte(CMD.COLMOD, 0);
    p.byte(0x05, 1);
    p.byte(CMD.MADCTL, 0);
    p.byte(MADCTL.MX | MADCTL.MY, 1);
    expect(p.rotation).toBe(0);
    p.byte(CMD.CASET, 0);
    for (const b of [0, 127, 0, 127]) p.byte(b, 1);
    p.byte(CMD.PASET, 0);
    for (const b of [0, 159, 0, 159]) p.byte(b, 1);
    p.byte(CMD.RAMWR, 0);
    p.byte(0xf8, 1);
    p.byte(0x00, 1);
    expect(p.data[159 * 128 + 127]).toBe(0xf800);
  });
});

describe("st7735-tft: real firmware (Adafruit_ST7735 1.12.0)", () => {
  it("draws the blocks, circle and text in portrait", () => {
    const wires: [string, string][] = [
      ["tft:VCC", "uno:5V"],
      ["tft:GND", "uno:GND.1"],
      ["tft:CS", "uno:D10"],
      ["tft:DC", "uno:D9"],
      ["tft:RST", "uno:D8"],
      ["tft:MOSI", "uno:D11"],
      ["tft:SCK", "uno:D13"],
      ["tft:LED", "uno:5V"],
    ];
    const sim = unoBench({ parts: [{ id: "tft", type: "st7735-tft", x: 0, y: 0 }], wires, hex: "./example.hex", base: import.meta.url });
    sim.runFor(2500);
    expect(serialLines(sim)).toContain("ST7735 drawn");
    const f = sim.framebuffer("tft")!;
    expect([f.width, f.height, f.on]).toEqual([128, 160, true]);
    expect(colorFrameAverage(f, 2, 2, 28, 20)).toBe("#FF0000");
    expect(colorFrameAverage(f, 98, 2, 28, 20)).toBe("#00FF00");
    expect(colorFrameAverage(f, 58, 94, 12, 12)).toBe("#0000FF");
    expect(sim.partState("tft")!.rotation).toBe(0);
    expect(Number(sim.partState("tft")!.bright)).toBeGreaterThan(100);
  }, 60_000);
});
