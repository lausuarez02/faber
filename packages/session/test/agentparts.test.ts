// Agent-made parts (decision 0003, C4/C5): create_part / update_part / list_project_parts, and
// parts made that way working with real firmware like built-ins. The firmware is
// fixtures/agentparts/main.ino compiled by the Docker runner (arduino-cli 1.5.1, avr 1.8.8) into
// main.hex: it reads an I2C sensor at 0x40 (WHO_AM_I + temperature), an analog soil sensor on A0,
// a PIR on D4, pings a UART module on SoftwareSerial D2/D3 and switches a relay on D7.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildRequest, BuildResult } from "@jumper/runner";
import { composeSvg, ProjectSession } from "../src/index.ts";

const fx = (f: string) => fileURLToPath(new URL(`./fixtures/agentparts/${f}`, import.meta.url));
const HEX = readFileSync(fx("main.hex"), "utf8");
const SKETCH = readFileSync(fx("main.ino"), "utf8");
const PARTS = JSON.parse(readFileSync(fx("parts.json"), "utf8")) as Record<"soil" | "relay" | "pump" | "temp" | "pir" | "uart", Record<string, unknown>>;

async function fakeBuilder(_req: BuildRequest): Promise<BuildResult> {
  return { ok: true, hex: HEX, cached: false, durationMs: 1, hash: "agentparts", diagnostics: [], errors: 0, warnings: 0, libraries: [], logTail: "" };
}

