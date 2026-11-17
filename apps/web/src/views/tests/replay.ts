// Deterministic scrubbing: rebuild the simulation from t = 0 and re-apply a scenario's recorded
// inputs (exact virtual times) up to any moment. Moving forward continues the same simulation;
// moving back rebuilds it. Same inputs at the same cycle → the same device state as in the test.
import type { Project, PropValue } from "@faber/project-format";
import { Simulation } from "@faber/sim-core";
import { createSandboxNetwork } from "@faber/ai-gateway";
import { hasWifiPart } from "../network/webNetwork.ts";
import { backendFactory } from "@faber/sim-backends";
import { registry } from "@faber/parts";
import { attachPhysics, initPhysics, type PhysicsBinding } from "@faber/physics";
import { ownedSimSource, type OwnedSimSource } from "../device/source.ts";
import type { VisualInput } from "./types.ts";

/** Apply one recorded input to a Simulation. Faults need the session's fault layer and are skipped (returns false). */
export function applyInputToSim(sim: Simulation, inp: VisualInput): boolean {
  switch (inp.kind) {
    case "press":
    case "release":
      sim.interact(inp.part!, { kind: inp.kind });
      return true;
    case "serial_write":
      sim.writeSerial(Number(inp.data) & 0xff);
      return true;
    case "set":
      if (inp.data === "prop" || inp.data === "noise-base") sim.setProp(inp.part!, inp.field!, inp.value as PropValue);
      else sim.interact(inp.part!, { kind: "set", key: inp.field!, value: inp.value as never });
      return true;
    default:
      return false;
  }
}

export interface Scrubber {
  /** The source the Device view reads (its own Simulation). */
  readonly source: OwnedSimSource;
  /** Bring the simulation to exactly `t` virtual ms (replays from 0 when going back). */
  seek(t: number): void;
  /** Inputs that could not be replayed in the browser (faults). */
  readonly skipped: VisualInput[];
  dispose(): void;
}

export async function createScrubber(project: Project, hex: string | undefined, inputs: readonly VisualInput[]): Promise<Scrubber> {
  if (project.world) await initPhysics();
  const skipped: VisualInput[] = [];
  let sim!: Simulation;
  let physics: PhysicsBinding | undefined;
  let source!: OwnedSimSource;
  let next = 0;
  const build = () => {
    source?.dispose();
    sim = new Simulation({ project, registry, backendFactory, ...(hex ? { firmware: hex } : {}), ...(hasWifiPart(project) ? { services: { network: createSandboxNetwork() } } : {}) });
    physics = project.world ? attachPhysics(sim, project.world) : undefined;
    source = ownedSimSource({ project, sim, physics });
    next = 0;
    skipped.length = 0;
  };
  build();
  const runTo = (t: number) => {
    let todo = t - sim.timeMs;
    while (todo > 1e-9) {
      const s = Math.min(50, todo);
      sim.runFor(s);
      todo = t - sim.timeMs;
    }
  };
  const holder: Scrubber = {
    get source() {
      return source;
    },
    get skipped() {
      return skipped;
    },
    seek(t) {
      if (t < sim.timeMs - 1e-9) build();
      while (next < inputs.length && inputs[next]!.t <= t) {
        const inp = inputs[next]!;
        runTo(inp.t);
        if (!applyInputToSim(sim, inp)) skipped.push(inp);
        next++;
      }
      runTo(t);
    },
    dispose() {
      source.dispose();
    },
  };
  return holder;
}
