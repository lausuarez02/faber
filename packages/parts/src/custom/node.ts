// Node side of agent-made parts: read <project>/parts/<id>/part.json (+ visual.svg) from disk.
// Kept out of the browser bundle (it uses node:fs); import it as "@jumper/parts/node".
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PartDefinition, PartRegistry } from "@jumper/sim-core";
import { compileCustomPart, CustomPartError, type CompiledCustomPart } from "./compile.ts";

export const PROJECT_PARTS_DIR = "parts";

export interface LoadedProjectParts {
  parts: (CompiledCustomPart & { id: string })[];
  /** Folders that could not be loaded, with the reason (what failed / why / fix). */
  errors: { id: string; message: string }[];
}

/** Every agent-made part in a project folder, compiled. Broken folders are reported, not thrown. */
export function readProjectParts(dir: string, builtins?: PartRegistry): LoadedProjectParts {
  const root = join(dir, PROJECT_PARTS_DIR);
  const out: LoadedProjectParts = { parts: [], errors: [] };
  if (!existsSync(root)) return out;
  for (const id of readdirSync(root).sort()) {
    const folder = join(root, id);
    const pj = join(folder, "part.json");
    if (!existsSync(pj)) continue;
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(pj, "utf8"));
      } catch (e) {
        throw new CustomPartError(`parts/${id}/part.json is not valid JSON (${(e as Error).message})`, "it was edited by hand or cut short", "fix the file or write it again with update_part");
      }
      const sv = join(folder, "visual.svg");
      const svg = existsSync(sv) ? readFileSync(sv, "utf8") : undefined;
      const c = compileCustomPart(raw, svg, builtins ? { builtins } : {});
      if (c.part.id !== id) {
        out.errors.push({ id, message: `parts/${id}/part.json says id '${c.part.id}'. Why: the folder name is the part type. Fix: rename the folder to parts/${c.part.id}/ or set "id": "${id}".` });
        continue;
      }
      out.parts.push({ ...c, id });
    } catch (e) {
      out.errors.push({ id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** The compiled definitions only (contract C4). */
export function loadProjectParts(dir: string, builtins?: PartRegistry): PartDefinition[] {
  return readProjectParts(dir, builtins).parts.map((p) => p.def);
}

/** Cheap change detector for parts/: names, sizes and mtimes of every part file. */
export function projectPartsStamp(dir: string): string {
  const root = join(dir, PROJECT_PARTS_DIR);
  if (!existsSync(root)) return "";
  const bits: string[] = [];
  try {
    for (const id of readdirSync(root).sort()) {
      for (const f of ["part.json", "visual.svg"]) {
        try {
          const s = statSync(join(root, id, f));
          bits.push(`${id}/${f}:${s.size}:${s.mtimeMs}`);
        } catch {
          // missing file
        }
      }
    }
  } catch {
    return "";
  }
  return bits.join("|");
}
