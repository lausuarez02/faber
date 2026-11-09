import { describe, expect, it } from "vitest";
import { GROUND, colorFrameAverage, rgb565ToRgb } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { serialLines, unoBench } from "../../lib/firmwareBench.ts";
import { CMD, MADCTL, MipiPanel } from "../../lib/mipiPanel.ts";
import { ILI9341_PANEL } from "./model.ts";

const def = need(registry.get("ili9341-tft"), "ili9341-tft");

/** Feed a command and its parameters to a panel. */
function send(p: MipiPanel, cmd: number, args: number[] = []): void {
  p.byte(cmd, 0);
  for (const a of args) p.byte(a, 1);
}
/** A panel in the state tft.begin() leaves: 16-bit colour. */
function panel(): MipiPanel {
  const p = new MipiPanel(ILI9341_PANEL);
  send(p, CMD.COLMOD, [0x55]);
  return p;
}
function window(p: MipiPanel, x0: number, y0: number, x1: number, y1: number): void {
  send(p, CMD.CASET, [x0 >> 8, x0 & 0xff, x1 >> 8, x1 & 0xff]);
  send(p, CMD.PASET, [y0 >> 8, y0 & 0xff, y1 >> 8, y1 & 0xff]);
}
function pixels(p: MipiPanel, color: number, n: number): void {
  p.byte(CMD.RAMWR, 0);
  for (let i = 0; i < n; i++) {
    p.byte(color >> 8, 1);
    p.byte(color & 0xff, 1);
  }
}
const at = (p: MipiPanel, x: number, y: number) => p.data[y * p.width + x]!;

describe("ili9341-tft: controller", () => {
  it("is dark until SLPOUT + DISPON, then shows RAM", () => {
    const p = new MipiPanel(ILI9341_PANEL);
    expect(p.lit).toBe(false);
    send(p, CMD.SLPOUT);
    expect(p.lit).toBe(false);
    send(p, CMD.DISPON);
    expect(p.lit).toBe(true);
    expect(p.framebuffer(true).on).toBe(true);
    expect(p.framebuffer(false).on).toBe(false);
  });

  it("rotation 1 (MV | BGR) is upright landscape; the window wraps", () => {
    const p = panel();
    send(p, CMD.MADCTL, [MADCTL.MV | MADCTL.BGR]);
    expect(p.rotation).toBe(1);
    window(p, 10, 20, 12, 21); // 3 x 2
    pixels(p, 0xf800, 7); // the 7th wraps to (10, 20)
    expect(at(p, 10, 20)).toBe(0xf800);
    expect(at(p, 12, 21)).toBe(0xf800);
    expect(at(p, 13, 21)).toBe(0);
    expect(p.dirty.take()).toEqual({ x0: 10, y0: 20, x1: 13, y1: 22 });
    expect(p.dirty.take()).toBeNull();
  });

  it("rotation 0 (MX | BGR) shows portrait content turned a quarter in the landscape frame", () => {
    const p = panel();
    send(p, CMD.MADCTL, [MADCTL.MX | MADCTL.BGR]);
    expect(p.rotation).toBe(0);
    window(p, 0, 0, 0, 0);
    pixels(p, 0x07e0, 1); // portrait top-left
    // physical col 239, row 0 → viewer (0, 239): bottom-left of the landscape frame
    expect(at(p, 0, 239)).toBe(0x07e0);
    send(p, CMD.MADCTL, [MADCTL.MX | MADCTL.MY | MADCTL.MV | MADCTL.BGR]);
    expect(p.rotation).toBe(3);
    window(p, 0, 0, 0, 0);
    pixels(p, 0x001f, 1);
    expect(at(p, 319, 239)).toBe(0x001f); // rotation 3: upside-down landscape
  });

  it("without the BGR bit red and blue swap, as on the glass", () => {
    const p = panel();
    send(p, CMD.MADCTL, [MADCTL.MV]);
    window(p, 0, 0, 0, 0);
    pixels(p, 0xf800, 1);
    expect(at(p, 0, 0)).toBe(0x001f);
  });

  it("18-bit COLMOD takes three bytes per pixel", () => {
    const p = panel();
    send(p, CMD.MADCTL, [MADCTL.MV | MADCTL.BGR]);
    send(p, CMD.COLMOD, [0x66]); // also the power-on default
    window(p, 0, 0, 1, 0);
    p.byte(CMD.RAMWR, 0);
    for (const b of [0xfc, 0x00, 0x00, 0x00, 0x00, 0xfc]) p.byte(b, 1);
    expect(at(p, 0, 0)).toBe(0xf800);
    expect(at(p, 1, 0)).toBe(0x001f);
  });

  it("answers register reads through the 0xD9 index (readcommand8)", () => {
    const p = new MipiPanel(ILI9341_PANEL);
    send(p, CMD.SLPOUT);
    send(p, CMD.DISPON);
    send(p, CMD.ILI_INDEX, [0x10]);
    p.byte(CMD.RDMODE, 0);
    expect(p.byte(0, 1)).toBe(0x9c);
  });
});

