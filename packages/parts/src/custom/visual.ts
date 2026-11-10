// Auto-generated visual for an agent-made part with no SVG: a labelled module drawing (board
// outline, name, a dashed "AGENT-MADE" tag, header pins with their labels, a status light or a
// value readout bound to the model's state). Displays get a glass rect marked data-screen so the
// canvas and screenshots draw live pixels on it. Pure string code (browser + Node).
import type { PinSpec } from "@jumper/sim-core";
import type { CustomPart } from "./schema.ts";

export const PIN_PITCH = 20;
const PAD = 14;
const HEADER = 30;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Split a name into at most `lines` lines of about `width` characters. */
function wrap(text: string, width: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width && cur) {
      out.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = kept[lines - 1]!.slice(0, Math.max(1, width - 1)) + "…";
    return kept;
  }
  return out.map((l) => (l.length > width ? l.slice(0, width - 1) + "…" : l));
}

export interface Screen {
  /** data-screen value: "WxH" in pixels of the frame as the viewer sees it. */
  kind: string;
  /** Pixel size of the frame (viewer orientation). */
  w: number;
  h: number;
  round: boolean;
}

export interface Layout {
  size: { w: number; h: number };
  pins: PinSpec[];
  /** Glass rect for displays. */
  glass?: { x: number; y: number; w: number; h: number };
}

/** Pin positions along the top edge (one header row), module size to fit pins, name and screen. */
export function layoutPins(pins: Omit<PinSpec, "x" | "y">[], screen?: Screen): Layout {
  const n = Math.max(1, pins.length);
  let w = Math.max(120, n * PIN_PITCH + 2 * PAD);
  let h = 110;
  let glass: Layout["glass"];
  if (screen) {
    // Fit the glass at a scale where one pixel is at most 2 px and the module stays readable.
    const maxW = Math.max(w - 2 * PAD, 160);
    const scale = Math.min(2, maxW / screen.w, 260 / screen.h);
    const gw = Math.round(screen.w * scale);
    const gh = Math.round(screen.h * scale);
    w = Math.max(w, gw + 2 * PAD);
    glass = { x: Math.round((w - gw) / 2), y: HEADER + 22, w: gw, h: gh };
    h = glass.y + gh + 40;
  }
  const x0 = Math.round((w - (n - 1) * PIN_PITCH) / 2);
  return {
    size: { w, h },
    pins: pins.map((p, i) => ({ ...p, x: x0 + i * PIN_PITCH, y: 12 })),
    ...(glass ? { glass } : {}),
  };
}

const FONT = 'font-family="IBM Plex Mono"';

/** Indicator drawn under the name, bound to the model's state keys (see models.ts). */
function indicator(part: CustomPart, w: number, y: number): string {
  const b = part.behavior;
  const cx = w / 2;
  switch (b.kind) {
    case "digital-input":
    case "actuator":
      return [
        `<circle cx="${PAD + 4}" cy="${y}" r="4" fill="#1E2630" stroke="#3A4250"/>`,
        `<circle cx="${PAD + 4}" cy="${y}" r="4" fill="#5CF2A1" opacity="0" data-bind="opacity:ledOpacity"/>`,
        `<text x="${cx}" y="${y + 3}" text-anchor="middle" ${FONT} font-size="8" fill="#5CF2A1" data-bind="text:label">${esc(b.kind === "actuator" ? "off" : "idle")}</text>`,
      ].join("\n  ");
    case "analog-sensor":
    case "i2c-device":
    case "uart-device":
      return `<text x="${cx}" y="${y + 3}" text-anchor="middle" ${FONT} font-size="8" fill="#5CF2A1" data-bind="text:label">${esc(b.kind === "i2c-device" ? "I2C" : b.kind === "uart-device" ? "UART" : "")}</text>`;
    default:
      return "";
  }
}

/** The full SVG for a part without an agent-supplied visual. */
export function generateVisual(part: CustomPart, layout: Layout, screen?: Screen): string {
  const { w, h } = layout.size;
  const id = part.id;
  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`);
  lines.push(`  <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="6" fill="#16222A" stroke="#3A4250" stroke-width="1.5"/>`);
  // Header strip with pin labels.
  const xs = layout.pins.map((p) => p.x);
  if (xs.length) lines.push(`  <rect x="${Math.min(...xs) - 9}" y="4" width="${Math.max(...xs) - Math.min(...xs) + 18}" height="16" rx="2" fill="#0E1418" stroke="#3A4250"/>`);
  for (const p of layout.pins) {
    const label = (p.label || p.id).slice(0, 5);
    lines.push(`  <text x="${p.x}" y="${HEADER - 2}" text-anchor="middle" ${FONT} font-size="${label.length > 3 ? 5 : 6}" fill="#E9EDF2">${esc(label)}</text>`);
  }
  let y = HEADER + 14;
  if (layout.glass && screen) {
    const g = layout.glass;
    lines.push(`  <text x="${w / 2}" y="${HEADER + 13}" text-anchor="middle" ${FONT} font-size="8" fill="#C9CED6">${esc(wrap(part.name, Math.floor((w - 2 * PAD) / 4.9), 1)[0] ?? id)}</text>`);
    lines.push(`  <rect x="${g.x - 4}" y="${g.y - 4}" width="${g.w + 8}" height="${g.h + 8}" rx="${screen.round ? (g.w + 8) / 2 : 3}" fill="#0B0F12" stroke="#3A4250"/>`);
    lines.push(`  <rect data-screen="${screen.kind}" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" fill="#05070A" data-bind="opacity:screenOpacity"/>`);
    if (screen.round) {
      // Bezel over the square frame's corners, drawn after the screen so it stays on top.
      const cx = g.x + g.w / 2;
      const cy = g.y + g.h / 2;
      const r = Math.min(g.w, g.h) / 2;
      lines.push(
        `  <path fill-rule="evenodd" fill="#0B0F12" d="M${g.x - 1} ${g.y - 1}H${g.x + g.w + 1}V${g.y + g.h + 1}H${g.x - 1}Z M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z"/>`,
      );
    }
    y = g.y + g.h + 18;
  } else {
    const name = wrap(part.name, Math.floor((w - 2 * PAD) / 5.5), 2);
    name.forEach((l, i) => lines.push(`  <text x="${w / 2}" y="${y + i * 11}" text-anchor="middle" ${FONT} font-size="9" fill="#E9EDF2">${esc(l)}</text>`));
    y += name.length * 11 + 8;
    const ind = indicator(part, w, y);
    if (ind) lines.push(`  ${ind}`);
    y += 14;
  }
  // The honesty tag: this drawing and its behaviour were made by an agent.
  const tagW = 76;
  lines.push(`  <rect x="${(w - tagW) / 2}" y="${Math.min(y, h - 18)}" width="${tagW}" height="12" rx="2" fill="none" stroke="#FFB23F" stroke-dasharray="3 2" stroke-width="1"/>`);
  lines.push(`  <text x="${w / 2}" y="${Math.min(y, h - 18) + 9}" text-anchor="middle" ${FONT} font-size="7" fill="#FFB23F">AGENT-MADE</text>`);
  for (const p of layout.pins) lines.push(`  <circle data-pin="${esc(p.id)}" cx="${p.x}" cy="${p.y}" r="3" fill="#C9CED6"/>`);
  lines.push("</svg>");
  return lines.join("\n") + "\n";
}
