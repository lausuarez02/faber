// End to end without a browser: the real examples/blink/jumper.json, the real part registry,
// the real avr8js backend and the committed golden Blink firmware.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject } from "@jumper/project-format";
import { Simulation } from "@jumper/sim-core";
import { backendFactory } from "@jumper/sim-backends";
import { registry } from "./registry.gen.ts";

const exampleDir = new URL("../../../examples/blink/", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, exampleDir)), "utf8");

const project = parseProject(read("jumper.json"));
const firmware = read(project.firmware!.artifact);

describe("examples/blink with the real parts registry", { timeout: 60_000 }, () => {
  it("jumper.json points at the golden firmware, identical to the arduino-cli build output", () => {
    expect(project.firmware?.artifact).toBe("firmware/blink.hex");
    expect(firmware).toBe(read("firmware/build/blink.ino.hex"));
    for (const p of project.parts) expect(registry.get(p.type), p.type).toBeDefined();
  });

  it("blinks the LED on D13: ~12 mA for 1 s, dark for 1 s, L LED in step, serial in order", () => {
    const sim = new Simulation({ project, registry, backendFactory, firmware });
    expect(sim.boardId).toBe("uno");

    sim.runFor(500);
    const on = sim.partState("led1")!;
    expect(on.on).toBe(true);
    expect(Number(on.currentmA)).toBeGreaterThan(11);
    expect(Number(on.currentmA)).toBeLessThan(13.5);
    expect(sim.partState("uno")).toMatchObject({ led_l: 1 });

    sim.runFor(1000); // t = 1.5 s
    expect(sim.partState("led1")).toMatchObject({ on: false });
    expect(sim.partState("uno")).toMatchObject({ led_l: 0 });

    sim.runFor(1000); // t = 2.5 s
    expect(sim.partState("led1")).toMatchObject({ on: true });
    expect(sim.serialText()).toBe("LED on\r\nLED off\r\nLED on\r\n");
    expect(sim.diagnostics().filter((d) => d.severity !== "info")).toEqual([]);
    sim.dispose();
  });

  it("is deterministic under animation-frame slicing", () => {
    const a = new Simulation({ project, registry, backendFactory, firmware });
    const b = new Simulation({ project, registry, backendFactory, firmware });
    a.runFor(2100);
    for (let i = 0; i < 131; i++) b.runFor(16);
    b.runFor(4);
    expect(a.traceHash()).toBe(b.traceHash());
    expect(Math.abs(a.timeMs - b.timeMs)).toBeLessThan(0.001);
  });
});
