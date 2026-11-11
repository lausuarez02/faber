import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { colorFrameToPng, decodeMonoFrame, monoPixel, parseBindings, restVisualState, routePath, routeWire, type ColorFrame, type PartRegistry, type RouteBox, type VisualState } from "@jumper/sim-core";
import type { Project, Rotation } from "@jumper/project-format";
import { drawArm, drawWorld, type WorldSnapshot } from "@jumper/physics";
import { sizeOf } from "./layout.ts";
import { SvgCtx } from "./svgCtx.ts";
import type { ColorFrameImage } from "./sim.ts";

/**
 * Headless screenshot: composes the canvas as one SVG (part visuals with their live states bound,
 * wires, labels, display framebuffers), then rasterizes it with Playwright's Chromium when available.
 * Same look as the web canvas, no browser app needed.
 */

const BG = "#0D0F12";
const DOT = "#2A3039";
const LIVE = "#5CF2A1";
const MUTED = "#8A93A0";
const PAD = 80;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Apply data-bind bindings to SVG markup, like applyVisualState does on a DOM. */
export function bindSvgString(svg: string, state: VisualState): string {
  let out = "";
  let i = 0;
  const re = /<([A-Za-z][\w:-]*)(\s[^<>]*?)?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const attrs = m[2] ?? "";
    const bind = attrs.match(/\sdata-bind="([^"]*)"/);
    if (!bind) continue;
    let bindings: { attr: string; key: string }[];
    try {
      bindings = parseBindings(bind[1]!);
    } catch {
      continue;
    }
    let newAttrs = attrs;
    let text: string | undefined;
    for (const b of bindings) {
      const v = state[b.key];
      if (v === undefined) continue;
      if (b.attr === "text") text = String(v);
      else if (b.attr === "visible") {
        newAttrs = newAttrs.replace(/\sdisplay="[^"]*"/, "");
        if (!v) newAttrs += ' display="none"';
      } else {
        const attrRe = new RegExp(`\\s${b.attr.replace(/[-:]/g, (c) => `\\${c}`)}="[^"]*"`);
        const val = ` ${b.attr}="${esc(String(v))}"`;
        newAttrs = attrRe.test(newAttrs) ? newAttrs.replace(attrRe, val) : newAttrs + val;
      }
    }
    out += svg.slice(i, m.index) + `<${m[1]}${newAttrs}${m[3]}>`;
    i = m.index + m[0].length;
    if (text !== undefined && !m[3]) {
      const close = svg.indexOf("<", i);
      out += esc(text);
      i = close >= 0 ? close : svg.length;
      re.lastIndex = i;
    }
  }
  return out + svg.slice(i);
}

/** Rotated pin position inside the rotated part box (same math as the web canvas). */
export function rotatedPin(size: { w: number; h: number }, pin: { x: number; y: number }, r: Rotation): { x: number; y: number } {
  const { w, h } = size;
  if (r === 90) return { x: h - pin.y, y: pin.x };
  if (r === 180) return { x: w - pin.x, y: h - pin.y };
  if (r === 270) return { x: pin.y, y: w - pin.x };
  return { x: pin.x, y: pin.y };
}

/** Find the screen rectangle in a display part's SVG: an element marked data-screen, or the one bound to screenOpacity. */
function screenRect(svg: string): { x: number; y: number; w: number; h: number } | undefined {
  const tags = svg.match(/<rect\b[^>]*>/g) ?? [];
  const pick = tags.find((t) => /data-screen/.test(t)) ?? tags.find((t) => /data-bind="[^"]*screenOpacity/.test(t)) ?? tags.find((t) => /screen/i.test(t));
  if (!pick) return undefined;
  const num = (a: string) => Number(pick.match(new RegExp(`\\s${a}="([\\d.]+)"`))?.[1] ?? NaN);
  const r = { x: num("x"), y: num("y"), w: num("width"), h: num("height") };
  return Object.values(r).every(Number.isFinite) ? r : undefined;
}

