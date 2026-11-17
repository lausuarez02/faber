// Picks how the Device view presents a project: its own designed case (when the Case view built
// one), a generic handheld (screen + buttons, no case yet), a robot in its arena, an arm on a
// table, or the board on a desk. Pure, so it is unit-tested.
import type { Project } from "@fabwright/project-format";
import { registry, tftTypeFor } from "../../lib/parts.ts";

export type DeviceKind = "case" | "handheld" | "rover" | "arm" | "board";

/** One opening of the built case (case frame, mm), from GET /api/device/case. */
export interface CaseOpening {
  part: string;
  feature: string;
  kind: string;
  face: string;
  /** Outward normal. */
  n: [number, number, number];
  /** Centre on the cavity's inner surface (outer surface = at + n * depth). */
  at: [number, number, number];
  shape: "rect" | "round";
  u: number;
  v: number;
  uAxis: [number, number, number];
  vAxis: [number, number, number];
  depth: number;
  standoff: number;
  /** window: the display's active area behind it. */
  screen?: { u: number; v: number; shape: string };
  insert?: { kind: string; d: number; travel: number; protrude: number; length: number };
  holes?: number;
}

/** The built case as the Device view gets it (GET /api/device/case; meshes stay base64 until drawn). */
export interface CaseModel {
  hash: string;
  engine: string;
  stale: boolean;
  stale_reason?: string;
  shape: string;
  color?: string;
  size_mm: { w: number; h: number; d: number };
  mesh: { hash: string; bodies: { body: string; kind: "shell" | "cap" | "part" | "insert"; color: string; positions: string; indices: string; explode: [number, number, number] }[] };
  openings: CaseOpening[];
  ms?: number;
}

/** The project's parts mapped onto the built case: what goes in which opening. */
export interface CaseFit {
  model: CaseModel;
  /** The display behind the window (no window: the screen is not shown). */
  screen?: { id: string; type: string; window?: CaseOpening };
  /** Same order as DeviceLayout.buttons (keys 1-9); opening / cap body when the case has one for it. */
  buttons: { id: string; opening?: CaseOpening; cap?: string }[];
  /** LEDs with a light pipe (or a hole) to shine through. */
  leds: { id: string; color: string; opening: CaseOpening; pipe?: string }[];
  /** Speaker grilles (rings while their part or a buzzer sounds). */
  grilles: CaseOpening[];
  /** USB and other connector openings. */
  connectors: CaseOpening[];
  /** Round 13: camera lens holes (the lens shows in them; it lights up while the camera takes pictures). */
  lenses: CaseOpening[];
}

export interface ScreenType {
  /** oled / lcd: pixels or glyphs from the visual state; tft: Simulation.framebuffer; panel: the framebuffer when the model has one, else pixels. */
  kind: "oled" | "lcd" | "tft" | "panel";
  screen: string;
  aspect: number;
  /** Shown in the HUD ("TFT + 1 button"). */
  label: string;
}

export const SCREEN_TYPES: Record<string, ScreenType> = {
  "ssd1306-oled-i2c": { kind: "oled", screen: "128x64", aspect: 2, label: "OLED" },
  "lcd1602-i2c": { kind: "lcd", screen: "16x2", aspect: 80 / 35, label: "LCD" },
  // Colour panels: pixels come from Simulation.framebuffer(partId), not the visual state.
  "ili9341-tft": { kind: "tft", screen: "320x240", aspect: 4 / 3, label: "TFT" },
  "st7735-tft": { kind: "tft", screen: "128x160", aspect: 128 / 160, label: "TFT" },
  // Round panel: the square framebuffer is shown; the glass circle is the part's own drawing.
  "gc9a01-round-tft": { kind: "tft", screen: "240x240", aspect: 1, label: "TFT" },
};

/**
 * The screen a part type has, or undefined. Round 17: besides the table above, any display part
 * whose drawing marks its glass with data-screen="WxH" (an e-paper, a memory LCD, an agent-made
 * panel) is a screen too; the Device view draws it from its framebuffer, else from its pixels.
 */
export function screenTypeOf(type: string): ScreenType | undefined {
  const known = SCREEN_TYPES[type];
  if (known) return known;
  const def = registry.get(type);
  if (!def || def.spec.category !== "display") return undefined;
  const m = /data-screen="(\d+)x(\d+)"/.exec(def.svg);
  if (!m) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0 && h > 0)) return undefined;
  const words = `${def.spec.name} ${(def.spec.tags ?? []).join(" ")}`;
  if (tftTypeFor(type)) return { kind: "tft", screen: `${w}x${h}`, aspect: w / h, label: "TFT" };
  if (w <= 40 && h <= 4) return { kind: "lcd", screen: `${w}x${h}`, aspect: (80 / 35) * (w / 16) * (2 / h), label: "LCD" };
  const label = /e-?paper|e-?ink/i.test(words) ? "E-paper" : /memory (lcd|display)/i.test(words) ? "Memory LCD" : /oled/i.test(words) ? "OLED" : "Screen";
  return { kind: "panel", screen: `${w}x${h}`, aspect: w / h, label };
}

/** The colour of a display part's blank glass (its drawing's data-screen fill), for a panel before its first frame. */
export function screenBlankOf(type: string): string {
  const svg = registry.get(type)?.svg ?? "";
  const tag = /<[^>]*data-screen="[^"]*"[^>]*>/.exec(svg)?.[0] ?? "";
  return /fill="(#[0-9a-fA-F]{3,8})"/.exec(tag)?.[1] ?? "#000";
}

const BUTTON_TYPES = new Set(["pushbutton"]);
const LED_TYPES = new Set(["led", "rgb-led"]);
const BOARD_TYPES = new Set(["arduino-uno", "arduino-nano", "raspberry-pi-pico", "seeed-xiao-rp2040", "waveshare-rp2040-zero"]);

