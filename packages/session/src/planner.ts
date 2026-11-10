import type { PartDefinition, PartRegistry, PartSpec } from "@jumper/sim-core";

/**
 * Round 5, track "agent" (decision 0003, C5 `plan_device`): turn a wish ("a pet that fits in my
 * pocket") into a plan the person can say yes to before anything is placed: which board and why, a
 * bill of materials with one line of why per part, what Jumper simulates exactly / with a stand-in /
 * with an agent-made part / not at all, a rough size, battery life, price and buy links, and what
 * the simulation cannot check.
 *
 * Read-only and deterministic. Numbers come from the parts' physical data (part.json C2 fields:
 * dimensions_mm, mass_g, current_ma, price_usd, buy_links); a part without a figure is left out of
 * that total and named in `missing_data`, never guessed. Batteries and the few helper modules that
 * are not catalog parts carry their own typical figures, labelled as assumptions.
 */

export interface PlanConstraints {
  pocket?: boolean;
  max_size_mm?: { w: number; h: number; d: number };
  budget_usd?: number;
  battery_hours?: number;
  board?: string;
}

export type BomSource = "simulated-exactly" | "stand-in" | "agent-made" | "not-simulated";

export interface BomLine {
  type: string | null;
  name: string;
  qty: number;
  why: string;
  source: BomSource;
  /** Fidelity of the simulated part ("exact" | "behavioral" | "stub"; agent-made parts: "behavioral, unverified"). */
  fidelity?: string;
  current_ma?: number;
  price_usd?: number;
  buy_links?: { vendor: string; url: string }[];
  /** For a stand-in: the real part it represents (mark it with mark_stand_in after placing). */
  stand_in_for?: string;
  /** For a missing part: how to make it (create_part with this behaviour kind). */
  make_with?: string;
  /** Props to place it with, e.g. a battery preset. */
  props?: Record<string, string | number>;
  /** Where a figure came from when it is not the part's own data. */
  assumption?: string;
}

export interface DevicePlan {
  summary: string;
  question?: string;
  board: { type: string; name: string; why: string };
  bom: BomLine[];
  size_mm: { parts: { w: number; h: number; d: number }; enclosure: { w: number; h: number; d: number }; note: string };
  battery?: { type: string; capacity_mah: number; avg_ma: number; hours: number; note: string };
  total_usd: number;
  cannot_check: string[];
  warnings: string[];
  missing_data: string[];
  next: string[];
}

interface Need {
  key: string;
  /** Matched against the goal (lower case). */
  match: RegExp;
  /** Real part, in plain words. */
  label: string;
  /** Part type ids to try first, then search phrases (every word must match id / name / tags). */
  ids: string[];
  search?: string[];
  why: string;
  qty?: (goal: string) => number;
  /** create_part behaviour kind when the catalog lacks the part. */
  behavior?: string;
  /** Catalog part that can stand in when nothing else is possible. */
  standIn?: string;
  /** What the simulation cannot tell about this need. */
  cannot?: string;
  /** Other needs this one brings along (an LED needs a resistor). */
  with?: string[];
  /** Skip this need when another one matched. */
  unless?: string[];
}

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1, single: 1, pair: 2 };
function countOf(goal: string, noun: RegExp, dflt: number): number {
  const m = new RegExp(`\\b(\\d+|one|two|three|four|five|six|a|an|single|pair of)\\s+(?:\\w+\\s+)?${noun.source}`).exec(goal);
  if (!m) return dflt;
  const w = m[1]!.replace(" of", "");
  const n = Number(w) || NUM[w] || dflt;
  return Math.max(1, Math.min(12, n));
}