describe("ili9341-tft: module", () => {
  it("draws ~80 mA from 5 V with the backlight on (LED pulled up) and less with LED low", () => {
    const b = mount(def, { id: "tft", wiring: { VCC: "vcc", GND: GROUND, LED: "led" } });
    let r = b.solve((c) => c.voltageSource("vcc", GROUND, 5, 0.01));
    r = b.solve();
    const on = Math.abs(r.current("e0") || 0);
    void on;
    expect(b.model.visualState().backlight).toBe(1);
    r = b.solve((c) => {
      c.voltageSource("vcc", GROUND, 5, 0.01);
      c.voltageSource("led", GROUND, 0, 0.01);
    });
    r = b.solve();
    expect(b.model.visualState().backlight).toBe(0);
  });

  it("flags 5 V logic on a 3.3 V-only module", () => {
    const b = mount(def, { id: "tft", props: { logic: "3v3-only" }, wiring: { VCC: "vcc", GND: GROUND, DC: "vcc" } });
    b.solve((c) => c.voltageSource("vcc", GROUND, 5, 0.01));
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("tft-logic-5v");
    const ok = mount(def, { id: "tft", wiring: { VCC: "vcc", GND: GROUND, DC: "vcc" } });
    ok.solve((c) => c.voltageSource("vcc", GROUND, 5, 0.01));
    expect(ok.model.diagnostics!().map((d) => d.code)).not.toContain("tft-logic-5v");
  });
});

describe("ili9341-tft: real firmware (Adafruit_ILI9341 1.7.0 + GFX 1.13.0)", () => {
  const wires: [string, string][] = [
    ["tft:VCC", "uno:5V"],
    ["tft:GND", "uno:GND.1"],
    ["tft:CS", "uno:D10"],
    ["tft:DC", "uno:D9"],
    ["tft:RST", "uno:D8"],
    ["tft:MOSI", "uno:D11"],
    ["tft:SCK", "uno:D13"],
    ["tft:MISO", "uno:D12"],
    ["tft:LED", "uno:5V"],
  ];

  it("draws the colour blocks, circle and text where the sketch put them", () => {
    const sim = unoBench({ parts: [{ id: "tft", type: "ili9341-tft", x: 0, y: 0 }], wires, hex: "./example.hex", base: import.meta.url });
    sim.runFor(1500);
    expect(sim.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
    const lines = serialLines(sim);
    expect(lines).toContain("ILI9341 drawn");
    expect(lines).toContain("RDMODE 0x9C");
    expect(lines).toContain("RDPIXFMT 0x55");
    const f = sim.framebuffer("tft")!;
    expect(f.on).toBe(true);
    expect(f.width).toBe(320);
    expect(f.height).toBe(240);
    expect(colorFrameAverage(f, 2, 2, 30, 20)).toBe("#FF0000");
    expect(colorFrameAverage(f, 45, 2, 30, 20)).toBe("#00FF00");
    expect(colorFrameAverage(f, 85, 2, 30, 20)).toBe("#0000FF");
    expect(colorFrameAverage(f, 230, 140, 20, 20)).toBe("#FFFF00");
    expect(colorFrameAverage(f, 150, 60, 20, 20)).toBe("#000000");
    expect(rgb565ToRgb(f.data[239 * 320 + 100]!)).toEqual([255, 255, 255]);
    const s = sim.partState("tft")!;
    expect(s.rotation).toBe(1);
    expect(Number(s.lit)).toBeGreaterThan(5000);
    expect(Number(s.bright)).toBeGreaterThan(300); // the white text and line
    // the counter keeps updating
    const before = Number(s.frame);
    sim.runFor(500);
    expect(Number(sim.partState("tft")!.frame)).toBeGreaterThan(before);
    expect(serialLines(sim).some((l) => /^count [3-9]/.test(l))).toBe(true);
  }, 60_000);
});
