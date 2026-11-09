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

  // Power and ground of modules.
  for (const p of project.parts) {
    const s = partSpec.get(p.id);
    if (!s || isBoard(s)) continue;
    const pins = s.pins.filter((x) => x.type === "power" || x.type === "ground");
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
    // Over-voltage: a 5 V source on a pin rated for less.
    const sources = n.pins.filter((x) => (isRail(x) || isGpio(x)) && (x.pin.voltage?.max ?? 0) >= 4.5);
    if (sources.length) {
      for (const x of n.pins) {
        if (sources.includes(x) || isBoard(x.spec)) continue;
        const max = x.pin.voltage?.max ?? x.spec.limits?.maxVoltage;
        if (max !== undefined && max < 4 && x.pin.type !== "ground" && x.pin.type !== "passive") {
          add({ severity: "error", code: "overvoltage", message: `5 V on a ${max} V pin: ${key(x.ref)} is rated up to ${max} V but shares a net with ${sources.map((s) => key(s.ref)).join(", ")} (5 V). It may be damaged. Fix: power it from 3V3, or use a level shifter / voltage divider on signals.`, parts: [x.ref.part], pins: [key(x.ref)] });
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

  // LEDs need a series resistor.
  for (const p of project.parts) {
    const s = partSpec.get(p.id);
    if (!s || (s.id !== "led" && s.id !== "rgb-led")) continue;
    for (const pin of s.pins) {
      const n = netOf.get(`${p.id}.${pin.id}`);
      if (!n) continue;
      const driver = n.pins.filter((x) => isGpio(x) || isRail(x));
      const hasR = n.pins.some(isResistive);
      if (driver.length && !hasR) {
        add({ severity: "error", code: "led-no-resistor", message: `${p.id}.${pin.id} is wired straight to ${driver.map((d) => key(d.ref)).join(", ")} with no resistor: about 100 mA would flow (an LED takes 20 mA max) and burn it and the pin. Fix: insert a 220 Ω resistor between ${driver.map((d) => key(d.ref))[0]} and ${p.id}.${pin.id} (place_part resistor, then connect both ends).`, parts: [p.id], pins: [`${p.id}.${pin.id}`] });
      }
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
  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}
