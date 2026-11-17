// The pre-rename names (Jumper → Faber) that keep working: see docs/migrating-from-jumper.md.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyLegacyEnv, currentSandboxHost, parseProject, ssidMatches, upgradeLegacyFormat } from "./index.ts";
import { hasProjectFile, projectFilePath, stateDirPath, userHomeDir } from "./node.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "faber-legacy-"));

describe("JUMPER_* environment variables", () => {
  it("fill FABER_* when it is not set, and never override it", () => {
    const env: Record<string, string | undefined> = { JUMPER_HOME: "/old", JUMPER_RUNTIME: "native", FABER_RUNTIME: "docker", PATH: "/bin" };
    expect(applyLegacyEnv(env)).toEqual(["FABER_HOME"]);
    expect(env.FABER_HOME).toBe("/old");
    expect(env.FABER_RUNTIME).toBe("docker");
    expect(env.PATH).toBe("/bin");
  });
});

describe("project files from before the rename", () => {
  it('read "format": "jumper/1" as the current format', () => {
    const p = parseProject({ format: "jumper/1", name: "old", parts: [] });
    expect(p.format).toBe("faber/1");
    expect(upgradeLegacyFormat({ format: "other/1" }, "faber/1")).toEqual({ format: "other/1" });
    expect(() => parseProject({ format: "jumper/2", name: "x" })).toThrow(/format/);
  });

  it("jumper.json and .jumper/ are used where they are; new folders get faber.json and .faber/", () => {
    const fresh = tmp();
    expect(projectFilePath(fresh)).toBe(join(fresh, "faber.json"));
    expect(stateDirPath(fresh)).toBe(join(fresh, ".faber"));
    expect(hasProjectFile(fresh)).toBe(false);

    const old = tmp();
    writeFileSync(join(old, "jumper.json"), "{}");
    mkdirSync(join(old, ".jumper"));
    expect(projectFilePath(old)).toBe(join(old, "jumper.json"));
    expect(stateDirPath(old)).toBe(join(old, ".jumper"));
    expect(hasProjectFile(old)).toBe(true);

    // both present (someone renamed by hand): the new name wins
    writeFileSync(join(old, "faber.json"), "{}");
    mkdirSync(join(old, ".faber"));
    expect(projectFilePath(old)).toBe(join(old, "faber.json"));
    expect(stateDirPath(old)).toBe(join(old, ".faber"));
  });

  it("~/.jumper (installed toolchains) is used when ~/.faber does not exist", () => {
    const home = tmp();
    expect(userHomeDir(home)).toBe(join(home, ".faber"));
    mkdirSync(join(home, ".jumper"));
    expect(userHomeDir(home)).toBe(join(home, ".jumper"));
    mkdirSync(join(home, ".faber"));
    expect(userHomeDir(home)).toBe(join(home, ".faber"));
  });
});

describe("sandbox names firmware may still use", () => {
  it("ai.jumper and relay.sandbox.jumper are the current hosts; JumperNet joins the default network", () => {
    expect(currentSandboxHost("AI.Jumper")).toBe("ai.faber");
    expect(currentSandboxHost("relay.sandbox.jumper")).toBe("relay.sandbox.faber");
    expect(currentSandboxHost("api.example.com")).toBe("api.example.com");
    expect(ssidMatches("JumperNet", "FaberNet")).toBe(true);
    expect(ssidMatches("FaberNet", "FaberNet")).toBe(true);
    expect(ssidMatches("JumperNet", "Home")).toBe(false);
  });
});
