import { describe, expect, it } from "vitest";
import { parseProject, type ProjectInput } from "@faber/project-format";
import { registry } from "@faber/parts";
import { createRegistry, type PartDefinition } from "@faber/sim-core";
import { checkDesign } from "../src/index.ts";

// Round 5 (decision 0003, C5): check_design fixes from the persona report.

type W = [string, string];
function project(parts: [string, string, Record<string, unknown>?][], wires: W[], extra: Partial<ProjectInput> = {}) {
  return parseProject({
    format: "faber/1",
    name: "t",
    parts: parts.map(([id, type, o], i) => ({ id, type, x: (o?.x as number) ?? i * 120, y: (o?.y as number) ?? 0, ...(o?.props ? { props: o.props } : {}) })),
    wires: wires.map(([a, b], i) => {
      const cut = (r: string) => [r.slice(0, r.indexOf(".")), r.slice(r.indexOf(".") + 1)];
      const [ap, an] = cut(a);
      const [bp, bn] = cut(b);
      return { id: `w${i + 1}`, from: { part: ap!, pin: an! }, to: { part: bp!, pin: bn! } };
    }),
    scenarios: [],
    ...extra,
  } as ProjectInput);
}
const codes = (p: ReturnType<typeof project>, reg = registry) => {
  const all = checkDesign(p, reg).map((i) => `${i.severity}:${i.code}`);
  expect(all).not.toContain("error:bad-pin");
  return all;
};
const msgs = (p: ReturnType<typeof project>, code: string, reg = registry) => checkDesign(p, reg).filter((i) => i.code === code).map((i) => i.message);

// A 3.3 V board (the rp2040 track ships the real ones): an Arduino Nano's drawing with RP2040 numbers.
const nano = registry.get("arduino-nano")!;
const pico33: PartDefinition = {
  ...nano,
  spec: {
    ...nano.spec,
    id: "fake-pico",
    name: "Fake 3.3 V board",
    mcu: { backend: "rp2040js", chip: "rp2040", clockHz: 125_000_000, vcc: 3.3 },
    pins: [
      ...nano.spec.pins.map((p) => (p.type === "digital" || p.type === "analog" ? { ...p, voltage: { min: 0, max: 3.3 } } : p)),
      { id: "VBUS", label: "VBUS", x: 0, y: 0, type: "power" as const, voltage: { min: 4.75, max: 5.25 } },
    ],
  },
};
const reg33 = createRegistry([...registry.list(), pico33]);

describe("led-no-resistor along the whole path", () => {
  it("a resistor on the cathode side is fine (persona b3 false positive)", () => {
    const p = project([["uno", "arduino-uno"], ["pump", "led"], ["r1", "resistor"]], [["pump.A", "uno.5V"], ["pump.C", "r1.1"], ["r1.2", "uno.GND.1"]]);
    expect(codes(p)).not.toContain("error:led-no-resistor");
  });
  it("two LEDs in series with one resistor past the second are fine; none at all is still an error", () => {
    const ok = project([["uno", "arduino-uno"], ["l1", "led"], ["l2", "led"], ["r1", "resistor"]], [["uno.D13", "l1.A"], ["l1.C", "l2.A"], ["l2.C", "r1.1"], ["r1.2", "uno.GND.1"]]);
    expect(codes(ok)).not.toContain("error:led-no-resistor");
    const bad = project([["uno", "arduino-uno"], ["l1", "led"]], [["uno.D13", "l1.A"], ["l1.C", "uno.GND.1"]]);
    expect(msgs(bad, "led-no-resistor").join()).toMatch(/l1\.A is wired straight to uno\.D13.*insert a 220 Ω resistor.*either side works/);
  });
  it("a resistor hanging off the LED's net with its other end free does not count", () => {
    const p = project([["uno", "arduino-uno"], ["l1", "led"], ["r1", "resistor"]], [["uno.D13", "l1.A"], ["uno.D13", "r1.1"], ["l1.C", "uno.GND.1"]]);
    expect(codes(p)).toContain("error:led-no-resistor");
  });
  it("an RGB LED: a resistor on the common leg covers the colours", () => {
    const p = project([["uno", "arduino-uno"], ["rgb", "rgb-led"], ["r1", "resistor"]], [["uno.D9", "rgb.R"], ["uno.D10", "rgb.G"], ["rgb.COM", "r1.1"], ["r1.2", "uno.GND.1"]]);
    expect(codes(p)).not.toContain("error:led-no-resistor");
  });
});

