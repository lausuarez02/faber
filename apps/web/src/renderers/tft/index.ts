// Live renderer for colour TFT parts (ILI9341 320x240, ST7735 160x128, GC9A01 240x240 round). Their frames are too big
// for visualState, so the part model exposes them as a ColorFrame (Simulation.framebuffer(id),
// RGB565, viewer orientation). mountTft() puts a <canvas> over the part's [data-screen] rect,
// like the OLED/LCD renderers, and each update() repaints only the rectangle that changed since
// the last paint (found by diffing a copy of the last frame, so any number of renderers can read
// the same part). Cost at 60 fps: nothing when the frame did not change; a full 320x240 repaint
// is about 1 ms.
//
// The canvas engine (lib/engine.ts) owns one layer: attach when a TFT part's SVG mounts (instead of
// the mono display layer), paint every frame after applyVisualState, detach on unmount.
import { colorFrameToRgba, type ColorFrame, type DirtyRect, type VisualState } from "@fabwright/sim-core";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

export const TFT_PART_TYPES: readonly string[] = ["ili9341-tft", "st7735-tft", "gc9a01-round-tft"];

/** Bounding box of the pixels that differ between two frames of the same size, or null. */
export function diffRect(prev: Uint16Array, next: Uint16Array, width: number, height: number): DirtyRect | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if (prev[row + x] !== next[row + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      if (first < x0) x0 = first;
      if (last > x1) x1 = last;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Incremental painter, independent of the DOM (tests, offscreen canvases, video recording). */
export class TftPainter {
  readonly rgba: Uint8ClampedArray;
  private prev: Uint16Array;
  private lastVersion = -1;
  private lastOn = false;
  private lastInv = false;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
    this.prev = new Uint16Array(width * height);
  }

  /** Bring the RGBA buffer up to date; returns the rect that changed (null = nothing to repaint). */
  update(f: ColorFrame): DirtyRect | null {
    if (f.width !== this.width || f.height !== this.height) throw new Error(`TftPainter: frame is ${f.width}x${f.height}, painter is ${this.width}x${this.height}; create a painter for the new size`);
    if (f.version === this.lastVersion && f.on === this.lastOn && f.inverted === this.lastInv) return null;
    const full = f.on !== this.lastOn || f.inverted !== this.lastInv || this.lastVersion < 0;
    const rect = full ? { x0: 0, y0: 0, x1: this.width, y1: this.height } : diffRect(this.prev, f.data, this.width, this.height);
    this.lastVersion = f.version;
    this.lastOn = f.on;
    this.lastInv = f.inverted;
    if (!rect) return null;
    colorFrameToRgba(f, this.rgba.subarray((rect.y0 * this.width + rect.x0) * 4), rect, this.width);
    for (let y = rect.y0; y < rect.y1; y++) this.prev.set(f.data.subarray(y * this.width + rect.x0, y * this.width + rect.x1), y * this.width + rect.x0);
    return rect;
  }
}

export interface TftRenderer {
  /** Repaint from the part's frame (no-op when nothing changed). `state` supplies the backlight level. */
  update(frame: ColorFrame | undefined, state?: VisualState): void;
  dispose(): void;
  readonly canvas: HTMLCanvasElement;
}

/** Mount on an inlined part SVG; undefined when it has no [data-screen="WxH"] rect. */
export function mountTft(svg: SVGSVGElement | Element): TftRenderer | undefined {
  const screen = svg.querySelector("[data-screen]");
  const m = /^(\d+)x(\d+)$/.exec(screen?.getAttribute("data-screen") ?? "");
  if (!screen || !m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  const doc = svg.ownerDocument;
  const fo = doc.createElementNS(SVG_NS, "foreignObject");
  for (const k of ["x", "y", "width", "height"]) fo.setAttribute(k, screen.getAttribute(k) ?? "0");
  fo.setAttribute("pointer-events", "none");
  fo.setAttribute("data-display-layer", "tft");
  const canvas = doc.createElementNS(XHTML_NS, "canvas") as HTMLCanvasElement;
  canvas.width = width;
  canvas.height = height;
  Object.assign(canvas.style, { width: "100%", height: "100%", display: "block", imageRendering: "pixelated", background: "#05070a" });
  // Round glass (GC9A01): the part's SVG covers the corners too, this keeps the canvas itself round.
  if (screen.getAttribute("data-screen-shape") === "round") canvas.style.borderRadius = "50%";
  fo.appendChild(canvas);
  screen.parentNode?.insertBefore(fo, screen.nextSibling);
  let ctx2d: CanvasRenderingContext2D | null = null;
  try {
    ctx2d = canvas.getContext("2d");
  } catch {
    ctx2d = null; // jsdom
  }
  const painter = new TftPainter(width, height);
  const image = ctx2d ? ctx2d.createImageData(width, height) : undefined;
  let lastBacklight = -1;
  return {
    canvas,
    update(frame, state) {
      const bl = typeof state?.backlight === "number" ? state.backlight : 1;
      if (bl !== lastBacklight) {
        lastBacklight = bl;
        // A dim backlight darkens the glass; off leaves the faint reflection of an unlit LCD.
        canvas.style.filter = bl >= 0.999 ? "" : `brightness(${Math.max(0.04, bl).toFixed(3)})`;
      }
      if (!frame || frame.width !== width || frame.height !== height) return;
      const rect = painter.update(frame);
      if (!rect || !ctx2d || !image) return;
      image.data.set(painter.rgba);
      ctx2d.putImageData(image, 0, 0, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
    },
    dispose() {
      fo.remove();
    },
  };
}

export interface TftLayer {
  /**
   * Mount on a part's inlined SVG. Built-in TFT types mount at once; any other part with a
   * [data-screen="WxH"] rect (an e-paper, a memory LCD, an agent-made panel) is kept as a candidate
   * and mounts on the first paint that finds a frame for it (its model exposes `framebuffer`).
   */
  attach(partId: string, partType: string, svg: SVGSVGElement | Element): void;
  paint(partId: string, state?: VisualState): void;
  detach(partId: string): void;
  clear(): void;
  has(partId: string): boolean;
}

/**
 * One layer per canvas engine; `frameOf` reads the live frame (Simulation.framebuffer). `onAdopt`
 * runs when a candidate part turned out to have frames, so the caller can drop the mono layer's
 * canvas over the same rect.
 */
export function registerTftRenderers(frameOf: (partId: string) => ColorFrame | undefined, types: readonly string[] = TFT_PART_TYPES, onAdopt?: (partId: string) => void): TftLayer {
  const live = new Map<string, TftRenderer>();
  const candidates = new Map<string, SVGSVGElement | Element>();
  const wanted = new Set(types);
  return {
    attach(partId, partType, svg) {
      live.get(partId)?.dispose();
      live.delete(partId);
      candidates.delete(partId);
      if (!wanted.has(partType)) {
        if (/^\d+x\d+$/.test(svg.querySelector("[data-screen]")?.getAttribute("data-screen") ?? "")) candidates.set(partId, svg);
        return;
      }
      const r = mountTft(svg);
      if (r) live.set(partId, r);
    },
    paint(partId, state) {
      let r = live.get(partId);
      if (!r) {
        const svg = candidates.get(partId);
        if (!svg) return;
        const f = frameOf(partId);
        if (!f) return;
        r = mountTft(svg);
        candidates.delete(partId);
        if (!r) return;
        live.set(partId, r);
        onAdopt?.(partId);
        r.update(f, state);
        return;
      }
      r.update(frameOf(partId), state);
    },
    detach(partId) {
      live.get(partId)?.dispose();
      live.delete(partId);
      candidates.delete(partId);
    },
    clear() {
      for (const r of live.values()) r.dispose();
      live.clear();
      candidates.clear();
    },
    has: (partId) => live.has(partId),
  };
}

export { TftScreen } from "./TftScreen.tsx";
export type { TftScreenProps } from "./TftScreen.tsx";
