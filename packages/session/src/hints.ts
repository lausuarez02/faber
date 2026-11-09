import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { PartSpec } from "@jumper/sim-core";
import { BOARDS_R5_HINTS } from "./hints-boards.ts";
import { PARTS_R5_HINTS } from "./hints-parts.ts";

/**
 * Wiring hints and minimal Arduino examples for get_part. A part folder may ship its own
 * `example.ino` (and `usage.md` for the hint); otherwise the built-in table below is used, and as a
 * last resort a hint is derived from the pin types.
 */

export interface Usage {
  wiring: string;
  /** Typical connections as "this.pin -> board.pin" pairs for an Uno. */
  connect?: string[];
  example?: string;
  libraries?: string[];
  /** Fields set_sensor_value / interact accept. */
  controls?: string;
}

const PARTS_DIR = (() => {
  try {
    return fileURLToPath(new URL("../../parts/src/parts/", import.meta.url));
  } catch {
    return "";
  }
})();

const CORE: Record<string, Usage> = {
  led: {
    wiring: "Anode A through a 220 Ω resistor to a GPIO (or 5V); cathode C to GND. Never connect an LED straight to a pin: it draws ~100 mA and burns out.",
    connect: ["uno.D13 -> r1.1", "r1.2 -> led1.A", "led1.C -> uno.GND"],
    example: `void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(500); digitalWrite(13, LOW); delay(500); }`,
  },
  resistor: { wiring: "Two interchangeable legs 1 and 2. Set the value with props {\"resistance\": 220} (Ω). 220 Ω for LEDs at 5 V, 10 kΩ for pull-ups/downs." },
  "rgb-led": {
    wiring: "Common cathode: COM to GND; R, G, B each through its own 220 Ω resistor to a PWM pin (D3, D5, D6, D9, D10, D11).",
    example: `void setup() {}\nvoid loop() { analogWrite(9, 255); analogWrite(10, 0); analogWrite(11, 128); }`,
  },
  pushbutton: {
    wiring: "Simplest: one side (1a) to a GPIO, the other side (2a) to GND, and pinMode(pin, INPUT_PULLUP): reads LOW while pressed. 1a/1b are the same contact, as are 2a/2b.",
    connect: ["btn1.1a -> uno.D2", "btn1.2a -> uno.GND"],
    example: `void setup() { pinMode(2, INPUT_PULLUP); Serial.begin(115200); }\nvoid loop() { if (digitalRead(2) == LOW) Serial.println("pressed"); delay(20); }`,
    controls: 'interact(part, "press") / interact(part, "release"); in scenarios {"press": "btn1", "hold_ms": 50}.',
  },
  "slide-switch": {
    wiring: "Middle pin 2 is common: to a GPIO with INPUT_PULLUP; pin 1 or 3 to GND.",
    controls: 'interact(part, "press") toggles; set_sensor_value(part, "position", 0|1).',
  },
  potentiometer: {
    wiring: "Outer pins 1 and 2 to 5V and GND, wiper W to an analog pin (A0). analogRead gives 0..1023.",
    connect: ["pot1.1 -> uno.5V", "pot1.2 -> uno.GND", "pot1.W -> uno.A0"],
    example: `void setup() { Serial.begin(115200); }\nvoid loop() { Serial.println(analogRead(A0)); delay(100); }`,
    controls: 'set_sensor_value(part, "position", 0..1).',
  },
  photoresistor: {
    wiring: "Voltage divider: pin 1 to 5V, pin 2 to A0 and through a 10 kΩ resistor to GND. More light → higher reading.",
    controls: 'set_sensor_value(part, "lux", 0..100000).',
  },
  buzzer: {
    wiring: "Active buzzer: POS to a GPIO, NEG to GND. digitalWrite HIGH beeps; tone() also works.",
    connect: ["buzzer1.POS -> uno.D8", "buzzer1.NEG -> uno.GND"],
    example: `void setup() { pinMode(8, OUTPUT); }\nvoid loop() { digitalWrite(8, HIGH); delay(100); digitalWrite(8, LOW); delay(900); }`,
  },
  "arduino-uno": {
    wiring: "GPIO ids D0–D13 and A0–A5 are the names you use in code. Power rails 5V and 3V3, grounds GND.1–GND.3 (\"uno.GND\" picks a free one). I2C is A4 (SDA) / A5 (SCL); D0/D1 are the serial port.",
    example: `void setup() { Serial.begin(115200); Serial.println("hello"); }\nvoid loop() {}`,
  },
  "arduino-nano": {
    wiring: "Same pin names as the Uno (D0–D13, A0–A7); A6/A7 are analog-only. I2C on A4/A5.",
  },
  "ssd1306-oled-i2c": {
    wiring: "GND → GND, VCC → 5V, SCL → A5, SDA → A4 (Uno). Address 0x3C. The module has its own pull-ups.",
    connect: ["oled1.GND -> uno.GND", "oled1.VCC -> uno.5V", "oled1.SCL -> uno.A5", "oled1.SDA -> uno.A4"],
    libraries: ["Adafruit SSD1306", "Adafruit GFX Library"],
    example: `#include <Wire.h>\n#include <Adafruit_GFX.h>\n#include <Adafruit_SSD1306.h>\nAdafruit_SSD1306 display(128, 64, &Wire, -1);\nvoid setup() {\n  Serial.begin(115200);\n  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { Serial.println("oled fail"); for (;;); }\n  display.clearDisplay();\n  display.setTextSize(2);\n  display.setTextColor(SSD1306_WHITE);\n  display.setCursor(0, 0);\n  display.println("Hi!");\n  display.display();\n}\nvoid loop() {}`,
    controls: "read_display(part) shows the screen as ASCII art; state fields: on, lit (lit pixel count), frame.",
  },
  "hc-sr04": {
    wiring: "VCC → 5V, GND → GND, TRIG → a GPIO (D9), ECHO → a GPIO (D10). Measure with pulseIn(echo, HIGH) / 58 = cm.",
    connect: ["sonar1.VCC -> uno.5V", "sonar1.GND -> uno.GND", "sonar1.TRIG -> uno.D9", "sonar1.ECHO -> uno.D10"],
    example: `const int TRIG = 9, ECHO = 10;\nvoid setup() { pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); Serial.begin(115200); }\nvoid loop() {\n  digitalWrite(TRIG, LOW); delayMicroseconds(2);\n  digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW);\n  long us = pulseIn(ECHO, HIGH, 30000);\n  Serial.print("cm="); Serial.println(us / 58);\n  delay(60);\n}`,
    controls: 'set_sensor_value(part, "distance", 2..400 cm) (or the robot physics sets it).',
  },
  l298n: {
    wiring: "Motor supply +12V (or 5V for small motors) and GND shared with the Arduino. ENA/ENB → PWM pins (D5, D6), IN1..IN4 → GPIOs; OUT1/OUT2 to motor A, OUT3/OUT4 to motor B.",
    example: `const int ENA = 5, IN1 = 7, IN2 = 8;\nvoid setup() { pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT); }\nvoid loop() { digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW); analogWrite(ENA, 180); }`,
  },
  "dc-motor": { wiring: "Two terminals to a FREE motor driver output pair: the first motor on L298N OUT1/OUT2, the second on OUT3/OUT4. Never drive a motor straight from a GPIO." },
  "battery-pack": {
    wiring: "POS → the board's VIN (6–12 V, goes through the onboard regulator) and/or a motor driver's supply (L298N 12V); NEG → GND, shared with the board. NEVER connect a battery pack to the 5V pin: anything above 5.5 V there damages the board.",
    connect: ["battery.POS -> uno.VIN", "battery.NEG -> uno.GND"],
  },
  servo: {
    wiring: "Brown/black GND → GND, red VCC → 5V (two or more servos: a separate 5–6 V supply with common GND), orange/yellow SIG → a free digital pin (typical_connections suggests one; the Servo library works on any pin and disables PWM on D9/D10). Use the Servo library.",
    connect: ["servo1.GND -> uno.GND", "servo1.VCC -> uno.5V", "servo1.SIG -> uno.D9"],
    libraries: ["Servo"],
    example: `#include <Servo.h>\nServo s;\nvoid setup() { s.attach(9); }\nvoid loop() { s.write(0); delay(1000); s.write(180); delay(1000); }`,
  },
};

