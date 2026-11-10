import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@jumper/parts";
import type { Project } from "@jumper/project-format";

const ROOT = join(import.meta.dirname, "../../..");

/** The Muse: the committed example when present (power track), else the fixture copy. */
export function muse(): Project {
  const ex = join(ROOT, "examples/agent-built/claude-pocket-muse/jumper.json");
  const file = existsSync(ex) ? ex : join(import.meta.dirname, "fixtures/pocket-muse.json");
  const p = JSON.parse(readFileSync(file, "utf8")) as Project;
  return { ...p, scenarios: p.scenarios ?? [], wires: p.wires ?? [] };
}

export const specOf = (t: string) => registry.get(t)?.spec;

export function partsOf(p: Project) {
  return p.parts.map((x) => ({ id: x.id, type: x.type, spec: specOf(x.type)! }));
}
