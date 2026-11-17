// Integration: sim-core's Simulation driving the real avr8js backend with the golden Blink firmware.
// The parts here are minimal in-test stand-ins (same pin ids/props as the real @fabwright/parts
// arduino-uno / resistor / led). The same scenario against the real registry and the real
// examples/blink/fabwright.json is packages/parts/src/blink.integration.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createMcuBoardModel,
  createRegistry,
  Simulation,
  type ElementId,
  type Fidelity,
  type PartDefinition,
  type PartSpec,
} from "@fabwright/sim-core";
import { backendFactory } from "./index.ts";

type Project = ConstructorParameters<typeof Simulation>[0]["project"];

const BLINK_HEX = readFileSync(
  fileURLToPath(new URL("../../../examples/blink/firmware/build/blink.ino.hex", import.meta.url)),
  "utf8",
);

const fid: Fidelity = {
  level: "behavioral",
  areas: {
    logic: { level: "ok", note: "" },
    timing: { level: "ok", note: "" },
    analog: { level: "approx", note: "" },
    power: { level: "n/a", note: "" },
    radio: { level: "n/a", note: "" },
  },
  emulates: [],
  doesNotEmulate: [],
  testOnRealDevice: [],
};
const pin = (id: string, type: PartSpec["pins"][number]["type"] = "passive") => ({ id, label: id, x: 0, y: 0, type });
const gpio = [...Array.from({ length: 14 }, (_, i) => `D${i}`), ...Array.from({ length: 6 }, (_, i) => `A${i}`)];

const uno: PartDefinition = {
  spec: {
    id: "arduino-uno",
    name: "Arduino Uno (test stand-in)",
    category: "board",
    description: "",
    size: { w: 10, h: 10 },
    pins: [...gpio.map((g) => pin(g, "digital")), pin("5V", "power"), pin("GND.1", "ground"), pin("GND.2", "ground")],
    mcu: { backend: "avr8js", chip: "atmega328p", clockHz: 16_000_000, vcc: 5, fqbn: "arduino:avr:uno" },
  },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) =>
    createMcuBoardModel(ctx, { rails: { "5V": 5 }, visual: () => ({ led_l: ctx.mcu?.readPin("D13").value ?? 0 }) }),
};

const resistor: PartDefinition = {
  spec: {
    id: "resistor",
    name: "Resistor",
    category: "passive",
    description: "",
    size: { w: 10, h: 10 },
    pins: [pin("1"), pin("2")],
    props: [{ id: "resistance", label: "R", type: "number", default: 220, unit: "Ω" }],
  },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => {
    let ohms = Number(ctx.props.resistance);
    return {
      stamp: (c) => void c.resistor(ctx.node("1"), ctx.node("2"), ohms),
      visualState: () => ({ resistance: ohms }),
      setProp: (id, v) => {
        if (id === "resistance") ohms = Number(v);
      },
    };
  },
};

const led: PartDefinition = {
  spec: {
    id: "led",
    name: "LED",
    category: "output",
    description: "",
    size: { w: 10, h: 10 },
    pins: [pin("A"), pin("C")],
    limits: { maxCurrentmA: 20 },
  },
  fidelity: fid,
  svg: "<svg/>",
  create: (ctx) => {
    let id: ElementId = "";
    let mA = 0;
    return {
      stamp: (c) => {
        id = c.led(ctx.node("A"), ctx.node("C"), { vf: 2.0, rOn: 5 });
      },
      onSolved: (r) => {
        mA = r.current(id) * 1000;
      },
      visualState: () => ({ brightness: Math.max(0, Math.min(1, mA / 20)), currentmA: mA }),
      setProp: () => {},
    };
  },
};

const registry = createRegistry([uno, resistor, led]);

const project: Project = {
  format: "fabwright/1",
  name: "Blink",
  parts: [
    { id: "uno", type: "arduino-uno", x: 0, y: 0, rotation: 0 },
    { id: "r1", type: "resistor", x: 300, y: 0, rotation: 0, props: { resistance: 220 } },
    { id: "led1", type: "led", x: 400, y: 0, rotation: 0 },
  ],
  wires: [
    { id: "w1", from: { part: "uno", pin: "D13" }, to: { part: "r1", pin: "1" } },
    { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" } },
    { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "uno", pin: "GND.1" } },
  ],
  firmware: { board: "uno", dir: "firmware", artifact: "firmware/build/blink.ino.hex" },
  scenarios: [],
};

const brightness = (sim: Simulation) => Number(sim.partState("led1")?.brightness ?? -1);

describe("Simulation + avr8js: Uno → 220 Ω → red LED on D13", { timeout: 60_000 }, () => {
  it("lights the LED for 1 s, dark for 1 s, with (5 V − 2 V) / (25 Ω + 220 Ω + 5 Ω) = 12 mA through it", () => {
    const sim = new Simulation({ project, registry, backendFactory, firmware: BLINK_HEX });
    expect(sim.boardId).toBe("uno");
    sim.runFor(500);
    expect(sim.mcu?.readPin("D13")).toEqual({ mode: "output", value: 1 });
    expect(sim.pinVoltage("uno", "D13")).toBeGreaterThan(4.5);
    const mA = Number(sim.partState("led1")?.currentmA);
    expect(mA).toBeCloseTo(12, 2);
    expect(brightness(sim)).toBeGreaterThan(0.5);
    expect(sim.partState("uno")).toMatchObject({ led_l: 1, pin_D13: 1 });

    sim.runFor(1000); // t = 1.5 s: LOW
    expect(brightness(sim)).toBe(0);
    sim.runFor(1000); // t = 2.5 s: HIGH again
    expect(brightness(sim)).toBeGreaterThan(0.5);
    expect(sim.serialText()).toBe("LED on\r\nLED off\r\nLED on\r\n");
    expect(sim.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
    sim.dispose();
  });

  it("trace hash is identical across runs and frame slicing", () => {
    const a = new Simulation({ project, registry, backendFactory, firmware: BLINK_HEX });
    const b = new Simulation({ project, registry, backendFactory, firmware: BLINK_HEX, chunkMs: 4 });
    a.runFor(2200);
    for (let i = 0; i < 137; i++) b.runFor(16); // animation-frame sized slices
    b.runFor(8);
    // MCU steps may overshoot by one instruction; Simulation absorbs that overshoot in the next runFor, so
    // per-frame slicing ends within one instruction of a single long run. The trace must not differ at all.
    expect(Math.abs(b.timeMs - a.timeMs)).toBeLessThan(0.001);
    expect(a.traceHash()).toBe(b.traceHash());
    expect(a.trace.filter((e) => e.kind === "pin" && e.pin === "D13").length).toBeGreaterThanOrEqual(3);
  });
});
