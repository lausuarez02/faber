// Pure pixel painters for display parts: turn a part's visualState into RGBA pixels.
// No DOM here, so they are unit-tested in jsdom and reused for screenshots.
import { base64ToBytes, decodeMonoFrame, monoPixel, type VisualState } from "@faber/sim-core";
import { glyphRows } from "./font5x7.ts";

export type Rgb = readonly [number, number, number];

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function fill(img: RgbaImage, c: Rgb, a = 255): void {
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = c[0];
    img.data[i + 1] = c[1];
    img.data[i + 2] = c[2];
    img.data[i + 3] = a;
  }
}

function put(img: RgbaImage, x: number, y: number, c: Rgb): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0];
  img.data[i + 1] = c[1];
  img.data[i + 2] = c[2];
  img.data[i + 3] = 255;
}

// ------------------------------------------------------------------------------------ OLED

const OLED_OFF: Rgb = [5, 7, 10];
const OLED_COLORS: Record<string, { top: Rgb; rest: Rgb }> = {
  white: { top: [232, 244, 255], rest: [232, 244, 255] },
  blue: { top: [79, 195, 255], rest: [79, 195, 255] },
  "yellow-blue": { top: [255, 213, 74], rest: [79, 195, 255] },
};

export function newImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * Paint a monochrome OLED frame 1:1 (one canvas pixel per display pixel) from the
 * `pixels`/`width`/`height`/`on`/`brightness`/`color` keys of its visualState.
 */
export function paintOled(state: VisualState, img?: RgbaImage): RgbaImage {
  const w = Number(state.width) || 128;
  const h = Number(state.height) || 64;
  const out = img && img.width === w && img.height === h ? img : newImage(w, h);
  fill(out, OLED_OFF);
  if (!state.on || typeof state.pixels !== "string" || state.pixels === "") return out;
  const frame = decodeMonoFrame(state.pixels, w, h);
  const pal = OLED_COLORS[String(state.color)] ?? OLED_COLORS.white!;
  const k = Math.min(1, Math.max(0.2, Number(state.brightness) || 1));
  const scale = (c: Rgb): Rgb => [Math.round(OLED_OFF[0] + (c[0] - OLED_OFF[0]) * k), Math.round(OLED_OFF[1] + (c[1] - OLED_OFF[1]) * k), Math.round(OLED_OFF[2] + (c[2] - OLED_OFF[2]) * k)];
  const top = scale(pal.top);
  const rest = scale(pal.rest);
  for (let y = 0; y < h; y++) {
    const c = y < 16 ? top : rest;
    for (let x = 0; x < w; x++) if (monoPixel(frame, x, y)) put(out, x, y, c);
  }
  return out;
}

// ------------------------------------------------------------------------------------ LCD

/** Pixel layout of the LCD canvas: each dot is DOT px with GAP px spacing. */
export const LCD_DOT = 3;
export const LCD_GAP = 1;
const CELL_W = 5 * (LCD_DOT + LCD_GAP);
const CELL_H = 8 * (LCD_DOT + LCD_GAP);
const CELL_GAP_X = 4;
const CELL_GAP_Y = 6;
const MARGIN = 4;

const LCD_COLORS: Record<string, { bgOn: Rgb; bgOff: Rgb; dot: Rgb; ghostOn: Rgb; ghostOff: Rgb }> = {
  blue: { bgOn: [40, 88, 230], bgOff: [16, 28, 78], dot: [236, 244, 255], ghostOn: [52, 102, 238], ghostOff: [20, 34, 88] },
  green: { bgOn: [160, 196, 52], bgOff: [70, 86, 30], dot: [24, 38, 10], ghostOn: [148, 184, 46], ghostOff: [64, 80, 28] },
};

export function lcdSize(cols: number, rows: number): { width: number; height: number } {
  return {
    width: MARGIN * 2 + cols * CELL_W + (cols - 1) * CELL_GAP_X,
    height: MARGIN * 2 + rows * CELL_H + (rows - 1) * CELL_GAP_Y,
  };
}

/** Paint a character LCD from `glyphs`/`cgram`/`cols`/`rows`/`backlight`/cursor keys. */
export function paintLcd(state: VisualState, img?: RgbaImage): RgbaImage {
  const cols = Number(state.cols) || 16;
  const rows = Number(state.rows) || 2;
  const { width, height } = lcdSize(cols, rows);
  const out = img && img.width === width && img.height === height ? img : newImage(width, height);
  const pal = LCD_COLORS[String(state.color)] ?? LCD_COLORS.blue!;
  const lit = !!state.backlight;
  fill(out, lit ? pal.bgOn : pal.bgOff);
  const glyphs = typeof state.glyphs === "string" ? base64ToBytes(state.glyphs) : new Uint8Array(cols * rows);
  const cgram = typeof state.cgram === "string" ? base64ToBytes(state.cgram) : new Uint8Array(64);
  const ghost = lit ? pal.ghostOn : pal.ghostOff;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const code = glyphs[r * cols + c] ?? 0x20;
      const rowsBits = code < 16 ? Array.from(cgram.subarray((code & 7) * 8, (code & 7) * 8 + 8)) : glyphRows(code);
      const cursorHere = state.on && Number(state.cursorRow) === r && Number(state.cursorCol) === c;
      const x0 = MARGIN + c * (CELL_W + CELL_GAP_X);
      const y0 = MARGIN + r * (CELL_H + CELL_GAP_Y);
      for (let dy = 0; dy < 8; dy++) {
        let bits = state.on ? (rowsBits[dy] ?? 0) & 0x1f : 0;
        if (cursorHere && state.blinkOn) bits = 0x1f;
        if (cursorHere && state.cursorOn && dy === 7) bits = 0x1f;
        for (let dx = 0; dx < 5; dx++) {
          const on = (bits >> (4 - dx)) & 1;
          const col = on ? pal.dot : ghost;
          const px = x0 + dx * (LCD_DOT + LCD_GAP);
          const py = y0 + dy * (LCD_DOT + LCD_GAP);
          for (let yy = 0; yy < LCD_DOT; yy++) for (let xx = 0; xx < LCD_DOT; xx++) put(out, px + xx, py + yy, col);
        }
      }
    }
  }
  return out;
}

/** Which painter a display part uses, by the `data-screen` value in its SVG. */
export function painterFor(screen: string): ((s: VisualState, img?: RgbaImage) => RgbaImage) | undefined {
  if (/^\d+x\d+$/.test(screen)) {
    const [w, h] = screen.split("x").map(Number) as [number, number];
    // Character displays are tagged with columns x rows (16x2, 20x4); pixel displays are wider.
    return w <= 40 && h <= 4 ? paintLcd : paintOled;
  }
  return undefined;
}