const NEEDS: Need[] = [
  { key: "round-display", match: /round (screen|display|lcd|tft)|circular (screen|display)|watch ?face|smart ?watch|\bgc9a01/, label: "round 1.28 in colour screen (GC9A01, 240 × 240)", ids: ["gc9a01-round-tft"], search: ["round display"], why: "a round colour screen, like a watch face", behavior: "display", cannot: "screen brightness, colours and viewing angle on the real panel" },
  { key: "color-display", unless: ["round-display"], match: /colou?r(ed)? (screen|display)|\btft\b|photos?\b|pictures?\b|round (screen|display)|gif/, label: "colour TFT screen", ids: ["st7735-tft", "gc9a01-round-tft", "ili9341-tft"], search: ["colour display", "tft"], why: "a colour screen to show faces and pictures", behavior: "display", cannot: "screen brightness, colours and viewing angle on the real panel" },
  { key: "display", match: /screen|display|\bshow|face|\bpet\b|tamagotchi|emoji|\btext\b|\bmenu|oled|\bscore/, label: "0.96 in OLED screen (SSD1306, I2C)", ids: ["ssd1306-oled-i2c"], search: ["oled"], why: "a small, low-power screen for faces, text and numbers (2 data wires)", unless: ["color-display", "round-display"], cannot: "screen brightness and readability in sunlight" },
  { key: "buttons", match: /button|\bpress|\bfeed\b|\bplay\b|\bclick|controls?\b|\bgame\b|\bmenu|\bpet\b|tamagotchi/, label: "6 mm push button", ids: ["pushbutton"], why: "buttons the person presses (feed, play, menu)", qty: (g) => (/\bpet\b|tamagotchi/.test(g) ? countOf(g, /buttons?/, 3) : countOf(g, /buttons?/, 1)), cannot: "how the buttons feel and whether they bounce (the simulation debounces nothing for you, but real contacts chatter more)" },
  { key: "melody", match: /melod|\bsongs?\b|\bmusic|\btunes?\b|\bnotes?\b|\btone\b|chiptune/, label: "passive piezo buzzer (plays notes)", ids: ["passive-buzzer", "piezo-buzzer"], search: ["passive buzzer"], why: "plays notes with tone(), so it can sing", standIn: "buzzer", behavior: "actuator", cannot: "how loud it is and how the notes sound" },
  { key: "buzzer", match: /sound|\bbeep|\bbuzz|alarm|chirp|squeak|notif|\bpet\b|tamagotchi|alert/, label: "active buzzer", ids: ["buzzer"], why: "beeps to get attention (one pin, no tone() needed)", unless: ["melody", "voice"], cannot: "how loud it is" },
  { key: "rgb", match: /rainbow|\brgb\b|colou?r(ed|ful)? lights?|mood light|neopixel|ws2812|led strip/, label: "RGB LED", ids: ["ws2812-strip", "ws2812", "rgb-led"], search: ["neopixel"], why: "mixes any colour for a rainbow or mood light", with: ["resistor3"], cannot: "real colour mixing and brightness" },
  { key: "led", match: /\blights?\b|\bleds?\b|\blamp|\bglow|blink|night ?light|indicator/, label: "5 mm LED", ids: ["led"], why: "a light that shows what the device is doing", qty: (g) => countOf(g, /(leds?|lights?)/, 1), with: ["resistor"], unless: ["rgb"] },
  { key: "climate", match: /temperature|humidity|weather|pressure|thermo|\bclimate/, label: "BME280 temperature / humidity / pressure sensor", ids: ["bme280"], search: ["temperature humidity"], why: "measures temperature, humidity and air pressure (I2C, shares the screen's wires)", cannot: "real sensor accuracy and self-heating inside a closed case" },
  { key: "distance", match: /distance|obstacle|\bavoid|ultrasonic|sonar|parking|\brange\b|follow[- ]me/, label: "HC-SR04 ultrasonic distance sensor", ids: ["hc-sr04"], search: ["ultrasonic"], why: "measures distance to things in front (2 cm to 4 m)", cannot: "echoes from soft or angled surfaces and sensor noise" },
  { key: "motion", match: /tilt|shake|motion|step count|pedometer|acceler|gyro|orientation|posture|\bsit(ting)?\b|\bfall\b/, label: "MPU-6050 motion sensor (accelerometer + gyro)", ids: ["mpu6050"], search: ["accelerometer"], why: "feels tilt, shakes and steps", cannot: "real motion: the simulation feeds the values you set, not your hand" },
  { key: "light-sensor", match: /light sensor|\bdark\b|darkness|brightness|daylight|sunlight|\bldr\b|when it gets dark/, label: "light sensor (LDR)", ids: ["photoresistor"], why: "notices when it gets dark", with: ["resistor10k"], cannot: "real light levels in the room" },
  { key: "knob", match: /\bknob|\bdial\b|volume|adjust|potentiometer|slider/, label: "10 kΩ knob (potentiometer)", ids: ["potentiometer"], why: "a knob to set a level or speed", cannot: "the feel of the knob" },
  { key: "soil", match: /\bsoil|\bplants?\b|garden|watering|waterer/, label: "capacitive soil moisture sensor", ids: ["soil-moisture-capacitive", "capacitive-soil-moisture", "soil-moisture-sensor", "soil-moisture"], search: ["soil"], why: "tells how dry the soil is", behavior: "analog-sensor", standIn: "potentiometer", cannot: "real soil: moisture readings depend on the soil, the pot and calibration" },
  { key: "pump", match: /\bpump|water(s|ing)? (it|the plant)|waterer|irrigat/, label: "small 5 V water pump", ids: ["water-pump", "dc-pump", "mini-pump"], search: ["pump"], why: "moves water to the plant", behavior: "actuator", standIn: "led", with: ["relay"], cannot: "real water flow, leaks and the pump running dry" },
  { key: "relay", match: /\brelay|\bswitch (a|the) (lamp|fan|heater|mains)/, label: "5 V relay module", ids: ["relay-module", "relay"], search: ["relay"], why: "lets the small board switch a bigger load", behavior: "actuator", standIn: "led", cannot: "the relay's click, contact wear and the load's real current" },
  { key: "rover", match: /\brover|robot car|\bcar\b|\bdrives?\b|\bwheels?|follow[- ]me|robot dog|line follow/, label: "2WD robot chassis + two TT motors + L298N driver", ids: ["robot-chassis-2wd"], why: "a base with two driven wheels", with: ["motors", "driver"], cannot: "real traction, wheel slip and battery sag over a run" },
  { key: "motors", match: /^$/, label: "TT gear motor", ids: ["dc-motor"], why: "turns a wheel", qty: () => 2 },
  { key: "driver", match: /^$/, label: "L298N motor driver", ids: ["l298n"], why: "a GPIO cannot power a motor; the driver switches the battery current" },
  { key: "servo", match: /\bservo|\barm\b|gripper|\bclaw|\bwave|\bflag|door lock|\bpoint(er|s)?\b/, label: "SG90 micro servo", ids: ["servo-sg90"], search: ["servo"], why: "moves to an exact angle", qty: (g) => countOf(g, /servos?/, /\barm\b/.test(g) ? 2 : 1), cannot: "real torque under load and servo jitter" },
  { key: "clock", match: /\bclock|time of day|alarm clock|calendar|schedule|every morning|at \d/, label: "DS3231 real-time clock", ids: ["ds3231-rtc"], search: ["rtc"], why: "keeps the real time, even when unplugged (coin cell)", cannot: "clock drift over weeks" },
  { key: "wifi", match: /wi-?fi|internet|online|\bai\b|\bchat|talks? back|answers?\b|\bcloud|\bapi\b|forecast|telegram|notification to (my|the) phone/, label: "ESP-01 Wi-Fi module", ids: ["esp01-wifi"], search: ["wifi"], why: "gets on Wi-Fi to ask an AI or the internet", cannot: "real Wi-Fi range and the real internet (the sandbox network answers instead)" },
  { key: "gps", match: /\bgps|location|where (it|i) (is|am)|tracker/, label: "GPS module (NEO-6M)", ids: ["gps-neo6m", "neo-6m-gps"], search: ["gps"], why: "knows where it is from satellites", behavior: "uart-device", cannot: "a real satellite fix (needs open sky) and position accuracy" },
  { key: "camera", match: /camera|\bphoto(graph)?s? of|video|face recogn|see (who|what)/, label: "camera module", ids: [], search: ["camera"], why: "takes pictures", cannot: "anything a camera sees: Jumper does not simulate cameras" },
  { key: "flight", match: /\bdrone|propeller|quadcopter|\bfly(ing)?\b|\besc\b/, label: "flight parts (brushless motors, ESCs, flight controller)", ids: [], why: "a drone needs fast brushless motors and a flight controller", cannot: "flight: Jumper does not simulate aerodynamics, propellers or brushless motors" },
  { key: "mic", match: /microphone|\bhears?\b|\bvoice\b|\blisten|clap/, label: "sound sensor (microphone module)", ids: ["sound-sensor", "microphone"], search: ["microphone"], why: "hears claps and noise levels (not words)", behavior: "analog-sensor", cannot: "real sound; speech recognition is far beyond these boards" },
  { key: "presence", match: /\bpir\b|someone (walks|comes|is)|people (walk|come)|presence|intruder|motion sensor|detects? (people|someone|movement)|when (someone|a person)/, label: "PIR motion sensor (HC-SR501)", ids: ["pir-motion"], search: ["pir"], why: "notices a person moving nearby (body heat)", behavior: "digital-input", cannot: "real detection range, sensitivity and false triggers from heat sources" },
  { key: "touch", match: /\btouch|\btap (it|on)|\bpet (it|him|her)\b|stroke/, label: "capacitive touch pad (TTP223)", ids: ["ttp223-touch"], search: ["touch"], why: "a pad that reacts to a finger, no moving parts", behavior: "digital-input", cannot: "real touch sensitivity through a case wall" },
  { key: "bump", match: /\bbump(ers?|s)?\b|collision|whisker|limit switch|end ?stop/, label: "lever micro switch (bump switch)", ids: ["bump-switch"], search: ["bump switch"], why: "tells the robot it touched something", qty: (g) => (/rover|robot|car/.test(g) ? 2 : 1), behavior: "digital-input", cannot: "real lever force and bounce" },
  { key: "ir", match: /line follow|\bcliff|table edge|\binfrared|\bir (sensor|obstacle)|close (by|range) obstacle/, label: "IR obstacle sensor (FC-51)", ids: ["ir-proximity"], search: ["infrared obstacle"], why: "sees a nearby obstacle or a dark line a few cm away", qty: (g) => (/line follow/.test(g) ? 2 : 1), behavior: "digital-input", cannot: "real IR reflectivity of colours and sunlight interference" },
  // round 7 voice: a device that talks plays text clips through a DFPlayer Mini and a speaker
  { key: "voice", match: /\btalk(s|ing)?\b|\bspeak(s|ing)?\b|\bspeaker\b|\bsays?\b|\bsaying\b|\bvoice\b|\bspeech\b|\bout loud\b/, label: "MP3 player DFPlayer Mini (microSD) + 8 Ω speaker", ids: ["dfplayer-mini"], search: ["dfplayer"], why: "says words out loud: each clip on its microSD card is a sentence (in Jumper the clips are text)", with: ["speaker", "resistor1k"], cannot: "the real voice and loudness: the simulator shows the words and the browser reads them aloud; the MP3s are made later (sd-card/make-clips.sh)" },
  { key: "vibration", match: /vibrat|haptic|\brumble/, label: "coin vibration motor", ids: ["vibration-motor"], search: ["vibration"], why: "buzzes silently in your hand", behavior: "actuator", standIn: "led", cannot: "how the vibration feels" },
];
const HELPERS: Record<string, Need> = {
  resistor: { key: "resistor", match: /^$/, label: "220 Ω resistor", ids: ["resistor"], why: "limits the LED current so it does not burn out" },
  resistor3: { key: "resistor3", match: /^$/, label: "220 Ω resistor", ids: ["resistor"], why: "one per colour, so each LED leg gets a safe current", qty: () => 3 },
  resistor10k: { key: "resistor10k", match: /^$/, label: "10 kΩ resistor", ids: ["resistor"], why: "forms a divider with the light sensor so the board can read it" },
  speaker: { key: "speaker", match: /^$/, label: "speaker 8 Ω 0.5 W (28 mm)", ids: ["speaker"], why: "the DFPlayer plays its clips through it (SPK_1 / SPK_2)" }, // round 7 voice
  resistor1k: { key: "resistor1k", match: /^$/, label: "1 kΩ resistor", ids: ["resistor"], why: "in series with the DFPlayer RX: less hiss and a safe 3.3 V input" }, // round 7 voice
};

