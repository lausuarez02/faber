import type { PartSpec, PinSpec } from "@faber/sim-core";

/**
 * Round 6 (canvas track): how a module's supply and bus pins go to a given board, from the board's
 * own pin protocols (I2C SDA/SCL, SPI MOSI/MISO/SCK/SS) and supply pins. Used by the web Inspector
 * so a part on a XIAO RP2040 says "SDA → GP6 (D4)", not the Uno's A4. Browser-safe (no node APIs).
 * Pins with no fixed role (a button leg, a GPIO line) are left to "any free GPIO".
 */

export interface WiringLine {
  /** The part's pin id. */
  pin: string;
  /** The board pin id it goes to (undefined: no matching pin on this board). */
  to: string | undefined;
  /** "GP6 (D4/SDA)": the board pin as printed on the board. */
  toLabel: string;
  /** Why this pin (a 5 V-only module on a 3.3 V board, a level shifter…). */
  note?: string;
}

export interface BoardWiring {
  board: string;
  lines: WiringLine[];
  /** Pins of the part that go to any free GPIO (no bus role). */
  free: string[];
  /** One sentence: "On Seeed XIAO RP2040: VCC → 3V3, GND → GND, SCL → GP7 (D5/SCL), SDA → GP6 (D4/SDA)." */
  text: string;
}

const BUS = ["i2c-sda", "i2c-scl", "spi-mosi", "spi-miso", "spi-sck"] as const;

function labelOf(p: PinSpec): string {
  const label = p.label?.trim();
  return label && label !== p.id ? `${p.id} (${label})` : p.id;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The board's supply pin for a module, or undefined when it has none of them. */
function supplyFor(part: PartSpec, pin: PinSpec, board: PartSpec): { id: string | undefined; note?: string } {
  const has = (id: string) => board.pins.find((x) => x.id === id);
  const five = ["5V", "VBUS", "VSYS", "VIN"].map(has).find(Boolean);
  const three = has("3V3");
  const min = num(pin.voltage?.min) ?? num(part.limits?.minVoltage);
  const max = num(pin.voltage?.max) ?? num(part.limits?.maxVoltage);
  const logic = board.mcu?.vcc ?? 5;
  if (max !== undefined && max < 4.5) return { id: three?.id, ...(three ? {} : { note: `needs 3.3 V; ${board.name} has no 3.3 V pin` }) };
  if (logic < 4) {
    if (min === undefined || min <= 3.3) return { id: (three ?? five)?.id };
    return { id: five?.id, note: `needs ${min} V or more: power it from 5 V; its outputs may be 5 V, too much for ${board.name}'s 3.3 V pins without a level shifter` };
  }
  return { id: (five ?? three)?.id };
}

export function boardWiring(part: PartSpec, board: PartSpec): BoardWiring | undefined {
  if (part.mcu || part.category === "board" || part.category === "power") return undefined;
  const lines: WiringLine[] = [];
  const free: string[] = [];
  const gnd = board.pins.find((x) => x.type === "ground");
  for (const pin of part.pins) {
    if (pin.type === "ground") {
      lines.push({ pin: pin.id, to: gnd?.id, toLabel: gnd ? (gnd.label || gnd.id) : "GND" });
      continue;
    }
    if (pin.type === "power") {
      const s = supplyFor(part, pin, board);
      const bp = s.id ? board.pins.find((x) => x.id === s.id) : undefined;
      lines.push({ pin: pin.id, to: s.id, toLabel: bp ? labelOf(bp) : "no supply pin", ...(s.note ? { note: s.note } : {}) });
      continue;
    }
    const proto = pin.protocols?.find((p) => (BUS as readonly string[]).includes(p) || p === "spi-cs");
    if (proto) {
      const want = proto === "spi-cs" ? "spi-ss" : proto;
      const bp = board.pins.find((x) => x.protocols?.includes(want));
      if (proto === "spi-cs" && bp) lines.push({ pin: pin.id, to: bp.id, toLabel: labelOf(bp), note: "any free GPIO works; this is the board's default" });
      else lines.push({ pin: pin.id, to: bp?.id, toLabel: bp ? labelOf(bp) : `no ${want.replace("-", " ").toUpperCase()} pin` });
      continue;
    }
    if (pin.type === "digital" || pin.type === "analog") free.push(pin.id);
  }
  if (!lines.length) return undefined;
  const parts = lines.map((l) => `${l.pin} → ${l.toLabel}`);
  const tail = free.length ? ` ${free.join(", ")} → any free GPIO.` : "";
  return { board: board.id, lines, free, text: `On ${board.name}: ${parts.join(", ")}.${tail}` };
}

/**
 * A part description with the sentences that name another board's pins removed (e.g. "SCL → A5,
 * SDA → A4 on an Uno" on a XIAO), for showing next to boardWiring(). Unchanged on Uno-style boards.
 */
export function descriptionForBoard(description: string, board: PartSpec | undefined): string {
  if (!board || board.pins.some((p) => p.id === "A4")) return description;
  const sentences = description.split(/(?<=[.!?])\s+/);
  const unoish = /\b(A[0-7]|D1[0-3]|D[0-9])\b.*\b(Uno|Nano)\b|\b(Uno|Nano) wiring\b|\bon an? (Uno|Nano)\b|\(Uno\)|→\s*(A[0-7]|D1[0-3]|D[0-9])\b/;
  return sentences.filter((s) => !unoish.test(s)).join(" ");
}
