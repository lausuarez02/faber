import { partDefinitions, registry } from "@jumper/parts";
import type { PartCategory, PartDefinition, PartSpec, PinSpec } from "@jumper/sim-core";
import type { Rotation } from "@jumper/project-format";

export { registry, partDefinitions };

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