function displayOverlay(svg: string, state: VisualState, size: { w: number; h: number }): string {
  if (typeof state.pixels !== "string" || !state.width || !state.height) return "";
  if (/data-bind="[^"]*:pixels/.test(svg)) return ""; // the SVG renders its own pixels
  let frame;
  try {
    frame = decodeMonoFrame(state.pixels, Number(state.width), Number(state.height));
  } catch {
    return "";
  }
  const rect = screenRect(svg) ?? { x: size.w * 0.1, y: size.h * 0.25, w: size.w * 0.8, h: size.h * 0.4 };
  const px = Math.min(rect.w / frame.width, rect.h / frame.height);
  const ox = rect.x + (rect.w - px * frame.width) / 2;
  const oy = rect.y + (rect.h - px * frame.height) / 2;
  const color = state.color === "blue" ? "#7FC8FF" : "#F2F5F8";
  const yellowRows = state.color === "yellow-blue" ? 16 : 0;
  let d = "";
  let dy = "";
  for (let y = 0; y < frame.height; y++) {
    let x = 0;
    while (x < frame.width) {
      if (!monoPixel(frame, x, y)) {
        x++;
        continue;
      }
      let e = x;
      while (e < frame.width && monoPixel(frame, e, y)) e++;
      const seg = `M${(ox + x * px).toFixed(2)} ${(oy + y * px).toFixed(2)}h${((e - x) * px).toFixed(2)}v${px.toFixed(2)}h${(-(e - x) * px).toFixed(2)}z`;
      if (y < yellowRows) dy += seg;
      else d += seg;
      x = e;
    }
  }
  const on = state.on !== false;
  return `<rect x="${ox}" y="${oy}" width="${px * frame.width}" height="${px * frame.height}" fill="#05070A"/>` + (on ? `<path d="${d}" fill="${state.color === "yellow-blue" ? "#7FC8FF" : color}"/>${dy ? `<path d="${dy}" fill="#FFD43B"/>` : ""}` : "");
}

let roundClips = 0;

/** A colour display's frame (TFT), drawn as an embedded PNG into the part's screen rectangle. */
function colorOverlay(svg: string, png: string, size: { w: number; h: number }): string {
  const rect = screenRect(svg) ?? { x: size.w * 0.1, y: size.h * 0.1, w: size.w * 0.8, h: size.h * 0.8 };
  const image = (extra: string) => `<image x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" preserveAspectRatio="xMidYMid meet" style="image-rendering:pixelated"${extra} href="data:image/png;base64,${png}"/>`;
  // A round panel (GC9A01, agent-made round glass) shows only the circle of its square frame.
  if (/<rect\b[^>]*data-screen-shape="round"/.test(svg)) {
    const id = `jumper-round-${++roundClips}`;
    return `<clipPath id="${id}"><ellipse cx="${rect.x + rect.w / 2}" cy="${rect.y + rect.h / 2}" rx="${rect.w / 2}" ry="${rect.h / 2}"/></clipPath>${image(` clip-path="url(#${id})"`)}`;
  }
  return image("");
}

export interface ComposeOptions {
  states?: Record<string, VisualState>;
  /** Colour display frames by part id (Simulation.framebuffer), for TFT screens. */
  framebuffers?: Record<string, ColorFrame>;
  /** Round 6 frames: colour screens as logged PNGs (Frame.color / VersionFrame.color), for history previews and thumbnails. */
  color?: Record<string, ColorFrameImage>;
  liveWires?: string[];
  title?: string;
  /** Highlight these parts (agent cursor). */
  highlight?: string[];
  /** The robot's world (arena top view or arm side view), drawn as a panel right of the circuit. */
  world?: WorldSnapshot;
}

const WORLD_W = 600;
const WORLD_H = 420;
const WORLD_HEADER = 30;

