import type { ColorFrame } from "./color.ts";
import type { SimServices } from "./network.ts";
import { z } from "zod";
import type { PropValue } from "@jumper/project-format";
import type { CircuitBuilder, NodeId, SolveResultView } from "./circuit.ts";
import type { I2cDevice, SpiDevice } from "./bus.ts";
import type { I2sDevice } from "./i2s.ts";
import { CAMERA_PIN_ROLES, CAMERA_SENSOR_IDS, type CameraDevice } from "./camera.ts";
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
  /** "text" (round 7 voice): free text over several lines (a DFPlayer's clip words), stored as a string. */
  type: z.enum(["number", "boolean", "color", "enum", "text"]),
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
 * Simulator backends a board part may declare in `mcu.backend` (decision 0003, C1; decision 0006).
 *   avr8js    ATmega328P (Uno, Nano) through avr8js                         in-process (browser + Node)
 *   rp2040js  RP2040 (Pico, XIAO RP2040, RP2040-Zero) through rp2040js      in-process (browser + Node)
 *   qemu-esp  ESP32 / ESP32-S3 / ESP32-C3 on Espressif's QEMU + Jumper bridge   local process (Docker)
 *   renode    Cortex-M boards (STM32, nRF52) on Renode                      local process (Docker)
 */
export const BOARD_BACKENDS = ["avr8js", "rp2040js", "qemu-esp", "renode"] as const;
export type BoardBackendId = (typeof BOARD_BACKENDS)[number];
/** Backends that run as a local emulator process the Jumper server owns (never in the browser). */
export const PROCESS_BACKENDS: readonly string[] = ["qemu-esp", "renode"];
export const isProcessBackend = (backend: string | undefined): boolean => !!backend && PROCESS_BACKENDS.includes(backend);

/** A pin a board needs at a level when it resets (ESP32 GPIO0 / 2 / 12 / 15…), checked by check_design. */
export const StrappingPinSchema = z.object({
  /** Board pin id. */
  pin: z.string().min(1),
  /** Level the chip needs at reset for a normal boot (internal pull), or "any" when it only changes an option. */
  boot: z.enum(["high", "low", "floating-or-high", "floating-or-low", "any"]),
  /** What goes wrong when something on this pin pulls it the other way at reset. */
  note: z.string().min(1),
});
export type StrappingPin = z.infer<typeof StrappingPinSchema>;

export const AvailabilitySchema = z.object({
  status: z.enum(["available", "planned"]),
  /** Planned: what is missing and why. Available: what proves it (the fixture test). */
  reason: z.string().min(1),
});
export type Availability = z.infer<typeof AvailabilitySchema>;


