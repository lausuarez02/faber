import type { Usage } from "./hints.ts";

/**
 * Round 5, track "parts" (owner): get_part usage hints for the new parts (gc9a01-round-tft,
 * lipo-battery, tp4056-charger, passive-buzzer, vibration-motor, ttp223-touch,
 * capacitive-soil-moisture, relay-module, water-pump, ir-proximity, bump-switch, dht22, pir-motion,
 * ws2812-strip). Merged over the core table in hints.ts. Decision 0003, C7.
 *
 * `connect` lines use the id place_part gives the first copy of a part (the type without dashes
 * + "1", e.g. "relaymodule1"), so typical_connections can rewrite them to the real ids and free
 * pins. Parts with an example.ino in their folder (dht22, passive-buzzer, ws2812-strip,
 * gc9a01-round-tft, water-pump) get that sketch as the example; it is built and tested on a simulated Uno.
 */
export const PARTS_R5_HINTS: Record<string, Usage> = {
  // Overrides the core hint, which said tone() works: an active buzzer has its own oscillator.
  buzzer: {
    wiring: "Active buzzer: POS to a GPIO, NEG to GND. digitalWrite HIGH beeps at its own ~2.3 kHz; tone() does NOT set its pitch (use passive-buzzer for notes and melodies).",
    connect: ["buzzer1.POS -> uno.D8", "buzzer1.NEG -> uno.GND"],
    example: `void setup() { pinMode(8, OUTPUT); }\nvoid loop() { digitalWrite(8, HIGH); delay(100); digitalWrite(8, LOW); delay(900); }`,
  },
  "passive-buzzer": {
    wiring: "POS to any GPIO, NEG to GND. Play notes with tone(pin, hz) and stop with noTone(pin); digitalWrite only clicks. A 100 Ω series resistor makes it quieter and gentler on the pin.",
    connect: ["passivebuzzer1.POS -> uno.D8", "passivebuzzer1.NEG -> uno.GND"],
    controls: 'State: frequency (Hz now, 0 = silent), note ("A4"), lastFrequency, tones (count), melody (last 24 notes, e.g. "C4 E4 G4"). In scenarios: {"expect_part": "passivebuzzer1.note", "value": "A4"} while it plays, or melody at the end.',
  },
  "gc9a01-round-tft": {
    wiring: "VCC → 5V (or 3V3), GND → GND, SCL → D13 (SPI SCK), SDA → D11 (SPI MOSI, not I2C), RES → D8, DC → D9, CS → D10, BLK → 5V (or a PWM pin to dim). 240 x 240, but only the inscribed circle is visible: keep drawings within 120 px of the centre (120, 120).",
    connect: ["gc9a01roundtft1.VCC -> uno.5V", "gc9a01roundtft1.GND -> uno.GND", "gc9a01roundtft1.SCK -> uno.D13", "gc9a01roundtft1.MOSI -> uno.D11", "gc9a01roundtft1.RST -> uno.D8", "gc9a01roundtft1.DC -> uno.D9", "gc9a01roundtft1.CS -> uno.D10", "gc9a01roundtft1.LED -> uno.5V"],
    libraries: ["Adafruit GFX Library (Adafruit_SPITFT)"],
    controls: "read_display(part) / expect_display read the round screen (the corners are always dark); screenshot shows the colours. Adafruit_GC9A01A works as is (firmware.libraries ["Adafruit GC9A01A"]: Adafruit_GC9A01A tft(CS, DC, RST); tft.begin();); TFT_eSPI works on RP2040 boards with a tft_setup.h next to the sketch (#define GC9A01_DRIVER, TFT_MOSI, TFT_SCLK, TFT_CS, TFT_DC, TFT_RST). The example's small GC9A01 class needs no library.", // round 6 frames: libs3
  },
  "lipo-battery": {
    wiring: "1S LiPo, 3.0–4.2 V. Usual pocket setup: LiPo + → tp4056 BAT (B+), − → tp4056 GND.2 (B−); tp4056 OUT → the board's battery input (VSYS on a Pico, BAT on a XIAO), GND.3 → GND. Never on a 5 V pin, and not on an Uno's VIN (it needs 7 V): a 5 V board needs a boost converter.",
    connect: ["lipobattery1.POS -> tp4056charger1.BAT", "lipobattery1.NEG -> tp4056charger1.GND.2"],
    example: `// Battery level through a 100 kΩ + 100 kΩ divider (battery + → 100k → A0 → 100k → GND).\nconst float VREF = 5.0;  // 3.3 on a 3.3 V board\nvoid setup() { Serial.begin(115200); }\nvoid loop() {\n  float v = analogRead(A0) * VREF / 1023.0 * 2;\n  Serial.print("battery="); Serial.println(v, 2);\n  if (v < 3.3) Serial.println("low battery: shutting down");\n  delay(1000);\n}`,
    controls: 'Props: capacity (mAh), soc (% at start), speedup (×N drain, for tests). State: volts, soc, currentmA, usedmAh, charging, cutoff. In scenarios: {"set": "lipobattery1.soc", "value": 10}, then expect the low-battery behaviour.',
  },
  "tp4056-charger": {
    wiring: "BAT (B+) / GND.2 (B−) to the LiPo, OUT (OUT+) / GND.3 (OUT−) to the device. USB plugs into its socket (press the part, or prop usb = true), or 5 V into VIN / GND.1. Set chargeCurrentmA to the cell's capacity or less (1C): the 1000 mA it is sold with is too much for a 500 mAh pocket cell.",
    connect: ["tp4056charger1.BAT -> lipobattery1.POS", "tp4056charger1.GND.2 -> lipobattery1.NEG"],
    example: `// Battery level through a 100 kΩ + 100 kΩ divider (battery + → 100k → A0 → 100k → GND).\nconst float VREF = 5.0;  // 3.3 on a 3.3 V board\nvoid setup() { Serial.begin(115200); }\nvoid loop() {\n  float v = analogRead(A0) * VREF / 1023.0 * 2;\n  Serial.print("battery="); Serial.println(v, 2);\n  if (v < 3.3) Serial.println("low battery: shutting down");\n  delay(1000);\n}`,
    controls: 'interact(part, "press") plugs / unplugs USB. State: mode ("off", "trickle", "CC", "CV", "full"), charging, full, chargemA, protected.',
  },
  "vibration-motor": {
    wiring: "Module with its own transistor: VCC → 3V3 or 5V, GND → GND, IN → any GPIO (digitalWrite on/off, analogWrite on a PWM pin for strength). A bare coin motor (60–90 mA) must never go straight on a pin.",
    connect: ["vibrationmotor1.VCC -> uno.5V", "vibrationmotor1.GND -> uno.GND", "vibrationmotor1.IN -> uno.D5"],
    example: `void setup() { pinMode(5, OUTPUT); }\nvoid loop() {\n  analogWrite(5, 200); delay(150);  // buzz\n  analogWrite(5, 0); delay(850);\n}`,
    controls: "State: running, strength (0..1 of the rated speed), rpm, currentmA.",
  },
  "ttp223-touch": {
    wiring: "VCC → 3V3 or 5V, GND → GND, IO → a digital pin. The output is push-pull: no pull-up, just pinMode(pin, INPUT); HIGH while touched (as sold).",
    connect: ["ttp223touch1.VCC -> uno.5V", "ttp223touch1.GND -> uno.GND", "ttp223touch1.IO -> uno.D2"],
    example: `void setup() { pinMode(2, INPUT); Serial.begin(115200); }\nvoid loop() {\n  static int last = LOW;\n  int now = digitalRead(2);\n  if (now == HIGH && last == LOW) Serial.println("touched");\n  last = now;\n  delay(10);\n}`,
    controls: 'interact(part, "press") / "release" is a finger; in scenarios {"press": "ttp223touch1", "hold_ms": 100}. Props output (active-high / low) and mode (momentary / toggle) are the A / B jumpers.',
  },
  "capacitive-soil-moisture": {
    wiring: "VCC → 3V3 or 5V, GND → GND, AOUT → an analog pin (A0). The reading FALLS as the soil gets wetter: ~590 dry, ~255 in water on a 5 V Uno. Map it with your own dry / wet calibration.",
    connect: ["capacitivesoilmoisture1.VCC -> uno.5V", "capacitivesoilmoisture1.GND -> uno.GND", "capacitivesoilmoisture1.AOUT -> uno.A0"],
    example: `const int DRY = 590, WET = 255;  // calibrate: probe in air, probe in water\nvoid setup() { Serial.begin(115200); }\nvoid loop() {\n  int raw = analogRead(A0);\n  int pct = constrain(map(raw, DRY, WET, 0, 100), 0, 100);\n  Serial.print("moisture="); Serial.println(pct);\n  delay(1000);\n}`,
    controls: 'set_sensor_value(part, "moisture", 0..100) (%); in scenarios {"set": "capacitivesoilmoisture1.moisture", "value": 15}.',
  },
  "relay-module": {
    wiring: "Control: VCC → 5V (not 3.3 V: the coil needs ≥ 3.75 V), GND → GND, IN → a GPIO. Load: the load supply's + → COM, NO → load +, load − → supply −. Active-LOW as sold: digitalWrite(pin, LOW) turns it on; write HIGH before pinMode(OUTPUT) so it does not click at boot. Put a diode across a pump or motor load.",
    connect: ["relaymodule1.VCC -> uno.5V", "relaymodule1.GND -> uno.GND", "relaymodule1.IN -> uno.D7"],
    example: `const int RELAY = 7;  // active LOW module\nvoid setup() { digitalWrite(RELAY, HIGH); pinMode(RELAY, OUTPUT); }\nvoid loop() {\n  digitalWrite(RELAY, LOW);  delay(2000);  // on\n  digitalWrite(RELAY, HIGH); delay(5000);  // off\n}`,
    controls: "State: energized, contact (NO / NC), loadmA, clicks. Prop trigger: low (default) or high.",
  },
  "water-pump": {
    wiring: "Never on a GPIO (it draws ~180 mA, more when starting). Switch it with a relay module: 5V → relay COM, relay NO → pump POS, pump NEG → GND; or from a motor driver output (L298N OUT1/OUT2) for speed control.",
    connect: ["waterpump1.POS -> relaymodule1.NO", "waterpump1.NEG -> uno.GND", "relaymodule1.COM -> uno.5V"],
    controls: 'State: running, flowLph, pumpedMl (water pumped since reset), currentmA. A watering test: {"expect_part": "waterpump1.pumpedMl", "op": ">", "value": 50}.',
  },
  "ir-proximity": {
    wiring: "VCC → 3V3 or 5V, GND → GND, OUT → a digital pin (it has its own pull-up): LOW = obstacle closer than the knob's distance (prop threshold, 2–30 cm).",
    connect: ["irproximity1.VCC -> uno.5V", "irproximity1.GND -> uno.GND", "irproximity1.OUT -> uno.D4"],
    example: `void setup() { pinMode(4, INPUT); Serial.begin(115200); }\nvoid loop() {\n  if (digitalRead(4) == LOW) Serial.println("obstacle");\n  delay(50);\n}`,
    controls: 'set_sensor_value(part, "distance", cm) (0 = nothing) or interact press / release. On a robot with a world the physics sets the distance on the side named by prop mount.',
  },
  "bump-switch": {
    wiring: "COM → GND, NO → a digital pin with pinMode(pin, INPUT_PULLUP): reads LOW while bumped. NC is the opposite contact (closed while free).",
    connect: ["bumpswitch1.COM -> uno.GND", "bumpswitch1.NO -> uno.D3"],
    example: `void setup() { pinMode(3, INPUT_PULLUP); Serial.begin(115200); }\nvoid loop() {\n  if (digitalRead(3) == LOW) { Serial.println("bump!"); delay(200); }\n}`,
    controls: 'interact(part, "press") / "release"; on a robot with a world the physics presses it on contact on the side named by prop mount.',
  },
  dht22: {
    wiring: "+ (VCC) → 3V3 or 5V, − → GND, OUT (DATA) → a digital pin. The module has its 10 kΩ pull-up. Wait 1 s after power-up and read at most every 2 s; each read returns the measurement taken at the previous read.",
    connect: ["dht221.VCC -> uno.5V", "dht221.GND -> uno.GND", "dht221.DATA -> uno.D2"],
    controls: 'set_sensor_value(part, "temperature", °C) / (part, "humidity", %). The DHT sensor library works (firmware.libraries ["DHT sensor library"]: DHT dht(PIN, DHT22); dht.begin(); dht.readTemperature();); the example reads it without a library.', // round 6 frames: libs3
  },
  "pir-motion": {
    wiring: "VCC → 5V (4.5–20 V; not 3.3 V), GND → GND, OUT → a digital pin: HIGH (3.3 V) for delay_s after motion, safe for 3.3 V and 5 V boards.",
    connect: ["pirmotion1.VCC -> uno.5V", "pirmotion1.GND -> uno.GND", "pirmotion1.OUT -> uno.D2"],
    example: `void setup() { pinMode(2, INPUT); Serial.begin(115200); }\nvoid loop() {\n  static int last = LOW;\n  int now = digitalRead(2);\n  if (now != last) Serial.println(now == HIGH ? "motion" : "quiet");\n  last = now;\n  delay(20);\n}`,
    controls: 'interact(part, "press") = someone moves, "release" = they stop; set_sensor_value(part, "motion", 1 | 0). Props delay_s (hold time), retrigger (repeat / single), warmup_s.',
  },
  "ws2812-strip": {
    wiring: "5V (VCC) → 5V, GND → GND, DIN → a digital pin (330 Ω in series is good practice). Set prop count to the number of LEDs (1–16). Full white is 60 mA per LED: more than ~8 bright LEDs need their own 5 V supply with a shared GND.",
    connect: ["ws2812strip1.VCC -> uno.5V", "ws2812strip1.GND -> uno.GND", "ws2812strip1.DIN -> uno.D6"],
    controls: 'State: colors ("#FF0000 #00FF00 …" per LED), lit, frames, currentmA, led0..led15. FastLED (MIT) and Adafruit NeoPixel (LGPL-3.0: shipping a firmware that links it carries LGPL duties) both work, on AVR and on RP2040 (PIO); the example bit-bangs the 800 kHz signal itself. interact set key "colors" paints the LEDs without firmware.', // round 6 frames: libs3
  },
};
