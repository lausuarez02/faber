import { buildNets, type PinRef, type Project } from "@jumper/project-format";
import type { PartRegistry, PartSpec, PinSpec } from "@jumper/sim-core";

/** Design rule checks: static (from the wiring) plus whatever the last simulation reported. */

export interface DesignIssue {
  severity: "error" | "warning" | "info";
  code: string;
  /** What is wrong, why it matters and how to fix it. */
  message: string;
  parts: string[];
  pins?: string[];
}

interface PinInfo {
  ref: PinRef;
  spec: PartSpec;
  pin: PinSpec;
}

const key = (r: PinRef) => `${r.part}.${r.pin}`;

function isBoard(s: PartSpec): boolean {
  return s.category === "board";
}
function isGpio(i: PinInfo): boolean {
  return isBoard(i.spec) && (i.pin.type === "digital" || i.pin.type === "analog") && /^[DA]\d+$/.test(i.pin.id);
}
function isRail(i: PinInfo): boolean {
  return i.pin.type === "power" && (isBoard(i.spec) || i.spec.category === "power");
}
function isResistive(i: PinInfo): boolean {
  return i.spec.id === "resistor" || i.spec.id === "potentiometer" || i.spec.id === "photoresistor";
}
/** A module pin that drives its net (UART TX, MISO, an echo or sensor output), from its protocols, id and description. */
function isOutputPin(i: PinInfo): boolean {
  if (i.pin.protocols?.some((p) => p === "uart-tx" || p === "spi-miso")) return true;
  if (/^(TX|TXD|DOUT|DO|OUT|ECHO|MISO|SDO|INT|IRQ|AO|SIG)$/i.test(i.pin.id)) return true;
  return /\boutput\b|serial out/i.test(i.pin.description ?? "") && !/\binput\b/i.test(i.pin.description ?? "");
}

/** A pin that supplies a rail: a board's regulated outputs, a battery or supply part, a module's regulator output (L298N 5V with its jumper on). */
function isSupplyOutput(i: PinInfo, props: Record<string, unknown> | undefined): boolean {
  if (i.pin.type !== "power") return false;
  if (isBoard(i.spec)) return /^(5V|3V3|3\.3V|3V3_OUT|VBUS)$/i.test(i.pin.id);
  if (i.spec.category === "power") return true;
  if (!/\boutput\b/i.test(i.pin.description ?? "") || !/regulat/i.test(i.pin.description ?? "")) return false;
  const jumper = Object.entries(props ?? {}).find(([k]) => /regulator.*jumper|jumper.*5v/i.test(k));
  const dflt = i.spec.props?.find((p) => /regulator.*jumper|jumper.*5v/i.test(p.id))?.default;
  return (jumper ? jumper[1] : dflt) !== false;
}

function i2cAddress(spec: PartSpec, props: Record<string, unknown> | undefined): number | undefined {
  const bus = spec.bus?.i2c;
  if (!bus) return undefined;
  if (bus.addressProp) {
    const v = props?.[bus.addressProp] ?? spec.props?.find((p) => p.id === bus.addressProp)?.default;
    if (typeof v === "number") return v;
    if (typeof v === "string") return v.startsWith("0x") ? parseInt(v, 16) : Number(v);
  }
  return bus.addresses[0];
}
const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;

export interface CheckOptions {
  /** The sketch is still the starter template (wiring comes first): firmware-dependent rules become reminders. */
  templateSketch?: boolean;
}