/** Typical batteries (not catalog parts): figures are typical retail values, labelled as assumptions. */
const BATTERIES = {
  lipo1s: { name: "1S LiPo 3.7 V 500 mAh + USB charger board (TP4056)", capacity: 500, dims: { w: 34, h: 25, d: 6 }, mass: 11, price: 7.5, props: { preset: "custom", voltage: 4.2, internalResistance: 0.15 }, buy: "lipo 3.7v 500mah" },
  aa4: { name: "4 × AA battery holder (alkaline)", capacity: 2000, dims: { w: 62, h: 58, d: 16 }, mass: 110, price: 5, props: { preset: "4xAA" }, buy: "4xAA battery holder" },
  lipo2s: { name: "2S LiPo 7.4 V 1000 mAh", capacity: 1000, dims: { w: 70, h: 35, d: 15 }, mass: 60, price: 13, props: { preset: "2S-LiPo" }, buy: "2s lipo 1000mah" },
} as const;

const POCKET = { w: 110, h: 70, d: 30 };

function searchLinks(name: string): { vendor: string; url: string }[] {
  const q = encodeURIComponent(name);
  return [
    { vendor: "DigiKey", url: `https://www.digikey.com/en/products/result?keywords=${q}` },
    { vendor: "Adafruit", url: `https://www.adafruit.com/search?q=${q}` },
  ];
}

