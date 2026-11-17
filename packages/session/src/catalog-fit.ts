// Round 6, track "power" (owner): search_parts that says when nothing fits (with a create_part
// template ready to fill in) and get_part that finds "rp2040-zero" → waveshare-rp2040-zero.
// Decision 0004, R4 ("Changes to existing tools").
import type { PartDefinition } from "@faber/sim-core";

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.+]+/).filter(Boolean);

/** A real match: every query term is in the part's id, name, tags or category (not only somewhere in its description). */
export function fits(d: PartDefinition, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const s = d.spec;
  const hay = [s.id, s.name.toLowerCase(), s.category, ...(s.tags ?? []).map((t) => t.toLowerCase())];
  const hayWords = new Set(hay.flatMap(words));
  return terms.every((t) => hay.some((h) => h.includes(t)) || hayWords.has(t.replace(/s$/, "")));
}

type Kind = "digital-input" | "analog-sensor" | "actuator" | "i2c-device" | "uart-device" | "display";

function guessKind(q: string): { kind: Kind; category: string } {
  if (/screen|display|lcd|oled|tft|e-?ink|epaper/.test(q)) return { kind: "display", category: "display" };
  if (/gps|uart|serial|rfid|fingerprint|lora|gsm|sim800|bluetooth|hc-05|mp3|dfplayer/.test(q)) return { kind: "uart-device", category: /gps|rfid|fingerprint/.test(q) ? "sensor" : "communication" };
  if (/i2c|imu|gyro|compass|magnet|barometer|lux|tof|vl53|ina219|current sensor|adc|ads1115|bmp|sht|aht|co2|scd|ccs811/.test(q)) return { kind: "i2c-device", category: "sensor" };
  if (/motor|pump|fan|heater|solenoid|valve|lamp|peltier|vibrat|actuator|magnet lock|lock/.test(q)) return { kind: "actuator", category: "motor" };
  if (/pir|reed|hall|tilt|button|switch|detect|obstacle|limit|touch|flame|rain|presence/.test(q)) return { kind: "digital-input", category: "input" };
  return { kind: "analog-sensor", category: "sensor" };
}

function slug(q: string): string {
  const s = words(q).join("-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z]/.test(s) ? s : `part-${s || "custom"}`;
}

/**
 * A create_part `part` an agent can fill in and send when the catalog has nothing that fits. It is
 * valid as it stands (compiles), with the behaviour template guessed from the words; every number is
 * a placeholder the description says to replace from the real part's datasheet.
 */
export function createPartTemplate(query: string, takenIds: ReadonlySet<string>): Record<string, unknown> {
  const q = query.toLowerCase();
  const { kind, category } = guessKind(q);
  let id = slug(q);
  if (takenIds.has(id)) id = `${id}-module`;
  const title = query.trim().replace(/\s+/g, " ").replace(/^./, (c) => c.toUpperCase());
  const power = [
    { id: "VCC", type: "power", voltage: { min: 3.3, max: 5.5 }, description: "Supply (check the module's range)." },
    { id: "GND", type: "ground", description: "Ground." },
  ];
  const base = {
    id,
    name: `${title} (module)`,
    category,
    description: `${title}: REPLACE with what it is and how to wire it, from the real module's datasheet.`,
    usage: { wiring: "VCC → 3V3 or 5V (check the range), GND → GND, signal → a GPIO. REPLACE with the real wiring." },
  };
  switch (kind) {
    case "digital-input":
      return { ...base, pins: [...power, { id: "OUT", type: "digital", description: "Goes HIGH (or LOW) when it detects something." }], behavior: { kind, output: "OUT", field: "active", active_level: "high", drive: "push-pull" } };
    case "actuator":
      return { ...base, pins: [{ id: "+", type: "passive", description: "Load +, to the supply." }, { id: "-", type: "passive", description: "Load −, to the driver (MOSFET drain / transistor collector)." }], behavior: { kind, drive: "load", plus: "+", minus: "-", rated_v: 5, rated_ma: 150 }, usage: { wiring: "+ → supply, − → n-mosfet D (S → GND, G ← GPIO through 100 Ω). REPLACE with the real ratings." } };
    case "i2c-device":
      return { ...base, pins: [...power, { id: "SDA", type: "digital", protocols: ["i2c-sda"] }, { id: "SCL", type: "digital", protocols: ["i2c-scl"] }], behavior: { kind, address: 0x40, registers: [{ reg: 0, bytes: 2, field: { id: "value", min: 0, max: 1000, default: 100, scale: 1 } }], pullup_ohms: 10000 } };
    case "uart-device":
      return { ...base, pins: [...power, { id: "TX", type: "digital", protocols: ["uart-tx"], description: "Module transmits (to the board's RX)." }, { id: "RX", type: "digital", protocols: ["uart-rx"], description: "Module receives (from the board's TX)." }], behavior: { kind, rx: "RX", tx: "TX", baud: 9600, responses: [{ match: "AT", reply: "OK" }] } };
    case "display":
      return { ...base, pins: [], behavior: { kind, controller: "st7735", resolution: { w: 128, h: 160 } } };
    default:
      return { ...base, pins: [...power, { id: "AO", type: "analog", description: "Analog output." }], behavior: { kind: "analog-sensor", output: "AO", quantity: { id: "reading", unit: "%", min: 0, max: 100, default: 50 }, curve: [{ value: 0, volts: 0.2 }, { value: 100, volts: 4.5 }], ratiometric: true } };
  }
}

/**
 * Resolve a part type an agent half-remembers: exact id, then unique ids that end with it or contain
 * it ("rp2040-zero" → "waveshare-rp2040-zero", "xiao" → "seeed-xiao-rp2040"), then a unique tag or
 * name match. Returns the id, or the candidates when more than one fits.
 */
export function resolvePartType(type: string, ids: readonly string[], defs: readonly PartDefinition[]): { id?: string; candidates: string[] } {
  const t = type.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (ids.includes(t)) return { id: t, candidates: [t] };
  const pick = (c: string[]) => (c.length === 1 ? { id: c[0]!, candidates: c } : { candidates: c });
  for (const test of [(id: string) => id.endsWith(`-${t}`) || id.startsWith(`${t}-`), (id: string) => id.includes(t)]) {
    const c = ids.filter(test);
    if (c.length) return pick(c);
  }
  const byTag = defs.filter((d) => (d.spec.tags ?? []).some((x) => x.toLowerCase().replace(/\s+/g, "-") === t) || d.spec.name.toLowerCase().replace(/\s+/g, "-").includes(t)).map((d) => d.spec.id);
  return byTag.length ? pick(byTag) : { candidates: [] };
}