/** Extra block for MCU boards. Round 10 (decision 0006): everything the runtime needs is data. */
export const McuSpecSchema = z.object({
  /** Backend id the backendFactory understands. Shipped boards use one of BOARD_BACKENDS (tests may use fakes). */
  backend: z.string().min(1),
  /** Chip name, e.g. "atmega328p", "esp32s3". */
  chip: z.string().min(1),
  /** Clock in Hz, e.g. 16000000 (the time base McuBackend.cycles counts in). */
  clockHz: z.number().positive(),
  /** Logic supply voltage, e.g. 5 or 3.3. */
  vcc: z.number().positive(),
  /** arduino-cli board id, e.g. "arduino:avr:uno". What the factory pack flashes onto the real board. */
  fqbn: z.string().optional(),
  /** Renode platform file (.repl), or the QEMU machine when it differs from the chip. */
  platform: z.string().optional(),
  /** Flash the board carries (the emulator's flash image is padded to it). */
  flash: z.object({ sizeMB: z.number().positive(), mode: z.string().optional() }).optional(),
  /** The UART the serial monitor shows, e.g. "uart0". */
  console: z.string().optional(),
  /** Board pin id → backend pin id, when they differ (e.g. "D13" → "P0.13"). Identity when absent. */
  pinMap: z.record(z.string(), z.string()).optional(),
  /** Pins with a pull-up resistor on the board itself (not the chip's internal ones). */
  pullUps: z.array(z.string()).optional(),
  /** Default bus pins (board pin ids) of Wire / SPI / Serial1. */
  busPins: z
    .object({
      i2c: z.object({ sda: z.string(), scl: z.string() }).optional(),
      spi: z.object({ sck: z.string(), mosi: z.string(), miso: z.string(), ss: z.string().optional() }).optional(),
      uart: z.object({ tx: z.string(), rx: z.string() }).optional(),
    })
    .optional(),
  /** Round 13: PSRAM on the board (camera frame buffers, big audio buffers). The simulator gives the emulator the same. */
  psram: z.object({ sizeMB: z.number().positive(), mode: z.enum(["quad", "octal"]).optional() }).optional(),
  /** Boot-strapping pins (check_design warns when a part pulls one the wrong way at reset). */
  strapping: z.array(StrappingPinSchema).optional(),
  /** Pins that can only be inputs (ESP32 GPIO34-39). */
  inputOnly: z.array(z.string()).optional(),
  /** Pins wired to the board's flash / PSRAM: never use them. */
  reserved: z.array(z.object({ pin: z.string(), why: z.string() })).optional(),
  /** ADC2 pins (ESP32 family): analogRead fails on them while Wi-Fi is on. */
  adc2: z.array(z.string()).optional(),
  /** How firmware is built for it. */
  toolchain: z
    .object({
      /** Docker image the runner builds with (informational; the runner picks it from the FQBN prefix). */
      image: z.string().optional(),
      /** FQBN of the build the simulator runs, when it differs from `fqbn` (e.g. Serial on UART0 instead of USB CDC). */
      simFqbn: z.string().optional(),
      /** Extra arduino-cli --build-property values for the simulator build. */
      simBuildProperties: z.array(z.string()).optional(),
      /** What the simulator build changes compared with the real board's build, in plain words. */
      simNote: z.string().optional(),
      /** How to flash the real board (factory pack), {bin} / {port} are filled in. */
      flash: z.string().optional(),
    })
    .optional(),
  /**
   * The fixture test that proves the board boots real firmware and its listed buses work
   * (e.g. "packages/sim-backends/src/qemu-esp/boards.integration.test.ts#seeed-xiao-esp32s3").
   * A process-backend board without it is listed as planned, not placed.
   */
  verified: z.string().optional(),
});
export type McuSpec = z.infer<typeof McuSpecSchema>;

// ---------------------------------------------------------------------------
// Mechanical data (round 6, decision 0004, contract R1). Everything a case needs to know about a
// part: where its screen window, button cap, connector opening, LEDs and sensor apertures are, its
// mounting holes and the room it needs above / below. All lengths in mm.
//
// Part frame: looking down at the part's top (component / front) face, oriented exactly like its
// visual.svg. Origin = the top-left corner of the dimensions_mm footprint, +x to the right (along
// w), +y DOWN (along h, like SVG), +z up out of the top face; z = 0 is the bottom of the body.
// dimensions_mm.d is the full height including components. A pin at visual.svg (px, py) sits at
// (px / size.w * w, py / size.h * h).
// ---------------------------------------------------------------------------

/** Which side of the part a feature faces out of, as an axis of the part frame (+z = top face). */
export const MECH_FACES = ["+z", "-z", "+x", "-x", "+y", "-y"] as const;
export type MechFace = (typeof MECH_FACES)[number];