function words(d: PartDefinition): string {
  const s = d.spec;
  return [s.id, s.name, ...(s.tags ?? [])].join(" ").toLowerCase();
}

/** The part for a need: ids first (built-in or agent-made), then search phrases. */
function findPart(reg: PartRegistry, need: Need): PartDefinition | undefined {
  for (const id of need.ids) {
    const d = reg.get(id);
    if (d) return d;
  }
  const all = reg.list();
  for (const phrase of need.search ?? []) {
    const ws = phrase.toLowerCase().split(/\s+/);
    const hit = all.find((d) => d.spec.category !== "board" && ws.every((w) => words(d).includes(w)));
    if (hit) return hit;
  }
  return undefined;
}

/** Physical size: dimensions_mm, or the w × h from the part's footprint text (d unknown). */
function dims(spec: PartSpec): { w: number; h: number; d?: number; from: "data" | "footprint" } | undefined {
  if (spec.dimensions_mm) return { ...spec.dimensions_mm, from: "data" };
  const m = /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)(?:\s*[×x]\s*(\d+(?:\.\d+)?))?\s*mm/.exec(spec.footprint ?? "");
  if (!m) return undefined;
  return { w: Number(m[1]), h: Number(m[2]), ...(m[3] ? { d: Number(m[3]) } : {}), from: "footprint" };
}

/** Supply current: current_ma.typ, or a typical figure the part already declares in limits. */
function currentMa(spec: PartSpec): { ma: number; from: string } | undefined {
  if (spec.current_ma) return { ma: spec.current_ma.typ, from: "data" };
  const l = (spec.limits ?? {}) as Record<string, number | undefined>;
  const v = l.typicalCurrentmA ?? l.idleCurrentmA;
  if (typeof v === "number") return { ma: v, from: "limits" };
  if (spec.category === "passive") return { ma: 0, from: "passive" };
  return undefined;
}

const fidelityOf = (d: PartDefinition) => (d.fidelity.origin === "agent-made" ? "behavioral, unverified" : d.fidelity.level);
const round1 = (n: number) => Math.round(n * 10) / 10;

function chooseBoard(reg: PartRegistry, c: PlanConstraints, needs5v: string[], small: boolean): { def: PartDefinition; why: string } {
  const boards = reg.list().filter((d) => d.spec.category === "board" && d.spec.mcu);
  if (!boards.length) throw new Error("the catalog has no boards");
  if (c.board) {
    const d = reg.get(c.board);
    if (!d || d.spec.category !== "board") {
      throw new Error(`no board '${c.board}' in the catalog; boards are: ${boards.map((b) => b.spec.id).join(", ")}`);
    }
    return { def: d, why: `you asked for the ${d.spec.name}` };
  }
  const area = (d: PartDefinition) => {
    const x = dims(d.spec);
    return x ? x.w * x.h : Number.POSITIVE_INFINITY;
  };
  if (small) {
    const fits = boards.filter((b) => !needs5v.length || (b.spec.mcu?.vcc ?? 5) >= 4.5);
    const pool = fits.length ? fits : boards;
    const best = [...pool].sort((a, b) => area(a) - area(b) || a.spec.id.localeCompare(b.spec.id))[0]!;
    const x = dims(best.spec);
    return {
      def: best,
      why: `the smallest board Jumper simulates${x ? ` (${x.w} × ${x.h} mm)` : ""}${needs5v.length && (best.spec.mcu?.vcc ?? 5) >= 4.5 ? `, and it runs at 5 V like the ${needs5v.join(", ")}` : ""}, so it fits in a pocket`,
    };
  }
  const uno = reg.get("arduino-uno");
  if (uno) return { def: uno, why: "the classic beginner board: plugs into USB, 5 V like most hobby modules, and has the most examples and help online" };
  return { def: boards[0]!, why: "the first board in the catalog" };
}