/** Core table + round-5 tables (each track owns its own file; decision 0003, C7). */
const BUILTIN: Record<string, Usage> = { ...CORE, ...PARTS_R5_HINTS, ...BOARDS_R5_HINTS };

function readIfExists(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Usage for a part type: the part folder's files win, then the built-in table, then a hint from the pins. */
export function usageFor(spec: PartSpec): Usage {
  const dir = PARTS_DIR ? join(PARTS_DIR, spec.id) : "";
  const example = dir ? readIfExists(join(dir, "example.ino")) : undefined;
  const usageMd = dir ? readIfExists(join(dir, "usage.md")) : undefined;
  const builtin = BUILTIN[spec.id] ?? BUILTIN[Object.keys(BUILTIN).find((k) => spec.id.startsWith(k)) ?? ""];
  const u: Usage = builtin ? { ...builtin } : { wiring: derivedWiring(spec) };
  if (usageMd) u.wiring = usageMd;
  if (example) u.example = example;
  return u;
}

function derivedWiring(spec: PartSpec): string {
  const bits: string[] = [];
  const power = spec.pins.filter((p) => p.type === "power").map((p) => p.id);
  const ground = spec.pins.filter((p) => p.type === "ground").map((p) => p.id);
  if (power.length) {
    const max = Math.max(...spec.pins.filter((p) => p.type === "power").map((p) => p.voltage?.max ?? 5));
    bits.push(max <= 3.6 ? `${power.join("/")} → 3V3 (3.3 V part: 5 V damages it)` : `${power.join("/")} → 5V if the pin's voltage range allows it (check get_part pins)`);
  }
  if (ground.length) bits.push(`${ground.join("/")} → GND`);
  for (const p of spec.pins) {
    const proto = p.protocols ?? [];
    if (proto.includes("i2c-sda")) bits.push(`${p.id} → A4 (SDA)`);
    else if (proto.includes("i2c-scl")) bits.push(`${p.id} → A5 (SCL)`);
    else if (proto.some((x) => x.startsWith("spi-"))) bits.push(`${p.id} → the board's ${proto.find((x) => x.startsWith("spi-"))!.slice(4).toUpperCase()} pin`);
  }
  const signals = spec.pins.filter((p) => (p.type === "digital" || p.type === "analog") && !(p.protocols ?? []).some((x) => x.startsWith("i2c") || x.startsWith("spi")));
  if (signals.length) bits.push(`${signals.map((p) => p.id).join(", ")} → GPIO pins`);
  return bits.length ? bits.join("; ") + "." : spec.description;
}

/** Pin kind a suggested board pin needs, from the pin the static hint named. */
function pinKind(pin: { id: string; protocols?: string[] }): "pwm" | "analog" | "digital" | "fixed" {
  const pr = pin.protocols ?? [];
  if (pr.some((x) => x.startsWith("i2c") || x.startsWith("uart") || x.startsWith("spi-sck") || x.startsWith("spi-miso") || x.startsWith("spi-mosi"))) return "fixed";
  if (/^D\d+$/.test(pin.id)) return pr.includes("pwm") ? "pwm" : "digital";
  if (/^A\d+$/.test(pin.id)) return "analog";
  return "fixed";
}

/**
 * typical_connections for a newly placed part with real board pins: the static hint ("btn1.1a ->
 * uno.D2") is moved to the next free pin of the same kind when that pin is already wired or was
 * suggested to an earlier part that has no wires yet. Ids are rewritten to the placed part and board.
 */
export function suggestConnections(
  project: { parts: { id: string; type: string }[]; wires: { from: { part: string; pin: string }; to: { part: string; pin: string } }[] },
  specOf: (type: string) => PartSpec | undefined,
  partId: string,
  shortId: (type: string) => string,
): string[] | undefined {
  const board = project.parts.find((p) => specOf(p.type)?.category === "board");
  const bspec = board ? specOf(board.type) : undefined;
  const taken = new Set<string>();
  if (board) for (const w of project.wires) for (const e of [w.from, w.to]) if (e.part === board.id) taken.add(e.pin);
  taken.add("D0");
  taken.add("D1");
  const hasI2c = project.parts.some((p) => specOf(p.type)?.bus?.i2c);
  if (hasI2c) {
    taken.add("A4");
    taken.add("A5");
  }
  const wiredParts = new Set(project.wires.flatMap((w) => [w.from.part, w.to.part]));
  let result: string[] | undefined;
  for (const p of project.parts) {
    const spec = specOf(p.type);
    if (!spec || spec.category === "board") continue;
    const u = usageFor(spec).connect;
    if (!u) continue;
    if (wiredParts.has(p.id) && p.id !== partId) continue; // its real pins are already in `taken`
    const placeholder = new RegExp(`\\b${shortId(spec.id)}1\\b`, "g");
    const lines = u.map((line) => {
      let l = line.replace(placeholder, p.id);
      if (board) l = l.replace(/\buno\./g, `${board.id}.`);
      const m = l.match(new RegExp(`\\b${board?.id ?? "uno"}\\.([A-Z]\\w*)$`)) ?? l.match(new RegExp(`^${board?.id ?? "uno"}\\.([A-Z]\\w*)\\b`));
      if (!m || !bspec) return l;
      const want = bspec.pins.find((x) => x.id === m[1]);
      if (!want) return l;
      const kind = pinKind(want);
      if (kind === "fixed" || (want.type !== "digital" && want.type !== "analog")) return l;
      let pick = want.id;
      if (taken.has(pick)) {
        const pool = bspec.pins.filter((x) => (x.type === "digital" || x.type === "analog") && !taken.has(x.id) && pinKind(x) !== "fixed");
        const ok = (x: (typeof pool)[number]) => (kind === "pwm" ? (x.protocols ?? []).includes("pwm") : kind === "analog" ? /^A\d+$/.test(x.id) : /^D\d+$/.test(x.id));
        // Plain digital needs: prefer non-PWM pins first, keep PWM pins for things that need them, then analog pins as digital.
        const ranked = [...pool.filter((x) => ok(x) && !(kind === "digital" && (x.protocols ?? []).includes("pwm"))), ...pool.filter((x) => ok(x) && kind === "digital" && (x.protocols ?? []).includes("pwm")), ...(kind === "digital" ? pool.filter((x) => /^A\d+$/.test(x.id)) : [])];
        const sorted = ranked.slice().sort((a, b) => num(a.id) - num(b.id));
        const after = sorted.filter((x) => num(x.id) > num(want.id) && sameBank(x.id, want.id));
        const next = (kind === "digital" ? ranked : [...after, ...sorted])[0];
        if (next) pick = next.id;
      }
      taken.add(pick);
      return l.replace(new RegExp(`\\.${want.id}\\b`), `.${pick}`);
    });
    if (p.id === partId) result = lines;
  }
  return result;
}

function num(id: string): number {
  return Number(id.replace(/\D/g, "")) + (id.startsWith("A") ? 100 : 0);
}
function sameBank(a: string, b: string): boolean {
  return a[0] === b[0];
}
