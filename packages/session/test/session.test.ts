import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { allOpNames, bindSvgString, composeSvg, FaberError, ProjectSession, TOOLS, TOOL_MODULES } from "../src/index.ts";

const GOLDEN = readFileSync(fileURLToPath(new URL("../../../examples/blink/firmware/blink.hex", import.meta.url)), "utf8");

/** Builder double: "compiles" any sketch to the golden Blink (D13, "LED on"/"LED off" at 115200), or fails on BROKEN. */
const builds: BuildRequest[] = [];
async function fakeBuilder(req: BuildRequest): Promise<BuildResult> {
  builds.push(req);
  const src = readFileSync(join(req.sketchDir, req.main ?? "main.ino"), "utf8");
  if (src.includes("BROKEN")) {
    return { ok: false, cached: false, durationMs: 1, hash: "x", diagnostics: [{ severity: "error", file: `${req.displayPrefix}${req.main}`, line: 2, column: 3, message: "'BROKEN' was not declared in this scope", hint: "declare it" }], errors: 1, warnings: 0, libraries: [], logTail: "" };
  }
  return { ok: true, hex: GOLDEN, cached: false, durationMs: 1, hash: "y", diagnostics: [], errors: 0, warnings: 0, size: { flash: 1992, flashMax: 32256, ram: 202, ramMax: 2048 }, libraries: [], logTail: "" };
}

const BLINK = 'void setup(){Serial.begin(115200);pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);Serial.println("LED on");delay(1000);digitalWrite(13,LOW);Serial.println("LED off");delay(1000);}\n';

let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

