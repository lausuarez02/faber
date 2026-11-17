// Cameras as a general capability (round 13): a camera part (a module, or a camera built into a
// board) renders frames from a source (a named test scene, a still image, the person's webcam) at
// the size and pixel format the firmware asks for, and an MCU backend that can carry frames
// (McuBackend.attachCamera) hands them to the firmware. Nothing here knows what the frames are for.
//
// Electrical behaviour (XCLK, PCLK / VSYNC / HREF edges, the 8-bit DVP bus, SCCB register traffic)
// is not simulated: the backend asks for a whole frame at the virtual time the driver starts a
// capture, and the camera answers with the encoded bytes and how long the capture takes.
// Deterministic: same source, settings and request, same bytes (no wall clock, no Math.random).
import { decodeJpeg, ImageFormatError, type DecodedImage } from "./image/jpeg-decode.ts";
import { encodeJpeg } from "./image/jpeg-encode.ts";
import { decodePng, isPng } from "./image/png-decode.ts";
import type { Unsubscribe } from "./mcu.ts";

export { ImageFormatError, type DecodedImage } from "./image/jpeg-decode.ts";
export { encodeJpeg } from "./image/jpeg-encode.ts";
export { decodeJpeg } from "./image/jpeg-decode.ts";
export { decodePng } from "./image/png-decode.ts";

