// Picks how the Device view presents a project: a handheld (screen + buttons), a robot in its
// arena, an arm on a table, or the board on a desk. Pure, so it is unit-tested.
import type { Project } from "@jumper/project-format";

export type DeviceKind = "handheld" | "rover" | "arm" | "board";

export const SCREEN_TYPES: Record<string, { kind: "oled" | "lcd" | "tft"; screen: string; aspect: number }> = {
  "ssd1306-oled-i2c": { kind: "oled", screen: "128x64", aspect: 2 },
  "lcd1602-i2c": { kind: "lcd", screen: "16x2", aspect: 80 / 35 },
  // Colour panels: pixels come from Simulation.framebuffer(partId), not the visual state.
  "ili9341-tft": { kind: "tft", screen: "320x240", aspect: 4 / 3 },
};

const BUTTON_TYPES = new Set(["pushbutton"]);
const LED_TYPES = new Set(["led", "rgb-led"]);

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
}

export function classifyProject(project: Project): DeviceLayout {
  const parts = project.parts;
  const screenPart = parts.find((p) => SCREEN_TYPES[p.type]);
  const buttons = parts.filter((p) => BUTTON_TYPES.has(p.type)).sort((a, b) => a.x - b.x || a.y - b.y).map((p) => ({ id: p.id }));
  const leds = parts.filter((p) => LED_TYPES.has(p.type)).map((p) => ({ id: p.id, color: String(p.props?.color ?? "red") }));
  const buzzers = parts.filter((p) => p.type === "buzzer").map((p) => ({ id: p.id }));
  const boardPart = parts.find((p) => p.type === "arduino-uno" || p.type === "arduino-nano");
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
  if (screenPart && buttons.length > 0) {
    return { ...base, kind: "handheld", why: `${SCREEN_TYPES[screenPart.type]!.kind.toUpperCase()} + ${buttons.length} button${buttons.length === 1 ? "" : "s"} → handheld` };
  }
  if (screenPart) return { ...base, kind: "handheld", why: `${SCREEN_TYPES[screenPart.type]!.kind.toUpperCase()} → handheld` };
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
