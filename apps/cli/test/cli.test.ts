import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/jumper.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "jumper-cli-"));
const jumper = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, INIT_CWD: dir, JUMPER_PROJECT: "" }, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("jumper CLI", () => {
  it("prints help and the tool list", () => {
    expect(jumper("help").out).toMatch(/Usage: jumper <command>/);
    const tools = JSON.parse(jumper("tools", "--json").out) as { name: string }[];
    expect(tools.map((t) => t.name)).toContain("run_tests");
  });

  it("creates a project, places and wires parts, with --json output", () => {
    expect(jumper("new", "p", "--template", "uno").code).toBe(0);
    const placed = JSON.parse(jumper("place", "led", "-p", "p", "--json", "--why", "status light").out);
    expect(placed).toMatchObject({ id: "led1", type: "led", step: { why: "status light" } });
    expect(jumper("place", "resistor", "--prop", "resistance=330", "-p", "p").code).toBe(0);
    expect(jumper("connect", "uno.D9", "r1.1", "-p", "p").code).toBe(0);
    expect(jumper("connect", "r1.2", "led1.A", "-p", "p").code).toBe(0);
    expect(jumper("connect", "led1.C", "uno.GND", "-p", "p").code).toBe(0);
    const status = JSON.parse(jumper("status", "-p", "p", "--json").out);
    expect(status.wires).toEqual(["w1: uno.D9 -> r1.1", "w2: r1.2 -> led1.A", "w3: led1.C -> uno.GND.1"]);
    expect(jumper("check", "-p", "p").code).toBe(0);
  }, 30_000); // five CLI processes: about 1 s each, more while the CAD and costs tests run beside it

  it("exits 1 with a what/why/fix message on errors, 2 on bad usage", () => {
    const r = jumper("connect", "uno.D99", "led1.A", "-p", "p");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no pin 'D99'.*Fix:/s);
    const j = jumper("connect", "uno.D99", "led1.A", "-p", "p", "--json");
    expect(JSON.parse(j.out).error.code).toBe("unknown-pin");
    expect(jumper("frobnicate").code).toBe(2);
    expect(jumper("connect", "uno.D9").code).toBe(2);
  });

  it("calls any tool by name", () => {
    const r = jumper("call", "get_part", '{"type":"pushbutton"}', "-p", "p", "--json");
    expect(JSON.parse(r.out).pins[0]).toMatch(/^1a/);
  });
});
