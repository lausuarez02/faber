import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import {
  CameraBus,
  captureLatencyUs,
  coverResize,
  decodeImage,
  decodeJpeg,
  DEFAULT_CAMERA_SETTINGS,
  encodeCameraPixels,
  encodeJpeg,
  ImageFormatError,
  renderCameraFrame,
  renderScene,
  type CameraDevice,
} from "./camera.ts";
import { encodePng } from "./color.ts";

function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    se += (a[i]! - b[i]!) ** 2;
    n++;
  }
  return 10 * Math.log10((255 * 255) / (se / n));
}

describe("camera images", () => {
  it("JPEG round trip: the encoder's output decodes back close to the picture (4:2:2 colour and grayscale)", () => {
    const img = renderScene("gradient", 64, 48);
    const jpg = encodeJpeg({ width: 64, height: 48, pixels: img.rgba }, 90);
    expect([jpg[0], jpg[1], jpg[jpg.length - 2], jpg[jpg.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    const back = decodeJpeg(jpg);
    expect([back.width, back.height]).toEqual([64, 48]);
    expect(psnr(img.rgba, back.rgba)).toBeGreaterThan(30);
    // odd sizes (partial blocks and MCUs) and grayscale
    const odd = renderScene("test-card", 37, 23);
    expect(psnr(odd.rgba, decodeJpeg(encodeJpeg({ width: 37, height: 23, pixels: odd.rgba }, 95)).rgba)).toBeGreaterThan(20);
    const gray = new Uint8Array(40 * 30).map((_, i) => (i * 7) & 255);
    const g = decodeJpeg(encodeJpeg({ width: 40, height: 30, pixels: gray, gray: true }, 95));
    expect(g.width).toBe(40);
  });

  it("quality changes the size, deterministically", () => {
    const img = renderScene("face", 320, 240);
    const hi = encodeJpeg({ width: 320, height: 240, pixels: img.rgba }, 90);
    const lo = encodeJpeg({ width: 320, height: 240, pixels: img.rgba }, 30);
    expect(lo.length).toBeLessThan(hi.length);
    expect(encodeJpeg({ width: 320, height: 240, pixels: img.rgba }, 90)).toEqual(hi);
  });

  it("decodes PNG (stored and compressed, RGB and RGBA) and refuses other files with the fix", () => {
    const img = renderScene("color-bars", 16, 8);
    const back = decodeImage(encodePng(img.rgba, 16, 8));
    expect(back.rgba).toEqual(img.rgba);
    // an RGB PNG with filter 1 (sub) and real deflate
    const w = 5, h = 3;
    const raw = new Uint8Array((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 3 + 1)] = 1;
      for (let i = 0; i < w * 3; i++) raw[y * (w * 3 + 1) + 1 + i] = i < 3 ? 10 * (y + 1) : 1;
    }
    const png = buildPng(w, h, 2, zlibSync(raw));
    const d = decodeImage(png);
    expect([...d.rgba.subarray(0, 8)]).toEqual([10, 10, 10, 255, 11, 11, 11, 255]);
    expect(() => decodeImage(new Uint8Array([1, 2, 3]))).toThrow(ImageFormatError);
  });

  it("formats: RGB565 big-endian, grayscale, YUYV and BGR888 sizes and values", () => {
    const red = new Uint8Array(4 * 4).fill(0);
    for (let i = 0; i < 4; i++) red.set([255, 0, 0, 255], 4 * i);
    expect([...encodeCameraPixels(red, 2, 2, "rgb565", 10).subarray(0, 2)]).toEqual([0xf8, 0x00]);
    expect(encodeCameraPixels(red, 2, 2, "grayscale", 10)[0]).toBe(76);
    expect(encodeCameraPixels(red, 2, 2, "yuv422", 10).length).toBe(8);
    expect([...encodeCameraPixels(red, 2, 2, "rgb888", 10).subarray(0, 3)]).toEqual([0, 0, 255]);
  });

  it("frames honour size, mirror and flip; capture time follows the frame size", () => {
    const f = renderCameraFrame("test-card", { width: 96, height: 96, format: "rgb565", quality: 12, settings: DEFAULT_CAMERA_SETTINGS, xclkHz: 20e6 });
    expect(f.data.length).toBe(96 * 96 * 2);
    const m = renderCameraFrame("gradient", { width: 8, height: 8, format: "grayscale", quality: 12, settings: { ...DEFAULT_CAMERA_SETTINGS, hmirror: true }, xclkHz: 20e6 });
    const n = renderCameraFrame("gradient", { width: 8, height: 8, format: "grayscale", quality: 12, settings: DEFAULT_CAMERA_SETTINGS, xclkHz: 20e6 });
    expect(m.data[0]).toBe(n.data[7]);
    expect(captureLatencyUs(320, 240)).toBeLessThan(captureLatencyUs(800, 600));
    expect(captureLatencyUs(800, 600)).toBeLessThan(captureLatencyUs(1600, 1200));
    expect(captureLatencyUs(1600, 1200, 20e6)).toBe(80_000);
  });

  it("cover resize keeps the centre of a wide picture", () => {
    const wide = { width: 4, height: 1, rgba: new Uint8Array([0, 0, 0, 255, 100, 0, 0, 255, 200, 0, 0, 255, 50, 0, 0, 255]) };
    const out = coverResize(wide, 1, 1);
    expect(out[0]).toBeGreaterThan(90);
  });
});

describe("CameraBus", () => {
  const pins = { xclk: "GPIO10", sda: "GPIO40", scl: "GPIO39", vsync: "GPIO38", href: "GPIO47", pclk: "GPIO13", d0: "GPIO15", d1: "GPIO17", d2: "GPIO18", d3: "GPIO16", d4: "GPIO14", d5: "GPIO12", d6: "GPIO11", d7: "GPIO48" };
  const device = (): CameraDevice & { inits: number } => ({
    sensor: "OV2640",
    inits: 0,
    cameraInit() {
      this.inits++;
    },
    cameraCapture: (req) => renderCameraFrame("face", req),
  });

  it("answers an init on the camera's pins and captures frames", () => {
    const bus = new CameraBus();
    const d = device();
    bus.attach("cam", d, pins);
    const a = bus.init({ cycle: 0, pins, xclkHz: 20e6, format: "jpeg", frameSize: 6, quality: 12, fbCount: 1, fbInPsram: false });
    expect(a.ok).toBe(true);
    expect(d.inits).toBe(1);
    const f = bus.capture({ cycle: 1, format: "jpeg", width: 320, height: 240, quality: 12, settings: DEFAULT_CAMERA_SETTINGS, capacity: 15360, xclkHz: 0 });
    expect(f?.data[0]).toBe(0xff);
    expect(bus.stats.frames).toBe(1);
  });

  it("says which pins differ when the firmware names other pins, and what to fix", () => {
    const bus = new CameraBus();
    bus.attach("cam", device(), pins);
    const a = bus.init({ cycle: 0, pins: { ...pins, xclk: "GPIO15" }, xclkHz: 20e6, format: "jpeg", frameSize: 6, quality: 12, fbCount: 1, fbInPsram: false });
    expect(a.ok).toBe(false);
    expect(a.why).toMatch(/XCLK: the firmware says GPIO15, cam is on GPIO10/);
    expect(a.why).toMatch(/Fix:/);
    expect(bus.capture({ cycle: 1, format: "jpeg", width: 96, height: 96, quality: 12, settings: DEFAULT_CAMERA_SETTINGS, capacity: 0, xclkHz: 0 })).toBeUndefined();
  });

  it("refuses a frame size larger than the sensor's", () => {
    const bus = new CameraBus();
    bus.attach("cam", device(), pins);
    expect(bus.init({ cycle: 0, pins, xclkHz: 20e6, format: "jpeg", frameSize: 19, quality: 12, fbCount: 1, fbInPsram: false }).code).toBe("bad-size");
  });
});

function buildPng(w: number, h: number, ctype: number, idat: Uint8Array): Uint8Array {
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    let c = 0xffffffff;
    for (let i = 4; i < 8 + data.length; i++) c = crcT[(c ^ out[i]!) & 0xff]! ^ (c >>> 8);
    dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = ctype;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
