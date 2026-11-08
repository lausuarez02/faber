import { z } from "zod";
import type { PropValue } from "@jumper/project-format";
import type { CircuitBuilder, NodeId, SolveResultView } from "./circuit.ts";
import type { McuBackend } from "./mcu.ts";

// ---------------------------------------------------------------------------
// part.json
// ---------------------------------------------------------------------------

export const PART_CATEGORIES = [
  "board",
  "output",
  "input",
  "passive",
  "sensor",
  "power",
  "display",
  "motor",
  "communication",
  "misc",
] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];

export const PinTypeSchema = z.enum(["digital", "analog", "power", "ground", "passive"]);
export type PinType = z.infer<typeof PinTypeSchema>;

export const PinSpecSchema = z.object({
  /** Stable pin id used in wires, e.g. "D13", "A", "GND.1". For boards: equals the McuBackend pin id for GPIOs. */
  id: z.string().min(1),
  /** Short label shown on hover / in the pin list, e.g. "13", "Anode". */
  label: z.string(),
  /** Pin position in px inside the visual.svg viewBox (0..size.w, 0..size.h). */
  x: z.number(),
  y: z.number(),
  /** "ground" pins are tied to circuit node "0" by the simulation. */
  type: PinTypeSchema,
  voltage: z.object({ min: z.number(), max: z.number() }).optional(),
  /** e.g. ["pwm"], ["i2c-sda"], ["uart-tx"], ["adc"]. */
  protocols: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type PinSpec = z.infer<typeof PinSpecSchema>;

export const PropSpecSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  type: z.enum(["number", "boolean", "color", "enum"]),
  default: z.union([z.number(), z.boolean(), z.string()]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
  /** For type "enum" (and optional presets for "color"). */
  options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).optional(),
  description: z.string().optional(),
});
export type PropSpec = z.infer<typeof PropSpecSchema>;

/** Documents one key of the model's visualState() (what visual.svg can data-bind to). */
export const BindingSpecSchema = z.object({
  key: z.string().min(1),
  type: z.enum(["number", "string", "boolean"]),
  description: z.string(),
});
export type BindingSpec = z.infer<typeof BindingSpecSchema>;

/** Extra block for MCU boards. */
export const McuSpecSchema = z.object({
  /** Backend id the backendFactory understands, e.g. "avr8js". */
  backend: z.string().min(1),
  /** Chip name, e.g. "atmega328p". */
  chip: z.string().min(1),
  /** Clock in Hz, e.g. 16000000. */
  clockHz: z.number().positive(),
  /** Logic supply voltage, e.g. 5 or 3.3. */
  vcc: z.number().positive(),
  /** arduino-cli board id, e.g. "arduino:avr:uno". */
  fqbn: z.string().optional(),
});
export type McuSpec = z.infer<typeof McuSpecSchema>;

export const PartSpecSchema = z.object({
  /** Part type id; equals the folder name, kebab-case, e.g. "arduino-uno". */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  category: z.enum(PART_CATEGORIES),
  description: z.string(),
  pins: z.array(PinSpecSchema),
  /** Size of the visual.svg viewBox (and the node on the canvas) in px. */
  size: z.object({ w: z.number().positive(), h: z.number().positive() }),
  props: z.array(PropSpecSchema).optional(),
  limits: z
    .object({
      maxCurrentmA: z.number().optional(),
      maxVoltage: z.number().optional(),
      minVoltage: z.number().optional(),
      maxPowerW: z.number().optional(),
    })
    .catchall(z.number())
    .optional(),
  footprint: z.string().optional(),
  buyLinks: z.array(z.object({ vendor: z.string(), url: z.string() })).optional(),
  bindings: z.array(BindingSpecSchema).optional(),
  mcu: McuSpecSchema.optional(),
  tags: z.array(z.string()).optional(),
});
export type PartSpec = z.infer<typeof PartSpecSchema>;

// ---------------------------------------------------------------------------
// fidelity.json
// ---------------------------------------------------------------------------

