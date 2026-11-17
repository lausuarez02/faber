import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { need } from "../../lib/bench.ts";
import { pwmReading, timedMount } from "../../lib/timedBench.ts";

const def = need(registry.get("vibration-motor"), "vibration-motor");
const wiring = { VCC: "vcc", IN: "in", GND: GROUND };

describe("vibration-motor", () => {
  it("vibrates at the rated ~12 000 rpm and ~75 mA when IN is HIGH on 3.3 V", () => {
    const t = timedMount(def, { wiring });
    t.set("vcc", 3.3);
    t.set("in", 0);
    t.advance(200);
    expect(t.model.visualState().running).toBe(false);
    t.set("in", 3.3);
    t.advance(400);
    const s = t.model.visualState();
    expect(s.running).toBe(true);
    expect(Number(s.rpm)).toBeGreaterThan(10_500);
    expect(Number(s.rpm)).toBeLessThan(13_500);
    expect(Number(s.currentmA)).toBeGreaterThan(65);
    expect(Number(s.currentmA)).toBeLessThan(90);
    t.set("in", 0);
    t.advance(400);
    expect(t.model.visualState().running).toBe(false);
  });

  it("runs faster on 5 V", () => {
    const t = timedMount(def, { wiring });
    t.set("vcc", 5);
    t.set("in", 5);
    t.advance(400);
    expect(Number(t.model.visualState().rpm)).toBeGreaterThan(15_000);
  });

  it("is weaker with analogWrite on IN", () => {
    const t = timedMount(def, { wiring });
    t.pwm.set("IN", pwmReading(0.5, 490, "mcu:D5"));
    t.set("vcc", 3.3);
    t.set("in", 1.65);
    t.advance(500);
    const s = Number(t.model.visualState().strength);
    expect(s).toBeGreaterThan(0.2);
    expect(s).toBeLessThan(0.75);
  });

  it("draws only a few mA from the pin", () => {
    const t = timedMount(def, { wiring });
    t.set("vcc", 5);
    const r = t.set("in", 5);
    expect(((5 - r.voltage("vibration-motor#b")) / 1000) * 1000).toBeLessThan(5);
  });

  it("says why it does not vibrate without VCC", () => {
    const t = timedMount(def, { wiring });
    t.set("in", 5);
    t.advance(50);
    expect(t.model.diagnostics!().map((d) => d.code)).toContain("vibration-unpowered");
  });
});