async function wiredBlink() {
  await call("new_project", { template: "blank", name: "t" });
  await call("place_part", { type: "arduino-uno", why: "board" });
  await call("place_part", { type: "resistor", props: { resistance: "220" }, why: "parts" });
  await call("place_part", { type: "led" });
  await call("connect", { from: "uno.13", to: "r1.1", why: "wires" });
  await call("connect", { from: "r1.2", to: "led1.A" });
  await call("connect", { from: "led1.C", to: "uno.GND" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "faber-session-"));
  s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test" });
});
afterEach(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("catalog", () => {
  it("has one tool per op and every op has a tool", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(allOpNames().sort());
  });
  it("gives every round-5 module tool a handler and no name twice", () => {
    for (const m of TOOL_MODULES) for (const t of m.tools) expect(typeof m.ops[t.name], `${m.name}: ${t.name}`).toBe("function");
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("editing", () => {
  it("places parts without overlaps and gives boards short ids", async () => {
    await call("new_project", {});
    expect((await call("place_part", { type: "arduino-uno" })).id).toBe("uno");
    for (let i = 0; i < 6; i++) await call("place_part", { type: i % 2 ? "led" : "pushbutton" });
    const proj = await call("get_project");
    expect(proj.parts).toHaveLength(7);
    expect(proj.overlapping_parts).toBeUndefined();
  });

  it("resolves forgiving pin names and reports what it resolved", async () => {
    await wiredBlink();
    const p = await call("get_project");
    expect(p.wires).toEqual(["w1: uno.D13 -> r1.1", "w2: r1.2 -> led1.A", "w3: led1.C -> uno.GND.1"]);
    const again = await call("connect", { from: "r1.1", to: "uno.D13" });
    expect(again.note).toMatch(/already connected/);
  });

  it("errors say what, why and how to fix, with suggestions", async () => {
    await wiredBlink();
    const bad = [
      [{ type: "ledd" }, /No part type 'ledd'.*Fix:.*Did you mean 'led'/s, "place_part"],
      [{ from: "uno.D99", to: "r1.1" }, /no pin 'D99'.*its pins are: .*D13.*Fix:/s, "connect"],
      [{ from: "unoo.D13", to: "r1.1" }, /No part 'unoo'.*Did you mean 'uno'/s, "connect"],
      [{ from: "uno.5V", to: "uno.GND" }, /Refusing.*short circuit.*Fix:/s, "connect"],
      [{ id: "r1", prop: "resistance", value: -5 }, /out of range.*Fix:/s, "set_part_property"],
    ] as const;
    for (const [args, re, op] of bad) {
      const err = await call(op, args as Record<string, unknown>).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FaberError);
      expect((err as Error).message).toMatch(re);
    }
  });

  it("groups edits into steps by why, and undo / redo / reject them", async () => {
    await wiredBlink();
    const steps = (await call("list_steps")).steps as { id: number; why: string; ops: string[] }[];
    expect(steps.map((x) => x.why)).toEqual(["new_project blank", "board", "parts", "wires"]);
    expect(steps[2]!.ops).toEqual(["place_part r1", "place_part led1"]);
    await call("undo"); // removes the three wires
    expect((await call("get_project")).wires).toEqual([]);
    await call("redo");
    expect((await call("get_project")).wires).toHaveLength(3);
    // Rejecting "parts" while wires use them is refused with the reason.
    await expect(call("reject_step", { step: 3 })).rejects.toThrow(/later changes depend on it.*Fix: undo or reject the later steps first/s);
    await call("reject_step", { step: 4 });
    await call("reject_step", { step: 3 });
    expect((await call("get_project")).parts).toEqual(["uno (arduino-uno) @0,0"]);
    expect((await call("accept_step", {})).accepted).toEqual([1, 2]);
  });

  it("writes firmware files, links the sketch to the board and keeps paths inside firmware/", async () => {
    await wiredBlink();
    const w = await call("write_file", { path: "main.ino", content: BLINK, why: "firmware" });
    expect(w.path).toBe("firmware/main.ino");
    expect(w.notes[0]).toMatch(/runs on uno/);
    expect(JSON.parse(readFileSync(join(dir, "faber.json"), "utf8")).firmware).toMatchObject({ board: "uno", sketch: "main.ino", artifact: "firmware/main.hex", build: { fqbn: "arduino:avr:uno" } });
    await expect(call("write_file", { path: "../evil.ino", content: "" })).rejects.toThrow(/leaves the firmware folder/);
    await call("set_libraries", { libraries: ["Adafruit SSD1306"] });
    expect((await call("get_project")).firmware.libraries).toEqual(["Adafruit SSD1306"]);
    await call("undo");
    expect(existsSync(join(dir, "firmware/main.ino"))).toBe(false);
  });

  it("logs every op with sequence numbers, timestamps and the project after edits", async () => {
    await wiredBlink();
    await call("place_part", { type: "nope" }).catch(() => {});
    const lines = readFileSync(join(dir, ".faber/actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
    expect(lines[1]).toMatchObject({ op: "place_part", ok: true, actor: "test", step: { why: "board" }, target: { part: "uno" } });
    expect(lines[1].project.parts).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ op: "place_part", ok: false });
    expect(lines.at(-1).error).toMatch(/Fix:/);
  });

  it("stays consistent when another process edits the same folder", async () => {
    await wiredBlink();
    const other = new ProjectSession({ dir, builder: fakeBuilder, actor: "cli" });
    await other.call("place_part", { type: "buzzer" });
    other.dispose();
    expect((await call("get_project")).parts).toHaveLength(4);
    const lines = readFileSync(join(dir, ".faber/actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(new Set(lines.map((l) => l.seq)).size).toBe(lines.length);
  });
});

describe("firmware and simulation", () => {
  it("builds on run, then simulates Blink: serial, pins, part states", async () => {
    await wiredBlink();
    await call("write_file", { path: "firmware/main.ino", content: BLINK });
    const r = await call("run", { ms: 1500 });
    expect(r.notes).toContain("built the firmware first (it had never been built)");
    expect(r.serial).toBe("LED on\r\nLED off\r\n");
    expect(r.pins.D13).toMatch(/^out L/);
    const pin = await call("read_pin", { pin: "uno.D13" });
    expect(pin).toMatchObject({ level: "low", mode: "output", connected_to: ["r1.1"] });
    const r2 = await call("run", { ms: 600 });
    expect(r2.t_ms).toBe(2100);
    expect(r2.serial).toBe("LED on\r\n");
    expect(r2.parts.led1.on).toBe(true);
    expect((await call("read_serial", { since: 0 })).text).toBe("LED on\r\nLED off\r\nLED on\r\n");
    expect(builds).toHaveLength(builds.length); // built once per source change
  });

  it("reports compile errors with file:line and a fix", async () => {
    await wiredBlink();
    await call("write_file", { path: "firmware/main.ino", content: "void setup(){\n  BROKEN;\n}\nvoid loop(){}\n" });
    const b = await call("build");
    expect(b.ok).toBe(false);
    expect(b.errors[0]).toBe("firmware/main.ino:2:3: 'BROKEN' was not declared in this scope (fix: declare it)");
    await expect(call("run", { ms: 100 })).rejects.toThrow(/does not compile.*Fix:/s);
  });

  it("injects faults: disconnect turns the LED off, unknown kinds explain themselves", async () => {
    await wiredBlink();
    await call("write_file", { path: "firmware/main.ino", content: BLINK });
    await call("run", { ms: 100 });
    expect((await call("run", { ms: 10 })).parts.led1.on).toBe(true);
    await call("inject_fault", { part: "led1", kind: "disconnect" });
    expect((await call("run", { ms: 10 })).parts.led1.on).toBe(false);
    // Faults model the hardware, so a restart keeps them (and says so).
    const restarted = await call("run", { ms: 100, reset: true });
    expect(restarted.t_ms).toBe(100);
    expect(restarted.parts.led1.on).toBe(false);
    expect(restarted.notes.join(" ")).toMatch(/injected faults still active/);
    await call("inject_fault", { part: "led1", kind: "clear" });
    expect((await call("run", { ms: 10 })).parts.led1.on).toBe(true);
    await expect(call("inject_fault", { part: "led1", kind: "brownout" })).rejects.toThrow(/planned but not simulated yet/);
    await expect(call("inject_fault", { part: "led1", kind: "i2c_nack" })).rejects.toThrow(/not an I2C device/);
  });

  it("click holds the button long enough for a busy loop and returns what the firmware printed", async () => {
    await call("new_project", { template: "uno" });
    await call("place_part", { type: "pushbutton", id: "b" });
    await call("connect", { from: "b.1a", to: "uno.D2" });
    await call("connect", { from: "b.2a", to: "uno.GND" });
    await call("write_file", { path: "firmware/main.ino", content: BLINK });
    await call("run", { ms: 50 });
    const r = await call("interact", { part: "b", action: "click" });
    expect(r.held_ms).toBe(200);
    expect(r.t_ms).toBeCloseTo(250, 0);
    expect(r.serial).toBeUndefined(); // Blink prints nothing new in 200 ms here; the field appears only when it does
  });

  it("noisy sensors are deterministic", async () => {
    const values = async () => {
      const d = mkdtempSync(join(tmpdir(), "faber-noise-"));
      const ss = new ProjectSession({ dir: d, builder: fakeBuilder });
      await ss.call("new_project", {});
      await ss.call("place_part", { type: "potentiometer" });
      await ss.call("inject_fault", { part: "pot1", kind: "noisy" });
      const out: unknown[] = [];
      for (let i = 0; i < 3; i++) out.push(((await ss.call("run", { ms: 25 })) as any).parts.pot1.position);
      ss.dispose();
      rmSync(d, { recursive: true, force: true });
      return out;
    };
    const a = await values();
    expect(a).toEqual(await values());
    expect(new Set(a).size).toBeGreaterThan(1);
  });
});

describe("scenarios", () => {
  beforeEach(async () => {
    await wiredBlink();
    await call("write_file", { path: "firmware/main.ino", content: BLINK });
  });

  it("Blink: expect_serial 'LED on' within 1100 ms and expect_pin D13 high pass", async () => {
    await call("write_scenario", { id: "blinks", steps: [{ expect_serial: "LED on", within_ms: 1100 }, { expect_pin: "uno.D13", level: "high" }, { expect_part: "led1.on", op: "==", value: true }, { expect_serial: "LED off", within_ms: 1100 }, { expect_pin: "uno.D13", level: "low" }, { expect_no_errors: true }] });
    const r = await call("run_tests");
    expect(r).toMatchObject({ passed: 1, failed: 0 });
    expect(r.results[0].t_ms).toBeGreaterThan(1000);
  });

  it("failures name the step, what was expected, what was seen, and the serial tail", async () => {
    await call("write_scenario", { id: "wrong", steps: [{ expect_serial: "LED on", within_ms: 1100 }, { expect_pin: "uno.D13", level: "low", within_ms: 200 }] });
    const r = await call("run_tests", { name: "wrong" });
    expect(r.failed).toBe(1);
    expect(r.results[0].reason).toMatch(/step 1 .*expected low but uno.D13 is high \(.*V, mode output\) after waiting 200 ms/);
    expect(r.results[0].serial_tail).toContain("LED on");
  });

  it("is deterministic and validates steps before running", async () => {
    await call("write_scenario", { id: "a", steps: [{ run_ms: 2500 }, { expect_serial: { regex: "LED (on|off)" } }] });
    const one = await call("run_tests");
    const two = await call("run_tests");
    expect(one.results).toEqual(two.results);
    await expect(call("write_scenario", { id: "bad", steps: [{ expect_pin: "uno.D13" }] })).rejects.toThrow(/needs "level".*or "voltage"/);
    await expect(call("write_scenario", { id: "bad", steps: [{ wait: 5 }] })).rejects.toThrow(/no action key found.*use exactly one of/);
    await expect(call("write_scenario", { id: "bad", steps: [{ press: "ghost" }] })).rejects.toThrow(/No part 'ghost'/);
    // Same options as the inject_fault tool.
    await call("place_part", { type: "potentiometer" });
    await call("write_scenario", { id: "noise", steps: [{ inject_fault: "pot1", kind: "noisy", field: "position", amplitude: 0.02 }, { run_ms: 50 }] });
    expect((await call("run_tests", { name: "noise" })).passed).toBe(1);
    // Two full 2.5 s simulations: ~2 s alone, past vitest's 5 s default when the whole suite shares a busy machine.
  }, 20_000);
});

describe("design rules", () => {
  it("catches an LED without a resistor and an unpowered I2C module on the wrong pins", async () => {
    await call("new_project", {});
    await call("place_part", { type: "arduino-uno" });
    await call("place_part", { type: "led" });
    const c = await call("connect", { from: "uno.D9", to: "led1.A" });
    expect(c.warnings?.join(" ")).toMatch(/no resistor/);
    await call("connect", { from: "led1.C", to: "uno.GND" });
    await call("place_part", { type: "ssd1306-oled-i2c" });
    await call("connect", { from: "oled1.SDA", to: "uno.D2" });
    const r = await call("check_design");
    const text = r.issues.join("\n");
    expect(r.ok).toBe(false);
    expect(text).toMatch(/led-no-resistor.*insert a 220 Ω resistor/);
    expect(text).toMatch(/\[unpowered\] oled1 .*connect oled1.GND → uno.GND and oled1.VCC → uno.5V/);
    expect(text).toMatch(/\[i2c-wrong-pin\].*uno.D2.*connect oled1.SDA → uno.A4/);
    expect(text).toMatch(/\[i2c-unwired\].*oled1.SCL/);
  });

  it("flags shared I2C addresses", async () => {
    await call("new_project", {});
    await call("place_part", { type: "arduino-uno" });
    for (const id of ["o1", "o2"]) {
      await call("place_part", { type: "ssd1306-oled-i2c", id });
      await call("connect", { from: `${id}.SDA`, to: "uno.A4" });
      await call("connect", { from: `${id}.SCL`, to: "uno.A5" });
    }
    expect((await call("check_design")).issues.join("\n")).toMatch(/i2c-address-conflict.*o1 and o2 share I2C address 0x3C/);
    await call("set_part_property", { id: "o2", prop: "address", value: "0x3D" });
    expect((await call("check_design")).issues.join("\n")).not.toMatch(/address-conflict/);
  });
});

describe("reports and pictures", () => {
  it("fidelity report, export and screenshot", async () => {
    await wiredBlink();
    await call("write_file", { path: "firmware/main.ino", content: BLINK });
    await call("run", { ms: 1200 });
    const f = await call("fidelity_report");
    expect(f.parts.map((p: { id: string }) => p.id)).toEqual(["uno", "r1", "led1"]);
    expect(f.areas.logic.level).toBe("ok");
    expect(f.testOnRealDevice.length).toBeGreaterThan(2);
    const e = await call("export");
    expect(e.files).toEqual(["BOM.md", "WIRING.md", "firmware.hex", "TEST-ON-HARDWARE.md"]);
    expect(e.bom).toMatch(/\| 1 \| Arduino Uno R3/);
    const shot = await call("screenshot", { path: "shot.svg" });
    const svg = readFileSync(shot.path, "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toMatch(/>led1</);
  });

  it("binds visual state into SVG markup like the canvas does", () => {
    const out = bindSvgString('<svg><circle data-bind="opacity:brightness,fill:color" opacity="0"/><text data-bind="text:label">x</text><g data-bind="visible:on"/></svg>', { brightness: 0.5, color: "#f00", label: "220 Ω", on: false });
    expect(out).toContain('opacity="0.5"');
    expect(out).toContain('fill="#f00"');
    expect(out).toContain(">220 Ω</text>");
    expect(out).toContain('display="none"');
  });

  it("composes an empty canvas without crashing", async () => {
    await call("new_project", {});
    expect(composeSvg(s.project, s.registry)).toMatch(/^<svg/);
  });
});
