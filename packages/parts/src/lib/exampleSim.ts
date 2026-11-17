// Runs a part's example.ino (golden example.hex next to it) on an Uno with the given parts and
// wires, for model tests: exampleSim("hc-sr04", parts, wires).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProject, type ProjectInput } from "@fabwright/project-format";
import { Simulation } from "@fabwright/sim-core";
import { backendFactory } from "@fabwright/sim-backends";
import { registry } from "../registry.gen.ts";

type Ref = `${string}.${string}`;

export function exampleSim(partType: string, parts: ProjectInput["parts"], wires: [Ref, Ref][], hexName = "example.hex"): Simulation {
  const hex = readFileSync(fileURLToPath(new URL(`../parts/${partType}/${hexName}`, import.meta.url)), "utf8");
  const ref = (r: Ref) => {
    const i = r.indexOf(".");
    return { part: r.slice(0, i), pin: r.slice(i + 1) };
  };
  const project = parseProject({
    format: "fabwright/1",
    name: `${partType} example`,
    parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }, ...(parts ?? [])],
    wires: wires.map(([a, b], i) => ({ id: `w${i}`, from: ref(a), to: ref(b) })),
    firmware: { board: "uno", artifact: hexName },
  });
  return new Simulation({ project, registry, backendFactory, firmware: hex });
}
