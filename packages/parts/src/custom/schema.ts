// Agent-made parts (decision 0003, C4): a declarative part format an agent can write when the
// catalog has no part for what a person wants. No code runs: a part is data (pins, physical facts,
// a behaviour template with numbers) that compileCustomPart() turns into an ordinary
// PartDefinition. Stored in the project as parts/<id>/part.json (+ optional visual.svg).
// JSON Schema: packages/parts/custom-part.schema.json (written by `pnpm gen`).
import { z } from "zod";
import { MechanicalSchema, PART_CATEGORIES, PinTypeSchema, PropSpecSchema, SourcingSchema } from "@jumper/sim-core";

export const CUSTOM_PART_FORMAT = "jumper-part/1";

/** Display controllers an agent-made display can reuse. gc9a01 needs the built-in GC9A01 part (parts track). */
export const DISPLAY_CONTROLLERS = ["ssd1306", "st7735", "ili9341", "gc9a01"] as const;
export type DisplayController = (typeof DISPLAY_CONTROLLERS)[number];

export const BEHAVIOR_KINDS = ["digital-input", "analog-sensor", "actuator", "i2c-device", "uart-device", "display"] as const;
export type BehaviorKind = (typeof BEHAVIOR_KINDS)[number];

const pinId = z
  .string()
  .regex(/^[A-Za-z0-9+-][A-Za-z0-9_+\-.]*$/, "pin ids use letters, digits, '_', '+', '-' or '.' (e.g. \"VCC\", \"OUT\", \"+\", \"GND.1\")")
  .max(24);
/** A state field / prop name: what tests read (expect_part sensor.moisture) and set_sensor_value sets. */
const fieldId = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]*$/, 'field names start with a lowercase letter and use letters, digits or "_" (e.g. "moisture", "flow_ml_min")')
  .max(32);
const level = z.enum(["high", "low"]);

export const CustomPinSchema = z.object({
  id: pinId,
  /** Silkscreen label; defaults to the id. */
  label: z.string().max(24).optional(),
  type: PinTypeSchema,
  /** Position inside visual.svg (required when you give an SVG; generated otherwise). */
  x: z.number().optional(),
  y: z.number().optional(),
  voltage: z.object({ min: z.number(), max: z.number() }).optional(),
  /** e.g. ["i2c-sda"], ["i2c-scl"], ["uart-tx"], ["uart-rx"], ["adc"], ["pwm"]. */
  protocols: z.array(z.string().max(16)).max(4).optional(),
  description: z.string().max(400).optional(),
});
export type CustomPin = z.infer<typeof CustomPinSchema>;

/** Where the part gets power. Default: its first "power" pin and first "ground" pin. */
const PowerSchema = z
  .object({
    vcc: pinId.optional(),
    gnd: pinId.optional(),
    /** Below this the part is off (default: the vcc pin's voltage.min, else 2.7 V). */
    min_v: z.number().positive().optional(),
    /** Above this check_design / the model reports over-voltage (default: the vcc pin's voltage.max, else 5.5 V). */
    max_v: z.number().positive().optional(),
  })
  .strict();

const NumberField = z
  .object({
    id: fieldId,
    label: z.string().max(40).optional(),
    unit: z.string().max(12).optional(),
    min: z.number(),
    max: z.number(),
    default: z.number(),
  })
  .strict();

export const DigitalInputBehavior = z
  .object({
    kind: z.literal("digital-input"),
    /** The pin that goes to a board GPIO. */
    output: pinId,
    /** State / prop name for "the thing is detected", e.g. "motion", "obstacle", "tilted". Default "active". */
    field: fieldId.default("active"),
    /** Output level while active. Default high (a PIR's OUT goes HIGH on motion; IR obstacle modules go LOW). */
    active_level: level.default("high"),
    /** push-pull drives both levels; open-drain only pulls low (use INPUT_PULLUP). Default push-pull. */
    drive: z.enum(["push-pull", "open-drain"]).default("push-pull"),
    default_active: z.boolean().default(false),
  })
  .strict()
  .describe('A module whose output pin goes HIGH/LOW when it detects something (PIR, IR obstacle, tilt, reed, hall switch). {kind, output: pin id, field: state name (default "active"), active_level: "high"|"low", drive: "push-pull"|"open-drain"}. set_sensor_value <part>.<field> true/false (or press / release) triggers it.');

