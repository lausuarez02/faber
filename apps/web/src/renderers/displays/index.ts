// Live display renderers for parts with a screen (SSD1306 OLED, 16x2 LCD).
//
// A display part's visual.svg marks its glass with <rect data-screen="128x64" …> (pixels) or
// data-screen="16x2" (characters). mountDisplay() puts a <canvas> exactly over that rect (inside
// an SVG <foreignObject>, so it pans, zooms and rotates with the part) and update() redraws it
// from the part's visualState with putImageData, only when the `frame` key changes: no React
// re-render, no DOM churn per frame.
//
// Wiring it into the canvas engine (for Integrate):
//   import { registerDisplayRenderers } from "../renderers/displays";
//   const displays = registerDisplayRenderers();          // once
//   displays.attach(partId, partType, svgRoot);           // when a part's SVG is inlined
//   displays.paint(partId, state);                        // after applyVisualState(svg, state)
//   displays.detach(partId);                              // when the part is removed
import type { VisualState } from "@jumper/sim-core";
import { newImage, painterFor, lcdSize, type RgbaImage } from "./paint.ts";

export { paintLcd, paintOled, painterFor, lcdSize } from "./paint.ts";
export type { RgbaImage } from "./paint.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** Part types whose SVG has a data-screen rect and that this module draws. */
export const DISPLAY_PART_TYPES: readonly string[] = ["ssd1306-oled-i2c", "lcd1602-i2c"];

export interface DisplayRenderer {
  /** Redraw from the part's visualState (cheap no-op when its `frame` did not change). */
  update(state: VisualState): void;
  /** Remove the canvas. */
  dispose(): void;
  /** The canvas (for screenshots and tests). */
  readonly canvas: HTMLCanvasElement;
}

/**
 * Mount a renderer on an inlined part SVG. Returns undefined when the SVG has no
 * [data-screen] rect, so it is safe to call for every part.
 */
export function mountDisplay(svg: SVGSVGElement | Element): DisplayRenderer | undefined {
  const screen = svg.querySelector("[data-screen]");
  if (!screen) return undefined;
  const kind = screen.getAttribute("data-screen") ?? "";
  const paint = painterFor(kind);
  if (!paint) return undefined;
  const x = screen.getAttribute("x") ?? "0";
  const y = screen.getAttribute("y") ?? "0";
  const w = screen.getAttribute("width") ?? "0";
  const h = screen.getAttribute("height") ?? "0";

  const doc = svg.ownerDocument;
  const fo = doc.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("x", x);
  fo.setAttribute("y", y);
  fo.setAttribute("width", w);
  fo.setAttribute("height", h);
  fo.setAttribute("pointer-events", "none");
  fo.setAttribute("data-display-layer", kind);
  const canvas = doc.createElementNS(XHTML_NS, "canvas") as HTMLCanvasElement;
  const [cw, ch] = kind.split("x").map(Number) as [number, number];
  const size = cw <= 40 && ch <= 4 ? lcdSize(cw, ch) : { width: cw, height: ch };
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.imageRendering = "pixelated";
  fo.appendChild(canvas);
  // Right after the screen rect, so frames/overlays drawn later in the SVG stay on top.
  screen.parentNode?.insertBefore(fo, screen.nextSibling);

  let ctx2d: CanvasRenderingContext2D | null = null;
  try {
    ctx2d = canvas.getContext("2d");
  } catch {
    ctx2d = null; // jsdom without canvas support
  }
  let img: RgbaImage = newImage(size.width, size.height);
  let imageData: ImageData | undefined;
  let lastKey = "";

  return {
    canvas,
    update(state) {
      const key = `${String(state.frame)}|${String(state.on)}|${String(state.backlight)}|${String(state.brightness)}|${String(state.color)}|${String(state.blinkOn)}`;
      if (key === lastKey) return;
      lastKey = key;
      img = paint(state, img);
      if (!ctx2d) return;
      if (!imageData || imageData.width !== img.width || imageData.height !== img.height) {
        imageData = ctx2d.createImageData(img.width, img.height);
        canvas.width = img.width;
        canvas.height = img.height;
      }
      imageData.data.set(img.data);
      ctx2d.putImageData(imageData, 0, 0);
    },
    dispose() {
      fo.remove();
    },
  };
}

export interface DisplayLayer {
  /** Mount on a part's inlined SVG if its type has a screen. Re-attaching replaces the old one. */
  attach(partId: string, partType: string, svg: SVGSVGElement | Element): void;
  /** Redraw one part from its visualState (no-op for parts without a screen). */
  paint(partId: string, state: VisualState): void;
  detach(partId: string): void;
  /** Drop every renderer. */
  clear(): void;
  has(partId: string): boolean;
}

/** The registration entry point: one layer per canvas engine. */
export function registerDisplayRenderers(types: readonly string[] = DISPLAY_PART_TYPES): DisplayLayer {
  const live = new Map<string, DisplayRenderer>();
  const wanted = new Set(types);
  return {
    attach(partId, partType, svg) {
      live.get(partId)?.dispose();
      live.delete(partId);
      if (!wanted.has(partType) && !svg.querySelector("[data-screen]")) return;
      const r = mountDisplay(svg);
      if (r) live.set(partId, r);
    },
    paint(partId, state) {
      live.get(partId)?.update(state);
    },
    detach(partId) {
      live.get(partId)?.dispose();
      live.delete(partId);
    },
    clear() {
      for (const r of live.values()) r.dispose();
      live.clear();
    },
    has: (partId) => live.has(partId),
  };
}
