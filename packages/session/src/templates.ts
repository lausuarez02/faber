import type { ProjectInput } from "@jumper/project-format";

/** Starting points for new_project. Each is a jumper.json plus firmware files. */
export interface Template {
  description: string;
  /** Part types it needs (checked against the catalog). */
  needs: string[];
  project: (name: string) => ProjectInput;
  files: Record<string, string>;
}

const BLINK_INO = `// Blink: D13 drives an LED through 220 ohm, 1 s on / 1 s off, and says so on serial.
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  Serial.println("LED on");
  delay(1000);
  digitalWrite(13, LOW);
  Serial.println("LED off");
  delay(1000);
}
`;

const EMPTY_INO = `void setup() {
  Serial.begin(115200);
  Serial.println("ready");
}

void loop() {
}
`;

export const TEMPLATES: Record<string, Template> = {
  blank: {
    description: "Empty canvas, no parts, no firmware.",
    needs: [],
    project: (name) => ({ format: "jumper/1", name, parts: [], wires: [], scenarios: [] }),
    files: {},
  },
  uno: {
    description: "An Arduino Uno and an empty sketch (firmware/main.ino) that prints 'ready'.",
    needs: ["arduino-uno"],
    project: (name) => ({
      format: "jumper/1",
      name,
      parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }],
      wires: [],
      firmware: { board: "uno", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" } },
      scenarios: [{ id: "boots", name: "Firmware boots", steps: [{ expect_serial: "ready", within_ms: 500 }] }],
    }),
    files: { "firmware/main.ino": EMPTY_INO },
  },
  nano: {
    description: "An Arduino Nano and an empty sketch (firmware/main.ino).",
    needs: ["arduino-nano"],
    project: (name) => ({
      format: "jumper/1",
      name,
      parts: [{ id: "nano", type: "arduino-nano", x: 0, y: 0 }],
      wires: [],
      firmware: { board: "nano", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:nano" } },
      scenarios: [{ id: "boots", name: "Firmware boots", steps: [{ expect_serial: "ready", within_ms: 500 }] }],
    }),
    files: { "firmware/main.ino": EMPTY_INO },
  },
  blink: {
    description: "Uno + 220 Ω + red LED on D13, the Blink sketch and two passing scenarios.",
    needs: ["arduino-uno", "resistor", "led"],
    project: (name) => ({
      format: "jumper/1",
      name,
      description: "D13 drives a red LED through 220 Ω, 1 s on / 1 s off.",
      parts: [
        { id: "uno", type: "arduino-uno", x: 0, y: 0 },
        { id: "r1", type: "resistor", x: 300, y: -130, props: { resistance: 220 } as Record<string, number> },
        { id: "led1", type: "led", x: 440, y: -210, props: { color: "red" } as Record<string, string> },
      ],
      wires: [
        { id: "w1", from: { part: "uno", pin: "D13" }, to: { part: "r1", pin: "1" }, color: "#FF4D2E" },
        { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" }, color: "#FF4D2E" },
        { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "uno", pin: "GND.1" }, color: "#2B3038" },
      ],
      firmware: { board: "uno", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.hex", build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" } },
      scenarios: [
        { id: "blinks", name: "LED turns on and off", steps: [{ expect_serial: "LED on", within_ms: 1100 }, { expect_pin: "uno.D13", level: "high" }, { expect_part: "led1.on", op: "==", value: true }, { expect_serial: "LED off", within_ms: 1100 }, { expect_pin: "uno.D13", level: "low" }] },
        { id: "safe", name: "No part is overloaded", steps: [{ run_ms: 2500 }, { expect_no_errors: true }] },
      ],
    }),
    files: { "firmware/main.ino": BLINK_INO },
  },
};

/** Every starter sketch a template writes, to tell "still the template" from firmware someone wrote. */
export const TEMPLATE_SOURCES: ReadonlySet<string> = new Set(Object.values(TEMPLATES).flatMap((t) => Object.values(t.files).map((f) => f.trim())));