export interface DeviceLayout {
  kind: DeviceKind;
  /** First display part (OLED / LCD), if any. */
  screen?: { id: string; type: string };
  /** Buttons left to right (canvas x order, so they match the wiring diagram). */
  buttons: { id: string }[];
  leds: { id: string; color: string }[];
  buzzers: { id: string }[];
  board?: { id: string; type: string };
  /** Short reason, shown in the HUD ("OLED + 3 buttons → handheld"). */
  why: string;
  /** kind "case": the parts in their real openings of the designed case. */
  case?: CaseFit;
}

const SHAPE_LABEL: Record<string, string> = { pebble: "Pebble", puck: "Puck", "rounded-box": "Box", pill: "Pill", keychain: "Keychain", custom: "Custom" };

/** "Custom case", "Pebble case": the HUD's name for a designed case. */
export function caseLabel(shape: string): string {
  return `${SHAPE_LABEL[shape] ?? shape.charAt(0).toUpperCase() + shape.slice(1)} case`;
}

/** Map the project's buttons, screen, LEDs and speakers onto the built case's openings and bodies. */
export function fitToCase(base: Pick<DeviceLayout, "buttons" | "leds" | "screen">, model: CaseModel): CaseFit {
  const bodies = new Set(model.mesh.bodies.map((b) => b.body));
  const of = (part: string, kinds: string[]) => model.openings.find((o) => o.part === part && kinds.includes(o.kind));
  const window = base.screen ? of(base.screen.id, ["window"]) : undefined;
  return {
    model,
    ...(base.screen ? { screen: { ...base.screen, ...(window ? { window } : {}) } } : {}),
    buttons: base.buttons.map((b) => {
      const opening = of(b.id, ["button"]);
      const cap = bodies.has(`cap-${b.id}`) ? `cap-${b.id}` : undefined;
      return { id: b.id, ...(opening ? { opening } : {}), ...(cap ? { cap } : {}) };
    }),
    leds: base.leds.flatMap((l) => {
      const opening = of(l.id, ["light-pipe", "hole"]);
      if (!opening) return [];
      const pipe = bodies.has(`light-pipe-${l.id}`) ? `light-pipe-${l.id}` : undefined;
      return [{ ...l, opening, ...(pipe ? { pipe } : {}) }];
    }),
    grilles: model.openings.filter((o) => o.kind === "grille"),
    connectors: model.openings.filter((o) => o.kind === "connector"),
    lenses: model.openings.filter((o) => o.kind === "lens"),
  };
}

/**
 * How the Device view shows the project. With `built` (the case the Case view built, from
 * GET /api/device/case) any project that is not a robot or an arm is shown as that case; without
 * one, a screen makes the generic handheld.
 */
export function classifyProject(project: Project, built?: CaseModel | null): DeviceLayout {
  const parts = project.parts;
  const screenPart = parts.find((p) => screenTypeOf(p.type));
  const buttons = parts.filter((p) => BUTTON_TYPES.has(p.type)).sort((a, b) => a.x - b.x || a.y - b.y).map((p) => ({ id: p.id }));
  const leds = parts.filter((p) => LED_TYPES.has(p.type)).map((p) => ({ id: p.id, color: String(p.props?.color ?? "red") }));
  const buzzers = parts.filter((p) => p.type === "buzzer" || p.type === "passive-buzzer").map((p) => ({ id: p.id }));
  const boardPart = parts.find((p) => BOARD_TYPES.has(p.type));
  const base = {
    buttons,
    leds,
    buzzers,
    ...(screenPart ? { screen: { id: screenPart.id, type: screenPart.type } } : {}),
    ...(boardPart ? { board: { id: boardPart.id, type: boardPart.type } } : {}),
  };
  const world = project.world as { robot?: unknown; arm?: unknown } | undefined;
  if (world?.robot !== undefined || parts.some((p) => p.type === "robot-chassis-2wd")) {
    return { ...base, kind: "rover", why: "robot chassis with a world → rover in its arena" };
  }
  if (world?.arm !== undefined) return { ...base, kind: "arm", why: "arm block in the world → arm on a table" };
  if (built && project.enclosure) {
    const has = [screenPart ? screenTypeOf(screenPart.type)!.label : "", buttons.length ? `${buttons.length} button${buttons.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ");
    return { ...base, kind: "case", case: fitToCase(base, built), why: `${caseLabel(built.shape)} from the Case view${has ? ` · ${has}` : ""}` };
  }
  if (screenPart && buttons.length > 0) {
    return { ...base, kind: "handheld", why: `${screenTypeOf(screenPart.type)!.label} + ${buttons.length} button${buttons.length === 1 ? "" : "s"} → handheld` };
  }
  if (screenPart) return { ...base, kind: "handheld", why: `${screenTypeOf(screenPart.type)!.label} → handheld` };
  return { ...base, kind: "board", why: "no screen or world → board on a desk" };
}

/** Latest `name=value` pairs of the last complete serial line that has any (for HUD readouts). */
export function serialStats(text: string, max = 6): { key: string; value: string }[] {
  const tail = text.slice(-600).split(/\r?\n/);
  tail.pop(); // the line being printed
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i]!;
    const pairs = [...line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(-?[\w.]+)/g)].map((m) => ({ key: m[1]!, value: m[2]! }));
    if (pairs.length >= 2) return pairs.slice(0, max);
  }
  return [];
}

/** Last complete serial line (for the HUD ticker). */
export function lastSerialLine(text: string): string {
  const lines = text.slice(-400).split(/\r?\n/);
  lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim()) return lines[i]!.trim();
  return "";
}
