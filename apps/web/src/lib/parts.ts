import { partDefinitions as builtinDefinitions, registry as builtinRegistry, withProjectParts } from "@fabwright/parts";
import type { PartCategory, PartDefinition, PartSpec, PinSpec } from "@fabwright/sim-core";
import type { Rotation } from "@fabwright/project-format";
import { TFT_PART_TYPES } from "../renderers/tft/index.ts";

/**
 * The built-in catalog plus the open project's agent-made parts (decision 0003, C4). Everything in
 * the app reads parts through this overlay; lib/projectParts.ts feeds it from GET /api/project-parts.
 */
export const registry = withProjectParts(builtinRegistry);
/** Built-in definitions (the parts library lists these). */
export const partDefinitions = builtinDefinitions;

/** Colour-TFT controller part types an agent-made display may reuse, by type id of the display. */
const tftOf = new Map<string, string>();

/**
 * Replace the agent-made parts. `tftBase` maps a custom display type to the built-in TFT type whose
 * renderer draws it. Returns warnings (a project part hiding a built-in id).
 */
export function setProjectParts(defs: readonly PartDefinition[], tftBase: Record<string, string> = {}): string[] {
  tftOf.clear();
  for (const [k, v] of Object.entries(tftBase)) tftOf.set(k, v);
  return registry.setProjectParts(defs);
}

/** The built-in TFT type that renders this part type (itself for built-in TFTs), or undefined. */
export function tftTypeFor(type: string): string | undefined {
  if (TFT_PART_TYPES.includes(type) && !tftOf.has(type)) return type;
  return tftOf.get(type);
}

export const CATEGORY_LABEL: Record<PartCategory, string> = {
  board: "Boards",
  output: "Outputs",
  input: "Inputs",
  passive: "Passives",
  sensor: "Sensors",
  power: "Power",
  display: "Displays",
  motor: "Motors",
  communication: "Communication",
  misc: "Misc",
};

export const CATEGORY_ORDER: PartCategory[] = [
  "board",
  "output",
  "input",
  "passive",
  "sensor",
  "display",
  "motor",
  "power",
  "communication",
  "misc",
];

export function getDef(type: string): PartDefinition | undefined {
  return registry.get(type);
}

/** Node size on the canvas after rotation. */
export function rotatedSize(spec: Pick<PartSpec, "size">, rotation: Rotation): { w: number; h: number } {
  const { w, h } = spec.size;
  return rotation === 90 || rotation === 270 ? { w: h, h: w } : { w, h };
}

/** A pin's position inside the rotated node box (clockwise rotation, y down). */
export function rotatedPin(spec: Pick<PartSpec, "size">, pin: Pick<PinSpec, "x" | "y">, rotation: Rotation): { x: number; y: number } {
  const { w, h } = spec.size;
  switch (rotation) {
    case 90:
      return { x: h - pin.y, y: pin.x };
    case 180:
      return { x: w - pin.x, y: h - pin.y };
    case 270:
      return { x: pin.y, y: w - pin.x };
    default:
      return { x: pin.x, y: pin.y };
  }
}

export type Side = "left" | "right" | "top" | "bottom";

/** The node edge a pin is closest to; decides which way a wire leaves it. */
export function pinSide(box: { w: number; h: number }, p: { x: number; y: number }): Side {
  const d: [Side, number][] = [
    ["left", p.x],
    ["right", box.w - p.x],
    ["top", p.y],
    ["bottom", box.h - p.y],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0]![0];
}

/** "led" → "led1", "led2"… first id not already used. */
export function nextPartId(type: string, used: Iterable<string>): string {
  const taken = new Set(used);
  let base = type.replace(/[^A-Za-z0-9_-]/g, "");
  if (!/^[A-Za-z]/.test(base)) base = `p${base}`;
  for (let i = 1; ; i++) {
    const id = `${base}${i}`;
    if (!taken.has(id)) return id;
  }
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