/** The world panel (same painters as the web app's World / Arm views), at x, y. */
export function worldPanelSvg(snap: WorldSnapshot, x: number, y: number): string {
  const kind = snap.robot || !snap.arm ? "world" : "arm";
  const ctx = new SvgCtx();
  (kind === "world" ? drawWorld : drawArm)(ctx, snap, { width: WORLD_W, height: WORLD_H });
  const title = kind === "world" ? "World · top view" : "Arm · side view";
  return (
    `<g transform="translate(${x} ${y})" data-world="${kind}">` +
    `<rect x="0" y="0" width="${WORLD_W}" height="${WORLD_H + WORLD_HEADER}" rx="8" fill="#15181D" stroke="#262B33"/>` +
    `<text x="14" y="20" font-family="IBM Plex Mono, monospace" font-size="12" fill="${MUTED}">${title}</text>` +
    `<line x1="0" y1="${WORLD_HEADER}" x2="${WORLD_W}" y2="${WORLD_HEADER}" stroke="#262B33"/>` +
    `<svg x="0" y="${WORLD_HEADER}" width="${WORLD_W}" height="${WORLD_H}" viewBox="0 0 ${WORLD_W} ${WORLD_H}">${ctx.markup()}</svg>` +
    `</g>`
  );
}

/** One SVG of the whole canvas. */
export function composeSvg(project: Project, registry: PartRegistry, opts: ComposeOptions = {}): string {
  const boxes = project.parts.map((p) => {
    const def = registry.get(p.type);
    const s = sizeOf(def?.spec, p.rotation);
    return { p, def, w: s.w, h: s.h };
  });
  const minX = Math.min(0, ...boxes.map((b) => b.p.x)) - PAD;
  const minY = Math.min(0, ...boxes.map((b) => b.p.y)) - PAD - (opts.title ? 40 : 0);
  const circuitMaxX = Math.max(400, ...boxes.map((b) => b.p.x + b.w)) + PAD;
  const worldY = minY + (opts.title ? 40 : 0) + PAD / 2;
  const maxX = circuitMaxX + (opts.world ? WORLD_W + PAD : 0);
  const maxY = Math.max(Math.max(300, ...boxes.map((b) => b.p.y + b.h)) + PAD, opts.world ? worldY + WORLD_H + WORLD_HEADER + PAD / 2 : -Infinity);
  const W = maxX - minX;
  const H = maxY - minY;
  const live = new Set(opts.liveWires ?? []);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${W} ${H}" width="${W}" height="${H}">`);
  out.push(`<defs><pattern id="jumper-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.2" fill="${DOT}"/></pattern>`);
  out.push(`<filter id="jumper-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter></defs>`);
  out.push(`<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="${BG}"/><rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="url(#jumper-dots)"/>`);
  if (opts.title) out.push(`<text x="${minX + 24}" y="${minY + 36}" font-family="Bricolage Grotesque, IBM Plex Sans, sans-serif" font-weight="700" font-size="22" fill="#E9EDF2">${esc(opts.title)}</text>`);

  const pinAbs = new Map<string, { x: number; y: number }>();
  for (const b of boxes) {
    if (!b.def) continue;
    for (const pin of b.def.spec.pins) {
      const r = rotatedPin(b.def.spec.size, pin, b.p.rotation);
      pinAbs.set(`${b.p.id}.${pin.id}`, { x: b.p.x + r.x, y: b.p.y + r.y });
    }
  }

  for (const b of boxes) {
    if (!b.def) {
      out.push(`<rect x="${b.p.x}" y="${b.p.y}" width="${b.w}" height="${b.h}" rx="8" fill="#1C2027" stroke="#FF4D2E" stroke-dasharray="4 4"/><text x="${b.p.x + 8}" y="${b.p.y + 20}" font-family="IBM Plex Mono, monospace" font-size="12" fill="#FF4D2E">unknown type ${esc(b.p.type)}</text>`);
      continue;
    }
    const { spec } = b.def;
    const state = opts.states?.[b.p.id];
    let svg = b.def.svg.replace(/<\?xml[^>]*>/, "");
    // before a run, the part as its props make it look (a blue LED's lens is blue)
    const bound = state ?? restVisualState(b.def, b.p.id, b.p.props);
    if (bound) svg = bindSvgString(svg, bound);
    // Make ids unique per instance so gradients/filters of two copies do not collide.
    svg = svg.replace(/\bid="([^"]+)"/g, `id="${b.p.id}--$1"`).replace(/url\(#([^)]+)\)/g, `url(#${b.p.id}--$1)`).replace(/href="#([^"]+)"/g, `href="#${b.p.id}--$1"`);
    svg = svg.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => `<svg${attrs.replace(/\s(width|height|x|y)="[^"]*"/g, "")} x="0" y="0" width="${spec.size.w}" height="${spec.size.h}">`);
    const fb = opts.framebuffers?.[b.p.id];
    const png = fb ? Buffer.from(colorFrameToPng(fb, 1)).toString("base64") : opts.color?.[b.p.id]?.png;
    const overlay = png ? colorOverlay(b.def.svg, png, spec.size) : state ? displayOverlay(b.def.svg, state, spec.size) : "";
    const rot = b.p.rotation ? ` rotate(${b.p.rotation} ${spec.size.w / 2} ${spec.size.h / 2})` : "";
    // Rotation is about the unrotated centre; then shift so the rotated box sits at x,y.
    const shift = b.p.rotation === 90 || b.p.rotation === 270 ? { x: (spec.size.h - spec.size.w) / 2, y: (spec.size.w - spec.size.h) / 2 } : { x: 0, y: 0 };
    const glow = typeof state?.brightness === "number" && state.brightness > 0.05 && spec.category !== "display" ? `<circle cx="${spec.size.w / 2}" cy="${spec.size.h / 2}" r="${Math.min(spec.size.w, spec.size.h) * 0.45}" fill="${glowColor(state)}" opacity="${Math.min(0.55, state.brightness * 0.6)}" filter="url(#jumper-glow)"/>` : "";
    out.push(`<g transform="translate(${b.p.x + shift.x} ${b.p.y + shift.y})${rot}">${glow}${svg}${overlay}</g>`);
    if (opts.highlight?.includes(b.p.id)) out.push(`<rect x="${b.p.x - 6}" y="${b.p.y - 6}" width="${b.w + 12}" height="${b.h + 12}" rx="10" fill="none" stroke="#4DA3FF" stroke-width="2" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${b.p.x}" y="${b.p.y + b.h + 16}" font-family="IBM Plex Mono, monospace" font-size="12" fill="${MUTED}">${esc(b.p.id)}</text>`);
  }

  // Wires route around part bodies and their id labels (drawn below each part).
  const obstacles: RouteBox[] = boxes.flatMap((b) => [
    { id: b.p.id, x: b.p.x, y: b.p.y, w: b.w, h: b.h },
    { id: `${b.p.id}#label`, x: b.p.x - 2, y: b.p.y + b.h + 3, w: b.p.id.length * 7.5 + 4, h: 17 },
  ]);
  for (const w of project.wires) {
    const a = pinAbs.get(`${w.from.part}.${w.from.pin}`);
    const z = pinAbs.get(`${w.to.part}.${w.to.pin}`);
    if (!a || !z) continue;
    const d = w.waypoints?.length ? routePath([a, ...w.waypoints, z]) : routePath(routeWire(a, z, obstacles, w.from.part, w.to.part));
    const color = w.color ?? "#FF4D2E";
    const isLive = live.has(w.id);
    if (isLive) out.push(`<path d="${d}" fill="none" stroke="${LIVE}" stroke-width="8" stroke-opacity="0.35" stroke-linejoin="round" filter="url(#jumper-glow)"/>`);
    out.push(`<path d="${d}" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="5" stroke-linejoin="round"/>`);
    out.push(`<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="3" stroke-linejoin="round"/>`);
    if (isLive) out.push(`<path d="${d}" fill="none" stroke="${LIVE}" stroke-width="1.2" stroke-dasharray="4 6" stroke-linejoin="round"/>`);
    for (const p of [a, z]) out.push(`<rect x="${p.x - 3}" y="${p.y - 3}" width="6" height="6" rx="1" fill="${esc(color)}"/>`);
  }
  if (opts.world) out.push(worldPanelSvg(opts.world, circuitMaxX, worldY));
  out.push("</svg>");
  return out.join("\n");
}

