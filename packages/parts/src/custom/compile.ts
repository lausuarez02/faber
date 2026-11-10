// compileCustomPart: an agent-made part.json (+ optional SVG) → an ordinary PartDefinition that
// place_part / connect / run / tests / the web canvas use like a built-in. Validation errors say
// what is wrong, why it matters and how to fix it. No fs here: Node and the browser share it.
import type { BindingSpec, ColorFrame, Fidelity, PartDefinition, PartModelFactory, PartRegistry, PartSpec, PinSpec, PropSpec } from "@jumper/sim-core";
import { PartSpecSchema } from "@jumper/sim-core";
import { createTftModule, ILI9341_PANEL } from "../parts/ili9341-tft/model.ts";
import { ST7735_PANEL } from "../parts/st7735-tft/model.ts";
import { registry as builtinRegistry } from "../registry.gen.ts";
import { BEHAVIOR_MODELS, supplyOf } from "./models.ts";
import { sanitizeSvg, setSvgSize, SvgError } from "./sanitize.ts";
import { CustomPartSchema, type CustomPart, type DisplayController } from "./schema.ts";
import { generateVisual, layoutPins, type Screen } from "./visual.ts";

/** What fidelity reports, BOM and wiring print for every agent-made part. */
export const AGENT_MADE_LABEL = "agent-made: behavioral, unverified";

export class CustomPartError extends Error {
  constructor(
    /** What failed. */
    readonly what: string,
    readonly why: string,
    readonly fix: string,
    /** Every problem found, for listing. */
    readonly problems: string[] = [],
  ) {
    super(`${what}. Why: ${why}. Fix: ${fix}`);
  }
}

export interface CompiledCustomPart {
  def: PartDefinition;
  /** The parsed part (defaults filled in). */
  part: CustomPart;
  /** The SVG actually used (sanitized, or generated). */
  svg: string;
  generatedSvg: boolean;
  warnings: string[];
}

export interface CompileOptions {
  /** Built-in parts (to reuse display controllers). Default: the shipped registry. */
  builtins?: PartRegistry;
}

/** Usage notes of agent-made parts, for get_part (hints.ts usageFor). */
const USAGE = new WeakMap<PartSpec, NonNullable<CustomPart["usage"]> & { datasheet?: string }>();
const ORIGIN = new WeakMap<PartSpec, CustomPart>();

/** The agent's usage block for an agent-made part's spec, or undefined for built-ins. */
export function customUsageOf(spec: PartSpec): (NonNullable<CustomPart["usage"]> & { datasheet?: string }) | undefined {
  return USAGE.get(spec);
}
/** The CustomPart a compiled spec came from, or undefined for built-ins. */
export function customPartOf(spec: PartSpec): CustomPart | undefined {
  return ORIGIN.get(spec);
}
export function isAgentMade(def: Pick<PartDefinition, "fidelity"> | undefined): boolean {
  return def?.fidelity.origin === "agent-made";
}

