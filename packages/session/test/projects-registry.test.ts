import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { jumperHome, listRegisteredProjects, newProjectFolder, projectId, projectSlug, registerProject, unregisterProject } from "../src/index.ts";

const tmp = mkdtempSync(join(tmpdir(), "jumper-home-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("projects registry", () => {
  it("follows JUMPER_HOME, adds, touches and removes entries", () => {
    expect(jumperHome({ JUMPER_HOME: tmp })).toBe(tmp);
    const file = join(tmp, "projects.json");
    expect(listRegisteredProjects(file)).toEqual([]);
    registerProject("/x/a", { name: "A", source: "agent" }, file, "2026-01-01T00:00:00.000Z");
    registerProject("/x/b", { source: "cli" }, file, "2026-01-02T00:00:00.000Z");
    registerProject("/x/a", { source: "web" }, file, "2026-01-03T00:00:00.000Z");
    const list = listRegisteredProjects(file);
    expect(list.map((p) => p.dir)).toEqual(["/x/a", "/x/b"]);
    expect(list[0]).toMatchObject({ name: "A", source: "agent", addedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-03T00:00:00.000Z" });
    expect(list[1]!.name).toBe("b");
    unregisterProject("/x/a", file);
    expect(listRegisteredProjects(file).map((p) => p.dir)).toEqual(["/x/b"]);
  });

  it("makes slugs, stable ids and unique new folders", () => {
    expect(projectSlug("My Plant Waterer!")).toBe("my-plant-waterer");
    expect(projectSlug("¡¡¡")).toBe("project");
    expect(projectId("/a/b")).toMatch(/^[0-9a-f]{12}$/);
    expect(projectId("/a/b")).toBe(projectId("/a/b/"));
    const a = newProjectFolder(tmp, "Pet");
    const b = newProjectFolder(tmp, "pet");
    expect(a.endsWith("/pet")).toBe(true);
    expect(b.endsWith("/pet-2")).toBe(true);
    expect(existsSync(b)).toBe(true);
  });
});
