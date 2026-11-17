// Projects, firmware and agent files made before the rename from Jumper to Faber keep working
// (docs/migrating-from-jumper.md).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installProjectFiles, LEGACY_MARKER, LEGACY_SKILL_PATH, SKILL_PATH } from "@faber/agent-skill";
import { SandboxNet } from "@faber/ai-gateway";
import { CustomPartSchema } from "@faber/parts";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { parseSleepMarker } from "@faber/sim-core";
import { ProjectSession } from "../src/index.ts";
import { relayBuildSources } from "../src/relay-build.ts";

const GOLDEN = readFileSync(fileURLToPath(new URL("../../../examples/blink/firmware/blink.hex", import.meta.url)), "utf8");
async function fakeBuilder(_req: BuildRequest): Promise<BuildResult> {
  return { ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, libraries: [], logTail: "" };
}
const tmp = () => mkdtempSync(join(tmpdir(), "faber-legacy-"));
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").length;

describe("a project folder from before the rename (jumper.json, .jumper/)", () => {
  it("opens, and every change goes back into jumper.json and .jumper/actions.jsonl", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "jumper.json"), JSON.stringify({ format: "jumper/1", name: "Old blink", parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }], wires: [] }, null, 2));
    mkdirSync(join(dir, ".jumper"));
    appendFileSync(join(dir, ".jumper", "actions.jsonl"), JSON.stringify({ seq: 1, t: new Date().toISOString(), actor: "mcp", op: "new_project", args: {}, ok: true }) + "\n");

    const s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test" });
    expect(s.exists).toBe(true);
    expect(s.project.name).toBe("Old blink");
    expect(s.project.parts.map((p) => p.id)).toEqual(["uno"]);

    await s.call("place_part", { type: "led", why: "a status light" });
    const saved = JSON.parse(readFileSync(join(dir, "jumper.json"), "utf8")) as { format: string; parts: { id: string }[] };
    expect(saved.parts.map((p) => p.id)).toEqual(["uno", "led1"]);
    expect(saved.format).toBe("faber/1");
    expect(existsSync(join(dir, "faber.json"))).toBe(false);
    expect(existsSync(join(dir, ".faber"))).toBe(false);
    expect(lines(join(dir, ".jumper", "actions.jsonl"))).toBeGreaterThan(1);

    // the agent reads the project file under either name
    expect(((await s.call("read_file", { path: "faber.json" })) as { path: string }).path).toBe("jumper.json");
    // and cannot delete it, or the state folder, under its old names
    await expect(s.call("delete_file", { path: "jumper.json" })).rejects.toThrow(/refusing to delete jumper\.json/);
    await expect(s.call("delete_file", { path: ".jumper/actions.jsonl" })).rejects.toThrow(/refusing to delete/);
  });

  it("a new project gets faber.json and .faber/", async () => {
    const dir = tmp();
    const s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test" });
    await s.call("new_project", { template: "blank", name: "new" });
    expect(existsSync(join(dir, "faber.json"))).toBe(true);
    expect(existsSync(join(dir, "jumper.json"))).toBe(false);
    expect(existsSync(join(dir, ".faber", "actions.jsonl"))).toBe(true);
  });
});

describe("firmware written before the rename", () => {
  const project = { format: "faber/1" as const, name: "relay", parts: [], wires: [], scenarios: [] };

  it("a sketch that includes JumperRelay.h gets the forwarding header, and jumper_device.h in a simulation build", () => {
    const sketch = tmp();
    writeFileSync(join(sketch, "main.ino"), '#include "JumperRelay.h"\nvoid setup() { Serial.println(jumperRelayUrl("api.example.com", "/x")); }\nvoid loop() {}\n');
    const extra = relayBuildSources(project, sketch, "simulator").extraSources ?? {};
    expect(Object.keys(extra).sort()).toEqual(["FaberRelay.h", "JumperRelay.h", "faber_device.h", "jumper_device.h"]);
    expect(extra["JumperRelay.h"]).toContain('#include "FaberRelay.h"');
    expect(extra["JumperRelay.h"]).toContain("jumperRelayUrl");
    expect(extra["jumper_device.h"]).toContain("#define JUMPER_RELAY_URL");
    expect(extra["FaberRelay.h"]).toContain('__has_include("jumper_device.h")');
    // a device build never gets a device header (the person's own one is never compiled)
    expect(Object.keys(relayBuildSources(project, sketch, "device").extraSources ?? {}).sort()).toEqual(["FaberRelay.h", "JumperRelay.h"]);
  });

  it("a sketch that keeps its own old JumperRelay.h copy is left with it", () => {
    const sketch = tmp();
    writeFileSync(join(sketch, "main.ino"), '#include "JumperRelay.h"\n');
    writeFileSync(join(sketch, "JumperRelay.h"), "// the person's copy\n");
    const extra = relayBuildSources(project, sketch, "simulator").extraSources ?? {};
    expect(extra["JumperRelay.h"]).toBeUndefined();
    expect(extra["jumper_device.h"]).toContain("#define JUMPER_DEVICE_TOKEN");
  });

  it("joins JumperNet and reaches ai.jumper on the sandbox network", () => {
    const net = new SandboxNet();
    expect(net.join("JumperNet", "", 0, "esp")).toBe(0);
    expect(net.resolve("ai.jumper")).toBe(net.resolve("ai.faber"));
    expect(net.resolve("ai.jumper")).toBeDefined();
    expect(net.join("SomeoneElsesNet", "", 0, "esp")).toBe(3);
  });

  it("an older sleep shim's [jumper:sleep] line still puts the board to sleep", () => {
    expect(parseSleepMarker('[jumper:sleep] {"mode":"deep","us":1000000,"pins":[],"any":true}')).toMatchObject({ mode: "deep", wakeAfterMs: 1000 });
  });

  it('an agent-made part saved as "jumper-part/1" still loads', () => {
    const r = CustomPartSchema.safeParse({ format: "jumper-part/1" });
    expect(r.success ? [] : r.error.issues.filter((i) => i.path[0] === "format")).toEqual([]);
  });
});

describe("agent files written before the rename", () => {
  it("are updated (not kept as someone else's), and the old skill folder is removed", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), `<!-- ${LEGACY_MARKER} -->\nold guide\n`);
    mkdirSync(join(dir, ".claude/skills/jumper-hardware"), { recursive: true });
    writeFileSync(join(dir, LEGACY_SKILL_PATH), `<!-- ${LEGACY_MARKER} -->\nold skill\n`);
    const r = installProjectFiles(dir, { tools: ["place_part"] });
    expect(r.files.find((f) => f.path === "AGENTS.md")?.action).toBe("updated");
    expect(r.files.find((f) => f.path === LEGACY_SKILL_PATH)?.action).toBe("removed");
    expect(existsSync(join(dir, LEGACY_SKILL_PATH))).toBe(false);
    expect(existsSync(join(dir, SKILL_PATH))).toBe(true);
  });

  it("an old skill file someone edited by hand is left alone", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".claude/skills/jumper-hardware"), { recursive: true });
    writeFileSync(join(dir, LEGACY_SKILL_PATH), "my own notes\n");
    installProjectFiles(dir, { tools: ["place_part"] });
    expect(existsSync(join(dir, LEGACY_SKILL_PATH))).toBe(true);
  });
});