let dir: string;
let s: ProjectSession;
const call = (op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jumper-agentparts-"));
  s = new ProjectSession({ dir, builder: fakeBuilder, actor: "test" });
});
afterEach(() => {
  s.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function plantRig() {
  await call("new_project", { template: "uno", name: "plant" });
  for (const p of Object.values(PARTS)) await call("create_part", { part: p, why: "parts the catalog lacks" });
  for (const [type, id] of [["soil-moisture-sensor", "soil"], ["relay-module-1ch", "relay"], ["mini-water-pump-5v", "pump"], ["tmp-sensor-x", "tmp"], ["pir-motion-sensor", "pir"], ["ping-module", "ping"]]) await call("place_part", { type, id });
  const wires = [
    ["soil.VCC", "uno.5V"], ["soil.GND", "uno.GND"], ["soil.AOUT", "uno.A0"],
    ["relay.VCC", "uno.5V"], ["relay.GND", "uno.GND"], ["relay.IN", "uno.D7"], ["relay.COM", "uno.5V"], ["relay.NO", "pump.+"], ["pump.-", "uno.GND"],
    ["tmp.VCC", "uno.5V"], ["tmp.GND", "uno.GND"], ["tmp.SDA", "uno.A4"], ["tmp.SCL", "uno.A5"],
    ["pir.VCC", "uno.5V"], ["pir.GND", "uno.GND"], ["pir.OUT", "uno.D4"],
    ["ping.VCC", "uno.5V"], ["ping.GND", "uno.GND"], ["ping.TX", "uno.D2"], ["ping.RX", "uno.D3"],
  ];
  for (const [from, to] of wires) await call("connect", { from, to });
  await call("write_file", { path: "firmware/main.ino", content: SKETCH });
  await call("remove", { id: "boots" }); // the uno template's scenario expects "ready"
}

describe("create_part", () => {
  it("writes parts/<id>/part.json as an undoable step and the part works with place_part", async () => {
    await call("new_project", { template: "uno" });
    const r = await call("create_part", { part: PARTS.soil, why: "no soil sensor in the catalog" });
    expect(r.type).toBe("soil-moisture-sensor");
    expect(r.fidelity).toBe("agent-made: behavioral, unverified");
    expect(r.state).toContain("moisture");
    expect(existsSync(join(dir, "parts/soil-moisture-sensor/part.json"))).toBe(true);
    const placed = await call("place_part", { type: "soil-moisture-sensor" });
    expect(placed.pins).toBe("GND VCC AOUT");
    const part = await call("get_part", { type: "soil-moisture-sensor" });
    expect(part.wiring).toContain("AOUT → A0");
    const found = await call("search_parts", { query: "soil" });
    expect(found.results[0]).toMatchObject({ type: "soil-moisture-sensor", fidelity: "agent-made: behavioral, unverified" });
    const list = await call("list_project_parts");
    expect(list.parts).toEqual([expect.objectContaining({ type: "soil-moisture-sensor", behavior: "analog-sensor", placed: ["soilmoisturesensor1"] })]);
    // Undo the placement and the part (same why = one step for the part, another for place_part).
    await call("undo");
    await call("undo");
    expect(existsSync(join(dir, "parts/soil-moisture-sensor/part.json"))).toBe(false);
    expect((await call("list_project_parts")).parts).toEqual([]);
    await expect(call("place_part", { type: "soil-moisture-sensor" })).rejects.toThrow(/No part type 'soil-moisture-sensor'/);
  });

  it("refuses built-in ids, duplicates and broken definitions with what / why / fix", async () => {
    await call("new_project", { template: "uno" });
    await expect(call("create_part", { part: { ...PARTS.soil, id: "led" } })).rejects.toThrow(/'led' is already a built-in part.*Fix: place it with place_part/);
    await call("create_part", { part: PARTS.soil });
    await expect(call("create_part", { part: PARTS.soil })).rejects.toThrow(/already has a part 'soil-moisture-sensor'.*update_part/);
    const bad = { ...PARTS.soil, id: "bad-sensor", behavior: { kind: "analog-sensor", output: "SIG", quantity: { id: "moisture", min: 0, max: 100, default: 140 }, curve: [{ value: 0, volts: 1 }, { value: 0, volts: 2 }] } };
    const err = await call("create_part", { part: bad }).catch((e: Error) => e);
    expect(String(err)).toMatch(/'SIG' is not one of the pins/);
    expect(String(err)).toMatch(/default 140 is outside 0..100/);
    expect(String(err)).toMatch(/same value/);
    expect(String(err)).toMatch(/Fix:/);
    await expect(call("create_part", { part: { id: "x" } })).rejects.toThrow(/part definition is invalid.*name/);
  });

  it("search_parts names create_part when nothing fits", async () => {
    const r = await call("search_parts", { query: "peristaltic" });
    expect(r.count).toBe(0);
    expect(r.hint).toMatch(/create_part/);
  });
});

describe("agent-made parts with real firmware", () => {
  it("an I2C sensor, an analog sensor, a relay + pump, a PIR and a UART module all work in run and tests", async () => {
    await plantRig();
    expect((await call("check_design")).errors).toBe(0);
    const run = await call("run", { ms: 400 });
    expect(run.serial).toMatch(/who=0xA7 err=0 t=22\.50 a0=46\d pump=off pir=0 uart=PONG 7/);
    expect(run.parts.tmp).toMatchObject({ address: "0x40", temperature: 22.5, config: 3, powered: true });
    expect(run.parts.pump).toMatchObject({ on: false, flow_ml_min: 0 });

    await call("write_scenario", {
      id: "dry-soil-runs-pump",
      steps: [
        { wait_ms: 300 },
        { expect_serial: "who=0xA7" },
        { set: "soil.moisture", value: 10 },
        { set: "tmp.temperature", value: -5.25 },
        { set: "pir.motion", value: true },
        { set: "ping.count", value: 42 },
        { wait_ms: 300 },
        { expect_serial: "t=-5.25 a0=5" },
        { expect_serial: "pump=on pir=1 uart=PONG 42" },
        { expect_part: "relay.on", op: "==", value: true },
        { expect_part: "pump.on", op: "==", value: true },
        { expect_part: "pump.flow_ml_min", op: ">", value: 1100 },
        { expect_part: "pump.current_ma", op: ">", value: 150 },
        { expect_part: "ping.lines_received", op: ">", value: 3 },
      ],
    });
    const t = await call("run_tests", { scenario: "dry-soil-runs-pump" });
    expect(t.failed, JSON.stringify(t.results?.[0]?.reason)).toBe(0);

    // Bus faults work on agent-made I2C parts like on built-ins.
    await call("inject_fault", { part: "tmp", kind: "i2c_nack" });
    const nack = await call("run", { ms: 300 });
    expect(nack.serial).toMatch(/who=0xFFFFFFFF err=2|who=0x[0-9A-F]+ err=2/);
  });

  it("update_part changes the running model, and the fidelity report and exports say agent-made", async () => {
    await plantRig();
    await call("run", { ms: 200 });
    const upd = { ...PARTS.temp, behavior: { ...(PARTS.temp.behavior as object), who_am_i: { reg: 0x0f, value: 0xb3 } } };
    const r = await call("update_part", { id: "tmp-sensor-x", part: upd, why: "fix chip id" });
    expect(r.next).toMatch(/restarts at 0 ms/);
    const run = await call("run", { ms: 200 });
    expect(run.serial).toMatch(/who=0xB3/);
    const relayNoNo = { ...PARTS.relay, pins: (PARTS.relay.pins as { id: string }[]).filter((p) => p.id !== "NO"), behavior: { ...(PARTS.relay.behavior as object), contacts: { com: "COM", nc: "NC" } } };
    await expect(call("update_part", { id: "relay-module-1ch", part: relayNoNo })).rejects.toThrow(/remove pins that wires use: w\d+ \(relay\.NO\).*Fix: disconnect/);

    // Headless screenshots (composeSvg) draw agent-made parts too.
    expect(composeSvg(s.project, s.registry)).toMatch(/AGENT-MADE/);
    const fid = await call("fidelity_report");
    expect(fid.parts.find((p: { id: string }) => p.id === "tmp").level).toBe("agent-made: behavioral, unverified");
    expect(fid.global.join("\n")).toMatch(/made by an agent/);
    await call("export", {});
    const bom = readFileSync(join(dir, "export/BOM.md"), "utf8");
    expect(bom).toMatch(/Mini submersible water pump 3-6 V \(agent-made: behavioral, unverified\)/);
    expect(readFileSync(join(dir, "export/WIRING.md"), "utf8")).toMatch(/agent-made: behavioral, unverified/);
  });

  it("a pump wired straight to a GPIO pin is flagged as an overload", async () => {
    await call("new_project", { template: "uno" });
    await call("create_part", { part: PARTS.pump });
    await call("place_part", { type: "mini-water-pump-5v", id: "pump" });
    await call("connect", { from: "pump.+", to: "uno.D7" });
    await call("connect", { from: "pump.-", to: "uno.GND" });
    await call("write_file", { path: "firmware/main.ino", content: SKETCH });
    const run = await call("run", { ms: 50 });
    expect(JSON.stringify(run.diagnostics)).toMatch(/gpio-overcurrent.*draws \d+ mA straight from a board pin.*transistor/);
  });

  it("an edited parts/ folder on disk is picked up, and a broken file is reported, not fatal", async () => {
    await call("new_project", { template: "uno" });
    await call("create_part", { part: PARTS.pir });
    writeFileSync(join(dir, "parts/pir-motion-sensor/part.json"), "{ not json");
    const list = await call("list_project_parts");
    expect(list.parts).toEqual([]);
    expect(list.problems[0]).toMatch(/not valid JSON/);
    await call("update_part", { id: "pir-motion-sensor", part: PARTS.pir });
    expect((await call("list_project_parts")).parts).toHaveLength(1);
  });
});