export function checkDesign(project: Project, registry: PartRegistry, firmwareSource = "", opts: CheckOptions = {}): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const add = (i: DesignIssue) => issues.push(i);
  const partSpec = new Map<string, PartSpec>();
  for (const p of project.parts) {
    const def = registry.get(p.type);
    if (!def) {
      add({ severity: "error", code: "unknown-part-type", message: `Part '${p.id}' has type '${p.type}', which is not in the catalog, so it is not simulated. Fix: remove it and place a type from search_parts.`, parts: [p.id] });
      continue;
    }
    partSpec.set(p.id, def.spec);
  }

  // Wire ends must be real pins.
  for (const w of project.wires) {
    for (const end of [w.from, w.to]) {
      const s = partSpec.get(end.part);
      if (s && !s.pins.some((pp) => pp.id === end.pin)) {
        add({ severity: "error", code: "bad-pin", message: `Wire ${w.id} ends on '${key(end)}', but ${s.id} has no pin '${end.pin}' (pins: ${s.pins.map((x) => x.id).join(", ")}). Fix: disconnect ${w.id} and connect to a real pin.`, parts: [end.part], pins: [key(end)] });
      }
    }
  }

  const nets = buildNets(project).map((n) => ({
    id: n.id,
    pins: n.pins.flatMap((ref): PinInfo[] => {
      const spec = partSpec.get(ref.part);
      const pin = spec?.pins.find((x) => x.id === ref.pin);
      return spec && pin ? [{ ref, spec, pin }] : [];
    }),
  }));
  const netOf = new Map<string, (typeof nets)[number]>();
  for (const n of nets) for (const p of n.pins) netOf.set(key(p.ref), n);
  const wired = new Set(netOf.keys());
  const boardPart = project.firmware?.board ?? project.parts.find((p) => partSpec.get(p.id) && isBoard(partSpec.get(p.id)!))?.id;
  /** The highest supply rail voltage on the nets of a part's power pins (what its outputs swing to). */
  const supplyOf = (part: string, s: PartSpec): number | undefined => {
    let v: number | undefined;
    for (const pp of s.pins.filter((x) => x.type === "power")) {
      for (const r of netOf.get(`${part}.${pp.id}`)?.pins.filter(isRail) ?? []) {
        const rv = r.pin.voltage?.max;
        if (rv !== undefined) v = Math.max(v ?? 0, rv);
      }
    }
    return v;
  };
  /** The voltage a pin drives HIGH: a board GPIO its rating (or the MCU's vcc), a module output its rating or its supply. */
  const driveVolts = (x: PinInfo): number | undefined => {
    if (isBoard(x.spec)) return x.pin.voltage?.max ?? x.spec.mcu?.vcc;
    return x.pin.voltage?.max ?? supplyOf(x.ref.part, x.spec);
  };

  // Power and ground of modules.
  for (const p of project.parts) {
    const s = partSpec.get(p.id);
    if (!s || isBoard(s)) continue;
    // A module's regulator output (L298N 5V with its jumper on) is optional to wire.
    const pins = s.pins.filter((x) => (x.type === "power" || x.type === "ground") && !(x.type === "power" && !isBoard(s) && s.category !== "power" && isSupplyOutput({ ref: { part: p.id, pin: x.id }, spec: s, pin: x }, p.props)));
    const missing = pins.filter((x) => !wired.has(`${p.id}.${x.id}`));
    if (missing.length && missing.length === pins.length && s.category !== "power") {
      add({ severity: "error", code: "unpowered", message: `${p.id} (${s.name}) has no power: ${missing.map((x) => `${p.id}.${x.id}`).join(", ")} ${missing.length > 1 ? "are" : "is"} not connected, so the module does nothing. Fix: connect ${missing.map((x) => `${p.id}.${x.id} → ${x.type === "ground" ? `${boardPart ?? "board"}.GND` : `${boardPart ?? "board"}.5V`}`).join(" and ")}.`, parts: [p.id], pins: missing.map((x) => `${p.id}.${x.id}`) });
    } else {
      for (const x of missing) {
        add({ severity: "error", code: "unconnected-supply", message: `${p.id}.${x.id} (${x.type === "ground" ? "ground" : "supply"}) is not connected: the module needs both power and ground. Fix: connect ${p.id}.${x.id} → ${boardPart ?? "board"}.${x.type === "ground" ? "GND" : x.voltage && x.voltage.max < 4 ? "3V3" : "5V"}.`, parts: [p.id], pins: [`${p.id}.${x.id}`] });
      }
    }
    if (s.pins.length === 0) {
      // Mechanical parts (a chassis) have no pins: the physics world uses them, not the circuit.
      const inWorld = JSON.stringify(project.world ?? null).includes(`"${p.id}"`) || (!!project.world && s.id.startsWith("robot-chassis") && project.parts.filter((x) => x.type === p.type).length === 1);
      if (!inWorld) {
        add({ severity: "warning", code: "not-in-world", message: `${p.id} (${s.name}) has no pins and is not used by a robot world, so it does nothing. Fix: add a world with set_world (robot.chassis "${p.id}"; get_part ${s.id} shows how) or remove ${p.id}.`, parts: [p.id] });
      }
    } else if (s.pins.every((x) => !wired.has(`${p.id}.${x.id}`))) {
      add({ severity: "warning", code: "not-connected", message: `${p.id} (${s.name}) is placed but has no wires, so it is not part of the circuit. Fix: wire it (get_part ${s.id} shows how) or remove it.`, parts: [p.id] });
    }
  }

  for (const n of nets) {
    const rails = n.pins.filter(isRail);
    const grounds = n.pins.filter((x) => x.pin.type === "ground");
    const gpios = n.pins.filter(isGpio);
    // Shorts.
    if (rails.length && grounds.length) {
      add({ severity: "error", code: "short-circuit", message: `Short circuit: ${rails.map((r) => key(r.ref)).join(", ")} is wired straight to ground (${grounds.map((g) => key(g.ref)).join(", ")}). On real hardware this overheats the regulator or the USB port shuts down. Fix: remove the wire that joins them.`, parts: [...new Set([...rails, ...grounds].map((x) => x.ref.part))], pins: [...rails, ...grounds].map((x) => key(x.ref)) });
    }
    const railVolts = new Set(rails.map((r) => r.pin.voltage?.max ?? 0).filter((v) => v > 0));
    if (railVolts.size > 1) {
      add({ severity: "error", code: "rails-shorted", message: `Two different supply rails are wired together (${rails.map((r) => `${key(r.ref)} ${r.pin.voltage?.max ?? "?"}V`).join(", ")}): they fight each other. Fix: keep each rail on its own net.`, parts: rails.map((r) => r.ref.part), pins: rails.map((r) => key(r.ref)) });
    }
    if (gpios.length && (rails.length || grounds.length)) {
      add({ severity: "warning", code: "gpio-on-rail", message: `${gpios.map((g) => key(g.ref)).join(", ")} is wired directly to ${[...rails, ...grounds].map((x) => key(x.ref)).join(", ")}. If the firmware drives that pin as an OUTPUT to the opposite level, ~100+ mA flows and can kill the pin. Fix: put a resistor (1 kΩ–10 kΩ) in between, or use it only as an INPUT.`, parts: [...new Set([...gpios, ...rails, ...grounds].map((x) => x.ref.part))], pins: [...gpios, ...rails, ...grounds].map((x) => key(x.ref)) });
    }
    if (gpios.length > 1 && new Set(gpios.map((g) => g.ref.part)).size === 1) {
      add({ severity: "warning", code: "pin-conflict", message: `${gpios.map((g) => key(g.ref)).join(" and ")} are wired together: if one is HIGH and the other LOW as outputs, they short. Fix: use one pin per signal.`, parts: [gpios[0]!.ref.part], pins: gpios.map((g) => key(g.ref)) });
    }
    // Over-voltage, by direction (round 5, C5): a supply rail on a module pin rated for less
    // ("overvoltage"), a supply below what a module needs ("part-needs-5v"), and a pin that drives a
    // net above what a receiving pin takes ("logic-level"). A 3.3 V output into a 5 V input is fine.
    if (rails.length) {
      const railV = Math.max(...rails.map((r) => r.pin.voltage?.max ?? 0));
      if (railV > 0) {
        const railNames = rails.map((r) => `${key(r.ref)} (${r.pin.voltage?.max} V)`).join(", ");
        for (const x of n.pins) {
          if (isRail(x) || isBoard(x.spec) || x.pin.type === "ground" || x.pin.type === "passive") continue;
          if (x.pin.type === "power") {
            const max = x.pin.voltage?.max ?? x.spec.limits?.maxVoltage;
            const min = x.pin.voltage?.min ?? x.spec.limits?.minVoltage;
            if (max !== undefined && railV > max + 0.3) {
              add({ severity: "error", code: "overvoltage", message: `${railV} V on a ${max} V supply pin: ${key(x.ref)} is rated up to ${max} V but is fed from ${railNames}. It may be damaged. Fix: power ${x.ref.part} from a ${max <= 3.6 ? "3.3 V" : `${max} V`} supply (e.g. the board's 3V3 pin, or a separate regulator for heavy loads).`, parts: [x.ref.part], pins: [key(x.ref)] });
            } else if (min !== undefined && min > 3.6 && railV <= 3.6) {
              add({ severity: "error", code: "part-needs-5v", message: `${x.ref.part} (${x.spec.name}) needs at least ${min} V on ${x.pin.id}, but it is fed from ${railNames}: it will not work (or work badly) on 3.3 V. Fix: connect ${key(x.ref)} to a 5 V supply (the board's 5V / VBUS pin or a battery through a 5 V regulator) and level-shift its signals back to the board if they are 5 V.`, parts: [x.ref.part], pins: [key(x.ref)] });
            }
          } else {
            const max = x.pin.voltage?.max;
            if (max !== undefined && railV > max + 0.3) {
              add({ severity: "error", code: "logic-level", message: `${key(x.ref)} is rated up to ${max} V but is wired straight to ${railNames}. It may be damaged. Fix: tie it to a ${max <= 3.6 ? "3.3 V" : "lower"} rail, or through a 10 kΩ resistor.`, parts: [x.ref.part], pins: [key(x.ref)] });
            }
          }
        }
      }
    } else {
      const signals = n.pins.filter((x) => (x.pin.type === "digital" || x.pin.type === "analog") && !x.pin.protocols?.some((p) => p.startsWith("i2c-")));
      const outs = signals.filter((x) => !isBoard(x.spec) && isOutputPin(x));
      const ins = signals.filter((x) => !isBoard(x.spec) && !isOutputPin(x));
      // A board pin drives the net when a module input listens on it (or nothing says otherwise); with only module outputs on it, it is reading.
      const boardDrives = ins.length > 0 || outs.length === 0;
      const drivers = [...outs, ...(boardDrives ? signals.filter((x) => isGpio(x) || (isBoard(x.spec) && x.pin.type !== "power")) : [])];
      const reported = new Set<string>();
      for (const d of drivers) {
        const dv = driveVolts(d);
        if (dv === undefined) continue;
        for (const r of signals) {
          if (r === d || r.ref.part === d.ref.part || drivers.includes(r) && !isBoard(r.spec)) continue;
          const max = r.pin.voltage?.max ?? (isBoard(r.spec) ? r.spec.mcu?.vcc : undefined);
          if (max === undefined || dv <= max + 0.3 || reported.has(key(r.ref))) continue;
          reported.add(key(r.ref));
          add({ severity: "error", code: "logic-level", message: `${key(d.ref)} drives ${dv} V into ${key(r.ref)}, which takes at most ${max} V: the ${isBoard(r.spec) ? "board pin" : "module pin"} can be damaged over time. Fix: put a level shifter between them, or a divider (1 kΩ from ${key(d.ref)}, 2 kΩ to GND, the middle to ${key(r.ref)}).`, parts: [...new Set([d.ref.part, r.ref.part])], pins: [key(d.ref), key(r.ref)] });
        }
      }
    }
    // Motors straight on a GPIO.
    for (const x of n.pins) {
      if (x.spec.category === "motor" && gpios.length && !/servo/.test(x.spec.id) && x.pin.type !== "digital") {
        add({ severity: "error", code: "motor-on-gpio", message: `${key(x.ref)} (a motor terminal) is wired straight to ${gpios.map((g) => key(g.ref)).join(", ")}. A GPIO gives at most 40 mA; a motor needs hundreds of mA and its back-EMF kills the pin. Fix: drive it through a motor driver (l298n) and connect the GPIO to the driver's IN/EN pins.`, parts: [x.ref.part], pins: [key(x.ref)] });
      }
    }
  }

  // LEDs need a series resistor somewhere along their path (round 5, C5): on the anode side, the
  // cathode side, or past another LED in series. Only one leg of the LED was checked before, so a
  // resistor on the cathode side was a false positive (persona report, b3).
  const isLed = (sp: PartSpec | undefined) => !!sp && (sp.id === "led" || sp.id === "rgb-led");
  /** The LED's other leg(s) for a pin: anode ↔ cathode; on an RGB LED colour ↔ common. */
  const ledPeers = (sp: PartSpec, pin: string): string[] => {
    const common = sp.pins.find((x) => /^(COM|CA|CC|K|COMMON)$/i.test(x.id));
    if (common) return pin === common.id ? sp.pins.filter((x) => x.id !== common.id).map((x) => x.id) : [common.id];
    return sp.pins.filter((x) => x.id !== pin).map((x) => x.id);
  };
  /** Does the path from this net (away from `from`) meet a resistor before a supply, GPIO or ground? */
  const resistorAhead = (net: (typeof nets)[number] | undefined, seen: Set<string>): boolean => {
    if (!net) return false;
    if (net.pins.some(isResistive)) return true;
    if (net.pins.some((x) => isGpio(x) || isRail(x) || x.pin.type === "ground")) return false;
    for (const x of net.pins) {
      if (!isLed(x.spec) || seen.has(x.ref.part)) continue;
      const next = new Set(seen).add(x.ref.part);
      if (ledPeers(x.spec, x.ref.pin).some((q) => resistorAhead(netOf.get(`${x.ref.part}.${q}`), next))) return true;
    }
    return false;
  };
  for (const p of project.parts) {
    const s = partSpec.get(p.id);
    if (!isLed(s)) continue;
    for (const pin of s!.pins) {
      const n = netOf.get(`${p.id}.${pin.id}`);
      if (!n) continue;
      const driver = n.pins.filter((x) => isGpio(x) || isRail(x));
      if (!driver.length || n.pins.some(isResistive)) continue;
      const seen = new Set([p.id]);
      if (ledPeers(s!, pin.id).some((q) => resistorAhead(netOf.get(`${p.id}.${q}`), seen))) continue;
      add({ severity: "error", code: "led-no-resistor", message: `${p.id}.${pin.id} is wired straight to ${driver.map((d) => key(d.ref)).join(", ")} with no resistor anywhere along the LED's path: about 100 mA would flow (an LED takes 20 mA max) and burn it and the pin. Fix: insert a 220 Ω resistor between ${driver.map((d) => key(d.ref))[0]} and ${p.id}.${pin.id} (place_part resistor, then connect both ends), or on the other leg (either side works).`, parts: [p.id], pins: [`${p.id}.${pin.id}`] });
    }
  }

  // I2C: pins, addresses, pull-ups.
  const i2cParts = project.parts.filter((p) => partSpec.get(p.id)?.bus?.i2c);
  const busNets = new Map<string, { parts: string[]; addrs: Map<number, string[]>; pullups: boolean; resistor: boolean }>();
  for (const p of i2cParts) {
    const s = partSpec.get(p.id)!;
    for (const proto of ["i2c-sda", "i2c-scl"] as const) {
      const pin = s.pins.find((x) => x.protocols?.includes(proto));
      if (!pin) continue;
      const n = netOf.get(`${p.id}.${pin.id}`);
      if (!n) {
        add({ severity: "error", code: "i2c-unwired", message: `${p.id}.${pin.id} (${proto === "i2c-sda" ? "SDA" : "SCL"}) is not connected, so the board cannot talk to ${p.id}. Fix: connect ${p.id}.${pin.id} → ${boardPart ?? "uno"}.${proto === "i2c-sda" ? "A4" : "A5"} (Uno/Nano).`, parts: [p.id], pins: [`${p.id}.${pin.id}`] });
        continue;
      }
      const boardPins = n.pins.filter((x) => isBoard(x.spec));
      for (const b of boardPins) {
        if (!b.pin.protocols?.includes(proto)) {
          const right = b.spec.pins.find((x) => x.protocols?.includes(proto));
          add({ severity: "error", code: "i2c-wrong-pin", message: `${p.id}.${pin.id} (${proto === "i2c-sda" ? "SDA" : "SCL"}) goes to ${key(b.ref)}, which is not the board's hardware ${proto === "i2c-sda" ? "SDA" : "SCL"} pin; Wire/Adafruit libraries only talk on ${right ? key({ part: b.ref.part, pin: right.id }) : "the I2C pins"}. Fix: disconnect it and connect ${p.id}.${pin.id} → ${right ? key({ part: b.ref.part, pin: right.id }) : "the board's I2C pin"}.`, parts: [p.id, b.ref.part], pins: [`${p.id}.${pin.id}`, key(b.ref)] });
        }
      }
      if (proto === "i2c-sda") {
        let bus = busNets.get(n.id);
        if (!bus) busNets.set(n.id, (bus = { parts: [], addrs: new Map(), pullups: false, resistor: false }));
        bus.parts.push(p.id);
        const a = i2cAddress(s, p.props);
        if (a !== undefined) bus.addrs.set(a, [...(bus.addrs.get(a) ?? []), p.id]);
        if (s.bus?.i2c?.pullUpOhms) bus.pullups = true;
        if (n.pins.some(isResistive)) bus.resistor = true;
      }
    }
  }
  for (const bus of busNets.values()) {
    for (const [addr, ids] of bus.addrs) {
      if (ids.length > 1) {
        add({ severity: "error", code: "i2c-address-conflict", message: `${ids.join(" and ")} share I2C address ${hex(addr)} on the same bus: both answer at once and the data is corrupted. Fix: change the address of one of them (set_part_property ${ids[1]} address …, e.g. the module's address jumper) or put it on another bus.`, parts: ids });
      }
    }
    if (!bus.pullups && !bus.resistor) {
      add({ severity: "warning", code: "i2c-no-pullup", message: `The I2C bus of ${bus.parts.join(", ")} has no pull-up resistors (none of these modules declares on-board pull-ups and no resistor goes to a supply). I2C lines idle HIGH only through pull-ups. Fix: add 4.7 kΩ from SDA and from SCL to 5V, or ignore this if your module has them on board.`, parts: bus.parts });
    }
  }

  // Firmware-aware checks (best effort, by reading the sketch text).
  const src = firmwareSource.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (boardPart) {
    const usesSerial = /\bSerial\s*\.\s*begin\s*\(/.test(src);
    for (const pin of ["D0", "D1"]) {
      if (usesSerial && wired.has(`${boardPart}.${pin}`)) {
        add({ severity: "warning", code: "serial-pin-used", message: `${boardPart}.${pin} is wired, but the sketch uses Serial, which owns D0 (RX) and D1 (TX): your device and the serial monitor will interfere. Fix: move that wire to another pin (D2–D13).`, parts: [boardPart], pins: [`${boardPart}.${pin}`] });
      }
    }
    // Buttons to GND with no pull-up anywhere.
    for (const p of project.parts) {
      const s = partSpec.get(p.id);
      if (!s || !/button|switch/.test(s.id)) continue;
      for (const pin of s.pins) {
        const n = netOf.get(`${p.id}.${pin.id}`);
        const g = n?.pins.find((x) => isGpio(x) && x.ref.part === boardPart);
        if (!n || !g || n.pins.some(isResistive)) continue;
        const num = g.pin.id.replace(/^D/, "");
        const re = new RegExp(`pinMode\\s*\\(\\s*(?:${num}|${g.pin.id})\\s*,\\s*INPUT_PULLUP`);
        const named = [...src.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(A?\d+)\b/g), ...src.matchAll(/#define\s+(\w+)\s+(A?\d+)\b/g)].filter((m) => m[2] === num || m[2] === g.pin.id).map((m) => m[1]!);
        const reNamed = named.length ? new RegExp(`pinMode\\s*\\(\\s*(?:${named.join("|")})\\s*,\\s*INPUT_PULLUP`) : undefined;
        if (src && !re.test(src) && !(reNamed && reNamed.test(src))) {
          const pinArg = g.pin.id.startsWith("A") ? g.pin.id : num;
          if (opts.templateSketch) {
            add({ severity: "info", code: "floating-input", message: `Reminder for the sketch you have not written yet: ${key(g.ref)} reads ${p.id} with no resistor, so use pinMode(${pinArg}, INPUT_PULLUP) (pressed reads LOW). This is checked again once firmware/main.ino is yours.`, parts: [p.id, boardPart], pins: [key(g.ref)] });
            continue;
          }
          add({ severity: "warning", code: "floating-input", message: `${key(g.ref)} reads ${p.id} with no pull-up or pull-down resistor, and the sketch does not set pinMode(${g.pin.id.startsWith("A") ? g.pin.id : num}, INPUT_PULLUP): the input floats and reads random values on real hardware (the simulator reads LOW). Fix: use pinMode(${g.pin.id.startsWith("A") ? g.pin.id : num}, INPUT_PULLUP) with the button to GND, or add a 10 kΩ resistor.`, parts: [p.id, boardPart], pins: [key(g.ref)] });
        }
      }
    }
  }
  if (boardPart && !project.firmware?.sketch && project.parts.length > 1) {
    add({ severity: "info", code: "no-firmware", message: `${boardPart} has no firmware yet, so only the passive circuit is simulated. Fix: write_file("firmware/main.ino", …) then build.`, parts: [boardPart] });
  }

  // Power budget on the board's 5 V / 3V3 rail (USB or the on-board regulator): only parts fed from it count.
  if (boardPart) {
    const railNets = new Set(nets.filter((n) => n.pins.some((x) => x.ref.part === boardPart && x.pin.type === "power" && /^(5V|3V3|3\.3V|IOREF)$/i.test(x.pin.id))).map((n) => n.id));
    const motorSupply = (pin: PinSpec) => pin.type === "power" && ((pin.voltage?.max ?? 0) > 5.5 || /^(12V|VS|VM|VMOT|VIN|\+)$/i.test(pin.id));
    const fedFromRail = (pid: string, s: PartSpec): boolean => {
      const power = s.pins.filter((x) => x.type === "power");
      const supply = power.filter(motorSupply);
      const check = supply.length ? supply : power;
      return check.some((x) => railNets.has(netOf.get(`${pid}.${x.id}`)?.id ?? ""));
    };
    let mA = 0;
    const loads: string[] = [];
    const heavy: string[] = [];
    for (const p of project.parts) {
      const s = partSpec.get(p.id);
      if (!s || isBoard(s) || s.category === "power" || !fedFromRail(p.id, s)) continue;
      const lim = (s.limits ?? {}) as Record<string, number | undefined>;
      let c = lim.typicalCurrentmA ?? lim.movingCurrentmA;
      let label = lim.typicalCurrentmA !== undefined ? "" : lim.movingCurrentmA !== undefined ? " moving" : "";
      // A motor driver fed from the rail passes its motors' current through.
      const outs = s.pins.filter((x) => x.type === "passive").map((x) => netOf.get(`${p.id}.${x.id}`)).filter(Boolean);
      const motors = project.parts.filter((m) => {
        const ms = partSpec.get(m.id);
        return ms && m.id !== p.id && ms.category === "motor" && !ms.pins.some((x) => x.type === "power") && ms.pins.some((x) => outs.includes(netOf.get(`${m.id}.${x.id}`)));
      });
      if (motors.length) {
        c = motors.reduce((sum, m) => sum + (partSpec.get(m.id)!.limits?.maxCurrentmA ?? 500), 0);
        label = ` for ${motors.map((m) => m.id).join(" + ")} at stall`;
      }
      if (typeof c === "number" && c > 0) {
        mA += c;
        loads.push(`${p.id} ${c} mA${label}`);
        if (s.category === "motor") heavy.push(p.id);
      }
    }
    if (mA > 450) {
      add({ severity: "warning", code: "power-budget", message: `${boardPart}'s 5V rail feeds about ${mA} mA worst case (${loads.join(", ")}), more than USB's 500 mA minus the board's own ~50 mA: the board browns out and resets when they all move at once. Fix: power ${heavy.length ? heavy.join(", ") : "the heavy loads"} from a separate supply (a battery-pack: POS to their supply pin${heavy.some((h) => partSpec.get(h)?.pins.some(motorSupply)) ? " such as the driver's 12V" : ", e.g. servo VCC"}) and connect its NEG to ${boardPart}.GND (common ground).`, parts: loads.map((l) => l.split(" ")[0]!) });
    }
  }
  // Two supply outputs on one net (round 5, C5): regulators in parallel fight each other, and a
  // battery on a regulator's output back-feeds it (persona report, b4: L298N 5V tied to the Uno's 5V).
  for (const n of nets) {
    const sources = n.pins.filter((x) => isSupplyOutput(x, project.parts.find((p) => p.id === x.ref.part)?.props));
    const byPart = [...new Map(sources.map((x) => [x.ref.part, x])).values()];
    if (byPart.length < 2) continue;
    const volts = new Set(byPart.map((x) => x.pin.voltage?.max).filter((v) => v !== undefined));
    if (volts.size > 1) continue; // rails-shorted already says it
    const names = byPart.map((x) => `${key(x.ref)}${x.pin.voltage?.max ? ` (${x.pin.voltage.max} V)` : ""}`);
    const regulator = byPart.find((x) => !isBoard(x.spec) && x.spec.category !== "power");
    add({
      severity: "warning",
      code: "parallel-regulators",
      message: `${names.join(" and ")} are both supply outputs on one net: two regulators (or a battery and a regulator) in parallel fight each other, and the higher one back-feeds the other, which can overheat it or the USB port. Fix: keep one source per rail${regulator ? `: e.g. remove the wire between ${key(regulator.ref)} and ${byPart.filter((x) => x !== regulator).map((x) => key(x.ref)).join(", ")} (or take the 5V-EN jumper off and feed ${regulator.ref.part} from the board)` : ""}; share only GND.`,
      parts: byPart.map((x) => x.ref.part),
      pins: byPart.map((x) => key(x.ref)),
    });
  }

  // The 3.3 V pin's budget (round 5, C5): the board's 3V3 regulator gives far less than its 5V rail
  // (50 mA on an Uno / Nano, about 300 mA on RP2040 boards). Persona report, b1: an ESP-01 on 3V3.
  for (const b of project.parts) {
    const bs = partSpec.get(b.id);
    if (!bs || !isBoard(bs)) continue;
    const pins3 = bs.pins.filter((x) => x.type === "power" && /^(3V3|3\.3V|3V3_OUT|3V3\(OUT\))$/i.test(x.id));
    const railNets = new Set(pins3.map((x) => netOf.get(`${b.id}.${x.id}`)?.id).filter(Boolean));
    if (!railNets.size) continue;
    const lim = (bs.limits ?? {}) as Record<string, number | undefined>;
    const budget = lim.max3v3mA ?? (bs.mcu?.backend === "rp2040js" ? 300 : 50);
    let typ = 0;
    let peak = 0;
    const loads: string[] = [];
    for (const p of project.parts) {
      const s = partSpec.get(p.id);
      if (!s || p.id === b.id || isBoard(s)) continue;
      if (!s.pins.some((x) => x.type === "power" && railNets.has(netOf.get(`${p.id}.${x.id}`)?.id))) continue;
      const pl = (s.limits ?? {}) as Record<string, number | undefined>;
      const t = s.current_ma?.typ ?? pl.typicalCurrentmA ?? pl.idleCurrentmA;
      const m = s.current_ma?.max ?? pl.maxCurrentmA ?? t;
      if (t === undefined) continue;
      typ += t;
      peak += m ?? t;
      loads.push(`${p.id} ${t} mA${m !== undefined && m > t ? ` (peaks ${m} mA)` : ""}`);
    }
    if (typ > budget) {
      add({ severity: "warning", code: "rail-3v3-budget", message: `${b.id}'s 3V3 pin gives about ${budget} mA, but ${loads.join(", ")} ${loads.length > 1 ? `draw about ${Math.round(typ)} mA${peak > typ ? ` (up to ${Math.round(peak)} mA)` : ""}` : "draws more"}: the 3.3 V rail sags and the module browns out or resets (the simulation does not show this). Fix: feed them from a separate 3.3 V regulator (e.g. an AMS1117-3.3 from 5V, 800 mA) and connect its GND to ${b.id}.GND.`, parts: [b.id, ...loads.map((l) => l.split(" ")[0]!)] });
    }
  }

  // Layout (round 5, C5, info): a part far from everything it is wired to makes a "spaghetti" picture
  // (persona report, b2: resistors far from their LEDs).
  const boxOf = (p: (typeof project.parts)[number]) => {
    const s = partSpec.get(p.id);
    if (!s) return undefined;
    const turned = p.rotation === 90 || p.rotation === 270;
    return { x: p.x, y: p.y, w: turned ? s.size.h : s.size.w, h: turned ? s.size.w : s.size.h };
  };
  const gap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
    const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
    const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
    return Math.hypot(dx, dy);
  };
  const farPairs = new Set<string>();
  // Small parts first, so the advice is to move the resistor, not the board; one note per pair.
  for (const p of [...project.parts].sort((a, b) => Number(isBoard(partSpec.get(a.id) ?? ({} as PartSpec))) - Number(isBoard(partSpec.get(b.id) ?? ({} as PartSpec))))) {
    const box = boxOf(p);
    if (!box) continue;
    const peers = new Set<string>();
    for (const w of project.wires) {
      if (w.from.part === p.id && w.to.part !== p.id) peers.add(w.to.part);
      if (w.to.part === p.id && w.from.part !== p.id) peers.add(w.from.part);
    }
    if (!peers.size) continue;
    let nearest = Number.POSITIVE_INFINITY;
    let nearestId = "";
    for (const id of peers) {
      const q = project.parts.find((x) => x.id === id);
      const qb = q ? boxOf(q) : undefined;
      if (!qb) continue;
      const g = gap(box, qb);
      if (g < nearest) [nearest, nearestId] = [g, id];
    }
    if (nearest > 600 && Number.isFinite(nearest) && !farPairs.has(`${nearestId}|${p.id}`)) {
      farPairs.add(`${p.id}|${nearestId}`);
      add({ severity: "info", code: "far-apart", message: `${p.id} is about ${Math.round(nearest)} px from the nearest part it is wired to (${nearestId}), so its wires cross the whole canvas and the picture is hard to follow. Fix: move_part ${p.id} next to ${nearestId} (only the drawing changes, not the circuit).`, parts: [p.id, nearestId] });
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}
