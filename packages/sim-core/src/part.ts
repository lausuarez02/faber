import type { ColorFrame } from "./color.ts";
import type { SimServices } from "./network.ts";
import { z } from "zod";
import type { PropValue } from "@jumper/project-format";
import type { CircuitBuilder, NodeId, SolveResultView } from "./circuit.ts";
import type { I2cDevice, SpiDevice } from "./bus.ts";
import type { McuBackend } from "./mcu.ts";
import type { PwmReading } from "./pwm.ts";

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

/**
 * Simulator backends a board part may declare in `mcu.backend` (decision 0003, C1).
 *   avr8js    ATmega328P (Uno, Nano) through avr8js
 *   rp2040js  RP2040 (Pico, XIAO RP2040, RP2040-Zero) through rp2040js (round 5, track rp2040)
 * ESP32 ("qemu-esp32") is planned, not implemented.
 */
export const BOARD_BACKENDS = ["avr8js", "rp2040js"] as const;
export type BoardBackendId = (typeof BOARD_BACKENDS)[number];

/** Extra block for MCU boards. */
export const McuSpecSchema = z.object({
  /** Backend id the backendFactory understands. Shipped boards use one of BOARD_BACKENDS (tests may use fakes). */
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
  // --- Physical data (round 5, decision 0003, C2). Optional in the schema so a part can land before
  // its numbers; packages/parts' spec test requires them for every shipped part. Typical figures for
  // the common module, from its datasheet or a vendor listing; plan_device sums them.
  /** Outer size of the module in mm: w × h on the board plane, d = height off the board / thickness. */
  dimensions_mm: z.object({ w: z.number().positive(), h: z.number().positive(), d: z.number().positive() }).optional(),
  /** Mass in grams (the module as sold, without wires). */
  mass_g: z.number().nonnegative().optional(),
  /** Supply current drawn by the part itself in mA: typ = usual operation, max = worst case (stall, all LEDs white, radio TX). Passive parts: 0/0. */
  current_ma: z.object({ typ: z.number().nonnegative(), max: z.number().nonnegative() }).optional(),
  /** Typical single-unit price in US dollars from a generic distributor. */
  price_usd: z.number().nonnegative().optional(),
  /** Where to buy it: generic distributors or the maker's own shop. Search URLs are fine. */
  buy_links: z.array(z.object({ vendor: z.string().min(1), url: z.string().regex(/^https:\/\//) })).optional(),
  bindings: z.array(BindingSpecSchema).optional(),
  mcu: McuSpecSchema.optional(),
  bus: z
    .object({
      /** The part is an I2C target. Its SDA/SCL pins carry protocols "i2c-sda" / "i2c-scl". */
      i2c: z
        .object({
          /** Every 7-bit address the part can have (e.g. [60, 61] for 0x3C/0x3D). The first is the default. */
          addresses: z.array(z.number().int().min(0).max(127)).min(1),
          /** Prop that selects the address, if any (its value is the address, e.g. "0x3C" or 60). */
          addressProp: z.string().optional(),
          /** On-board pull-up resistors on SDA/SCL (Ω), when the module has them. */
          pullUpOhms: z.number().positive().optional(),
          /** Max SCL clock the part supports (Hz), e.g. 400000. */
          maxHz: z.number().positive().optional(),
        })
        .optional(),
      /** The part is an SPI peripheral. Pins carry "spi-mosi", "spi-miso", "spi-sck", "spi-cs". */
      spi: z
        .object({
          /** SPI modes the part accepts (0..3). */
          modes: z.array(z.number().int().min(0).max(3)).optional(),
          maxHz: z.number().positive().optional(),
        })
        .optional(),
    })
    .optional(),
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
  /**
   * Round 5 (decision 0003, C4): who made the part. "agent-made" parts come from a project's parts/
   * folder (create_part); fidelity reports and exports print "agent-made: behavioral, unverified".
   * Omitted = "builtin".
   */
  origin: z.enum(["builtin", "agent-made"]).optional(),
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
  /**
   * PWM / pulse measurement of the net one of this part's pins is on: set when an MCU pin drives
   * that net directly, or when a driver part declared it with setPwm (an H-bridge output). Measured
   * from cycle stamps, so a servo reads its pulse width to the cycle. Optional: the Simulation
   * provides it, simple test benches may not.
   */
  pwm?(pinId: string): PwmReading | undefined;
  /**
   * Declare that this part switches the net of `pinId` with a duty cycle (e.g. an L298N output
   * while its ENA pin gets analogWrite). Parts on that net (a DC motor) read it with pwm(). Pass
   * undefined to clear.
   */
  setPwm?(pinId: string, reading: { duty: number; freqHz?: number } | undefined): void;
  /**
   * Run `cb` after `delayMs` of virtual time (cycle-exact on the MCU clock; the MCU is stopped at
   * that cycle so firmware polling the pin sees the change on time, as pulseIn() needs). Returns a
   * cancel function. Events are dropped on reset.
   */
  schedule?(delayMs: number, cb: () => void): () => void;
  /**
   * Digital level of the net one of this part's pins is on, right now: the live output level when
   * a firmware-board GPIO drives that net (directly or through resistors, e.g. a level-shifting
   * divider), otherwise the last solve's voltage against `threshold` volts (default half the
   * MCU's VCC). Unlike onSolved voltages it is exact inside fast toggling (SPI D/C, CS, UART),
   * where the Simulation solves on duty-averaged values. Optional: simple test benches may not provide it.
   */
  digital?(pinId: string, threshold?: number): 0 | 1;
  /**
   * Edges of the GPIO driving one of this part's pins (same rule as digital()): called inside the
   * MCU step at the exact cycle, with the new level and the virtual time in ms. For bit-banged
   * protocols (SoftwareSerial UART). Returns an unsubscribe function; dropped on reset.
   */
  watch?(pinId: string, cb: (level: 0 | 1, tMs: number) => void): () => void;
  /** Host services (e.g. `network`, the sandbox Wi-Fi network) passed to the Simulation. */
  readonly services?: SimServices;
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
  /**
   * Time-stepped behaviour (motor inertia, servo slew). The Simulation calls it every TICK_MS of
   * virtual time, at fixed cycle numbers, so the result does not depend on how runFor is sliced.
   * Call ctx.requestSolve() from here only when the electrical picture changed.
   */
  tick?(tMs: number, dtMs: number): void;
  /**
   * I2C target behaviour. The Simulation attaches it to the board's I2C bus when the part's
   * "i2c-sda" / "i2c-scl" pins are wired to the board's SDA / SCL.
   */
  i2c?: I2cDevice;
  /** SPI peripheral behaviour, attached when its MOSI/MISO/SCK pins are wired to the board's. */
  spi?: SpiDevice;
  /**
   * Colour display parts: the frame the glass shows (RGB565, viewer orientation). Too big for
   * visualState(), so renderers and screenshots read it here (Simulation.framebuffer(partId)).
   */
  framebuffer?(): ColorFrame;
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
