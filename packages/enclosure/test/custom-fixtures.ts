// Round 7 test fixtures: a talking speaker part (the voice track adds the real one; this stands in
// for it here) and the egg device: XIAO RP2040 + GC9A01 eyes + LiPo + TP4056 + speaker.
import type { Project } from "@jumper/project-format";
import type { PartSpec } from "@jumper/sim-core";
import { registry } from "@jumper/parts";

function speaker(id: string, od: number, d: number, grille: number): PartSpec {
  const base = registry.get("passive-buzzer")!.spec;
  return {
    ...base,
    id,
    name: `Speaker ${od} mm (8 Ω, 0.5 W, test fixture)`,
    description: "Small round speaker for speech (test fixture).",
    tags: ["speaker", "audio", "voice", "sound", "output"],
    dimensions_mm: { w: od, h: od, d },
    mechanical: {
      outline: "round",
      keepout_bottom_mm: 0.5,
      features: [{ id: "sound", kind: "grille", face: "+z", x: od / 2, y: od / 2, shape: "round", d: grille }],
      source: "test fixture",
    },
  } as PartSpec;
}

export const SPEAKER_28 = speaker("speaker-28mm", 28, 5, 18);
export const SPEAKER_20 = speaker("speaker-20mm", 20, 4, 14);

const FIXTURES = new Map<string, PartSpec>([
  [SPEAKER_28.id, SPEAKER_28],
  [SPEAKER_20.id, SPEAKER_20],
]);

export const specOfX = (t: string): PartSpec | undefined => FIXTURES.get(t) ?? registry.get(t)?.spec;

/** Every part spec in the library plus the fixtures (for swap suggestions). */
export function catalogX(): PartSpec[] {
  return [...registry.list().map((d) => d.spec), ...FIXTURES.values()];
}

/**
 * An egg drawn as a custom outline (SVG, y down like any drawing program): narrow top, wide bottom,
 * 56 x 73 mm (h = 1.3 w), widest about a third of the way up from the bottom.
 */
export const EGG_SVG = "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z";

/** The same kind of egg as points (y up) with smoothing. */
export const EGG_POINTS: [number, number][] = [
  [0, 40],
  [14, 33],
  [24, 16],
  [28, -4],
  [24, -22],
  [13, -32],
  [0, -34],
  [-13, -32],
  [-24, -22],
  [-28, -4],
  [-24, 16],
  [-14, 33],
];

/** A bean (kidney) outline, y up. */
export const BEAN_POINTS: [number, number][] = [
  [-30, 6],
  [-24, 20],
  [-8, 24],
  [4, 17],
  [16, 22],
  [30, 14],
  [34, -2],
  [26, -18],
  [6, -24],
  [-14, -22],
  [-28, -12],
];

/** A rounded heart, SVG (y down). */
export const HEART_SVG = "M 0 -14 C -6 -30 -34 -30 -34 -6 C -34 12 -12 26 0 38 C 12 26 34 12 34 -6 C 34 -30 6 -30 0 -14 Z";

export function eggProject(enclosure: Project["enclosure"]): Project {
  return {
    format: "jumper/1",
    name: "Talking egg",
    parts: [
      { id: "xiao", type: "seeed-xiao-rp2040", x: 0, y: 0, rotation: 0 },
      { id: "eyes", type: "gc9a01-round-tft", x: 300, y: 0, rotation: 0 },
      { id: "bat", type: "lipo-battery", x: 0, y: 300, rotation: 0, props: { capacity: 500 } },
      { id: "chg", type: "tp4056-charger", x: 300, y: 300, rotation: 0 },
      { id: "spk", type: "speaker-28mm", x: 600, y: 0, rotation: 0 },
    ],
    wires: [],
    scenarios: [],
    ...(enclosure ? { enclosure } : {}),
  } as unknown as Project;
}

export function partsX(p: Project) {
  return p.parts.map((x) => ({ id: x.id, type: x.type, spec: specOfX(x.type)!, ...(x.props ? { props: x.props as Record<string, unknown> } : {}) }));
}
