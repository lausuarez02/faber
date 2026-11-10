// A registry that is the built-in catalog plus one project's agent-made parts (decision 0003, C4).
// The session and the web app keep one of these and swap the project parts when parts/ changes,
// so everything that holds the registry (simulation, DRC, screenshots) sees the new parts.
import type { PartDefinition, PartRegistry } from "@jumper/sim-core";

export interface ProjectPartRegistry extends PartRegistry {
  readonly base: PartRegistry;
  /** Replace the project parts. Returns a warning per project part that hides a built-in type. */
  setProjectParts(defs: readonly PartDefinition[]): string[];
  projectParts(): PartDefinition[];
  /** Bumped on every setProjectParts. */
  readonly version: number;
}

export function withProjectParts(base: PartRegistry): ProjectPartRegistry {
  let custom = new Map<string, PartDefinition>();
  let merged: PartDefinition[] | undefined;
  let version = 0;
  return {
    base,
    get version() {
      return version;
    },
    get: (t) => custom.get(t) ?? base.get(t),
    list() {
      merged ??= [...base.list().filter((d) => !custom.has(d.spec.id)), ...custom.values()].sort((a, b) => (a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0));
      return merged.slice();
    },
    projectParts: () => [...custom.values()],
    setProjectParts(defs) {
      custom = new Map(defs.map((d) => [d.spec.id, d]));
      merged = undefined;
      version++;
      return defs.filter((d) => base.get(d.spec.id)).map((d) => `project part '${d.spec.id}' has the same id as a built-in part; this project uses its own (agent-made) version. Rename it with update_part if you meant the built-in one.`);
    },
  };
}
