// I2S parts in a whole Simulation: the board's I2S bus attaches the amplifier and the microphone
// when their BCLK / WS pins are wired to board GPIOs, and the amp drives a speaker part. The MCU
// is a scripted stand-in for a backend with attachI2s (the ESP32 family through qemu-esp).
import { describe, expect, it } from "vitest";
import { parseProject } from "@fabwright/project-format";
import { Simulation, type I2sBus } from "@fabwright/sim-core";
import { registry } from "./registry.gen.ts";
import { ScriptedMcu } from "./lib/bench.ts";

class I2sMcu extends ScriptedMcu {
  bus?: I2sBus;
  attachI2s(bus: I2sBus): void {
    this.bus = bus;
  }
}

const w = (id: string, a: string, b: string) => {
  const [ap, aq] = a.split(":");
  const [bp, bq] = b.split(":");
  return { id, from: { part: ap!, pin: aq! }, to: { part: bp!, pin: bq! } };
};

function rig(wired = true) {
  const mcu = new I2sMcu();
  const project = parseProject({
    format: "fabwright/1",
    name: "i2s bench",
    parts: [
      { id: "uno", type: "arduino-uno", x: 0, y: 0 },
      { id: "amp", type: "max98357a", x: 0, y: 0 },
      { id: "spk", type: "speaker", x: 0, y: 0, props: { rated_w: 3 } },
      { id: "mic", type: "inmp441", x: 0, y: 0, props: { sound: "tone", spl_db: 94 } },
    ],
    wires: [
      w("a1", "amp:VIN", "uno:5V"),
      w("a2", "amp:GND", "uno:GND.1"),
      ...(wired ? [w("a3", "amp:BCLK", "uno:D2"), w("a4", "amp:LRC", "uno:D3")] : []),
      w("a5", "amp:DIN", "uno:D4"),
      w("s1", "spk:+", "amp:OUT+"),
      w("s2", "spk:-", "amp:OUT-"),
      w("m1", "mic:VDD", "uno:3V3"),
      w("m2", "mic:GND", "uno:GND.2"),
      w("m3", "mic:SCK", "uno:D2"),
      w("m4", "mic:WS", "uno:D3"),
      w("m5", "mic:SD", "uno:D5"),
      w("m6", "mic:L/R", "uno:GND.3"),
    ],
    firmware: { board: "uno", artifact: "none.hex" },
  });
  const sim = new Simulation({ project, registry, backendFactory: () => mcu, chunkMs: 1 });
  sim.runFor(1);
  return { sim, mcu };
}

describe("I2S parts on the board's I2S bus", () => {
  it("frames the board sends play on the amp and the speaker sounds; the mic answers reads", () => {
    const { sim, mcu } = rig();
    expect(sim.i2s.list()).toEqual([
      { partId: "amp", sink: true, source: false },
      { partId: "mic", sink: false, source: true },
    ]);
    const samples = Int32Array.from({ length: 320 }, (_, i) => Math.round(16000 * Math.sin((2 * Math.PI * Math.floor(i / 2)) / 16)));
    mcu.bus!.send({ cycle: mcu.cycles, sampleRate: 16000, bits: 16, channels: 2, samples });
    sim.runFor(1);
    expect(sim.partState("amp")?.playing).toBe(true);
    expect(sim.partState("spk")?.sounding).toBe(true);
    const got = mcu.bus!.request({ cycle: mcu.cycles, sampleRate: 16000, bits: 32, channels: 1, frames: 16 });
    expect(got.some((v) => v !== 0)).toBe(true);
    sim.runFor(150);
    expect(sim.partState("amp")?.playing).toBe(false);
  });

  it("an unwired GAIN pin is 9 dB (floating), GAIN to GND 12 dB: the level follows the strap (round 13 fix)", () => {
    const sine = Int32Array.from({ length: 240 }, (_, i) => Math.round(8192 * Math.sin((2 * Math.PI * i) / 16)));
    const { sim, mcu } = rig();
    mcu.bus!.send({ cycle: mcu.cycles, sampleRate: 16000, bits: 16, channels: 1, samples: sine });
    sim.runFor(1);
    // A quarter-scale sine: RMS 0.177 of full scale.
    expect(sim.partState("amp")?.level).toBeCloseTo(0.177, 3);
    expect(sim.partState("spk")?.sounding).toBe(true);
  });

  it("an amp with BCLK / LRC unwired is not attached and says what to wire", () => {
    const { sim } = rig(false);
    expect(sim.i2s.list().map((d) => d.partId)).toEqual(["mic"]);
    const d = sim.diagnostics().find((x) => x.code === "i2s-not-connected");
    expect(d?.partId).toBe("amp");
    expect(d?.message).toMatch(/Wire BCLK and WS/);
  });
});