/** The camera signals a part maps to its pins (esp32-camera's camera_config_t names; d0 = Y2 … d7 = Y9). */
export const CAMERA_PIN_ROLES = ["xclk", "sda", "scl", "vsync", "href", "pclk", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "pwdn", "reset"] as const;
export type CameraPinRole = (typeof CAMERA_PIN_ROLES)[number];
/** Roles a firmware's pin config must match for the camera to answer (pwdn / reset may be tied off). */
export const CAMERA_REQUIRED_ROLES: readonly CameraPinRole[] = ["xclk", "sda", "scl", "vsync", "href", "pclk", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"];

/** Frame sizes in esp32-camera's framesize_t order (the index the firmware sends). */
export const CAMERA_FRAME_SIZES = [
  { id: "96X96", w: 96, h: 96 },
  { id: "QQVGA", w: 160, h: 120 },
  { id: "128X128", w: 128, h: 128 },
  { id: "QCIF", w: 176, h: 144 },
  { id: "HQVGA", w: 240, h: 176 },
  { id: "240X240", w: 240, h: 240 },
  { id: "QVGA", w: 320, h: 240 },
  { id: "320X320", w: 320, h: 320 },
  { id: "CIF", w: 400, h: 296 },
  { id: "HVGA", w: 480, h: 320 },
  { id: "VGA", w: 640, h: 480 },
  { id: "SVGA", w: 800, h: 600 },
  { id: "XGA", w: 1024, h: 768 },
  { id: "HD", w: 1280, h: 720 },
  { id: "SXGA", w: 1280, h: 1024 },
  { id: "UXGA", w: 1600, h: 1200 },
  { id: "FHD", w: 1920, h: 1080 },
  { id: "P_HD", w: 720, h: 1280 },
  { id: "P_3MP", w: 864, h: 1536 },
  { id: "QXGA", w: 2048, h: 1536 },
  { id: "QHD", w: 2560, h: 1440 },
  { id: "WQXGA", w: 2560, h: 1600 },
  { id: "P_FHD", w: 1080, h: 1920 },
  { id: "QSXGA", w: 2560, h: 1920 },
  { id: "5MP", w: 2592, h: 1944 },
] as const;
export const frameSizeIndex = (id: string): number => CAMERA_FRAME_SIZES.findIndex((f) => f.id === id.toUpperCase());

/** Pixel formats in esp32-camera's pixformat_t order. */
export const CAMERA_PIXFORMATS = ["rgb565", "yuv422", "yuv420", "grayscale", "jpeg", "rgb888"] as const;
export type CameraPixelFormat = (typeof CAMERA_PIXFORMATS)[number];
/** What Fabwright renders (YUV420 and the RAW formats are not). */
export const CAMERA_RENDERED_FORMATS: readonly CameraPixelFormat[] = ["rgb565", "yuv422", "grayscale", "jpeg", "rgb888"];

/** Image sensors a part can carry, with what the firmware's driver reads from them. */
export const CAMERA_SENSORS = {
  OV2640: { pid: 0x26, mid: 0x7fa2, ver: 0x42, sccbAddr: 0x30, maxSize: "UXGA", jpeg: true, fovDeg: 66, activeMa: 40, standbyMa: 0.6 },
  OV3660: { pid: 0x3660, mid: 0x7fa2, ver: 0x00, sccbAddr: 0x3c, maxSize: "QXGA", jpeg: true, fovDeg: 66, activeMa: 45, standbyMa: 0.02 },
  OV5640: { pid: 0x5640, mid: 0x7fa2, ver: 0x00, sccbAddr: 0x3c, maxSize: "5MP", jpeg: true, fovDeg: 68, activeMa: 100, standbyMa: 0.02 },
} as const;
export type CameraSensorId = keyof typeof CAMERA_SENSORS;
export const CAMERA_SENSOR_IDS = Object.keys(CAMERA_SENSORS) as CameraSensorId[];

/** sensor_t settings the firmware can change, applied to each frame. */
export interface CameraSettings {
  hmirror: boolean;
  vflip: boolean;
  colorbar: boolean;
  /** -2..2 */
  brightness: number;
  contrast: number;
  saturation: number;
  aeLevel: number;
  /** 0 none, 1 negative, 2 grayscale, 3 red tint, 4 green tint, 5 blue tint, 6 sepia */
  effect: number;
}
export const DEFAULT_CAMERA_SETTINGS: CameraSettings = { hmirror: false, vflip: false, colorbar: false, brightness: 0, contrast: 0, saturation: 0, aeLevel: 0, effect: 0 };

/** What the firmware's esp_camera_init() said, with pins as MCU pin ids ("GPIO10"). */
export interface CameraInitRequest {
  cycle: number;
  pins: Partial<Record<CameraPinRole, string>>;
  xclkHz: number;
  format: CameraPixelFormat | "unknown";
  frameSize: number;
  quality: number;
  fbCount: number;
  fbInPsram: boolean;
}

export interface CameraCaptureRequest {
  cycle: number;
  format: CameraPixelFormat | "unknown";
  width: number;
  height: number;
  /** esp32-camera jpeg_quality: 0..63, lower is better. */
  quality: number;
  settings: CameraSettings;
  /** Bytes the firmware's frame buffer holds (informational: the firmware drops a bigger frame). */
  capacity: number;
  xclkHz: number;
}

export interface CameraFrame {
  data: Uint8Array;
  width: number;
  height: number;
  format: CameraPixelFormat;
  /** How long the capture takes on the device (µs of virtual time). */
  latencyUs: number;
  /** The rendered picture before encoding (for previews), RGBA at width × height. */
  rgba?: Uint8Array;
}

/** What a camera part model implements (PartModel.camera). */
export interface CameraDevice {
  sensor: CameraSensorId;
  /** The firmware asked for a frame: render it (undefined = the camera is not powered / not answering). */
  cameraCapture(req: CameraCaptureRequest): CameraFrame | undefined;
  /** The firmware initialised (or released) the camera: for the part's state and power. */
  cameraInit?(req: CameraInitRequest): void;
  cameraDeinit?(): void;
  /** False while the camera has no power: the probe fails like a real unpowered sensor. */
  cameraPowered?(): boolean;
}

export interface CameraInitAnswer {
  ok: boolean;
  /** "not-detected" (nothing on those pins, or no power), "not-supported" (format / sensor), "bad-size". */
  code?: "not-detected" | "not-supported" | "bad-size";
  partId?: string;
  sensor?: CameraSensorId;
  /** Init time on the device (µs): sensor reset and register writes. */
  latencyUs: number;
  /** Why it failed, with the fix, for check_design and the run report. */
  why?: string;
}

export interface CameraStats {
  inits: number;
  frames: number;
  bytes: number;
  failedInits: number;
  /** Frames larger than the firmware's frame buffer (the driver drops them: FB-OVF). */
  dropped: number;
  /** Why the last frame was dropped, with the fix. */
  dropWhy?: string;
  last?: { partId: string; width: number; height: number; format: CameraPixelFormat; bytes: number; cycle: number };
  /** The last init failure (what the firmware asked and why nothing answered). */
  problem?: string;
}

interface CameraAttached {
  partId: string;
  device: CameraDevice;
  pins: Partial<Record<CameraPinRole, string>>;
}

/** Sensor init time: hardware reset, PLL lock and the register table (roughly what esp_camera_init takes on a board). */
export const CAMERA_INIT_US = 300_000;

/**
 * Capture time of one frame: esp_camera_fb_get() waits for the next frame and its transfer, about
 * one sensor frame period. The OV2640 runs at about 60 fps at CIF and below, 30 at SVGA and below,
 * 15 above, at a 24 MHz XCLK (datasheet); the frame rate scales with XCLK.
 */
export function captureLatencyUs(width: number, height: number, xclkHz = 20_000_000): number {
  const px = width * height;
  const fps24 = px <= 400 * 296 ? 60 : px <= 800 * 600 ? 30 : 15;
  const fps = (fps24 * Math.max(6e6, Math.min(24e6, xclkHz || 20e6))) / 24e6;
  return Math.round(1e6 / fps);
}

/** The bus between an MCU's camera port and camera parts. The first camera whose pins match answers. */
export class CameraBus {
  private devices: CameraAttached[] = [];
  private active: CameraAttached | undefined;
  private _stats: CameraStats = { inits: 0, frames: 0, bytes: 0, failedInits: 0, dropped: 0 };
  private listeners = new Set<(partId: string, frame: CameraFrame, cycle: number) => void>();
  private xclkHz = 20_000_000;

  attach(partId: string, device: CameraDevice, pins: Partial<Record<CameraPinRole, string>>): Unsubscribe {
    const entry = { partId, device, pins };
    this.devices.push(entry);
    return () => {
      this.devices = this.devices.filter((d) => d !== entry);
      if (this.active === entry) this.active = undefined;
    };
  }

  list(): { partId: string; sensor: CameraSensorId; pins: Partial<Record<CameraPinRole, string>> }[] {
    return this.devices.map((d) => ({ partId: d.partId, sensor: d.device.sensor, pins: d.pins }));
  }

  get stats(): Readonly<CameraStats> {
    return this._stats;
  }

  /** The part that answered the last init (undefined before, or after a failed init). */
  get activePart(): string | undefined {
    return this.active?.partId;
  }

  onFrame(cb: (partId: string, frame: CameraFrame, cycle: number) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** esp_camera_init(): find the camera on the pins the firmware names. */
  init(req: CameraInitRequest): CameraInitAnswer {
    this._stats.inits++;
    this.xclkHz = req.xclkHz || 20_000_000;
    const fail = (code: CameraInitAnswer["code"], why: string): CameraInitAnswer => {
      this._stats.failedInits++;
      this._stats.problem = why;
      this.active = undefined;
      return { ok: false, code, latencyUs: CAMERA_INIT_US, why };
    };
    if (!this.devices.length) return fail("not-detected", "The firmware started a camera (esp_camera_init) but the circuit has no camera part. Fix: add a camera (a board with one, like the XIAO ESP32-S3 Sense, or an OV2640 camera module wired to the board).");
    const mismatch = (d: CameraAttached): string[] => {
      const out: string[] = [];
      for (const role of CAMERA_REQUIRED_ROLES) {
        const wired = d.pins[role];
        const asked = req.pins[role];
        if (wired === undefined) {
          out.push(`${role.toUpperCase()} of ${d.partId} is not wired${asked ? ` (the firmware expects it on ${asked})` : ""}`);
          continue;
        }
        if (asked !== wired) out.push(`${role.toUpperCase()}: the firmware says ${asked ?? "none (-1)"}, ${d.partId} is on ${wired}`);
      }
      return out;
    };
    const ranked = this.devices.map((d) => ({ d, bad: mismatch(d) })).sort((a, b) => a.bad.length - b.bad.length);
    const best = ranked[0]!;
    if (best.bad.length) {
      return fail("not-detected", `esp_camera_init found no camera on the pins it was given (as on the board: "Camera probe failed"). ${best.bad.slice(0, 4).join("; ")}${best.bad.length > 4 ? `; and ${best.bad.length - 4} more` : ""}. Fix: use the camera's pins in camera_config_t (get_part ${best.d.partId} lists them), or rewire the camera to the pins the sketch uses.`);
    }
    if (best.d.device.cameraPowered?.() === false) return fail("not-detected", `${best.d.partId} has no power, so it does not answer the probe. Fix: power its 3.3 V (and GND) pins.`);
    const sensor = CAMERA_SENSORS[best.d.device.sensor];
    if (req.frameSize > frameSizeIndex(sensor.maxSize)) {
      return fail("bad-size", `The firmware asks the ${best.d.device.sensor} for ${CAMERA_FRAME_SIZES[req.frameSize]?.id ?? req.frameSize}, larger than its largest frame (${sensor.maxSize}). Fix: a smaller frame_size.`);
    }
    this.active = best.d;
    this._stats.problem = undefined;
    best.d.device.cameraInit?.(req);
    return { ok: true, partId: best.d.partId, sensor: best.d.device.sensor, latencyUs: CAMERA_INIT_US };
  }

  deinit(): void {
    this.active?.device.cameraDeinit?.();
    this.active = undefined;
  }

  /** esp_camera_fb_get(): the active camera's next frame. */
  capture(req: CameraCaptureRequest): CameraFrame | undefined {
    const a = this.active;
    if (!a) return undefined;
    const frame = a.device.cameraCapture({ ...req, xclkHz: req.xclkHz || this.xclkHz });
    if (!frame) return undefined;
    this._stats.frames++;
    this._stats.bytes += frame.data.length;
    this._stats.last = { partId: a.partId, width: frame.width, height: frame.height, format: frame.format, bytes: frame.data.length, cycle: req.cycle };
    if (req.capacity > 0 && frame.data.length > req.capacity) {
      this._stats.dropped++;
      this._stats.dropWhy = `A ${frame.width}x${frame.height} ${frame.format.toUpperCase()} frame is ${frame.data.length} bytes, more than the firmware's ${req.capacity}-byte frame buffer, so the driver drops it (esp_camera_fb_get returns NULL; "FB-OVF" on the board). Why: frame buffers are sized at esp_camera_init for its frame_size and pixel_format${frame.format === "jpeg" ? " (JPEG: width × height / 5)" : ""}. Fix: ${frame.format === "jpeg" ? "a higher jpeg_quality number (smaller files), or a larger jpeg_buffer_size" : "init the camera with this frame size (esp_camera_deinit, then esp_camera_init), or keep the size you started with"}.`;
    }
    for (const l of this.listeners) l(a.partId, frame, req.cycle);
    return frame;
  }

  reset(): void {
    this.devices = [];
    this.active = undefined;
    this._stats = { inits: 0, frames: 0, bytes: 0, failedInits: 0, dropped: 0 };
  }
}

// ------------------------------------------------------------------ sources

/** Named test scenes (generic pictures to point the camera at). */
export const CAMERA_SCENES = ["test-card", "color-bars", "face", "gradient", "checker", "black", "white", "dark-room"] as const;
export type CameraScene = (typeof CAMERA_SCENES)[number];

export interface CameraImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** A still image from PNG or JPEG bytes (throws ImageFormatError with what to do for other formats). */
export function decodeImage(bytes: Uint8Array): CameraImage {
  if (isPng(bytes)) return decodePng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJpeg(bytes);
  throw new ImageFormatError("the image is neither PNG nor JPEG. Fix: use a .png or .jpg file");
}

/** Bytes of a data: URL or plain base64. */
export function dataUrlBytes(s: string): Uint8Array {
  const b64 = s.startsWith("data:") ? s.slice(s.indexOf(",") + 1) : s;
  const bin = typeof atob === "function" ? atob(b64) : "";
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const COLOR_BARS: [number, number, number][] = [
  [235, 235, 235],
  [235, 235, 16],
  [16, 235, 235],
  [16, 235, 16],
  [235, 16, 235],
  [235, 16, 16],
  [16, 16, 235],
  [16, 16, 16],
];

/** Renders a named scene at w × h, RGBA. Pure function of (name, w, h). */
export function renderScene(name: string, w: number, h: number): CameraImage {
  const rgba = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const o = 4 * (y * w + x);
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      switch (name) {
        case "color-bars": {
          const [r, g, b] = COLOR_BARS[Math.min(7, Math.floor(u * 8))]!;
          set(x, y, r, g, b);
          break;
        }
        case "gradient":
          set(x, y, Math.round(u * 255), Math.round(v * 255), Math.round((1 - u) * 255));
          break;
        case "checker": {
          const c = (Math.floor(u * 8) + Math.floor(v * 6)) % 2 ? 230 : 25;
          set(x, y, c, c, c);
          break;
        }
        case "black":
          set(x, y, 0, 0, 0);
          break;
        case "white":
          set(x, y, 255, 255, 255);
          break;
        case "dark-room": {
          const l = Math.round(18 + 22 * Math.exp(-(((u - 0.7) ** 2 + (v - 0.3) ** 2) / 0.02)));
          set(x, y, l, l, Math.round(l * 1.2));
          break;
        }
        case "face": {
          // a smiling face on a soft blue wall: something for "is there a person" code to look at
          const bg: [number, number, number] = [96 + Math.round(40 * v), 140 + Math.round(30 * v), 200];
          const ax = (u - 0.5) * (w / h), ay = v - 0.5;
          const r = Math.hypot(ax, ay);
          let c = bg;
          if (r < 0.34) c = [238, 196, 160];
          if (Math.hypot(ax + 0.12, ay + 0.08) < 0.045 || Math.hypot(ax - 0.12, ay + 0.08) < 0.045) c = [40, 30, 30];
          if (ay > 0.04 && Math.abs(Math.hypot(ax, ay + 0.02) - 0.16) < 0.022) c = [150, 50, 60];
          if (r >= 0.34 && r < 0.36) c = [190, 150, 120];
          set(x, y, c[0], c[1], c[2]);
          break;
        }
        default: {
          // test-card: colour bars on top, a gray ramp, a circle and a frame, so size, orientation,
          // mirroring and colour all show
          let c: [number, number, number];
          if (v < 0.5) c = COLOR_BARS[Math.min(7, Math.floor(u * 8))]!;
          else if (v < 0.62) {
            const l = Math.round(u * 255);
            c = [l, l, l];
          } else c = [40, 44, 52];
          const ax = (u - 0.5) * (w / h), ay = v - 0.5;
          if (Math.abs(Math.hypot(ax, ay) - 0.3) < 0.012) c = [255, 255, 255];
          if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) c = [255, 255, 255];
          // an arrow in the top-left corner: shows mirror / flip
          if (u < 0.12 && v > 0.04 && v < 0.2 && Math.abs(v - 0.12) < (0.12 - u) * 0.7) c = [255, 255, 255];
          set(x, y, c[0], c[1], c[2]);
        }
      }
    }
  return { width: w, height: h, rgba };
}

/** Scales `src` to cover w × h (centre crop, area-averaged when shrinking). */
export function coverResize(src: CameraImage, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const scale = Math.max(w / src.width, h / src.height);
  const cw = w / scale, ch = h / scale;
  const ox = (src.width - cw) / 2, oy = (src.height - ch) / 2;
  const step = 1 / scale;
  const n = Math.max(1, Math.min(4, Math.floor(step)));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const sx = Math.min(src.width - 1, Math.max(0, Math.floor(ox + (x + (i + 0.5) / n) * step)));
          const sy = Math.min(src.height - 1, Math.max(0, Math.floor(oy + (y + (j + 0.5) / n) * step)));
          const o = 4 * (sy * src.width + sx);
          r += src.rgba[o]!;
          g += src.rgba[o + 1]!;
          b += src.rgba[o + 2]!;
        }
      const o = 4 * (y * w + x);
      const k = n * n;
      out[o] = Math.round(r / k);
      out[o + 1] = Math.round(g / k);
      out[o + 2] = Math.round(b / k);
      out[o + 3] = 255;
    }
  return out;
}