export const MECH_FEATURE_KINDS = [
  "screen", // active (lit) area of a display; the case cuts a window over it
  "button", // a cap / actuator the person presses (tactile switch, touch pad)
  "switch", // slide / toggle switch lever
  "knob", // potentiometer / encoder shaft
  "connector", // USB / JST / header the person (or a cable) must reach
  "led", // an LED that should be seen (light pipe or hole)
  "sensor-window", // light sensor, IR, PIR dome, ultrasonic transducers: needs an opening / window
  "grille", // buzzer / speaker / microphone: needs sound holes
  "vent", // needs airflow (regulators, chargers)
  "antenna", // keep metal / thick walls away
  "camera", // a lens: the case opens a hole wide enough for its field of view (fov_deg)
] as const;
export type MechFeatureKind = (typeof MECH_FEATURE_KINDS)[number];

export const MechFeatureSchema = z.object({
  /** Unique within the part, e.g. "active-area", "cap", "usb", "dome". */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(MECH_FEATURE_KINDS),
  face: z.enum(MECH_FACES),
  /** Centre of the feature in the part frame (mm). On a ±z face: the point on that face. On a side face: x and y of the point on that edge (one of them is the edge itself: 0 or w / h). */
  x: z.number(),
  y: z.number(),
  /** Height of the centre above the body bottom (mm). Required for side faces; for ±z faces it defaults to d (+z) or 0 (-z). */
  z: z.number().optional(),
  shape: z.enum(["rect", "round"]).optional(),
  /** Size on the face (mm). rect: w along the face's horizontal axis (x for ±z / ±y faces, y for ±x faces), h along the other one (y for ±z, z for side faces). round: d. */
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  d: z.number().positive().optional(),
  /** How far the feature stands out of the face (button plunger, USB receptacle lip, PIR dome), mm. */
  protrude_mm: z.number().nonnegative().optional(),
  /** screen: the visible frame around the active area the window may overlap (mm, each side). */
  bezel_mm: z.number().nonnegative().optional(),
  /** button / switch: actuation travel (mm). */
  travel_mm: z.number().nonnegative().optional(),
  /** connector: extra opening around the receptacle for the plug's overmold (mm, each side). USB-C plugs need about 1.5. */
  plug_clearance_mm: z.number().nonnegative().optional(),
  /** camera: the lens' diagonal field of view (degrees); the hole widens with the wall so the wall stays out of the picture. */
  fov_deg: z.number().positive().max(180).optional(),
  /** connector: "usb-c", "micro-usb", "jst-ph-2", "jst-sh-4", "header-2.54", … */
  connector: z.string().optional(),
  /** The case must expose it (window / hole / cap / opening). Default: true for screen, button, switch, knob, connector, led, sensor-window, grille; false for vent, antenna. */
  expose: z.boolean().optional(),
  description: z.string().optional(),
});
export type MechFeature = z.infer<typeof MechFeatureSchema>;

export const MechanicalSchema = z.object({
  /** Footprint outline: "rect" (the w × h box, default) or "round" (a disc of diameter w centred in the box, e.g. the GC9A01 module). */
  outline: z.enum(["rect", "round"]).optional(),
  // round 6 case: footprints that are neither the box nor a centred disc (the GC9A01's round PCB with a header tab).
  /** The footprint as a union of rects (x, y = top-left, w, h) and discs (x, y = centre, d) in the part frame. Overrides `outline` for packing and fit checks. */
  outline_parts: z.array(z.union([z.object({ shape: z.literal("rect"), x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }), z.object({ shape: z.literal("round"), x: z.number(), y: z.number(), d: z.number().positive() })])).optional(),
  /** PCB thickness when the part is a board / module (mm), e.g. 1.0 for a XIAO, 1.6 for most modules. */
  pcb_mm: z.number().positive().optional(),
  /** Extra room above the top face (wires, solder joints), mm. Default 0. */
  keepout_top_mm: z.number().nonnegative().optional(),
  /** Extra room below the bottom face (header pins, through-hole leads, solder), mm. Default 0. */
  keepout_bottom_mm: z.number().nonnegative().optional(),
  /** Soft body that must not be pressed or pierced (LiPo pouch): the case gives it a cradle with ~10 % swell room, never a boss or a screw. */
  soft: z.boolean().optional(),
  /** Mounting holes in the part frame (mm): centre and hole diameter (e.g. 2.2 for M2). */
  mounting_holes: z.array(z.object({ x: z.number(), y: z.number(), d: z.number().positive() })).optional(),
  features: z.array(MechFeatureSchema).optional(),
  /** Where the numbers come from ("datasheet", "measured", "typical module"), printed in the drawing notes. */
  source: z.string().optional(),
});
export type Mechanical = z.infer<typeof MechanicalSchema>;

