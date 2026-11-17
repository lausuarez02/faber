// Node-only lookups for the pre-rename names (see ./legacy.ts). One rule everywhere: use the new
// name when it is there, else the old name when that is there, else the new name. So a project
// made before the rename keeps reading and writing its jumper.json and .jumper/ (no surprise
// second file, nothing moved behind the person's back), and every new project gets fabwright.json.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, LEGACY_HOME_DIR, LEGACY_PROJECT_FILE, LEGACY_STATE_DIR, PROJECT_FILE, STATE_DIR } from "./legacy.ts";

function pick(dir: string, current: string, legacy: string): string {
  const now = join(dir, current);
  if (existsSync(now)) return now;
  const old = join(dir, legacy);
  return existsSync(old) ? old : now;
}

/** The project file of `dir`: fabwright.json, or jumper.json in a project made before the rename. */
export function projectFilePath(dir: string): string {
  return pick(dir, PROJECT_FILE, LEGACY_PROJECT_FILE);
}

/** True when `dir` has a project file under either name. */
export function hasProjectFile(dir: string): boolean {
  return existsSync(join(dir, PROJECT_FILE)) || existsSync(join(dir, LEGACY_PROJECT_FILE));
}

/** The project's state folder: .fabwright, or .jumper in a project made before the rename. */
export function stateDirPath(dir: string): string {
  return pick(dir, STATE_DIR, LEGACY_STATE_DIR);
}

/** ~/.fabwright, or ~/.jumper when only that exists (its installed toolchains keep working). */
export function userHomeDir(home: string = homedir()): string {
  return pick(home, HOME_DIR, LEGACY_HOME_DIR);
}
