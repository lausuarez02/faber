import { describe, expect, it } from "vitest";
import { registry } from "../../registry.gen.ts";
import { exampleSim } from "../../lib/exampleSim.ts";
import { need } from "../../lib/bench.ts";
import { serialLines } from "../../lib/firmwareBench.ts";
import { timedMount } from "../../lib/timedBench.ts";
import { dhtFrame, dhtWaveform } from "./model.ts";

const def = need(registry.get("dht22"), "dht22");

describe("dht22: protocol", () => {
  it("encodes humidity, temperature (with sign bit) and the checksum", () => {
    expect(dhtFrame(22.5, 55.1)).toEqual([0x02, 0x27, 0x00, 0xe1, (0x02 + 0x27 + 0x00 + 0xe1) & 0xff]);
    expect(dhtFrame(-10.1, 30)).toEqual([0x01, 0x2c, 0x80, 0x65, (0x01 + 0x2c + 0x80 + 0x65) & 0xff]);
  });

  it("answers a start pulse with 80/80 µs then 40 bits of 50 + 26/70 µs", () => {
    const w = dhtWaveform(dhtFrame(22.5, 55.1));
    expect(w.slice(0, 2)).toEqual([[0, 80], [1, 80]]);
    expect(w).toHaveLength(2 + 80 + 1);
    expect(w[3]).toEqual([1, 26]); // first bit of 0x02 is 0
    expect(w[15]).toEqual([1, 70]); // 7th bit of 0x02 is 1
  });

  it("drives DATA from scheduled events after a ≥ 0.8 ms start pulse", () => {
    const t = timedMount(def, { wiring: { VCC: "vcc", DATA: "d" } });
    t.set("vcc", 5);
    t.advance(1100);
    t.set("d", 0);
    t.advance(1);
    const r = t.set("d", undefined); // host releases
    expect(r.voltage("d")).toBeCloseTo(5, 1);
    t.advance(0.05); // 30 µs response delay + into the 80 µs LOW
    expect(t.result!.voltage("d")).toBeLessThan(0.1);
    expect(t.model.visualState()).toMatchObject({ sending: true, reads: 1 });
    t.advance(6);
    expect(t.model.visualState().sending).toBe(false);
    expect(t.result!.voltage("d")).toBeCloseTo(5, 1);
  });

  it("ignores a start pulse in the first second after power-up and says why", () => {
    const t = timedMount(def, { wiring: { VCC: "vcc", DATA: "d" } });
    t.set("vcc", 5);
    t.set("d", 0);
    t.advance(1);
    t.set("d", undefined);
    t.advance(1);
    expect(t.model.visualState().reads).toBe(0);
    expect(t.model.diagnostics!().map((d) => d.code)).toContain("dht-read-too-early");
  });
});

describe("dht22: real firmware (library-free reader, example.ino)", () => {
  it("reads the values set, one reading behind as the datasheet says", () => {
    const sim = exampleSim("dht22", [{ id: "dht", type: "dht22", x: 0, y: 0, props: { temperature: 23.4, humidity: 61.2 } }], [
      ["dht.VCC", "uno.5V"],
      ["dht.GND", "uno.GND.1"],
      ["dht.DATA", "uno.D2"],
    ]);
    sim.runFor(1700);
    expect(serialLines(sim)).toEqual(["T=23.4 H=61.2"]);
    sim.interact("dht", { kind: "set", key: "temperature", value: -5.5 });
    sim.interact("dht", { kind: "set", key: "humidity", value: 40 });
    sim.runFor(2100);
    // Read 2 returns the measurement taken at read 1 (still 23.4 / 61.2)…
    expect(serialLines(sim).at(-1)).toBe("T=23.4 H=61.2");
    sim.runFor(2100);
    // …read 3 the new one, including the negative temperature.
    expect(serialLines(sim).at(-1)).toBe("T=-5.5 H=40.0");
    expect(sim.partState("dht")!.reads).toBe(3);
  }, 60_000);

  it("reports a failed read when the sensor has no supply", () => {
    const sim = exampleSim("dht22", [{ id: "dht", type: "dht22", x: 0, y: 0 }], [
      ["dht.GND", "uno.GND.1"],
      ["dht.DATA", "uno.D2"],
    ]);
    sim.runFor(1700);
    expect(serialLines(sim)).toEqual(["DHT read failed"]);
  }, 60_000);
});

