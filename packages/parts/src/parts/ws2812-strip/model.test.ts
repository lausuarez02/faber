import { describe, expect, it } from "vitest";

import { registry } from "../../registry.gen.ts";
import { exampleSim } from "../../lib/exampleSim.ts";
import { mount, need, supply } from "../../lib/bench.ts";
import { serialLines } from "../../lib/firmwareBench.ts";

const def = need(registry.get("ws2812-strip"), "ws2812-strip");

describe("ws2812-strip: model", () => {
  it("shows count LEDs, draws idle current, and can be painted by set colors", () => {
    const b = mount(def, { wiring: { VCC: "v" }, props: { count: 4 } });
    b.solve(supply("v", 5));
    let s = b.model.visualState();
    expect(s).toMatchObject({ count: 4, show3: true, show4: false, lit: 0, colors: "#000000 #000000 #000000 #000000", currentmA: 4 });
    b.interact({ kind: "set", key: "colors", value: "#FF0000 #00FF00 #000080 #FFFFFF" });
    s = b.model.visualState();
    expect(s).toMatchObject({ lit: 4, led0: "#FF0000", led2: "#0000FF", colors: "#FF0000 #00FF00 #000080 #FFFFFF" });
    expect(Number(s.glow2)).toBeLessThan(Number(s.glow0));
    // 4 idle + red 20 + green 20 + blue 20·128/255 + white 60
    expect(Number(s.currentmA)).toBeCloseTo(4 + 20 + 20 + 10.04 + 60, 0);
  });

  it("warns when a full-white strip needs more than a USB 5V pin gives", () => {
    const b = mount(def, { wiring: { VCC: "v" }, props: { count: 8 } });
    b.solve(supply("v", 5));
    b.interact({ kind: "set", key: "colors", value: Array(8).fill("#FFFFFF").join(" ") });
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("ws2812-current");
  });
});

describe("ws2812-strip: real firmware (bit-banged 800 kHz on D6, example.ino)", () => {
  it("decodes the colours the sketch sends, frame by frame", () => {
    const sim = exampleSim("ws2812-strip", [{ id: "strip", type: "ws2812-strip", x: 0, y: 0 }], [
      ["strip.VCC", "uno.5V"],
      ["strip.GND", "uno.GND.1"],
      ["strip.DIN", "uno.D6"],
    ]);
    sim.runFor(50);
    expect(serialLines(sim)).toContain("frame 1");
    let s = sim.partState("strip")!;
    expect(s.colors).toBe("#FF0000 #00FF00 #0000FF #FFFFFF #100800 #000000 #000000 #000000");
    expect(s).toMatchObject({ frames: 1, lit: 5, led0: "#FF0000", led4: "#FF8000" });
    expect(sim.diagnostics().filter((d) => d.partId === "strip").map((d) => d.code)).not.toContain("ws2812-timing");
    sim.runFor(150);
    s = sim.partState("strip")!;
    expect(s.colors).toBe(Array(8).fill("#000028").join(" "));
    expect(s).toMatchObject({ frames: 2, lit: 8 });
  }, 60_000);

  it("keeps LEDs past the end of a shorter strip out and says so", () => {
    const sim = exampleSim("ws2812-strip", [{ id: "strip", type: "ws2812-strip", x: 0, y: 0, props: { count: 3 } }], [
      ["strip.VCC", "uno.5V"],
      ["strip.GND", "uno.GND.1"],
      ["strip.DIN", "uno.D6"],
    ]);
    sim.runFor(50);
    expect(sim.partState("strip")!.colors).toBe("#FF0000 #00FF00 #0000FF");
    expect(sim.diagnostics().map((d) => d.code)).toContain("ws2812-more-data");
  }, 60_000);
});


