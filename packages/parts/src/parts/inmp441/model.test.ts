import { describe, expect, it } from "vitest";
import { GROUND } from "@fabwright/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("inmp441"), "inmp441");
const rms = (s: Int32Array, full: number) => Math.sqrt(s.reduce((a, v) => a + (v / full) ** 2, 0) / s.length);

describe("inmp441", () => {
  it("a 94 dB SPL tone reads -26 dBFS, as 24-bit data in 32-bit slots, phase-continuous across blocks", () => {
    const b = mount(def, { props: { sound: "tone", spl_db: 94, tone_hz: 1000 }, wiring: { VDD: "v", "L/R": GROUND } });
    b.solve((c) => c.voltageSource("v", GROUND, 3.3, 0.01));
    const a = b.model.i2s!.i2sProvide!({ cycle: 0, sampleRate: 16000, bits: 32, channels: 1, frames: 160 })!;
    const db = 20 * Math.log10(rms(a, 2 ** 31));
    expect(db).toBeCloseTo(-26, 0);
    expect(a.every((v) => v % 256 === 0)).toBe(true);
    const next = b.model.i2s!.i2sProvide!({ cycle: 0, sampleRate: 16000, bits: 32, channels: 1, frames: 1 })!;
    expect(next[0]).toBe(a[0]); // 160 frames = 10 whole periods of 1 kHz at 16 kHz
  });

  it("stereo slots: L/R at GND fills the left channel only; silence is zeros", () => {
    const b = mount(def, { props: { sound: "noise", spl_db: 80 }, wiring: { VDD: "v", "L/R": GROUND } });
    b.solve((c) => c.voltageSource("v", GROUND, 3.3, 0.01));
    const s = b.model.i2s!.i2sProvide!({ cycle: 0, sampleRate: 16000, bits: 16, channels: 2, frames: 32 })!;
    expect(s.filter((_, i) => i % 2 === 1).every((v) => v === 0)).toBe(true);
    expect(s.filter((_, i) => i % 2 === 0).some((v) => v !== 0)).toBe(true);
    b.model.setProp("sound", "silence");
    expect(b.model.i2s!.i2sProvide!({ cycle: 0, sampleRate: 16000, bits: 16, channels: 1, frames: 8 })!.every((v) => v === 0)).toBe(true);
  });

  it("unpowered sends nothing; on 5 V it is an error with a fix", () => {
    const b = mount(def, { wiring: { VDD: "v" } });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    expect(b.model.diagnostics?.()[0]).toMatchObject({ severity: "error", code: "inmp441-overvoltage" });
    const off = mount(def, {});
    off.solve();
    expect(off.model.i2s!.i2sProvide!({ cycle: 0, sampleRate: 16000, bits: 16, channels: 1, frames: 4 })).toBeUndefined();
  });
});
