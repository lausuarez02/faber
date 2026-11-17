import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/fabwright.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "fabwright-cli-"));
mkdirSync(join(dir, "own"));
const fabwright = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, INIT_CWD: dir, FABWRIGHT_PROJECT: "" }, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fabwright CLI", () => {
  it("prints help and the tool list", () => {
    expect(fabwright("help").out).toMatch(/Usage: fabwright <command>/);
    const tools = JSON.parse(fabwright("tools", "--json").out) as { name: string }[];
    expect(tools.map((t) => t.name)).toContain("run_tests");
  });

  it("creates a project, places and wires parts, with --json output", () => {
    expect(fabwright("new", "p", "--template", "uno").code).toBe(0);
    const placed = JSON.parse(fabwright("place", "led", "-p", "p", "--json", "--why", "status light").out);
    expect(placed).toMatchObject({ id: "led1", type: "led", step: { why: "status light" } });
    expect(fabwright("place", "resistor", "--prop", "resistance=330", "-p", "p").code).toBe(0);
    expect(fabwright("connect", "uno.D9", "r1.1", "-p", "p").code).toBe(0);
    expect(fabwright("connect", "r1.2", "led1.A", "-p", "p").code).toBe(0);
    expect(fabwright("connect", "led1.C", "uno.GND", "-p", "p").code).toBe(0);
    const status = JSON.parse(fabwright("status", "-p", "p", "--json").out);
    expect(status.wires).toEqual(["w1: uno.D9 -> r1.1", "w2: r1.2 -> led1.A", "w3: led1.C -> uno.GND.1"]);
    expect(fabwright("check", "-p", "p").code).toBe(0);
  }, 30_000); // five CLI processes: about 1 s each, more while the CAD and costs tests run beside it

  it("round 12 skill: fabwright skill print / install writes the project's agent files, keeps the person's own", () => {
    const printed = fabwright("skill", "print");
    expect(printed.code).toBe(0);
    expect(printed.out).toMatch(/^---\nname: fabwright-hardware\ndescription: "/);
    expect(fabwright("skill", "print", "--target", "instructions").out).toMatch(/^Design for assembly/);
    expect(fabwright("skill", "print", "--target", "nope")).toMatchObject({ code: 2, err: expect.stringMatching(/no target 'nope'.*Fix:/) });
    expect(fabwright("skill", "frob")).toMatchObject({ code: 2, err: expect.stringMatching(/print or install.*Fix:/) });
    writeFileSync(join(dir, "own", "AGENTS.md"), "# mine\n");
    const inst = JSON.parse(fabwright("skill", "install", "--project", "own", "--json").out) as { files: { path: string; action: string }[] };
    expect(inst.files.map((f) => `${f.path}:${f.action}`)).toEqual([".claude/skills/fabwright-hardware/SKILL.md:written", "AGENTS.md:kept", "CLAUDE.md:written"]);
    expect(readFileSync(join(dir, "own", "AGENTS.md"), "utf8")).toBe("# mine\n");
    expect(fabwright("skill", "install", "--project", "own", "--force").out).toMatch(/updated +.*AGENTS.md/);
  }, 30_000); // seven CLI processes: timed out at the 5 s default while the e2e suite ran beside it

  it("exits 1 with a what/why/fix message on errors, 2 on bad usage", () => {
    const r = fabwright("connect", "uno.D99", "led1.A", "-p", "p");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no pin 'D99'.*Fix:/s);
    const j = fabwright("connect", "uno.D99", "led1.A", "-p", "p", "--json");
    expect(JSON.parse(j.out).error.code).toBe("unknown-pin");
    expect(fabwright("frobnicate").code).toBe(2);
    expect(fabwright("connect", "uno.D9").code).toBe(2);
  });

  it("calls any tool by name", () => {
    const r = fabwright("call", "get_part", '{"type":"pushbutton"}', "-p", "p", "--json");
    expect(JSON.parse(r.out).pins[0]).toMatch(/^1a/);
  });
});