function glowColor(state: VisualState): string {
  const c = typeof state.color === "string" ? state.color.toLowerCase() : "";
  const map: Record<string, string> = { red: "#FF3B30", green: "#5CF2A1", blue: "#4DA3FF", yellow: "#FFD43B", white: "#FFFFFF" };
  return map[c] ?? (c.startsWith("#") ? c : LIVE);
}

type PlaywrightModule = { chromium: { launch(o?: object): Promise<{ newPage(o?: object): Promise<{ setContent(h: string, o?: object): Promise<void>; screenshot(o?: object): Promise<Buffer>; evaluate<T>(f: string): Promise<T> }>; close(): Promise<void> }> } };

/** Load Playwright from the web app's dev dependencies (or anywhere Node can find it). */
export function loadPlaywright(): PlaywrightModule | undefined {
  const tries = [import.meta.url, new URL("../../../apps/web/package.json", import.meta.url).href];
  for (const from of tries) {
    try {
      const req = createRequire(from.startsWith("file:") ? fileURLToPath(from) : from);
      for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
        try {
          return req(name) as PlaywrightModule;
        } catch {
          // next
        }
      }
    } catch {
      // next
    }
  }
  return undefined;
}

let fontCss: string | undefined;
/** @font-face rules for the three brand families, inlined from the web app's @fontsource packages. */
function brandFontCss(): string {
  if (fontCss !== undefined) return fontCss;
  const root = fileURLToPath(new URL("../../../apps/web/node_modules/@fontsource/", import.meta.url));
  const faces: [string, string, number][] = [
    ["Bricolage Grotesque", "bricolage-grotesque", 600],
    ["Bricolage Grotesque", "bricolage-grotesque", 800],
    ["IBM Plex Sans", "ibm-plex-sans", 400],
    ["IBM Plex Sans", "ibm-plex-sans", 600],
    ["IBM Plex Mono", "ibm-plex-mono", 400],
    ["IBM Plex Mono", "ibm-plex-mono", 500],
  ];
  fontCss = faces
    .map(([family, pkg, weight]) => {
      const f = `${root}${pkg}/files/${pkg}-latin-${weight}-normal.woff2`;
      if (!existsSync(f)) return "";
      return `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(f).toString("base64")}) format("woff2")}`;
    })
    .join("");
  return fontCss;
}

