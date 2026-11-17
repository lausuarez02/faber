// Runs a part with real compiled firmware on a simulated Uno: the bench for bus parts, whose
// behaviour only shows up when a real library (Wire, Adafruit_*, U8g2, RTClib…) talks to them.
import { readFileSync } from "node:fs";
import { parseProject, type ProjectInput } from "@faber/project-format";
import { Simulation, decodeMonoFrame, monoToAscii, type MonoFrame } from "@faber/sim-core";
import { backendFactory } from "@faber/sim-backends";
import { registry } from "../registry.gen.ts";

export interface UnoBenchOptions {
  /** Parts besides the Uno (id "uno"). */
  parts: NonNullable<ProjectInput["parts"]>;
  /** Wires as "part:pin" pairs, e.g. ["oled:SDA", "uno:A4"]. */
  wires: [string, string][];
  /** Path to the .hex, relative to `base` (a file URL, usually import.meta.url). */
  hex: string;
  base: string | URL;
}

/** The usual I2C module wiring on an Uno: GND, VCC → 5V, SDA → A4, SCL → A5. */
export function i2cWires(id: string, pins = { gnd: "GND", vcc: "VCC", sda: "SDA", scl: "SCL" }): [string, string][] {
  return [
    [`${id}:${pins.gnd}`, "uno:GND.2"],
    [`${id}:${pins.vcc}`, "uno:5V"],
    [`${id}:${pins.sda}`, "uno:A4"],
    [`${id}:${pins.scl}`, "uno:A5"],
  ];
}

export function unoBench(opts: UnoBenchOptions): Simulation {
  const hex = readFileSync(new URL(opts.hex, opts.base), "utf8");
  const project = parseProject({
    format: "faber/1",
    name: "bench",
    parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }, ...opts.parts],
    wires: opts.wires.map(([a, b], i) => {
      const [ap, aq] = a.split(":");
      const [bp, bq] = b.split(":");
      return { id: `w${i}`, from: { part: ap!, pin: aq! }, to: { part: bp!, pin: bq! } };
    }),
    firmware: { board: "uno", artifact: "example.hex" },
  });
  return new Simulation({ project, registry, backendFactory, firmware: hex, chunkMs: 1 });
}

/** The current OLED/LCD frame of a display part as a MonoFrame. */
export function frameOf(sim: Simulation, partId: string): MonoFrame {
  const s = sim.partState(partId);
  if (!s) throw new Error(`no part '${partId}'`);
  return decodeMonoFrame(String(s.pixels), Number(s.width), Number(s.height));
}

export function asciiOf(sim: Simulation, partId: string, scale = 1): string {
  return monoToAscii(frameOf(sim, partId), scale);
}

/** Serial lines printed so far (CRLF split, last partial line dropped). */
export function serialLines(sim: Simulation): string[] {
  const parts = sim.serialText().split("\r\n");
  parts.pop();
  return parts;
}
