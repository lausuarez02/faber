// The pre-rename names (Jumper → Fabwright) that keep working: see docs/migrating-from-jumper.md.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyLegacyEnv, currentSandboxHost, parseProject, ssidMatches, upgradeLegacyFormat } from "./index.ts";
import { hasProjectFile, projectFilePath, stateDirPath, userHomeDir } from "./node.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "fabwright-legacy-"));

describe("JUMPER_* environment variables", () => {
  it("fill FABWRIGHT_* when it is not set, and never override it", () => {
    const env: Record<string, string | undefined> = { JUMPER_HOME: "/old", JUMPER_RUNTIME: "native", FABWRIGHT_RUNTIME: "docker", PATH: "/bin" };
    expect(applyLegacyEnv(env)).toEqual(["FABWRIGHT_HOME"]);
    expect(env.FABWRIGHT_HOME).toBe("/old");
    expect(env.FABWRIGHT_RUNTIME).toBe("docker");
    expect(env.PATH).toBe("/bin");
  });
});

describe("project files from before the rename", () => {
  it('read "format": "jumper/1" as the current format', () => {
    const p = parseProject({ format: "jumper/1", name: "old", parts: [] });
    expect(p.format).toBe("fabwright/1");
    expect(upgradeLegacyFormat({ format: "other/1" }, "fabwright/1")).toEqual({ format: "other/1" });
    expect(() => parseProject({ format: "jumper/2", name: "x" })).toThrow(/format/);
  });

  it("jumper.json and .jumper/ are used where they are; new folders get fabwright.json and .fabwright/", () => {
    const fresh = tmp();
    expect(projectFilePath(fresh)).toBe(join(fresh, "fabwright.json"));
    expect(stateDirPath(fresh)).toBe(join(fresh, ".fabwright"));
    expect(hasProjectFile(fresh)).toBe(false);

    const old = tmp();
    writeFileSync(join(old, "jumper.json"), "{}");
    mkdirSync(join(old, ".jumper"));
    expect(projectFilePath(old)).toBe(join(old, "jumper.json"));
    expect(stateDirPath(old)).toBe(join(old, ".jumper"));
    expect(hasProjectFile(old)).toBe(true);

    // both present (someone renamed by hand): the new name wins
    writeFileSync(join(old, "fabwright.json"), "{}");
    mkdirSync(join(old, ".fabwright"));
    expect(projectFilePath(old)).toBe(join(old, "fabwright.json"));
    expect(stateDirPath(old)).toBe(join(old, ".fabwright"));
  });

  it("~/.jumper (installed toolchains) is used when ~/.fabwright does not exist", () => {
    const home = tmp();
    expect(userHomeDir(home)).toBe(join(home, ".fabwright"));
    mkdirSync(join(home, ".jumper"));
    expect(userHomeDir(home)).toBe(join(home, ".jumper"));
    mkdirSync(join(home, ".fabwright"));
    expect(userHomeDir(home)).toBe(join(home, ".fabwright"));
  });
});

describe("sandbox names firmware may still use", () => {
  it("ai.jumper and relay.sandbox.jumper are the current hosts; JumperNet joins the default network", () => {
    expect(currentSandboxHost("AI.Jumper")).toBe("ai.fabwright");
    expect(currentSandboxHost("relay.sandbox.jumper")).toBe("relay.sandbox.fabwright");
    expect(currentSandboxHost("api.example.com")).toBe("api.example.com");
    expect(ssidMatches("JumperNet", "FabwrightNet")).toBe(true);
    expect(ssidMatches("FabwrightNet", "FabwrightNet")).toBe(true);
    expect(ssidMatches("JumperNet", "Home")).toBe(false);
  });
});