/** Applies the sensor settings (mirror, flip, brightness, contrast, saturation, exposure level, special effect). */
export function applyCameraSettings(rgba: Uint8Array, w: number, h: number, s: CameraSettings): Uint8Array {
  const out = new Uint8Array(rgba.length);
  const bright = s.brightness * 20 + s.aeLevel * 15;
  const contrast = 1 + s.contrast * 0.2;
  const sat = 1 + s.saturation * 0.25;
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = s.hmirror ? w - 1 - x : x;
      const sy = s.vflip ? h - 1 - y : y;
      const i = 4 * (sy * w + sx);
      let r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * sat;
      g = l + (g - l) * sat;
      b = l + (b - l) * sat;
      r = (r - 128) * contrast + 128 + bright;
      g = (g - 128) * contrast + 128 + bright;
      b = (b - 128) * contrast + 128 + bright;
      const l2 = 0.299 * r + 0.587 * g + 0.114 * b;
      switch (s.effect) {
        case 1:
          r = 255 - r;
          g = 255 - g;
          b = 255 - b;
          break;
        case 2:
          r = g = b = l2;
          break;
        case 3:
          r = l2 * 1.2;
          g = b = l2 * 0.8;
          break;
        case 4:
          g = l2 * 1.2;
          r = b = l2 * 0.8;
          break;
        case 5:
          b = l2 * 1.2;
          r = g = l2 * 0.8;
          break;
        case 6:
          r = l2 * 1.07 + 20;
          g = l2 * 0.95 + 8;
          b = l2 * 0.75;
          break;
      }
      const o = 4 * (y * w + x);
      out[o] = clamp(r);
      out[o + 1] = clamp(g);
      out[o + 2] = clamp(b);
      out[o + 3] = 255;
    }
  return out;
}

