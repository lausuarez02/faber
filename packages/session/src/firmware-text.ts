// Round 13: the firmware's source text, for rules that depend on what the sketch uses (a board's own
// card slot needs a card only when the firmware reads one: the kit's shopping list and the assembly plan).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every source file of the project's firmware, joined (undefined when the project has no firmware folder). */
export function firmwareText(s: { dir: string; project: { firmware?: { dir?: string } } }): string | undefined {
  const dir = s.project.firmware?.dir;
  if (!dir || !existsSync(join(s.dir, dir))) return undefined;
  try {
    return readdirSync(join(s.dir, dir))
      .filter((f) => /\.(ino|cpp|c|h|hpp|py)$/.test(f))
      .map((f) => readFileSync(join(s.dir, dir, f), "utf8"))
      .join("\n");
  } catch {
    return undefined;
  }
}