export const AnalogSensorBehavior = z
  .object({
    kind: z.literal("analog-sensor"),
    /** Analog output pin, to a board ADC pin (A0…). */
    output: pinId,
    /** The physical quantity: id (e.g. "moisture"), unit, range and default. set_sensor_value sets it. */
    quantity: NumberField,
    /**
     * Output voltage as a function of the quantity, piecewise linear between points sorted by value
     * (at least 2). Volts are at a 5 V supply when `ratiometric` (default), so they scale with VCC.
     * A capacitive soil sensor: [{value: 0, volts: 3.0}, {value: 100, volts: 1.2}] (wetter = lower).
     */
    curve: z.array(z.object({ value: z.number(), volts: z.number().min(0).max(24) }).strict()).min(2).max(32),
    ratiometric: z.boolean().default(true),
    /** Output impedance in Ω (default 1000). */
    output_ohms: z.number().positive().max(1e7).default(1000),
    /** Optional comparator output (the DO pin of many sensor modules). */
    digital: z
      .object({
        output: pinId,
        /** Quantity value where it switches. */
        threshold: z.number(),
        /** Active when the quantity is above (default) or below the threshold. */
        when: z.enum(["above", "below"]).default("above"),
        active_level: level.default("low"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe('A sensor with an analog output (soil moisture, gas, flex, force, sound level). {kind, output: pin id, quantity: {id, unit, min, max, default}, curve: [{value, volts}...] (volts at 5 V supply when ratiometric, the default), output_ohms, digital?: {output, threshold, when: "above"|"below", active_level}}. set_sensor_value <part>.<quantity.id> <number>.');

export const ActuatorBehavior = z
  .object({
    kind: z.literal("actuator"),
    /**
     * load:  two terminals, the part is a load between them (pump, motor, solenoid, heater, lamp):
     *        `plus`, `minus`, `rated_v`, `rated_ma`. Its level follows the voltage across it
     *        (PWM averages), so analogWrite through a transistor or driver sets the speed.
     * logic: a module with VCC/GND and a control input (relay board, MOSFET module, LED driver):
     *        `input`, `active_level`; optional relay `contacts`.
     */
    drive: z.enum(["load", "logic"]),
    plus: pinId.optional(),
    minus: pinId.optional(),
    rated_v: z.number().positive().max(48).optional(),
    rated_ma: z.number().positive().max(10000).optional(),
    /** A load that only works one way round (default false: a DC motor just spins backwards). */
    polarized: z.boolean().default(false),
    input: pinId.optional(),
    active_level: level.default("high"),
    /** Load the control input puts on the GPIO, in Ω (default 10 kΩ; an optocoupler input is ~1 kΩ). */
    input_ohms: z.number().positive().max(1e7).default(10000),
    /** Relay contacts switched by the input: COM to NO when on, COM to NC when off. */
    contacts: z.object({ com: pinId, no: pinId.optional(), nc: pinId.optional() }).strict().optional(),
    /** A testable output proportional to the drive level, e.g. {id: "flow_ml_min", unit: "ml/min", at_full: 1200}. */
    effect: z.object({ id: fieldId, unit: z.string().max(12).optional(), at_full: z.number() }).strict().optional(),
    /** Force / thrust at full drive in newtons, reported as state `force_n`. Not applied to the robot world's physics. */
    force_n: z.number().nonnegative().max(1000).optional(),
  })
  .strict()
  .describe('Something the board drives. drive "load": a pump / motor / solenoid / heater between plus and minus pins with rated_v and rated_ma (drive it through a transistor, MOSFET module, relay or driver). drive "logic": a module with VCC/GND and a control input (relay board, MOSFET module) with active_level, optional relay contacts {com, no, nc}. Optional effect {id, unit, at_full} and force_n for tests.');

export const I2cRegisterSchema = z
  .object({
    /** Register address 0x00..0xFF. */
    reg: z.number().int().min(0).max(255),
    /** State key for the register's current raw value (shows writes from firmware), e.g. "config". */
    name: fieldId.optional(),
    /** Width in bytes (1..4); it occupies reg..reg+bytes-1. Default 1. */
    bytes: z.number().int().min(1).max(4).default(1),
    endian: z.enum(["big", "little"]).default("big"),
    /** Power-on raw value. */
    value: z.number().int().optional(),
    /** Firmware may write it (default false: writes are ACKed and ignored, as many sensors do). */
    writable: z.boolean().default(false),
    /**
     * The register reports a physical quantity: raw = round(value × scale + offset), clamped to the
     * register width (two's complement when signed). E.g. temperature in °C with 0.01 °C per LSB:
     * {id: "temperature", unit: "°C", min: -40, max: 85, default: 22.5, scale: 100, signed: true}.
     */
    field: NumberField.extend({ scale: z.number().default(1), offset: z.number().default(0), signed: z.boolean().default(false) }).strict().optional(),
  })
  .strict();
export type I2cRegister = z.infer<typeof I2cRegisterSchema>;

export const I2cDeviceBehavior = z
  .object({
    kind: z.literal("i2c-device"),
    /** 7-bit address, or every address the part can have (the first is the default; an "address" prop picks one). */
    address: z.union([z.number().int().min(0x03).max(0x77), z.array(z.number().int().min(0x03).max(0x77)).min(1).max(8)]),
    registers: z.array(I2cRegisterSchema).max(128),
    /** The chip id register (read by begin() in most libraries). */
    who_am_i: z.object({ reg: z.number().int().min(0).max(255), value: z.number().int().min(0).max(255) }).strict().optional(),
    /** The register pointer advances after each byte (default true, as almost every sensor does). */
    auto_increment: z.boolean().default(true),
    /** On-board pull-ups on SDA/SCL in Ω (most breakouts have 4.7 kΩ or 10 kΩ). */
    pullup_ohms: z.number().positive().max(1e6).optional(),
    /** Unmapped registers read as this byte (default 0x00). */
    default_byte: z.number().int().min(0).max(255).default(0),
  })
  .strict()
  .describe('An I2C chip read with Wire: {kind, address (7-bit, or a list), registers: [{reg, bytes, endian, value | field: {id, unit, min, max, default, scale, offset, signed}, name, writable}], who_am_i: {reg, value}, auto_increment, pullup_ohms}. Needs pins with protocols ["i2c-sda"] and ["i2c-scl"] and a power pin.');

export const UartDeviceBehavior = z
  .object({
    kind: z.literal("uart-device"),
    /** Pin that receives from the board (the part's RX), and pin that sends to it (TX). */
    rx: pinId,
    tx: pinId,
    baud: z.number().int().min(300).max(115200).default(9600),
    /** Line ending added to each reply. Incoming lines end at CR or LF. */
    newline: z.enum(["\r\n", "\n", "\r"]).default("\r\n"),
    /**
     * Scripted answers, first match wins: {match: "AT", reply: "OK"}. mode exact (default), prefix
     * or contains. A reply may use {field} placeholders from `fields` and "\n" for more lines.
     */
    responses: z
      .array(
        z
          .object({
            match: z.string().min(1).max(200),
            mode: z.enum(["exact", "prefix", "contains"]).default("exact"),
            reply: z.string().max(2000),
            /** Time before the reply starts (default 1 ms: a module's own MCU needs a moment, and an instant reply can collide with SoftwareSerial still sending). */
            delay_ms: z.number().nonnegative().max(60000).default(1),
          })
          .strict(),
      )
      .max(64),
    /** Sent for a line nothing matched (omit to stay silent). */
    unknown_reply: z.string().max(2000).optional(),
    /** Sent once after power-up. */
    greeting: z.string().max(2000).optional(),
    /** Sent every `every_ms` while powered (a GPS module's NMEA sentences, a scale's readings). */
    stream: z.object({ every_ms: z.number().min(10).max(600000), text: z.string().min(1).max(2000) }).strict().optional(),
    /** Echo received bytes back (some modules echo AT commands). */
    echo: z.boolean().default(false),
    /** Numbers a reply can include as {id}: settable with set_sensor_value. */
    fields: z.array(NumberField.extend({ decimals: z.number().int().min(0).max(8).default(2) }).strict()).max(16).optional(),
  })
  .strict()
  .describe('A serial module on SoftwareSerial pins (8N1): {kind, rx, tx, baud, newline, responses: [{match, mode: "exact"|"prefix"|"contains", reply, delay_ms}], unknown_reply, greeting, stream: {every_ms, text}, echo, fields: [{id, min, max, default, decimals}] used as {id} in replies}.');

export const DisplayBehavior = z
  .object({
    kind: z.literal("display"),
    /** Reuse an existing controller model (same commands, same libraries). */
    controller: z.enum(DISPLAY_CONTROLLERS),
    /** Native panel size in pixels (portrait, as the datasheet gives it) for st7735 / ili9341 panels, e.g. ST7789 240x240 → {w: 240, h: 240}. */
    resolution: z.object({ w: z.number().int().min(8).max(480), h: z.number().int().min(8).max(480) }).strict().optional(),
    /**
     * Controller RAM size (native, portrait) when it is bigger than the glass, with `offset` = where
     * the glass starts inside it (viewer orientation). ST7789 240x240 with Adafruit_ST7789:
     * resolution {w: 240, h: 240}, ram {w: 240, h: 320}, offset {x: 0, y: 80}.
     */
    ram: z.object({ w: z.number().int().min(8).max(480), h: z.number().int().min(8).max(480) }).strict().optional(),
    offset: z.object({ x: z.number().int().min(0).max(480), y: z.number().int().min(0).max(480) }).strict().optional(),
    /** Round glass (drawn with a round bezel). */
    round: z.boolean().default(false),
    /** IPS glass (ST7789 and most round panels): its library turns inversion on to get normal colours. Default false. */
    ips: z.boolean().default(false),
  })
  .strict()
  .describe('A screen that reuses a built-in controller model (same commands, same Arduino libraries): {kind, controller: "ssd1306"|"st7735"|"ili9341"|"gc9a01", resolution?: {w, h} (st7735 / ili9341 only), round, ips (true for ST7789 / IPS panels)}. Leave "pins" out to get the controller module\'s pins.');

export const BehaviorSchema = z.discriminatedUnion("kind", [DigitalInputBehavior, AnalogSensorBehavior, ActuatorBehavior, I2cDeviceBehavior, UartDeviceBehavior, DisplayBehavior]);
export type Behavior = z.infer<typeof BehaviorSchema>;

export const CustomPartSchema = z
  .object({
    format: z.literal(CUSTOM_PART_FORMAT).default(CUSTOM_PART_FORMAT),
    /** Type id, kebab-case, must not be a built-in type, e.g. "capacitive-soil-sensor". */
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'ids are kebab-case: lowercase letters, digits and "-", starting with a letter (e.g. "soil-moisture-sensor")').max(48),
    name: z.string().min(1).max(80),
    category: z.enum(PART_CATEGORIES).refine((c) => c !== "board", "agent-made parts cannot be boards (a board needs a simulated MCU)"),
    /** What it is and how to wire it, in one or two sentences (search_parts shows the first). */
    description: z.string().min(1).max(1000),
    /** Pins. A display may leave them out to get the controller module's pins. */
    pins: z.array(CustomPinSchema).max(40).default([]),
    /** visual.svg viewBox size (required when you give an SVG; generated otherwise). */
    size: z.object({ w: z.number().positive().max(2000), h: z.number().positive().max(2000) }).strict().optional(),
    /** Extra props besides the ones the behaviour adds. */
    props: z.array(PropSpecSchema).max(16).optional(),
    power: PowerSchema.optional(),
    behavior: BehaviorSchema.describe("How the part behaves: one template, chosen by kind."),
    /** Shown by get_part. */
    usage: z
      .object({
        wiring: z.string().min(1).max(1000),
        example: z.string().max(8000).optional(),
        libraries: z.array(z.string().max(80)).max(10).optional(),
      })
      .strict()
      .optional(),
    // Physical data (decision 0003, C2), as for built-in parts. plan_device and the BOM use them.
    dimensions_mm: z.object({ w: z.number().positive(), h: z.number().positive(), d: z.number().positive() }).strict().optional(),
    mass_g: z.number().nonnegative().optional(),
    current_ma: z.object({ typ: z.number().nonnegative(), max: z.number().nonnegative() }).strict().optional(),
    price_usd: z.number().nonnegative().optional(),
    buy_links: z.array(z.object({ vendor: z.string().min(1).max(60), url: z.string().regex(/^https:\/\/[^\s"'<>]+$/, "buy links must be https URLs") }).strict()).max(6).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    /** Datasheet the numbers came from (https), shown by get_part and in exports. */
    datasheet: z.string().regex(/^https:\/\/[^\s"'<>]+$/).optional(),
    mechanical: MechanicalSchema.optional().describe("Round 6: screen window, buttons, connectors, mounting holes and keep-outs for the case (docs/part-spec.md, Mechanical)."), // round 6 case
    sourcing: SourcingSchema.optional().describe("Round 6: MPN / generic description for a factory BOM; LCSC numbers only when checked."), // round 6 case
  })
  .strict();

export type CustomPart = z.infer<typeof CustomPartSchema>;
export type CustomPartInput = z.input<typeof CustomPartSchema>;

/** JSON Schema (draft 2020-12) of part.json, input side (what an agent writes). */
export function customPartJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(CustomPartSchema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  return { $id: "urn:jumper:custom-part:1", title: "Jumper agent-made part (parts/<id>/part.json)", ...schema };
}