/** esp32-camera jpeg_quality (0..63, lower is better) as a 1..100 JPEG quality. */
export const jpegQualityOf = (q: number): number => Math.max(5, Math.min(97, Math.round(100 - Math.max(0, Math.min(63, q)) * 1.5)));

/** Encodes RGBA pixels in a camera pixel format, as esp32-camera hands them to the sketch. */
export function encodeCameraPixels(rgba: Uint8Array, w: number, h: number, format: CameraPixelFormat, quality: number): Uint8Array {
  const n = w * h;
  switch (format) {
    case "jpeg":
      return encodeJpeg({ width: w, height: h, pixels: rgba }, jpegQualityOf(quality));
    case "grayscale": {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.round(0.299 * rgba[4 * i]! + 0.587 * rgba[4 * i + 1]! + 0.114 * rgba[4 * i + 2]!);
      return out;
    }
    case "rgb888": {
      // esp32-camera's RGB888 is B, G, R per pixel (fmt2rgb888 order)
      const out = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        out[3 * i] = rgba[4 * i + 2]!;
        out[3 * i + 1] = rgba[4 * i + 1]!;
        out[3 * i + 2] = rgba[4 * i]!;
      }
      return out;
    }
    case "yuv422": {
      // YUYV, as the sensor sends it
      const out = new Uint8Array(n * 2);
      for (let i = 0; i < n; i += 2) {
        const px = (k: number) => {
          const j = Math.min(n - 1, i + k);
          return [rgba[4 * j]!, rgba[4 * j + 1]!, rgba[4 * j + 2]!] as const;
        };
        const [r0, g0, b0] = px(0);
        const [r1, g1, b1] = px(1);
        const y0 = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
        const y1 = 0.299 * r1 + 0.587 * g1 + 0.114 * b1;
        const r = (r0 + r1) / 2, g = (g0 + g1) / 2, b = (b0 + b1) / 2;
        const u = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
        const v = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
        const c = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
        out[2 * i] = c(y0);
        out[2 * i + 1] = c(u);
        out[2 * i + 2] = c(y1);
        out[2 * i + 3] = c(v);
      }
      return out;
    }
    default: {
      // RGB565, high byte first (as the sensor sends it and esp32-camera's converters expect)
      const out = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) {
        const v = ((rgba[4 * i]! & 0xf8) << 8) | ((rgba[4 * i + 1]! & 0xfc) << 3) | (rgba[4 * i + 2]! >> 3);
        out[2 * i] = v >> 8;
        out[2 * i + 1] = v & 0xff;
      }
      return out;
    }
  }
}

