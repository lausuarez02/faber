import { describe, expect, it } from "vitest";
import { getPart } from "@fabwright/parts";
import type { ColorFrame } from "@fabwright/sim-core";
import { diffRect, mountTft, registerTftRenderers, TftPainter } from "./index.ts";

function frame(w: number, h: number): ColorFrame {
  return { width: w, height: h, data: new Uint16Array(w * h), version: 0, on: true, inverted: false };
}

describe("TFT painter", () => {
  it("finds the changed rectangle", () => {
    const a = new Uint16Array(16);
    const b = a.slice();
    expect(diffRect(a, b, 4, 4)).toBeNull();
    b[1 * 4 + 2] = 1;
    b[3 * 4 + 1] = 1;
    expect(diffRect(a, b, 4, 4)).toEqual({ x0: 1, y0: 1, x1: 3, y1: 4 });
  });

  it("repaints the whole frame first, then only what changed; black when off", () => {
    const f = frame(8, 6);
    const p = new TftPainter(8, 6);
    f.data[0] = 0xf800;
    expect(p.update(f)).toEqual({ x0: 0, y0: 0, x1: 8, y1: 6 });
    expect([...p.rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(p.update(f)).toBeNull();
    f.data[5 * 8 + 7] = 0x001f;
    f.version++;
    expect(p.update(f)).toEqual({ x0: 7, y0: 5, x1: 8, y1: 6 });
    expect([...p.rgba.subarray((5 * 8 + 7) * 4, (5 * 8 + 7) * 4 + 4)]).toEqual([0, 0, 255, 255]);
    f.on = false;
    p.update(f);
    expect([...p.rgba.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
  });
});

describe("mountTft", () => {
  it("overlays a 320x240 canvas on the ILI9341 glass and follows the backlight", () => {
    const host = document.createElement("div");
    host.innerHTML = getPart("ili9341-tft")!.svg;
    const svg = host.querySelector("svg")!;
    const r = mountTft(svg)!;
    expect(r.canvas.width).toBe(320);
    expect(r.canvas.height).toBe(240);
    const fo = svg.querySelector("foreignObject")!;
    const rect = svg.querySelector("[data-screen]")!;
    for (const k of ["x", "y", "width", "height"]) expect(fo.getAttribute(k)).toBe(rect.getAttribute(k));
    r.update(frame(320, 240), { backlight: 0.5 });
    expect(r.canvas.style.filter).toMatch(/brightness\(0\.50*\)/);
    r.dispose();
    expect(svg.querySelector("foreignObject")).toBeNull();
  });

  it("the layer only takes TFT parts", () => {
    const layer = registerTftRenderers(() => frame(320, 240));
    const host = document.createElement("div");
    host.innerHTML = getPart("ili9341-tft")!.svg;
    layer.attach("tft", "ili9341-tft", host.querySelector("svg")!);
    expect(layer.has("tft")).toBe(true);
    layer.paint("tft", { backlight: 1 });
    layer.attach("led", "led", host.querySelector("svg")!);
    expect(layer.has("led")).toBe(false);
    layer.clear();
  });

  it("round 17: any panel with a data-screen rect is drawn from its frames once it has one (e-paper, memory LCD)", () => {
    let have = false;
    const adopted: string[] = [];
    const layer = registerTftRenderers((id) => (have && id === "epd" ? frame(200, 200) : undefined), undefined, (id) => adopted.push(id));
    for (const [id, type] of [["epd", "epaper-154-ssd1681"], ["lcd", "sharp-memory-lcd-128"], ["led", "led"]] as const) {
      const host = document.createElement("div");
      host.innerHTML = getPart(type)!.svg;
      layer.attach(id, type, host.querySelector("svg")!);
    }
    layer.paint("epd", {});
    expect(layer.has("epd")).toBe(false); // no frame yet: its own drawing stays
    have = true;
    layer.paint("epd", {});
    layer.paint("lcd", {});
    layer.paint("led", {});
    expect(layer.has("epd")).toBe(true);
    expect(layer.has("lcd")).toBe(false); // this frameOf has none for it
    expect(layer.has("led")).toBe(false);
    expect(adopted).toEqual(["epd"]);
    layer.clear();
  });
});