export const FidelityAreaSchema = z.object({
  level: z.enum(["ok", "approx", "none", "n/a"]),
  note: z.string(),
});
export type FidelityArea = z.infer<typeof FidelityAreaSchema>;

export const FidelitySchema = z.object({
  level: z.enum(["exact", "behavioral", "stub"]),
  areas: z.object({
    logic: FidelityAreaSchema,
    timing: FidelityAreaSchema,
    analog: FidelityAreaSchema,
    power: FidelityAreaSchema,
    radio: FidelityAreaSchema,
  }),
  emulates: z.array(z.string()),
  doesNotEmulate: z.array(z.string()),
  testOnRealDevice: z.array(z.string()),
});
export type Fidelity = z.infer<typeof FidelitySchema>;

// ---------------------------------------------------------------------------
// model.ts
// ---------------------------------------------------------------------------

export type VisualValue = number | string | boolean;
/** Consumed by the SVG binding system (data-bind) and by tests. Keys documented in part.json `bindings`. */
export type VisualState = Record<string, VisualValue>;

export interface PartInteraction {
  kind: "press" | "release" | "set";
  /** Which control, for parts with several (e.g. a keypad key). Optional. */
  key?: string;
  /** For "set": e.g. knob position 0..1, sensor value. */
  value?: VisualValue;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  /** Machine-readable code, e.g. "led-overcurrent", "floating-input". */
  code?: string;
  /** Pin this is about, if any. */
  pin?: string;
}

/** What the simulation hands a part model when it is created. */
export interface PartContext {
  /** Instance id from jumper.json, e.g. "led1". */
  readonly id: string;
  readonly spec: PartSpec;
  /** spec.props defaults merged with the instance's props. setProp() keeps this up to date. */
  readonly props: Readonly<Record<string, PropValue>>;
  /**
   * Circuit node of one of this part's pins: "0" for ground nets,
   * the net id when wired, or a unique "<partId>:<pinId>" node when unconnected.
   */
  node(pinId: string): NodeId;
  /** A private node inside this part, e.g. internalNode("mid") → "led1#mid". */
  internalNode(name: string): NodeId;
  /** The MCU backend. Only set for the board part named in project.firmware.board. */
  readonly mcu?: McuBackend;
  /** Ask for a re-stamp + re-solve (e.g. after the model's own state changed). Synchronous. */
  requestSolve(): void;
  /** Current virtual time in ms. */
  now(): number;
}

export interface PartModel {
  /** Add this part's electrical elements between its pin nodes. Called on every (re)solve. */
  stamp(c: CircuitBuilder): void;
  /** Read voltages/currents after each solve. tMs = virtual time. */
  onSolved?(r: SolveResultView, tMs: number): void;
  visualState(): VisualState;
  setProp(id: string, value: PropValue): void;
  interact?(event: PartInteraction): void;
  diagnostics?(): Diagnostic[];
  /** Called on sim reset/stop to drop resources (optional). */
  dispose?(): void;
}

export type PartModelFactory = (ctx: PartContext) => PartModel;

/** One entry of the generated registry. */
export interface PartDefinition {
  spec: PartSpec;
  fidelity: Fidelity;
  /** visual.svg contents, inlined by codegen. */
  svg: string;
  create: PartModelFactory;
}

export interface PartRegistry {
  get(type: string): PartDefinition | undefined;
  list(): PartDefinition[];
}

export function createRegistry(defs: Iterable<PartDefinition>): PartRegistry {
  const map = new Map<string, PartDefinition>();
  for (const d of defs) {
    if (map.has(d.spec.id)) throw new Error(`duplicate part type '${d.spec.id}' in registry`);
    map.set(d.spec.id, d);
  }
  const sorted = [...map.values()].sort((a, b) => (a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0));
  return { get: (t) => map.get(t), list: () => sorted.slice() };
}

/** spec.props defaults overlaid with instance props. */
export function resolveProps(spec: PartSpec, props?: Record<string, PropValue>): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const p of spec.props ?? []) out[p.id] = p.default;
  for (const [k, v] of Object.entries(props ?? {})) out[k] = v;
  return out;
}