/** Sourcing for a factory BOM (round 6, R1). Only numbers checked against the distributor; unknown = left out, never guessed. */
export const SourcingSchema = z.object({
  /** Manufacturer part number of the module or its key chip, e.g. "1N5817". */
  mpn: z.string().optional(),
  manufacturer: z.string().optional(),
  /** LCSC part number, e.g. "C8598". */
  lcsc: z.string().regex(/^C\d+$/).optional(),
  /** JLCPCB assembly library class of that LCSC part. */
  jlc: z.enum(["basic", "extended"]).optional(),
  /** Package or form factor, e.g. "DO-41", "SOT-23-3", "module 21 x 17.5 mm". */
  package: z.string().optional(),
  /** Plain words a supplier can quote from when there is no MPN, e.g. "1.28 in round IPS TFT 240x240, GC9A01, SPI, module". */
  generic: z.string().optional(),
});
export type Sourcing = z.infer<typeof SourcingSchema>;

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
  current_ma: z
    .object({
      typ: z.number().nonnegative(),
      max: z.number().nonnegative(),
      /** Round 15: what it draws while idle (the board asleep, a screen holding its image, a sensor between samples), µA. */
      standby_ua: z.number().nonnegative().optional(),
      /** Round 15: parts that draw `typ` only while they do one thing (an e-paper refresh, a reading): how long that takes, ms. */
      event_ms: z.number().positive().optional(),
      /** Round 15: what that one thing is, in words ("full refresh"). */
      event: z.string().optional(),
    })
    .optional(),
  /** Typical single-unit price in US dollars from a generic distributor. */
  price_usd: z.number().nonnegative().optional(),
  /** Where to buy it: generic distributors or the maker's own shop. Search URLs are fine. */
  buy_links: z.array(z.object({ vendor: z.string().min(1), url: z.string().regex(/^https:\/\//) })).optional(),
  bindings: z.array(BindingSpecSchema).optional(),
  mcu: McuSpecSchema.optional(),
  /**
   * Round 10: whether the part can be placed. A board whose emulator support is not proven by a
   * fixture test (real firmware boots and its listed buses work) is "planned": the parts library
   * lists it with the reason, and placing it is refused with that reason. Omitted = available.
   */
  availability: AvailabilitySchema.optional(),
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
  /**
   * Round 13: the part is (or carries) a camera. `pins` maps each camera signal (esp32-camera's
   * camera_config_t names) to a pin: on a module, its own pin ids (wired to the board's GPIOs); on a
   * board with a built-in camera, the board's MCU pin ids it is hard-wired to.
   */
  camera: z
    .object({
      sensor: z.enum(CAMERA_SENSOR_IDS as [string, ...string[]]),
      /** Other sensors the same product ships with (batches differ), e.g. ["OV3660"]. */
      alternatives: z.array(z.enum(CAMERA_SENSOR_IDS as [string, ...string[]])).optional(),
      pins: z.partialRecord(z.enum(CAMERA_PIN_ROLES), z.string()),
      /** Current while capturing (mA), on top of the board's own. */
      activeMa: z.number().nonnegative().optional(),
      note: z.string().optional(),
    })
    .optional(),
  /** Round 6 (decision 0004, R1): what a case needs. Optional; the case track requires it for every part an example uses. The LAST key of part.json. */
  mechanical: MechanicalSchema.optional(),
  /** Round 6 (R1): factory BOM numbers. Optional; written after mechanical. */
  sourcing: SourcingSchema.optional(),
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

/**
 * Round 7 (voice): one thing a part said out loud (a DFPlayer playing a clip whose words are
 * known). Behavioral: the words come from the part's clip table, the timing is estimated.
 */
export interface Utterance {
  /** Virtual ms when playback started. */
  t_ms: number;
  /** Estimated playback length in virtual ms. */
  dur_ms: number;
  /** Track number the firmware asked for (a folder play keeps the track inside the folder). */
  track: number;
  /** Key looked up in the clip table: "12" for a track, "2/5" for folder 2 track 5. */
  clip: string;
  /** The words; when the clip has none: "(track 7: no words set)". */
  text: string;
  /** True when the clip had no words in the table. */
  missing?: boolean;
  /** True when a load is wired to the audio outputs (a speaker on SPK_1/SPK_2 or the DAC pins), so a person would hear it. */
  audible: boolean;
  /** Volume 0..30 when it started. */
  volume: number;
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
  // round 6 power
  /** The project's power situation (jumper.json `power`): `usb` = a USB cable is plugged into the board. Absent = USB plugged (round-5 behaviour). Live: the Simulation updates it. */
  readonly power?: { readonly usb: boolean };
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
  // round 6 power
  /** Boards: whether the MCU has power after the last solve. The Simulation holds the firmware board's MCU in reset while this is false. Absent = always powered. */
  powered?(): boolean;
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
   * I2S audio behaviour (an amplifier that plays, a microphone that records). Attached to the
   * board's I2S bus when the part's "i2s-bclk" and "i2s-ws" pins are wired to board GPIOs.
   */
  i2s?: I2sDevice;
  /**
   * Round 13: a camera. The Simulation attaches it to the board's camera port (McuBackend.attachCamera)
   * at the pins part.json `camera.pins` names: wired module pins, or a board's own GPIOs.
   */
  camera?: CameraDevice;
  /**
   * Colour display parts: the frame the glass shows (RGB565, viewer orientation). Too big for
   * visualState(), so renderers and screenshots read it here (Simulation.framebuffer(partId)).
   */
  framebuffer?(): ColorFrame;
  /** Round 7 (voice): everything this part said since the simulation started, oldest first. */
  speech?(): readonly Utterance[];
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

/**
 * How a part's props change its look before anything runs (no circuit solved, no firmware): the keys
 * of its model's visualState() that differ from the same model with default props. A blue LED gives
 * its blue lens (round 10 eval: the canvas and screenshots drew every idle LED red); a board gives
 * nothing, so it does not look powered before a run. Undefined when nothing differs or the model
 * cannot be created without a simulation.
 */
export function restVisualState(def: PartDefinition, id: string, props?: Record<string, PropValue>): VisualState | undefined {
  if (!props || !Object.keys(props).length) return undefined;
  const look = (p: Record<string, PropValue> | undefined): VisualState | undefined => {
    try {
      const model = def.create({
        id,
        spec: def.spec,
        props: resolveProps(def.spec, p),
        node: (pin) => `${id}:${pin}`,
        internalNode: (name) => `${id}#${name}`,
        requestSolve: () => {},
        now: () => 0,
      } as PartContext);
      const state = model.visualState();
      model.dispose?.();
      return state;
    } catch {
      return undefined;
    }
  };
  const mine = look(props);
  const base = look(undefined);
  if (!mine || !base) return undefined;
  const out: VisualState = {};
  for (const [k, v] of Object.entries(mine)) if (JSON.stringify(v) !== JSON.stringify(base[k])) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** spec.props defaults overlaid with instance props. */
export function resolveProps(spec: PartSpec, props?: Record<string, PropValue>): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const p of spec.props ?? []) out[p.id] = p.default;
  for (const [k, v] of Object.entries(props ?? {})) out[k] = v;
  return out;
}