describe("voltage by direction", () => {
  it("a 3.3 V output into a 5 V input is fine (persona b1: ESP-01 TX into uno.D2)", () => {
    const p = project([["uno", "arduino-uno"], ["esp", "esp01-wifi"]], [["esp.TX", "uno.D2"], ["esp.VCC", "uno.3V3"], ["esp.GND", "uno.GND.1"]]);
    expect(codes(p).filter((c) => /overvoltage|logic-level/.test(c))).toEqual([]);
  });
  it("a 5 V output straight into a 3.3 V input is an error; through a divider it is not", () => {
    const direct = project([["uno", "arduino-uno"], ["esp", "esp01-wifi"]], [["uno.D3", "esp.RX"]]);
    expect(msgs(direct, "logic-level").join()).toMatch(/uno\.D3 drives 5 V into esp\.RX, which takes at most 3\.6 V.*divider/);
    const divided = project([["uno", "arduino-uno"], ["esp", "esp01-wifi"], ["r1", "resistor"], ["r2", "resistor"]], [["uno.D3", "r1.1"], ["r1.2", "esp.RX"], ["esp.RX", "r2.1"], ["r2.2", "uno.GND.1"]]);
    expect(codes(divided)).not.toContain("error:logic-level");
  });
  it("a 5 V module output into a 3.3 V board pin is an error (HC-SR04 ECHO on a 3.3 V board)", () => {
    const p = project([["b", "fake-pico"], ["sonar", "hc-sr04"]], [["sonar.VCC", "b.VBUS"], ["sonar.GND", "b.GND.1"], ["sonar.ECHO", "b.D3"], ["b.D2", "sonar.TRIG"]]);
    const lv = msgs(p, "logic-level", reg33);
    expect(lv.join()).toMatch(/sonar\.ECHO drives 5\.25 V into b\.D3, which takes at most 3\.3 V/);
    expect(lv.join()).not.toMatch(/TRIG/); // 3.3 V into the sonar's 5 V input is fine
  });
  it("a supply above a module's rating is overvoltage; below its minimum is part-needs-5v", () => {
    expect(msgs(project([["uno", "arduino-uno"], ["esp", "esp01-wifi"]], [["esp.VCC", "uno.5V"], ["esp.GND", "uno.GND.1"]]), "overvoltage").join()).toMatch(/5\.25 V on a 3\.6 V supply pin: esp\.VCC/);
    expect(msgs(project([["uno", "arduino-uno"], ["sonar", "hc-sr04"]], [["sonar.VCC", "uno.3V3"], ["sonar.GND", "uno.GND.1"]]), "part-needs-5v").join()).toMatch(/sonar \(.*\) needs at least 4\.5 V on VCC.*uno\.3V3/);
  });
});

describe("supplies", () => {
  it("two regulator outputs on one net (persona b4: L298N 5V tied to uno.5V)", () => {
    const p = project([["uno", "arduino-uno"], ["drv", "l298n"]], [["drv.5V", "uno.5V"], ["drv.GND", "uno.GND.1"]]);
    expect(msgs(p, "parallel-regulators").join()).toMatch(/drv\.5V and uno\.5V .*both supply outputs.*5V-EN jumper/);
    const off = project([["uno", "arduino-uno"], ["drv", "l298n", { props: { regulatorJumper: false } }]], [["drv.5V", "uno.5V"], ["drv.GND", "uno.GND.1"]]);
    expect(codes(off)).not.toContain("warning:parallel-regulators");
  });
  it("an L298N's 5V output may stay unwired", () => {
    const p = project([["uno", "arduino-uno"], ["drv", "l298n"], ["bat", "battery-pack"]], [["bat.POS", "drv.12V"], ["bat.NEG", "drv.GND"], ["drv.GND", "uno.GND.1"]]);
    expect(codes(p)).not.toContain("error:unconnected-supply");
  });
  it("the 3V3 pin's budget: 50 mA on an Uno, 300 mA on an RP2040 board", () => {
    const uno = project([["uno", "arduino-uno"], ["esp", "esp01-wifi"]], [["esp.VCC", "uno.3V3"], ["esp.GND", "uno.GND.1"]]);
    expect(msgs(uno, "rail-3v3-budget").join()).toMatch(/uno's 3V3 pin gives about 50 mA, but esp 80 mA \(peaks 300 mA\).*AMS1117/);
    const pico = project([["b", "fake-pico"], ["esp", "esp01-wifi"]], [["esp.VCC", "b.3V3"], ["esp.GND", "b.GND.1"]]);
    expect(codes(pico, reg33)).not.toContain("warning:rail-3v3-budget");
  });
});

describe("layout", () => {
  it("far-apart: a part more than 600 px from everything it is wired to (info)", () => {
    const far = project([["uno", "arduino-uno", { x: 0 }], ["r1", "resistor", { x: 1500, y: 900 }]], [["uno.D13", "r1.1"]]);
    const i = checkDesign(far, registry).find((x) => x.code === "far-apart");
    expect(i?.severity).toBe("info");
    expect(i?.message).toMatch(/r1 is about \d+ px from the nearest part it is wired to \(uno\).*move_part r1 next to uno/);
    const near = project([["uno", "arduino-uno", { x: 0 }], ["r1", "resistor", { x: 600, y: -100 }]], [["uno.D13", "r1.1"]]);
    expect(codes(near)).not.toContain("info:far-apart");
  });
});