/** Format zod issues as "path: message" lines. */
function zodProblems(issues: { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
}

/** State keys each behaviour publishes (documented as bindings, usable in expect_part). */
function bindingsFor(p: CustomPart): BindingSpec[] {
  const b = p.behavior;
  const n = (key: string, description: string): BindingSpec => ({ key, type: "number", description });
  const bool = (key: string, description: string): BindingSpec => ({ key, type: "boolean", description });
  const s = (key: string, description: string): BindingSpec => ({ key, type: "string", description });
  const label = s("label", "Short readout drawn on the part.");
  switch (b.kind) {
    case "digital-input":
      return [bool(b.field, "True while the part detects its thing (set it with set_sensor_value or press/release)."), n("level", `Logic level of ${b.output} (0/1).`), bool("powered", "Supply inside its range."), label, n("ledOpacity", "Status light.")];
    case "analog-sensor":
      return [
        n(b.quantity.id, `${b.quantity.label ?? b.quantity.id}${b.quantity.unit ? ` in ${b.quantity.unit}` : ""} (set it with set_sensor_value).`),
        n("volts", `Voltage on ${b.output}.`),
        bool("powered", "Supply inside its range."),
        ...(b.digital ? [bool("triggered", `Comparator output ${b.digital.output} active.`)] : []),
        label,
      ];
    case "actuator":
      return [
        bool("on", "Running / energised."),
        n("level", "Drive level 0..1 (PWM duty or voltage / rated voltage)."),
        ...(b.drive === "load" ? [n("volts", "Voltage across the load."), n("current_ma", "Current through the load in mA."), n("direction", "1 forward, -1 reversed, 0 stopped.")] : [bool("powered", "Supply inside its range.")]),
        ...(b.effect ? [n(b.effect.id, `${b.effect.id}${b.effect.unit ? ` in ${b.effect.unit}` : ""}, level × ${b.effect.at_full}.`)] : []),
        ...(b.force_n !== undefined ? [n("force_n", "Force in N, level × force_n (not applied to the robot world).")] : []),
        label,
        n("ledOpacity", "Status light."),
      ];
    case "i2c-device":
      return [
        s("address", "Current I2C address, e.g. 0x40."),
        bool("powered", "Supply inside its range (it NACKs when off)."),
        n("reads", "Bytes the firmware has read."),
        n("writes", "Bytes written to writable registers."),
        ...b.registers.filter((r) => r.field).map((r) => n(r.field!.id, `${r.field!.label ?? r.field!.id}${r.field!.unit ? ` in ${r.field!.unit}` : ""} (register 0x${r.reg.toString(16)}).`)),
        ...b.registers.filter((r) => r.name).map((r) => n(r.name!, `Raw value of register 0x${r.reg.toString(16)} (shows what firmware wrote).`)),
        label,
      ];
    case "uart-device":
      return [
        bool("powered", "Supply inside its range."),
        n("baud", "UART rate."),
        n("lines_received", "Lines received from the board."),
        n("replies_sent", "Replies sent."),
        n("unmatched", "Lines no response matched."),
        s("last_line", "Last line received."),
        s("last_reply", "Last reply sent."),
        n("framing_errors", "Bytes with a bad stop bit (wrong baud rate)."),
        ...(b.fields ?? []).map((f) => n(f.id, `${f.label ?? f.id}${f.unit ? ` in ${f.unit}` : ""} (used in replies as {${f.id}}).`)),
        label,
      ];
    case "display":
      return [];
  }
}

const RESERVED_KEYS = new Set(["label", "level", "powered", "volts", "on", "address", "reads", "writes", "baud", "ledOpacity", "screenOpacity", "triggered", "current_ma", "direction", "force_n", "lines_received", "replies_sent", "unmatched", "last_line", "last_reply", "framing_errors"]);

/** Props the behaviour adds (what set_sensor_value and place_part props set). */
function behaviorProps(p: CustomPart): PropSpec[] {
  const b = p.behavior;
  const numProp = (f: { id: string; label?: string | undefined; unit?: string | undefined; min: number; max: number; default: number }): PropSpec => ({
    id: f.id,
    label: f.label ?? f.id,
    type: "number",
    default: f.default,
    min: f.min,
    max: f.max,
    ...(f.unit ? { unit: f.unit } : {}),
  });
  switch (b.kind) {
    case "digital-input":
      return [{ id: b.field, label: b.field, type: "boolean", default: b.default_active, description: "Detected / active." }];
    case "analog-sensor":
      return [numProp(b.quantity)];
    case "i2c-device": {
      const addrs = Array.isArray(b.address) ? b.address : [b.address];
      const hex = (a: number) => `0x${a.toString(16).toUpperCase().padStart(2, "0")}`;
      return [
        ...(addrs.length > 1 ? [{ id: "address", label: "I2C address", type: "enum" as const, default: hex(addrs[0]!), options: addrs.map(hex) }] : []),
        ...b.registers.filter((r) => r.field).map((r) => numProp(r.field!)),
      ];
    }
    case "uart-device":
      return (b.fields ?? []).map(numProp);
    default:
      return [];
  }
}

const DISPLAY_PART: Record<Exclude<DisplayController, "gc9a01">, string> = { ssd1306: "ssd1306-oled-i2c", st7735: "st7735-tft", ili9341: "ili9341-tft" };

function displayBase(controller: DisplayController, builtins: PartRegistry): PartDefinition | undefined {
  if (controller === "gc9a01") return builtins.list().find((d) => d.spec.id.startsWith("gc9a01"));
  return builtins.get(DISPLAY_PART[controller]);
}

function screenOfSvg(svg: string): string | undefined {
  return /data-screen="(\d+x\d+)"/.exec(svg)?.[1];
}

/**
 * Validate and compile. Throws CustomPartError (with every problem listed) when the part cannot
 * work; returns warnings for things it fixed or that look odd.
 */
export function compileCustomPart(input: unknown, svgInput?: string | null, opts: CompileOptions = {}): CompiledCustomPart {
  const builtins = opts.builtins ?? builtinRegistry;
  const parsed = CustomPartSchema.safeParse(input);
  if (!parsed.success) {
    const problems = zodProblems(parsed.error.issues);
    throw new CustomPartError(
      `The part definition is invalid (${problems.length} problem${problems.length > 1 ? "s" : ""}): ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? "; …" : ""}`,
      "create_part only accepts the jumper-part/1 format, so the simulator knows exactly how the part behaves",
      "fix those fields (JSON Schema: packages/parts/custom-part.schema.json; docs/custom-parts.md has a worked example per behaviour) and call again",
      problems,
    );
  }
  const part = parsed.data;
  const b = part.behavior;
  const problems: string[] = [];
  const warnings: string[] = [];

  // ---- display: take the controller module's pins / props / bus
  let base: PartDefinition | undefined;
  let screen: Screen | undefined;
  let pinsIn = part.pins;
  if (b.kind === "display") {
    base = displayBase(b.controller, builtins);
    if (!base) {
      throw new CustomPartError(
        `Display controller '${b.controller}' is not available yet`,
        "an agent-made display reuses a built-in controller model, and this build has no built-in GC9A01 part",
        "use ssd1306, st7735 or ili9341 (ST7789 panels: st7735 with a resolution); gc9a01 needs the built-in gc9a01-round-tft part in the parts catalog",
      );
    }
    const basePins = base.spec.pins;
    if (!pinsIn.length) pinsIn = basePins.map((p) => ({ id: p.id, label: p.label, type: p.type, ...(p.voltage ? { voltage: p.voltage } : {}), ...(p.protocols ? { protocols: p.protocols } : {}), ...(p.description ? { description: p.description } : {}) }));
    else {
      const missing = basePins.filter((bp) => !pinsIn.some((p) => p.id === bp.id)).map((p) => p.id);
      if (missing.length) problems.push(`behavior.controller ${b.controller} needs pins with ids ${basePins.map((p) => p.id).join(", ")} (missing ${missing.join(", ")}); leave "pins" out to get them, or keep the ids and change only labels`);
      pinsIn = pinsIn.map((p) => {
        const bp = basePins.find((x) => x.id === p.id);
        return bp ? { ...p, type: bp.type, ...(bp.protocols ? { protocols: bp.protocols } : {}) } : p;
      });
    }
    if (b.ips && b.controller === "ssd1306") problems.push("behavior.ips only applies to colour TFT controllers (st7735, ili9341, gc9a01)");
    if (b.ram && !b.resolution) problems.push("behavior.ram needs behavior.resolution (the glass size inside the RAM)");
    if (b.ram && b.resolution) {
      const ox = b.offset?.x ?? 0;
      const oy = b.offset?.y ?? 0;
      const landscape = b.controller === "ili9341";
      const [rw, rh] = landscape ? [b.ram.h, b.ram.w] : [b.ram.w, b.ram.h];
      const [gw, gh] = landscape ? [b.resolution.h, b.resolution.w] : [b.resolution.w, b.resolution.h];
      if (ox + gw > rw || oy + gh > rh) problems.push(`behavior.offset: a ${gw}x${gh} glass at (${ox}, ${oy}) does not fit in the ${rw}x${rh} RAM frame`);
    }
    if (b.resolution && b.controller !== "st7735" && b.controller !== "ili9341") problems.push(`behavior.resolution only works with st7735 / ili9341 panels; the ${b.controller} model has a fixed size`);
    let kind = screenOfSvg(base.svg) ?? "128x64";
    if (b.resolution && (b.controller === "st7735" || b.controller === "ili9341")) {
      const landscape = (b.controller === "ili9341" ? ILI9341_PANEL : ST7735_PANEL).viewer === "landscape";
      kind = landscape ? `${b.resolution.h}x${b.resolution.w}` : `${b.resolution.w}x${b.resolution.h}`;
    }
    const [sw, sh] = kind.split("x").map(Number) as [number, number];
    screen = { kind, w: sw, h: sh, round: b.round || b.controller === "gc9a01" };
  }

  // ---- pins
  const pinIds = new Set<string>();
  for (const p of pinsIn) {
    if (pinIds.has(p.id)) problems.push(`pins: '${p.id}' appears twice; pin ids must be unique`);
    pinIds.add(p.id);
  }
  if (!pinsIn.length) problems.push("pins: the part has no pins, so nothing can be wired to it; list at least its signal and supply pins");
  const needPin = (where: string, id: string | undefined, what: string) => {
    if (id !== undefined && !pinIds.has(id)) problems.push(`${where}: '${id}' is not one of the pins (${[...pinIds].join(", ")}); ${what}`);
  };
  const supply = supplyOf({ ...part, pins: pinsIn });
  needPin("power.vcc", part.power?.vcc, "name the supply pin");
  needPin("power.gnd", part.power?.gnd, "name the ground pin");
  if (supply.minV >= supply.maxV) problems.push(`power: min_v ${supply.minV} V is not below max_v ${supply.maxV} V`);
  const fieldIds = new Set<string>();
  const field = (where: string, id: string) => {
    if (fieldIds.has(id)) problems.push(`${where}: field '${id}' is used twice; every field needs its own name`);
    if (RESERVED_KEYS.has(id)) problems.push(`${where}: '${id}' is a state key the template already uses; pick another name (e.g. '${id}_value')`);
    fieldIds.add(id);
  };
  const range = (where: string, f: { min: number; max: number; default: number }) => {
    if (f.min >= f.max) problems.push(`${where}: min ${f.min} must be below max ${f.max}`);
    else if (f.default < f.min || f.default > f.max) problems.push(`${where}: default ${f.default} is outside ${f.min}..${f.max}`);
  };
  switch (b.kind) {
    case "digital-input":
      needPin("behavior.output", b.output, "it is the pin the board reads");
      field("behavior.field", b.field);
      break;
    case "analog-sensor": {
      needPin("behavior.output", b.output, "it is the pin wired to an analog input");
      field("behavior.quantity.id", b.quantity.id);
      range("behavior.quantity", b.quantity);
      if (b.digital) needPin("behavior.digital.output", b.digital.output, "it is the comparator pin");
      const xs = b.curve.map((c) => c.value);
      if (new Set(xs).size !== xs.length) problems.push("behavior.curve: two points have the same value; each value needs one voltage");
      if (Math.max(...xs) < b.quantity.max || Math.min(...xs) > b.quantity.min) warnings.push(`behavior.curve covers ${Math.min(...xs)}..${Math.max(...xs)} but the quantity goes ${b.quantity.min}..${b.quantity.max}; values outside the curve read its end voltage`);
      if (b.ratiometric && !supply.vcc) warnings.push("behavior.ratiometric is true but the part has no power pin, so the curve is used as given (5 V)");
      break;
    }
    case "actuator":
      if (b.drive === "load") {
        if (!b.plus || !b.minus) problems.push('behavior: drive "load" needs "plus" and "minus" (the two terminals of the load)');
        needPin("behavior.plus", b.plus, "it is the + terminal");
        needPin("behavior.minus", b.minus, "it is the - terminal");
        if (!b.rated_v) problems.push('behavior.rated_v: a "load" needs its rated voltage (e.g. 5 for a 5 V pump), from the datasheet or listing');
        if (!b.rated_ma && !part.current_ma?.typ) problems.push('behavior.rated_ma: a "load" needs its current at the rated voltage (or current_ma.typ), so the circuit knows how much it draws');
      } else {
        if (!b.input) problems.push('behavior: drive "logic" needs "input" (the control pin, e.g. "IN")');
        needPin("behavior.input", b.input, "it is the control pin");
        if (b.active_level === "low" && !supply.vcc) problems.push('behavior.active_level "low" needs a power pin (the input pulls current from VCC through the module)');
        if (b.contacts) {
          needPin("behavior.contacts.com", b.contacts.com, "it is the relay common");
          needPin("behavior.contacts.no", b.contacts.no, "it is the normally-open contact");
          needPin("behavior.contacts.nc", b.contacts.nc, "it is the normally-closed contact");
          if (!b.contacts.no && !b.contacts.nc) problems.push("behavior.contacts: give no, nc or both");
        }
      }
      if (b.effect) field("behavior.effect.id", b.effect.id);
      break;
    case "i2c-device": {
      const sda = pinsIn.filter((p) => p.protocols?.includes("i2c-sda"));
      const scl = pinsIn.filter((p) => p.protocols?.includes("i2c-scl"));
      if (sda.length !== 1 || scl.length !== 1) problems.push(`pins: an I2C device needs exactly one pin with protocols ["i2c-sda"] and one with ["i2c-scl"] (found ${sda.length} and ${scl.length}); that is how the simulator attaches it to the board's bus`);
      if (!supply.vcc) problems.push('pins: an I2C device needs a power pin (type "power"), so it only answers while powered');
      const used = new Map<number, number>();
      b.registers.forEach((r, i) => {
        for (let k = 0; k < r.bytes; k++) {
          const a = r.reg + k;
          if (a > 255) problems.push(`behavior.registers[${i}]: 0x${r.reg.toString(16)} with ${r.bytes} bytes runs past register 0xFF`);
          else if (used.has(a)) problems.push(`behavior.registers[${i}] overlaps registers[${used.get(a)}] at 0x${a.toString(16)}; give each byte one owner`);
          else used.set(a, i);
        }
        if (r.field) {
          field(`behavior.registers[${i}].field.id`, r.field.id);
          range(`behavior.registers[${i}].field`, r.field);
        }
        if (r.name) field(`behavior.registers[${i}].name`, r.name);
      });
      if (b.who_am_i && used.has(b.who_am_i.reg)) problems.push(`behavior.who_am_i: register 0x${b.who_am_i.reg.toString(16)} is also in registers; list it in one place`);
      break;
    }
    case "uart-device":
      needPin("behavior.rx", b.rx, "it is the pin the board transmits to");
      needPin("behavior.tx", b.tx, "it is the pin that sends to the board");
      if (b.rx === b.tx) problems.push("behavior: rx and tx must be different pins");
      for (const [i, f] of (b.fields ?? []).entries()) {
        field(`behavior.fields[${i}].id`, f.id);
        range(`behavior.fields[${i}]`, f);
      }
      for (const text of [b.greeting, b.unknown_reply, b.stream?.text, ...b.responses.map((r) => r.reply)]) {
        for (const m of (text ?? "").matchAll(/\{([a-z][a-zA-Z0-9_]*)\}/g)) if (!b.fields?.some((f) => f.id === m[1])) warnings.push(`'{${m[1]}}' in a reply is not one of behavior.fields, so it is sent as written`);
      }
      break;
    case "display":
      break;
  }

  // ---- props
  const props: PropSpec[] = [...(base?.spec.props ?? []), ...behaviorProps(part)];
  for (const p of part.props ?? []) {
    if (props.some((x) => x.id === p.id)) problems.push(`props: '${p.id}' is already defined by the behaviour; remove it or rename it`);
    else props.push(p);
  }

  // ---- visual
  let svg: string;
  let generatedSvg = false;
  let size: { w: number; h: number };
  let pins: PinSpec[];
  const baseLabel = (p: (typeof pinsIn)[number]) => p.label ?? p.id;
  if (svgInput) {
    if (!part.size) problems.push("size: an SVG needs the part's size {w, h} in px (its viewBox), so pins and wires line up");
    const missing = pinsIn.filter((p) => p.x === undefined || p.y === undefined).map((p) => p.id);
    if (missing.length) problems.push(`pins: ${missing.join(", ")} need x and y (their position inside your SVG); or leave out svg to get a generated drawing`);
    size = part.size ?? { w: 100, h: 100 };
    for (const p of pinsIn) {
      if (p.x !== undefined && p.y !== undefined && (p.x < 0 || p.y < 0 || p.x > size.w || p.y > size.h)) problems.push(`pins: '${p.id}' at (${p.x}, ${p.y}) is outside the ${size.w}×${size.h} drawing`);
    }
    pins = pinsIn.map((p) => ({ ...p, label: baseLabel(p), x: p.x ?? 0, y: p.y ?? 0 }));
    try {
      const s = sanitizeSvg(svgInput, part.id);
      svg = setSvgSize(s.svg, size.w, size.h);
      for (const r of s.removed) warnings.push(`svg: ${r}`);
    } catch (e) {
      if (!(e instanceof SvgError)) throw e;
      problems.push(`svg: it is not well-formed SVG (${e.message}); fix it, or leave svg out for a generated drawing`);
      svg = "";
    }
    if (screen && svg) {
      const got = screenOfSvg(svg);
      if (got !== screen.kind) problems.push(`svg: a ${b.kind === "display" ? b.controller : ""} display needs a <rect data-screen="${screen.kind}" x=… y=… width=… height=…> where the pixels go (found ${got ? `data-screen="${got}"` : "none"})`);
    }
  } else {
    if (part.size) warnings.push("size is ignored without an SVG: the generated drawing sizes itself to the pins");
    if (pinsIn.some((p) => p.x !== undefined)) warnings.push("pin x/y are ignored without an SVG: the generated drawing puts the pins in one header row");
    const layout = layoutPins(
      pinsIn.map((p) => ({ id: p.id, label: baseLabel(p), type: p.type, ...(p.voltage ? { voltage: p.voltage } : {}), ...(p.protocols ? { protocols: p.protocols } : {}), ...(p.description ? { description: p.description } : {}) })),
      screen,
    );
    size = layout.size;
    pins = layout.pins;
    svg = generateVisual(part, layout, screen);
    generatedSvg = true;
  }

  if (problems.length) {
    throw new CustomPartError(
      `Part '${part.id}' cannot be built (${problems.length} problem${problems.length > 1 ? "s" : ""}): ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? "; …" : ""}`,
      "the simulator needs every pin the behaviour names, sane ranges, and a drawing whose pins line up",
      "fix those fields and call again",
      problems,
    );
  }

  // ---- spec
  const i2cAddrs = b.kind === "i2c-device" ? (Array.isArray(b.address) ? b.address : [b.address]) : undefined;
  const specIn: PartSpec = {
    id: part.id,
    name: part.name,
    category: part.category,
    description: part.description,
    pins,
    size,
    ...(props.length ? { props } : {}),
    ...(i2cAddrs
      ? { bus: { i2c: { addresses: i2cAddrs, ...(i2cAddrs.length > 1 ? { addressProp: "address" } : {}), ...((b as { pullup_ohms?: number }).pullup_ohms ? { pullUpOhms: (b as { pullup_ohms?: number }).pullup_ohms! } : {}), maxHz: 400000 } } }
      : base?.spec.bus
        ? { bus: base.spec.bus }
        : {}),
    ...(supply.vcc ? { limits: { maxVoltage: supply.maxV, minVoltage: supply.minV, ...(part.current_ma ? { maxCurrentmA: part.current_ma.max } : {}) } } : {}),
    ...(part.dimensions_mm ? { dimensions_mm: part.dimensions_mm } : {}),
    ...(part.mechanical ? { mechanical: part.mechanical } : {}), // round 6 case
    ...(part.sourcing ? { sourcing: part.sourcing } : {}), // round 6 case
    ...(part.mass_g !== undefined ? { mass_g: part.mass_g } : {}),
    ...(part.current_ma ? { current_ma: part.current_ma } : {}),
    ...(part.price_usd !== undefined ? { price_usd: part.price_usd } : {}),
    ...(part.buy_links ? { buy_links: part.buy_links } : {}),
    bindings: base ? (base.spec.bindings ?? []) : bindingsFor(part),
    tags: [...(part.tags ?? []), "agent-made"],
  };
  const checked = PartSpecSchema.safeParse(specIn);
  if (!checked.success) {
    const ps = zodProblems(checked.error.issues);
    throw new CustomPartError(`Part '${part.id}' does not make a valid part spec: ${ps.join("; ")}`, "the compiled spec must pass the same schema as built-in parts", "fix those fields and call again", ps);
  }
  const spec = specIn;

  // ---- model
  let create: PartModelFactory;
  switch (b.kind) {
    case "digital-input":
      create = BEHAVIOR_MODELS.digitalInput({ ...part, pins: pinsIn }, b);
      break;
    case "analog-sensor":
      create = BEHAVIOR_MODELS.analogSensor({ ...part, pins: pinsIn }, b);
      break;
    case "actuator":
      create = BEHAVIOR_MODELS.actuator({ ...part, pins: pinsIn }, b);
      break;
    case "i2c-device":
      create = BEHAVIOR_MODELS.i2cDevice({ ...part, pins: pinsIn }, b);
      break;
    case "uart-device":
      create = BEHAVIOR_MODELS.uartDevice({ ...part, pins: pinsIn }, b);
      break;
    case "display": {
      const res = b.resolution;
      if (res && (b.controller === "st7735" || b.controller === "ili9341")) {
        const ram = b.ram ?? res;
        const panel = { ...(b.controller === "ili9341" ? ILI9341_PANEL : ST7735_PANEL), nativeW: ram.w, nativeH: ram.h };
        const chip = b.controller.toUpperCase();
        create = (ctx) => createTftModule(ctx, { panel, chip });
        if (b.ram) {
          // The glass shows a window of the controller's RAM: crop the viewer frame to it.
          const [gw, gh] = screen!.kind.split("x").map(Number) as [number, number];
          const ox = b.offset?.x ?? 0;
          const oy = b.offset?.y ?? 0;
          const inner = create;
          create = (ctx) => {
            const m = inner(ctx);
            const fb = m.framebuffer!.bind(m);
            let cache: ColorFrame | undefined;
            m.framebuffer = () => {
              const f = fb();
              if (cache && cache.version === f.version && cache.on === f.on && cache.inverted === f.inverted) return cache;
              const data = new Uint16Array(gw * gh);
              for (let y = 0; y < gh; y++) {
                const row = (y + oy) * f.width + ox;
                if (y + oy < f.height) data.set(f.data.subarray(row, row + Math.min(gw, f.width - ox)), y * gw);
              }
              cache = { width: gw, height: gh, data, version: f.version, on: f.on, inverted: f.inverted };
              return cache;
            };
            return m;
          };
        }
      } else create = base!.create;
      if (b.ips && b.controller !== "ssd1306") {
        // IPS glass is normally black: the library's INVON gives normal colours, so the frame the
        // glass shows is the controller's with the inversion flag flipped.
        const inner = create;
        create = (ctx) => {
          const m = inner(ctx);
          const fb = m.framebuffer?.bind(m);
          if (fb) m.framebuffer = () => {
            const f = fb();
            return { ...f, inverted: !f.inverted };
          };
          return m;
        };
      }
      break;
    }
  }

  const fidelity = fidelityFor(part, base);
  const def: PartDefinition = { spec, fidelity, svg, create };
  USAGE.set(spec, { ...(part.usage ?? { wiring: autoWiring(part, pinsIn) }), ...(part.datasheet ? { datasheet: part.datasheet } : {}) });
  ORIGIN.set(spec, part);
  if (!part.usage) warnings.push("usage is empty: get_part shows a generated wiring line; add usage.wiring (and usage.example) so the next agent wires it right");
  if (!part.current_ma || part.price_usd === undefined || !part.dimensions_mm) warnings.push("physical data missing (current_ma, price_usd, dimensions_mm): plan_device and the BOM cannot count this part; add typical figures from a listing or datasheet");
  return { def, part, svg, generatedSvg, warnings };
}

function autoWiring(part: CustomPart, pins: CustomPart["pins"]): string {
  const b = part.behavior;
  const s = supplyOf({ ...part, pins });
  const bits: string[] = [];
  if (s.vcc) bits.push(`${s.vcc} → ${s.maxV <= 3.6 ? "3V3" : "5V"}`);
  if (s.gnd) bits.push(`${s.gnd} → GND`);
  switch (b.kind) {
    case "digital-input":
      bits.push(`${b.output} → a digital pin (${b.drive === "open-drain" ? "INPUT_PULLUP" : "INPUT"}; reads ${b.active_level.toUpperCase()} when ${b.field})`);
      break;
    case "analog-sensor":
      bits.push(`${b.output} → an analog pin (analogRead)`);
      if (b.digital) bits.push(`${b.digital.output} → a digital pin`);
      break;
    case "actuator":
      bits.push(b.drive === "load" ? `${b.plus}/${b.minus} → a transistor, MOSFET or driver output (it draws ${b.rated_ma ?? part.current_ma?.typ} mA, too much for a GPIO pin)` : `${b.input} → a digital pin (active ${b.active_level.toUpperCase()})`);
      break;
    case "i2c-device":
      bits.push("SDA → A4, SCL → A5 on an Uno (Wire)");
      break;
    case "uart-device":
      bits.push(`${b.tx} → the SoftwareSerial RX pin, ${b.rx} → its TX pin, ${b.baud} baud`);
      break;
    case "display":
      bits.push(`same wiring as the built-in ${b.controller} module`);
      break;
  }
  return bits.join(", ");
}

/** Agent-made fidelity: always behavioral and unverified; each area says what the template does. */
export function fidelityFor(part: CustomPart, base?: PartDefinition): Fidelity {
  const b = part.behavior;
  const unverified = "described by an agent, not checked against a datasheet or the real module";
  const na = { level: "n/a" as const, note: "" };
  const areas: Fidelity["areas"] = {
    logic: { level: "approx", note: `Behaviour template '${b.kind}' with the agent's numbers; ${unverified}.` },
    timing: { level: "approx", note: "Responds instantly unless the template has a delay; real conversion and start-up times are not modelled." },
    analog: b.kind === "analog-sensor" ? { level: "approx", note: "Output follows the agent's piecewise-linear curve; real sensors are nonlinear, noisy and drift." } : na,
    power: part.current_ma || b.kind === "actuator" ? { level: "approx", note: "Supply current is a fixed figure from part.json (a resistor), not measured." } : { level: "none", note: "No current_ma given, so the part draws nothing in the simulation." },
    radio: na,
  };
  const emulates: string[] = [];
  const doesNot: string[] = [`Anything beyond the '${b.kind}' template: this part was made by an agent and never verified`];
  switch (b.kind) {
    case "digital-input":
      emulates.push(`${b.output} ${b.drive} output, ${b.active_level.toUpperCase()} when ${b.field}`);
      doesNot.push("Detection range, sensitivity, retrigger / hold times");
      break;
    case "analog-sensor":
      emulates.push(`${b.output} voltage from ${b.quantity.id} through a ${b.curve.length}-point curve${b.ratiometric ? " (scales with VCC)" : ""}`);
      doesNot.push("Noise, temperature drift, response time, calibration spread between units");
      break;
    case "actuator":
      emulates.push(b.drive === "load" ? `A ${b.rated_v} V / ${b.rated_ma ?? part.current_ma?.typ} mA resistive load; level follows the voltage (PWM averaged)` : `Control input active ${b.active_level}${b.contacts ? ", relay contacts switch in the circuit" : ""}`);
      doesNot.push("Inrush / stall current, inductive kick-back, mechanical delay and wear", "Physics: force_n is reported, not applied to the robot world");
      break;
    case "i2c-device":
      emulates.push(`I2C target at ${(Array.isArray(b.address) ? b.address : [b.address]).map((a) => `0x${a.toString(16)}`).join("/")} with a ${b.registers.length}-register map${b.who_am_i ? " and WHO_AM_I" : ""}`);
      doesNot.push("Measurement timing, data-ready flags, FIFOs, interrupts and any register not listed");
      break;
    case "uart-device":
      emulates.push(`8N1 UART at ${b.baud} baud (bit-level, SoftwareSerial pins) with ${b.responses.length} scripted replies${b.stream ? ` and a stream every ${b.stream.every_ms} ms` : ""}`);
      doesNot.push("Hardware Serial pins D0/D1, flow control, anything not in the script");
      break;
    case "display":
      emulates.push(`The ${b.controller.toUpperCase()} controller model of '${base?.spec.id}'${b.resolution ? ` at ${b.resolution.w}x${b.resolution.h}` : ""}`);
      if (b.resolution && !b.ram) doesNot.push("Panels whose glass is smaller than the controller RAM (ST7789 240x240: give ram and offset) draw shifted without ram / offset");
      if (b.ram) doesNot.push(`The glass is a fixed window of the RAM at (${b.offset?.x ?? 0}, ${b.offset?.y ?? 0}); libraries that move the window with rotation (rotations 2-3 on some panels) show a shifted picture`);
      if (b.round) doesNot.push("Pixels outside the round glass are kept in the frame (only the drawing hides them)");
      if (b.ips) doesNot.push("IPS: colours are the controller's with inversion flipped; the lit / bright counts in the part state still count the controller's view");
      break;
  }
  return {
    level: "behavioral",
    origin: "agent-made",
    areas,
    emulates,
    doesNotEmulate: doesNot,
    testOnRealDevice: [`Everything about ${part.name}: ${AGENT_MADE_LABEL}. Check pinout, supply voltage and behaviour against the real module's datasheet`],
  };
}
