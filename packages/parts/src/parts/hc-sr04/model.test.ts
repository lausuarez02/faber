import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { exampleSim } from "../../lib/exampleSim.ts";
import { timedMount } from "../../lib/timedBench.ts";
import { BURST_DELAY_US, echoMicros, TIMEOUT_US } from "./model.ts";

const def = need(registry.get("hc-sr04"), "hc-sr04");

const rig = (distance: number, vcc = 5) => {
  const b = timedMount(def, { props: { distance }, wiring: { VCC: "vcc", TRIG: "trig", ECHO: "echo" } });
  b.extra((c) => void c.resistor("echo", "0", 1e6, { id: "mcu-input" }));
  b.set("vcc", vcc);
  b.set("trig", 0);
  return b;
};

/** Pulse TRIG for `us`, then return [echo rise, echo fall] in µs after the falling edge (1 µs resolution). */
function ping(b: ReturnType<typeof rig>, us = 10): [number, number] | undefined {
  b.set("trig", 5);
  b.advance(us / 1000);
  b.set("trig", 0);
  const t0 = b.now();
  let rise: number | undefined;
  for (let i = 0; i < 45_000; i++) {
    b.advance(0.001);
    const high = b.result!.voltage("echo") > 2.5;
    const t = Math.round((b.now() - t0) * 1000);
    if (high && rise === undefined) rise = t;
    if (!high && rise !== undefined) return [rise, t];
  }
  return undefined;
}

describe("hc-sr04", () => {
  it("echo pulse = 58.2 µs per cm (20 °C), starting 460 µs after the trigger", () => {
    const b = rig(100);
    const r = ping(b)!;
    expect(r[0]).toBe(BURST_DELAY_US);
    const width = r[1] - r[0];
    expect(width).toBeGreaterThanOrEqual(Math.floor(echoMicros(100)));
    expect(width).toBeLessThanOrEqual(Math.ceil(echoMicros(100)));
    expect(echoMicros(100)).toBeCloseTo(5824, -1);
    // what a sketch computes with the usual /58:
    expect(Math.round(width / 58)).toBe(100);
    expect(b.model.visualState()).toMatchObject({ pings: 1, echo: false, measuring: false });
  });

  it("covers 2–400 cm and times out after 38 ms beyond", () => {
    for (const cm of [2, 10, 57, 400]) {
      const r = ping(rig(cm))!;
      expect(Math.round((r[1] - r[0]) / 58.2), `${cm} cm`).toBe(cm);
    }
    const far = ping(rig(450))!;
    expect(far[1] - far[0]).toBe(TIMEOUT_US);
    const none = ping(rig(0))!;
    expect(none[1] - none[0]).toBe(TIMEOUT_US);
    expect(rig(450).model.visualState().label).toBe("> 400 cm");
  });

  it("ignores a trigger shorter than 10 µs and says how to fix it", () => {
    const b = rig(50);
    expect(ping(b, 4)).toBeUndefined();
    const d = b.model.diagnostics!().find((x) => x.code === "hc-sr04-short-trigger");
    expect(d?.message).toMatch(/4\.0 µs.*delayMicroseconds\(10\)/s);
  });

  it("ignores triggers while busy and follows a distance set during the run", () => {
    const b = rig(30);
    b.set("trig", 5);
    b.advance(0.01);
    b.set("trig", 0);
    b.advance(0.6); // echo is high now
    b.set("trig", 5);
    b.advance(0.01);
    b.set("trig", 0);
    b.advance(40);
    expect(b.model.visualState().pings).toBe(1);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("hc-sr04-busy");
    b.model.interact!({ kind: "set", key: "distance", value: 20 });
    const r = ping(b)!;
    expect(Math.round((r[1] - r[0]) / 58.2)).toBe(20);
  });

  it("does nothing without power and reports it", () => {
    const b = rig(50, 0);
    expect(ping(b)).toBeUndefined();
    expect(b.model.diagnostics!().find((d) => d.code === "hc-sr04-unpowered")?.severity).toBe("error");
  });

  it("speed of sound follows temperature", () => {
    expect(echoMicros(100, 0)).toBeGreaterThan(echoMicros(100, 30));
    expect(echoMicros(100, 20)).toBeCloseTo((2 / 343.42) * 1e6, 0);
  });
});

describe("hc-sr04 example.ino on the Uno", { timeout: 60_000 }, () => {
  const run = (cm: number) => {
    const sim = exampleSim("hc-sr04", [{ id: "sonar", type: "hc-sr04", x: 0, y: 0, props: { distance: cm } }], [
      ["uno.5V", "sonar.VCC"],
      ["sonar.GND", "uno.GND.1"],
      ["uno.D9", "sonar.TRIG"],
      ["sonar.ECHO", "uno.D10"],
    ]);
    sim.runFor(250);
    return sim.serialText().trim().split(/\r?\n/);
  };
  it("prints the distance (µs / 58, so the same or 1 cm less)", () => {
    expect(["42 cm", "41 cm"]).toContain(run(42)[0]);
    expect(run(450)[0]).toBe("out of range");
  });
});
