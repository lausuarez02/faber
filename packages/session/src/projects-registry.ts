import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { userHomeDir } from "@fabwright/project-format/node";

/**
 * Round 5 (decision 0003, C3): the list of project folders Fabwright knows about, outside the repo's
 * projects/ and examples/ (which the server scans itself). Agents' new projects, folders opened with
 * `--project`, and projects created from the web app are added here so the Projects gallery can show
 * them all.
 *
 *   $FABWRIGHT_HOME/projects.json   (FABWRIGHT_HOME defaults to ~/.fabwright; tests set it to a temp dir)
 *   { "version": 1, "projects": [{ "dir": "/abs/path", "name": "…", "source": "agent", "addedAt": "…", "lastOpenedAt": "…" }] }
 */
export interface RegisteredProject {
  /** Absolute folder (holds fabwright.json). The key: one entry per dir. */
  dir: string;
  name: string;
  /** Who created or opened it first. */
  source: "agent" | "web" | "cli" | "serve";
  addedAt: string;
  lastOpenedAt: string;
}

export interface ProjectsRegistryFile {
  version: 1;
  projects: RegisteredProject[];
}

export function fabwrightHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.FABWRIGHT_HOME || userHomeDir(homedir()));
}

export function projectsRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(fabwrightHome(env), "projects.json");
}

/** Every registered project (missing or unreadable file → empty list; never throws). */
export function listRegisteredProjects(file = projectsRegistryPath()): RegisteredProject[] {
  try {
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectsRegistryFile>;
    return Array.isArray(data.projects) ? data.projects.filter((p) => p && typeof p.dir === "string") : [];
  } catch {
    return [];
  }
}

/** Add or touch a project (lastOpenedAt = now). Written atomically. Returns the entry. */
export function registerProject(
  dir: string,
  meta: { name?: string; source: RegisteredProject["source"] },
  file = projectsRegistryPath(),
  now = new Date().toISOString(),
): RegisteredProject {
  const abs = resolve(dir);
  const list = listRegisteredProjects(file);
  const found = list.find((p) => p.dir === abs);
  const entry: RegisteredProject = found
    ? { ...found, ...(meta.name ? { name: meta.name } : {}), lastOpenedAt: now }
    : { dir: abs, name: meta.name ?? abs.split(/[\\/]/).pop() ?? "project", source: meta.source, addedAt: now, lastOpenedAt: now };
  const next: ProjectsRegistryFile = { version: 1, projects: [entry, ...list.filter((p) => p.dir !== abs)] };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, file);
  return entry;
}

/** Remove a folder from the list (does not touch the folder). */
export function unregisterProject(dir: string, file = projectsRegistryPath()): void {
  const abs = resolve(dir);
  const list = listRegisteredProjects(file);
  if (!list.some((p) => p.dir === abs)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, projects: list.filter((p) => p.dir !== abs) } satisfies ProjectsRegistryFile, null, 2) + "\n");
}

/** Stable opaque id of a project folder for URLs (/api/projects/:id): first 12 hex of sha256(abs dir). */
export function projectId(dir: string): string {
  return createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 12);
}

/** "My Plant Waterer!" → "my-plant-waterer" (a-z0-9 and dashes, at most 48 chars; "project" if empty). */
export function projectSlug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "project";
}

/**
 * A new, empty folder for a new project under `root` (decision 0003, C3): <root>/<slug>, or
 * <slug>-2, -3… when taken. Creates it and returns its absolute path. Does not write fabwright.json
 * (new_project does) and does not register it (the caller does, with its source).
 */
export function newProjectFolder(root: string, name: string): string {
  const base = projectSlug(name);
  for (let i = 1; ; i++) {
    const dir = resolve(root, i === 1 ? base : `${base}-${i}`);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      return dir;
    }
  }
}
