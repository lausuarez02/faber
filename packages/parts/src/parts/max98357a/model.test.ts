import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("max98357a"), "max98357a");

const sine = (n: number, amp: number, channels = 2) =>
  Int32Array.from({ length: n * channels }, (_, i) => Math.round(amp * 32767 * Math.sin((2 * Math.PI * Math.floor(i / channels)) / 16)));

describe("max98357a", () => {
  it("plays a full-scale I2S sine on 5 V: ~2.5 V RMS into the speaker terminals, level ~0.71", () => {
    const b = mount(def, { wiring: { VIN: "v", "OUT+": "a", "OUT-": "b" } });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    b.model.i2s!.i2sReceive!({ cycle: 0, sampleRate: 16000, bits: 16, channels: 2, samples: sine(160, 1) });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    const s = b.model.visualState();
    expect(s.playing).toBe(true);
    expect(Number(s.level)).toBeCloseTo(0.707, 2);
    expect(Number(s.outVrms)).toBeCloseTo(2.55, 1);
    expect(s.sampleRate).toBe(16000);
  });

  it("SD at GND shuts it down: no output", () => {
    const b = mount(def, { wiring: { VIN: "v", SD: GROUND, "OUT+": "a", "OUT-": "b" } });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    b.model.i2s!.i2sReceive!({ cycle: 0, sampleRate: 16000, bits: 16, channels: 2, samples: sine(160, 1) });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    expect(b.model.visualState().playing).toBe(false);
    expect(b.model.visualState().outVrms).toBe(0);
  });

  it("silence plays nothing; under 2.5 V it warns with a fix", () => {
    const b = mount(def, { wiring: { VIN: "v" } });
    b.solve((c) => c.voltageSource("v", GROUND, 2, 0.01));
    b.model.i2s!.i2sReceive!({ cycle: 0, sampleRate: 16000, bits: 16, channels: 1, samples: new Int32Array(64) });
    expect(b.model.visualState().playing).toBe(false);
    expect(b.model.diagnostics?.()[0]?.message).toMatch(/Fix:/);
  });
});