/** Rasterize an SVG to PNG with Chromium. Returns undefined when Playwright is not installed. */
export async function svgToPng(svg: string, scale = 1): Promise<Buffer | undefined> {
  const pw = loadPlaywright();
  if (!pw) return undefined;
  const w = Number(svg.match(/width="(\d+(?:\.\d+)?)"/)?.[1] ?? 1200);
  const h = Number(svg.match(/height="(\d+(?:\.\d+)?)"/)?.[1] ?? 800);
  const maxSide = 2400;
  const s = Math.min(scale, maxSide / Math.max(w, h));
  let browser;
  try {
    browser = await pw.chromium.launch();
  } catch {
    return undefined; // Playwright is there but its Chromium is not installed: the caller falls back to SVG and says how to install it
  }
  try {
    const page = await browser.newPage({ viewport: { width: Math.ceil(w * s), height: Math.ceil(h * s) }, deviceScaleFactor: 1 });
    const html = `<!doctype html><html><head><style>${brandFontCss()}html,body{margin:0;background:${BG}}svg{display:block;width:${Math.ceil(w * s)}px;height:${Math.ceil(h * s)}px}</style></head><body>${svg}</body></html>`;
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    return await page.screenshot({ type: "png", fullPage: false });
  } finally {
    await browser.close();
  }
}
