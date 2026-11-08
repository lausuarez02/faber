import { parseProject, safeParseProject, type Project } from "@jumper/project-format";

// Globs are tolerant: a file that does not exist yet just is not in the map.
const projectFiles = import.meta.glob("../../../../examples/*/jumper.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const hexFiles = import.meta.glob(["../../../../examples/*/firmware/**/*.hex", "!**/*with_bootloader*"], {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const EXAMPLES_PREFIX = "../../../../examples/";

/** The Blink example built in code, used when examples/blink/jumper.json is not there yet. */
export function blinkFallback(): Project {
  return parseProject({
    format: "jumper/1",
    name: "Blink",
    description: "Arduino Uno blinking a red LED on D13 through 220 Ω.",
    parts: [
      { id: "uno", type: "arduino-uno", x: 0, y: 0 },
      { id: "r1", type: "resistor", x: 300, y: -130, props: { resistance: 220 } },
      { id: "led1", type: "led", x: 440, y: -210, props: { color: "red" } },
    ],
    wires: [
      { id: "w1", from: { part: "uno", pin: "D13" }, to: { part: "r1", pin: "1" }, color: "#FF4D2E" },
      { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" }, color: "#FFB23F" },
      { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "uno", pin: "GND.1" }, color: "#2B3038" },
    ],
    firmware: {
      board: "uno",
      dir: "firmware",
      sketch: "blink/blink.ino",
      artifact: "firmware/blink.hex",
      build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" },
    },
  });
}

export interface ExampleProject {
  project: Project;
  /** "blink" for examples/blink. */
  example: string;
  source: "file" | "built-in";
  issues?: string[];
}

export function loadBlinkExample(): ExampleProject {
  const raw = projectFiles[`${EXAMPLES_PREFIX}blink/jumper.json`];
  if (raw !== undefined) {
    const res = safeParseProject(raw);
    if (res.ok) return { project: res.project, example: "blink", source: "file" };
    return {
      project: blinkFallback(),
      example: "blink",
      source: "built-in",
      issues: res.issues.map((i) => `${i.path || "(root)"}: ${i.message}`),
    };
  }
  return { project: blinkFallback(), example: "blink", source: "built-in" };
}

export interface FirmwareFile {
  hex: string;
  name: string;
}

/**
 * Finds the built firmware for an example: the project's `firmware.artifact` first, then
 * the arduino-cli build output (`firmware/build/<sketch>.hex`), then any .hex in the example.
 */
export async function loadExampleFirmware(example: string, project: Project): Promise<FirmwareFile | undefined> {
  const base = `${EXAMPLES_PREFIX}${example}/`;
  const candidates: string[] = [];
  if (project.firmware?.artifact) candidates.push(base + project.firmware.artifact.replace(/^\.\//, ""));
  if (project.firmware?.sketch) candidates.push(`${base}firmware/build/${project.firmware.sketch}.hex`);
  for (const key of Object.keys(hexFiles).sort()) {
    if (key.startsWith(base) && !key.includes("with_bootloader")) candidates.push(key);
  }
  for (const key of candidates) {
    const load = hexFiles[key];
    if (load) {
      try {
        const hex = await load();
        if (hex.trim().startsWith(":")) return { hex, name: key.slice(base.length) };
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}