/** The plan for a wish. Throws an Error with a readable message on a bad board constraint. */
export function planDevice(goal: string, constraints: PlanConstraints, reg: PartRegistry, opts: { createPartAvailable?: boolean } = {}): DevicePlan {
  const g = ` ${goal.toLowerCase().replace(/\s+/g, " ")} `;
  const c = constraints;
  const pocket = !!c.pocket || /pocket|keychain|key ?ring|wearable|wrist|smart ?watch|badge|tiny|small enough/.test(g);
  const portable = pocket || c.battery_hours !== undefined || /battery|portable|wireless|on the go|carry|outside|camping/.test(g);
  // Round 7: a shape the person names ("shaped like an egg") is a custom outline, never a preset
  const shapeWord = /\b(egg|heart|bean|star|cloud|ghost|cat|bear|frog|fish|leaf|teardrop|guitar pick|kidney|apple|pear|mushroom|shell|blob)\b/.exec(g)?.[1];
  const shapeWish = shapeWord && /sh\w*pe|like|look|form|case/.test(g) ? shapeWord : undefined;
  const sizeLimit = c.max_size_mm ?? (pocket ? POCKET : undefined);

  // Which needs the wish names.
  const matched = new Map<string, Need>();
  for (const n of NEEDS) if (n.match.source !== "^$" && n.match.test(g)) matched.set(n.key, n);
  if (matched.has("light-sensor") && !/\blights? up|\bleds?\b|lamp|glow|night ?light/.test(g)) matched.delete("led");
  for (const n of [...matched.values()]) if (n.unless?.some((k) => matched.has(k))) matched.delete(n.key);
  for (const n of [...matched.values()]) for (const w of n.with ?? []) {
    const extra = NEEDS.find((x) => x.key === w) ?? HELPERS[w];
    if (extra && !matched.has(w)) matched.set(w, extra);
  }
  const rover = matched.has("rover");

  const bom: BomLine[] = [];
  const cannot = new Set<string>(["how the printed case feels in the hand and how well it prints (design_case checks the geometry: wall, fit, button travel, USB access; not the print or the plastic)"]);
  const missing: string[] = [];
  const warnings: string[] = [];
  const needs5v: string[] = [];

  for (const n of matched.values()) {
    const qty = n.qty ? n.qty(g) : 1;
    const def = findPart(reg, n);
    if (n.cannot) cannot.add(n.cannot);
    if (def) {
      const s = def.spec;
      const cur = currentMa(s);
      const power = s.pins.filter((p) => p.type === "power");
      if (power.length && power.every((p) => (p.voltage?.min ?? 0) >= 4.5)) needs5v.push(s.name);
      const props = n.key === "resistor10k" ? { resistance: 10000 } : n.key === "resistor1k" ? { resistance: 1000 } : undefined; // round 7 voice: 1k
      bom.push({
        type: s.id,
        name: HELPERS[n.key] ? n.label : s.name,
        qty,
        why: n.why,
        source: def.fidelity.origin === "agent-made" ? "agent-made" : "simulated-exactly",
        fidelity: fidelityOf(def),
        ...(cur ? { current_ma: cur.ma } : {}),
        ...(s.price_usd !== undefined ? { price_usd: s.price_usd } : {}),
        buy_links: s.buy_links?.length ? s.buy_links : searchLinks(n.key === "resistor10k" ? "10k resistor" : s.name),
        ...(props ? { props } : {}),
        ...(cur && cur.from === "limits" ? { assumption: "current from the part's typical-current limit (no current_ma yet)" } : {}),
      });
      if (def.fidelity.origin === "agent-made") cannot.add(`${s.name} is agent-made: it behaves as the agent described it, unverified against the real part`);
      continue;
    }
    // Not in the catalog: an agent-made part when create_part can express it, else a stand-in, else nothing.
    if (n.behavior && opts.createPartAvailable) {
      bom.push({ type: null, name: n.label, qty, why: n.why, source: "agent-made", fidelity: "behavioral, unverified", make_with: `create_part with behavior {"kind": "${n.behavior}"} (agent-made: behavioral, unverified)`, buy_links: searchLinks(n.label) });
      cannot.add(`the ${n.label} will be agent-made: it behaves as described, unverified against the real part`);
    } else if (n.standIn && reg.get(n.standIn)) {
      const sd = reg.get(n.standIn)!;
      bom.push({ type: sd.spec.id, name: n.label, qty, why: `${n.why}. Jumper has no ${n.label}, so the ${sd.spec.name} stands in for it in the simulation`, source: "stand-in", fidelity: sd.fidelity.level, stand_in_for: n.label, buy_links: searchLinks(n.label) });
      cannot.add(`the ${n.label}: the ${sd.spec.name} stands in for it, so its real behaviour is not simulated`);
    } else {
      bom.push({ type: null, name: n.label, qty, why: n.why, source: "not-simulated", buy_links: searchLinks(n.label) });
    }
    missing.push(`${n.label}: no price, size or current figures (not a catalog part)`);
  }

  // Board.
  const small = pocket || (!!sizeLimit && sizeLimit.w * sizeLimit.h < 120 * 80);
  const { def: boardDef, why: boardWhy } = chooseBoard(reg, c, needs5v, small);
  const b = boardDef.spec;
  const bcur = currentMa(b);
  bom.unshift({
    type: b.id,
    name: b.name,
    qty: 1,
    why: boardWhy,
    source: "simulated-exactly",
    fidelity: fidelityOf(boardDef),
    ...(bcur ? { current_ma: bcur.ma } : {}),
    ...(b.price_usd !== undefined ? { price_usd: b.price_usd } : {}),
    buy_links: b.buy_links?.length ? b.buy_links : searchLinks(b.name),
  });
  const vcc = b.mcu?.vcc ?? 5;
  if (vcc < 4.5 && needs5v.length) warnings.push(`${needs5v.join(", ")} need${needs5v.length > 1 ? "" : "s"} 5 V, but the ${b.name} runs at ${vcc} V: power ${needs5v.length > 1 ? "them" : "it"} from 5 V (VBUS / VSYS) and put a level shifter or divider on signals going back into the board`);

  // Battery.
  let battery: DevicePlan["battery"];
  if (portable || rover) {
    const kind = rover ? BATTERIES.lipo2s : pocket ? BATTERIES.lipo1s : BATTERIES.aa4;
    const pack = reg.get("battery-pack");
    const cell = kind === BATTERIES.lipo1s ? reg.get("lipo-battery") : undefined;
    const charger = cell ? reg.get("tp4056-charger") : undefined;
    if (cell) {
      // The catalog's own 1S LiPo and TP4056 charger (parts with physical data), simulated as themselves.
      bom.push({ type: cell.spec.id, name: `${cell.spec.name}, 500 mAh`, qty: 1, why: "a thin rechargeable cell fits a pocket", source: "simulated-exactly", fidelity: fidelityOf(cell), props: { capacity: 500 }, ...(cell.spec.price_usd !== undefined ? { price_usd: cell.spec.price_usd } : {}), buy_links: cell.spec.buy_links?.length ? cell.spec.buy_links : searchLinks(kind.buy) });
      if (charger) bom.push({ type: charger.spec.id, name: charger.spec.name, qty: 1, why: "charges the cell from USB and cuts it off before it runs flat", source: "simulated-exactly", fidelity: fidelityOf(charger), ...(charger.spec.price_usd !== undefined ? { price_usd: charger.spec.price_usd } : {}), buy_links: charger.spec.buy_links?.length ? charger.spec.buy_links : searchLinks(charger.spec.name) });
    } else bom.push({
      type: pack ? "battery-pack" : null,
      name: kind.name,
      qty: 1,
      why: rover ? "motors need more current than USB gives; the driver and board run from it" : pocket ? "a thin rechargeable cell fits a pocket" : "runs it away from USB",
      source: pack ? "simulated-exactly" : "not-simulated",
      ...(pack ? { fidelity: fidelityOf(pack), props: { ...kind.props } } : {}),
      price_usd: kind.price,
      buy_links: searchLinks(kind.buy),
      assumption: `typical ${kind.capacity} mAh, ${kind.dims.w} × ${kind.dims.h} × ${kind.dims.d} mm, $${kind.price} (not a catalog part figure)`,
    });
    // round 6 power: the real power path, with catalog parts (decision 0004, R2).
    const takesCell = b.pins.find((p) => p.type === "power" && !/^3V3|GND/i.test(p.id) && p.voltage && p.voltage.min <= 3.0 && p.voltage.max >= 4.2);
    const blim = (b.limits ?? {}) as Record<string, number | undefined>;
    const usbPin = b.pins.find((p) => p.type === "power" && /^(VBUS|5V)$/i.test(p.id));
    const viaDiode = !takesCell && vcc < 4.5 && !!usbPin && (blim.vbusInMinV ?? 99) <= 3.6;
    const line = (type: string, why: string, qty = 1) => {
      const d = reg.get(type);
      if (!d) return;
      const cur = currentMa(d.spec);
      bom.push({ type, name: d.spec.name, qty, why, source: "simulated-exactly", fidelity: fidelityOf(d), ...(cur ? { current_ma: cur.ma } : {}), ...(d.spec.price_usd !== undefined ? { price_usd: d.spec.price_usd } : {}), buy_links: d.spec.buy_links?.length ? d.spec.buy_links : searchLinks(d.spec.name) });
    };
    if (kind === BATTERIES.lipo1s) line("slide-switch", "turns the device off without unplugging the battery");
    if (kind === BATTERIES.lipo1s && takesCell) warnings.push(`wire the cell through the charger's OUT and the switch to ${b.name} ${takesCell.label ?? takesCell.id}: it takes ${takesCell.voltage!.min} to ${takesCell.voltage!.max} V and has its own diode, so a 1S LiPo needs no boost converter`);
    if (kind === BATTERIES.lipo1s && viaDiode) {
      line("schottky-diode", `stops USB on the ${b.name} from pushing current back into the battery (a 1N5817 between the switch and the board's ${usbPin!.label ?? usbPin!.id} pad)`);
      const drop = blim.ldoDropoutV ?? 0.25;
      warnings.push(`power path: cell → charger BAT, charger OUT → switch → Schottky diode → ${b.name} ${usbPin!.label ?? usbPin!.id} (the board has no BAT pad); test it with set_power {"usb": false}. Its 3.3 V regulator gives a full 3.3 V only while the cell is above about ${(3.3 + drop + 0.3).toFixed(2)} V and the board stops near ${((blim.min3v3V ?? 2.7) + drop + 0.3).toFixed(2)} V, so plan a low-battery shutdown`);
    }
    if (kind === BATTERIES.lipo1s && !takesCell && !viaDiode) {
      const in5 = b.pins.find((p) => p.type === "power" && p.voltage && p.voltage.min >= 4.5 && p.voltage.max <= 5.5);
      if (reg.get("boost-converter")) {
        line("boost-converter", `a 3.7 V cell is below the 5 V the ${b.name} needs on ${in5 ? (in5.label ?? in5.id) : "its supply pin"}; the boost raises it (about 88 % efficient)`);
        line("schottky-diode", `between the boost's OUT+ and the ${b.name}'s 5V, so USB on the board never back-feeds the boost`);
      } else {
        bom.push({ type: null, name: "5 V boost converter (MT3608 or similar)", qty: 1, why: `a 3.7 V cell is below the 5 V the ${b.name} needs on ${in5 ? (in5.label ?? in5.id) : "its supply pin"}; the boost raises it`, source: "not-simulated", price_usd: 2, buy_links: searchLinks("mt3608 boost converter"), assumption: "typical $2, 22 × 17 mm (not a catalog part)" });
      }
      cannot.add("the boost converter's switching noise on the 5 V rail (its efficiency is modelled as a fixed 88 %)");
    }
    let avg = 0;
    const noCurrent: string[] = [];
    for (const l of bom) {
      if (l.type === "battery-pack" || l.type === "lipo-battery" || l.type === "tp4056-charger" || l.type === "boost-converter" || l.type === "schottky-diode" || l.type === "slide-switch" || (l.type === null && l.source === "not-simulated" && /boost/.test(l.name))) continue;
      if (l.current_ma === undefined) {
        noCurrent.push(l.name);
        continue;
      }
      // Motors and servos only draw while moving; count them at a quarter duty.
      const duty = l.type && ["dc-motor", "servo-sg90"].includes(l.type) ? 0.25 : 1;
      avg += l.current_ma * l.qty * duty;
    }
    // round 6 power: a boost from a 3.7 V cell to 5 V takes 5 / 3.7 / 0.88 ≈ 1.5 × the load's current from the cell.
    if (bom.some((l) => l.type === "boost-converter")) avg = avg * (5 / 3.7 / 0.88);
    const usable = kind.capacity * 0.8;
    const hours = avg > 0 ? round1(usable / avg) : 0;
    battery = {
      type: kind.name,
      capacity_mah: kind.capacity,
      avg_ma: round1(avg),
      hours,
      note: `80 % of ${kind.capacity} mAh at an average ${round1(avg)} mA, everything on all the time${rover ? " (motors and servos at a quarter of the time)" : ""}; sleep modes would stretch it.${noCurrent.length ? ` Not counted (no current figure): ${noCurrent.join(", ")}, so the real time is shorter.` : ""}`,
    };
    if (noCurrent.length) missing.push(`current draw: ${noCurrent.join(", ")}`);
    if (c.battery_hours !== undefined && hours < c.battery_hours && avg > 0) {
      const need = Math.ceil((c.battery_hours * avg) / 0.8 / 100) * 100;
      warnings.push(`it would last about ${hours} h, short of the ${c.battery_hours} h you want: use about ${need} mAh, or let the firmware sleep between updates`);
    }
    cannot.add("real battery life: sleep currents, regulator losses and battery ageing are not simulated");
  }

  // Size: sum of footprints packed with 25 % air, thickness of the tallest part, battery under the board.
  let area = 0;
  let maxW = 0;
  let maxD = 0;
  const noSize: string[] = [];
  let batteryD = 0;
  for (const l of bom) {
    if (l.type === "lipo-battery") {
      const x = reg.get("lipo-battery") ? dims(reg.get("lipo-battery")!.spec) : undefined;
      batteryD = Math.max(batteryD, x?.d ?? BATTERIES.lipo1s.dims.d);
      continue;
    }
    if (l.type === "battery-pack" || (!l.type && l.assumption)) {
      const kind = Object.values(BATTERIES).find((k) => k.name === l.name);
      if (kind) batteryD = Math.max(batteryD, kind.dims.d);
      continue;
    }
    if (l.type === "robot-chassis-2wd") continue;
    const def = l.type ? reg.get(l.type) : undefined;
    const x = def ? dims(def.spec) : undefined;
    if (!x || l.source === "stand-in" || l.source === "not-simulated" || (l.source === "agent-made" && !l.type)) {
      noSize.push(l.name);
      continue;
    }
    area += x.w * x.h * l.qty;
    maxW = Math.max(maxW, x.w);
    if (x.d !== undefined) maxD = Math.max(maxD, x.d);
    else if (def?.spec.category !== "passive") noSize.push(`${l.name} (thickness)`);
  }
  const packed = area * 1.25;
  const pw = Math.max(maxW, Math.ceil(Math.sqrt(packed)));
  const ph = pw ? Math.ceil(packed / pw) : 0;
  const partsBox = { w: Math.round(pw), h: Math.round(ph), d: Math.round(maxD || 0) };
  const chassis = bom.find((l) => l.type === "robot-chassis-2wd");
  const chassisDims = chassis ? dims(reg.get("robot-chassis-2wd")!.spec) : undefined;
  const enclosure = chassisDims ? { w: Math.round(chassisDims.w), h: Math.round(chassisDims.h), d: Math.round((maxD || 20) + 40) } : { w: partsBox.w + 10, h: partsBox.h + 10, d: partsBox.d + batteryD + 8 };
  if (noSize.length) missing.push(`size: ${noSize.join(", ")}`);
  const sizeNote = `${chassisDims ? "the robot chassis is the case" : "parts side by side with 25 % room for wires, a 2 mm wall and 3 mm clearance around"}${batteryD ? ", battery stacked under the board" : ""}; rough, a real layout can be smaller with a custom board${noSize.length ? `; not counted: ${noSize.join(", ")}` : ""}`;
  if (sizeLimit && (enclosure.w > sizeLimit.w || enclosure.h > sizeLimit.h || enclosure.d > sizeLimit.d)) {
    const big = bom.filter((l) => l.type && reg.get(l.type) && (dims(reg.get(l.type)!.spec)?.w ?? 0) > sizeLimit.w * 0.6).map((l) => l.name);
    warnings.push(`the case comes out about ${enclosure.w} × ${enclosure.h} × ${enclosure.d} mm, bigger than ${pocket && !c.max_size_mm ? "a pocket" : "your limit"} (${sizeLimit.w} × ${sizeLimit.h} × ${sizeLimit.d} mm)${big.length ? `; the largest parts are ${big.join(", ")}` : ""}${c.board ? "" : ""}`);
  }

  // Price.
  let total = 0;
  const noPrice: string[] = [];
  for (const l of bom) {
    if (l.price_usd === undefined) noPrice.push(l.name);
    else total += l.price_usd * l.qty;
  }
  total = Math.round(total * 100) / 100;
  if (noPrice.length) missing.push(`price: ${noPrice.join(", ")}`);
  if (c.budget_usd !== undefined && total > c.budget_usd) warnings.push(`the parts come to about $${total}, over your $${c.budget_usd} budget${noPrice.length ? " (and some prices are unknown)" : ""}`);

  for (const l of bom) if (l.source === "not-simulated" && !/boost/.test(l.name)) cannot.add(`the ${l.name}: Jumper does not simulate it`);
  if (bom.some((l) => l.type === "esp01-wifi") && vcc >= 4.5) warnings.push("the ESP-01 is a 3.3 V part: its RX needs a 1k/2k divider from the 5 V board, and it needs a 3.3 V supply that gives 300 mA peaks (the board's 3V3 pin gives 50 mA)");

  // One clarifying question when the wish leaves a real choice open.
  let question: string | undefined;
  const parts = [...matched.keys()].filter((k) => !HELPERS[k] && !["motors", "driver"].includes(k));
  if (!parts.length) question = "What should it do: show something on a screen, make sounds, light up, sense something (temperature, distance, light), or move?";
  else if (/talks? back|answers? (me|what)|understand|hear (me|what)|conversation|chat with/.test(g) && !/type|screen|display|text/.test(g)) question = "Should it answer with words on a little screen (it needs Wi-Fi to ask an AI, and you type or pick what to say), or just react with faces and sounds? Boards this small cannot understand spoken words.";
  else if (matched.has("soil") && !matched.has("pump")) question = "Should it only tell you when the plant is thirsty, or also water it with a small pump?";
  else if ((matched.has("display") || matched.has("color-display")) && /\bpet\b|tamagotchi/.test(g) && !portable && !/usb|plug/.test(g)) question = "Will it stay plugged into USB on a desk, or should it run on a battery in your pocket?";

  const simulated = bom.filter((l) => l.source === "simulated-exactly").length;
  const others = bom.filter((l) => l.source !== "simulated-exactly");
  const listed = bom.slice(1).filter((l) => !/resistor|boost|schottky|slide switch/i.test(l.name)).map((l) => `${l.qty > 1 ? `${l.qty} ` : ""}${l.name.replace(/ \(.*\)$/, "")}`);
  const summary = [
    `${goal.trim().replace(/\.$/, "")}: ${b.name}${listed.length ? ` with ${listed.join(", ")}` : ""}.`,
    `About ${enclosure.w} × ${enclosure.h} × ${enclosure.d} mm in a case${battery && battery.hours ? `, about ${battery.hours} h per charge` : ""}, ${total > 0 ? `parts about $${total}${noPrice.length ? ` plus ${noPrice.length} unpriced line${noPrice.length > 1 ? "s" : ""}` : ""}` : "price not known yet (the parts have no price data)"}.`,
    `${simulated} of ${bom.length} lines are parts Jumper simulates as themselves${others.length ? `; ${others.map((l) => `${l.name} (${l.source})`).join(", ")}` : ""}.`,
  ].join(" ");

  const next = [
    "Tell the person this plan in plain words (no part numbers unless they ask) and wait for a yes" + (question ? ", after asking the question" : ""),
    'new_project {"folder": true, "name": "<short name>", "template": "blank"} so the idea gets its own project',
    ...(others.some((l) => l.make_with) ? ["create_part for the agent-made lines before placing them"] : []),
    ...(others.some((l) => l.source === "stand-in") ? ["after placing a stand-in, mark_stand_in {id, real} so exports name the real part"] : []),
    "place_part each line (omit x/y), connect, check_design, write_file, run, write_scenario, run_tests",
    // Round 6: the flow ends with a real device when the person wants one.
    ...(rover
      ? ["when the person wants to build it for real: export_manufacturing (factory pack: BOM, wiring, wire cuts, firmware, assembly steps; the chassis is the case)"]
      : [
          `when the person wants to build it for real: ${portable ? 'set_assembly "soldered", ' : ""}design_case {"shape": "${shapeWish ? "custom" : pocket ? "pebble" : "rounded-box"}"${shapeWish ? `, "outline": <the ${shapeWish} drawn as an SVG path in mm or {"points": [...], "smooth": true}>` : ""}} (${shapeWish ? `there is no "${shapeWish}" preset: draw it; check_fit first, under a second, says what fits and suggests smaller parts when it does not` : "any other shape is custom with an outline you draw; try a variant with save: false: puck, pill, keychain, rounded-box"}), show the renders and the measured size, then export_manufacturing (factory pack: STL / 3MF / STEP for a printer or a factory, BOM, wiring, wire cuts, firmware, assembly steps)`,
        ]),
  ];

  return {
    summary,
    ...(question ? { question } : {}),
    board: { type: b.id, name: b.name, why: boardWhy },
    bom,
    size_mm: { parts: partsBox, enclosure, note: sizeNote },
    ...(battery ? { battery } : {}),
    total_usd: total,
    cannot_check: [...cannot],
    warnings,
    missing_data: missing,
    next,
  };
}
