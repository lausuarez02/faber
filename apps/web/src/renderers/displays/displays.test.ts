import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "@faber/sim-core";
import { getPart } from "@faber/parts";
import { DISPLAY_PART_TYPES, mountDisplay, paintLcd, paintOled, registerDisplayRenderers } from "./index.ts";
import { glyphRows } from "./font5x7.ts";

const px = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

function inline(type: string): SVGSVGElement {
  const def = getPart(type);
  if (!def) throw new Error(`no part ${type}`);
  const host = document.createElement("div");
  host.innerHTML = def.svg;
  return host.querySelector("svg") as SVGSVGElement;
}

describe("OLED painter", () => {
  it("draws lit pixels in the panel colour and dark otherwise", () => {
    const frame = new Uint8Array(16 * 64);
    frame[0] = 0x80; // (0,0)
    frame[16 * 20 + 1] = 0x01; // (15,20)
    const state = { on: true, pixels: bytesToBase64(frame), width: 128, height: 64, color: "yellow-blue", brightness: 1, frame: 1 };
    const img = paintOled(state);
    expect(img.width).toBe(128);
    expect(px(img, 0, 0)).toEqual([255, 213, 74]); // top 16 rows are yellow
    expect(px(img, 15, 20)).toEqual([79, 195, 255]);
    expect(px(img, 1, 0)).toEqual([5, 7, 10]);
    expect(px(paintOled({ ...state, on: false }), 0, 0)).toEqual([5, 7, 10]);
  });
});

describe("LCD painter", () => {
  it("draws ROM glyphs and CGRAM characters as dot matrices", () => {
    const glyphs = new Uint8Array(32).fill(0x20);
    glyphs[0] = "A".charCodeAt(0);
    glyphs[1] = 0; // custom char 0
    const cgram = new Uint8Array(64);
    cgram[0] = 0x1f; // top row of custom char 0 fully lit
    const img = paintLcd({ on: true, backlight: true, glyphs: bytesToBase64(glyphs), cgram: bytesToBase64(cgram), cols: 16, rows: 2, color: "blue", cursorCol: -1, cursorRow: 0 });
    const dot = [236, 244, 255];
    // 'A' row 0 is ..#.. and row 1 is .#.#. in the 5x7 font
    const a = glyphRows(0x41);
    expect(a.slice(0, 2)).toEqual([0b00100, 0b01010]);
    expect(px(img, 4 + 2 * 4, 4)).toEqual(dot);
    expect(px(img, 4, 4)).not.toEqual(dot);
    // custom char in cell 1: every dot of the first row lit
    const cell1 = 4 + 20 + 4;
    for (let c = 0; c < 5; c++) expect(px(img, cell1 + c * 4, 4)).toEqual(dot);
  });
});

describe("mountDisplay", () => {
  it("overlays a canvas exactly on the data-screen rect of the real part SVGs", () => {
    for (const type of DISPLAY_PART_TYPES) {
      const svg = inline(type);
      const rect = svg.querySelector("[data-screen]")!;
      const r = mountDisplay(svg)!;
      expect(r, type).toBeDefined();
      const fo = svg.querySelector("foreignObject")!;
      for (const k of ["x", "y", "width", "height"]) expect(fo.getAttribute(k), `${type} ${k}`).toBe(rect.getAttribute(k));
      expect(r.canvas.width).toBeGreaterThan(0);
      r.update({ frame: 1, on: true, width: 128, height: 64, pixels: "", cols: 16, rows: 2 });
      r.dispose();
      expect(svg.querySelector("foreignObject")).toBeNull();
    }
  });

  it("the layer ignores parts without a screen", () => {
    const layer = registerDisplayRenderers();
    layer.attach("led1", "led", inline("led"));
    expect(layer.has("led1")).toBe(false);
    layer.attach("oled", "ssd1306-oled-i2c", inline("ssd1306-oled-i2c"));
    expect(layer.has("oled")).toBe(true);
    layer.paint("oled", { frame: 2, on: false });
    layer.clear();
    expect(layer.has("oled")).toBe(false);
  });

  it("round 17: a screen it does not know gets the mono canvas only once its state has pixels", () => {
    const layer = registerDisplayRenderers();
    layer.attach("epd", "epaper-154-ssd1681", inline("epaper-154-ssd1681"));
    layer.paint("epd", { on: true, frame: 3, lit: 10 });
    expect(layer.has("epd")).toBe(false); // an e-paper is drawn from frames, not a black OLED
    layer.paint("epd", { on: true, frame: 4, pixels: "", width: 200, height: 200 });
    expect(layer.has("epd")).toBe(true);
    layer.clear();
  });
});
