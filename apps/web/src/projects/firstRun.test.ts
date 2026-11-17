import { describe, expect, it } from "vitest";
import type { Project } from "@fabwright/project-format";
import { isFreshPlayground, isServerLanding, landOnProjects } from "./firstRun.ts";

// Round 6, switch track: someone new lands on the Projects page, not on a canvas they did not ask for.
const empty: Project = { format: "fabwright/1", name: "playground", parts: [], wires: [], scenarios: [] };
const built: Project = { ...empty, name: "Pocket Muse", parts: [{ id: "nano", type: "arduino-nano", x: 0, y: 0, rotation: 0 }] };
const landing = { host: "localhost:7780", search: `?follow=${encodeURIComponent("ws://localhost:7780/live")}` };

describe("first screen", () => {
  it("knows the server's own landing from a hand-made follow link", () => {
    expect(isServerLanding(landing)).toBe(true);
    expect(isServerLanding({ host: "localhost:5173", search: landing.search })).toBe(false);
    expect(isServerLanding({ ...landing, search: `${landing.search}&autorun=1` })).toBe(false);
    expect(isServerLanding({ ...landing, search: "?example=blink" })).toBe(false);
  });

  it("a fresh playground or a browser that never opened a project starts on Projects", () => {
    expect(isFreshPlayground(empty, "/x/projects/playground")).toBe(true);
    expect(isFreshPlayground(built, "/x/projects/playground")).toBe(false);
    expect(isFreshPlayground(empty, "/x/projects/untitled-device")).toBe(false);
    expect(landOnProjects(empty, "/x/projects/playground", true, true)).toBe(true);
    expect(landOnProjects(built, "/x/projects/playground", false, true)).toBe(true);
    expect(landOnProjects(built, "/x/projects/playground", true, true)).toBe(false);
    expect(landOnProjects(built, "/x/projects/playground", false, false)).toBe(false);
  });
});