/** One frame of `source` as the firmware asked for it. */
export function renderCameraFrame(source: CameraImage | CameraScene | string, req: Pick<CameraCaptureRequest, "width" | "height" | "format" | "quality" | "settings" | "xclkHz">): CameraFrame {
  const w = req.width, h = req.height;
  const format: CameraPixelFormat = req.format === "unknown" || req.format === "yuv420" ? "rgb565" : req.format;
  let rgba = req.settings.colorbar ? renderScene("color-bars", w, h).rgba : typeof source === "string" ? renderScene(source, w, h).rgba : coverResize(source, w, h);
  if (!req.settings.colorbar) rgba = applyCameraSettings(rgba, w, h, req.settings);
  return { data: encodeCameraPixels(rgba, w, h, format, req.quality), width: w, height: h, format, latencyUs: captureLatencyUs(w, h, req.xclkHz), rgba };
}

/** A small JPEG data URL of a frame's picture, for previews on the canvas (≤ maxW wide). */
export function previewDataUrl(rgba: Uint8Array, w: number, h: number, maxW = 96): string {
  const pw = Math.min(maxW, w);
  const ph = Math.max(1, Math.round((h * pw) / w));
  const small = coverResize({ width: w, height: h, rgba }, pw, ph);
  const jpg = encodeJpeg({ width: pw, height: ph, pixels: small }, 70);
  let s = "";
  for (let i = 0; i < jpg.length; i++) s += String.fromCharCode(jpg[i]!);
  return `data:image/jpeg;base64,${typeof btoa === "function" ? btoa(s) : ""}`;
}

/** Parses a source: a scene name, or an image (data URL / base64 of PNG or JPEG). */
export function cameraSourceOf(value: string): CameraImage | CameraScene {
  const v = value.trim();
  if ((CAMERA_SCENES as readonly string[]).includes(v)) return v as CameraScene;
  if (!v) return "test-card";
  return decodeImage(dataUrlBytes(v));
}

export type { DecodedImage as CameraDecodedImage };
