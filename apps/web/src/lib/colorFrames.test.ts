import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { clearColorFrames, colorFrameOf, decodePngTo565, hasColorFrames, setColorFrames, setLastColorFrames } from "./colorFrames.ts";
import { emitProjectSwitch } from "./projectSwitch.ts";

/** A PNG the way any encoder may write it: RGB or RGBA, one filter type per row. */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number], channels: 3 | 4, filterOf: (y: number) => number): string {
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      row.set(channels === 4 ? [r, g, b, 255] : [r, g, b], x * channels);
    }
    const f = filterOf(y);
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]!;
      raw[y * (stride + 1) + 1 + i] = (row[i]! - pred) & 0xff;
    }
    prev = row;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); // CRC not checked by the decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const pattern = (x: number, y: number): [number, number, number] => [(x * 37) & 0xff, (y * 53) & 0xff, ((x + y) * 11) & 0xff];
const rgb565 = ([r, g, b]: [number, number, number]) => ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);

describe("colour frames in the browser (round 6)", () => {
  it("decodes RGB and RGBA PNGs with every row filter into RGB565", () => {
    for (const channels of [3, 4] as const) {
      const f = decodePngTo565(Buffer.from(png(17, 10, pattern, channels, (y) => y % 5), "base64"));
      expect(f.width).toBe(17);
      expect(f.height).toBe(10);
      for (let y = 0; y < 10; y++) for (let x = 0; x < 17; x++) expect(f.data[y * 17 + x]).toBe(rgb565(pattern(x, y)));
    }
  });

  it("keeps the latest frame per part with a new version, and clears on a project switch", () => {
    clearColorFrames();
    setColorFrames({ eye: { w: 4, h: 4, png: png(4, 4, () => [255, 0, 0], 3, () => 0) } });
    const a = colorFrameOf("eye")!;
    expect(a.data[0]).toBe(0xf800);
    expect(a.on).toBe(true);
    setLastColorFrames([{ color: { eye: { w: 4, h: 4, png: png(4, 4, () => [0, 0, 255], 3, () => 1) } } }, {}, { color: { eye: { w: 4, h: 4, png: png(4, 4, () => [0, 255, 0], 3, () => 2) } } }]);
    const b = colorFrameOf("eye")!;
    expect(b.data[5]).toBe(0x07e0);
    expect(b.version).toBeGreaterThan(a.version);
    emitProjectSwitch({ id: "other", reason: "open" });
    expect(colorFrameOf("eye")).toBeUndefined();
  });

  it("skips an image that does not decode instead of throwing", () => {
    setColorFrames({ bad: { w: 1, h: 1, png: "bm90IGEgcG5n" } });
    expect(colorFrameOf("bad")).toBeUndefined();
    expect(hasColorFrames({ color: { eye: {} } })).toBe(true);
    expect(hasColorFrames({ t_ms: 1 })).toBe(false);
  });
});
