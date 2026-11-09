import { parseProject } from "@jumper/project-format";
import { Simulation, createRegistry } from "@jumper/sim-core";
import { describe, expect, it } from "vitest";
import { registry } from "../registry.gen.ts";
import { compileCustomPart, CustomPartError } from "./compile.ts";
import { encodeField, interpolate } from "./models.ts";
import { withProjectParts } from "./overlay.ts";
import { sanitizeSvg, SvgError } from "./sanitize.ts";

describe("sanitizeSvg", () => {
  const clean = (svg: string) => sanitizeSvg(svg, "p");

  it("keeps ordinary drawing markup and bindings", () => {
    const r = clean('<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#123" data-bind="opacity:ledOpacity"/><text x="1" y="9" font-family="IBM Plex Mono">Hi &amp; bye</text></svg>');
    expect(r.removed).toEqual([]);
    expect(r.svg).toContain('data-bind="opacity:ledOpacity"');
    expect(r.svg).toContain("Hi &amp; bye");
    expect(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it("removes scripts, event handlers, foreignObject, style and animation", () => {
    const r = clean(
      '<svg onload="alert(1)"><script>alert(2)</script><g ONCLICK="x()"><rect width="1" height="1"/></g><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(3)"/></div></foreignObject><style>@import url(http://evil/a.css);</style><set attributeName="onmouseover" to="alert(4)"/><animate attributeName="href" values="javascript:alert(5)"/></svg>',
    );
    expect(r.svg).not.toMatch(/script|alert|onload|onclick|foreignObject|style|import|<set|animate|evil/i);
    expect(r.svg).toContain("<rect");
    expect(r.removed.join("\n")).toMatch(/<script>/);
    expect(r.removed.join("\n")).toMatch(/event handler onload/);
  });

  it("allows only #id links and inline raster images", () => {
    const r = clean(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"/></defs><use href="#g"/><use xlink:href="https://evil.example/x.svg#a"/><a href="javascript:alert(1)"><rect width="1" height="1"/></a><image href="https://evil.example/t.png"/><image href="data:image/svg+xml;base64,PHN2Zz4="/><image href="data:image/png;base64,iVBORw0KGgo="/><rect fill="url(#g)" stroke="url(https://evil.example/f)"/><rect style="fill:url(&#x27;http://evil&#x27;)"/></svg>',
    );
    expect(r.svg).not.toMatch(/evil|javascript|svg\+xml/);
    expect(r.svg).toContain('href="#p-g"');
    expect(r.svg).toContain('id="p-g"');
    expect(r.svg).toContain('fill="url(#p-g)"');
    expect(r.svg).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(r.svg.match(/<image/g)).toHaveLength(1);
  });

  it("decodes entities before checking, so encoded javascript: does not slip through", () => {
    const r = clean('<svg><use href="&#106;avascript:alert(1)"/><rect fill="u&#114;l(http://x)"/></svg>');
    expect(r.svg).not.toMatch(/javascript|http:\/\/x/);
  });

  it("refuses DOCTYPE / entities, bad markup and huge files with a line number", () => {
    expect(() => clean('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toThrow(SvgError);
    expect(() => clean("<svg><g></svg>")).toThrow(/line 1: <\/svg> closes <g>/);
    expect(() => clean("<div/>")).toThrow(/root element is <div>/);
    expect(() => clean(`<svg>${"<g/>".repeat(70000)}</svg>`)).toThrow(/KB/);
  });

  it("drops unknown namespaces' content but keeps the document valid", () => {
    const r = clean('<svg><x:foo xmlns:x="urn:x"><rect/></x:foo><circle r="2"/></svg>');
    expect(r.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>');
  });
});

describe("helpers", () => {
  it("interpolates a curve and encodes register fields", () => {
    expect(interpolate([{ x: 0, y: 3 }, { x: 100, y: 1 }], 25)).toBe(2.5);
    expect(interpolate([{ x: 0, y: 3 }, { x: 100, y: 1 }], 140)).toBe(1);
    expect(encodeField(22.5, 100, 0, 2, true, "big")).toEqual([0x08, 0xca]);
    expect(encodeField(-5.25, 100, 0, 2, true, "big")).toEqual([0xfd, 0xf3]);
    expect(encodeField(-5.25, 100, 0, 2, true, "little")).toEqual([0xf3, 0xfd]);
    expect(encodeField(1e9, 1, 0, 1, false, "big")).toEqual([0xff]);
  });
});

const sensor = {
  id: "flex-sensor",
  name: "Flex sensor 2.2 in",
  category: "sensor",
  description: "Bend sensor module.",
  pins: [{ id: "VCC", type: "power" }, { id: "GND", type: "ground" }, { id: "SIG", type: "analog" }, { id: "DO", type: "digital" }],
  behavior: { kind: "analog-sensor", output: "SIG", quantity: { id: "bend", unit: "°", min: 0, max: 90, default: 0 }, curve: [{ value: 0, volts: 1 }, { value: 90, volts: 4 }], digital: { output: "DO", threshold: 45 } },
};

function bench(defs: ReturnType<typeof compileCustomPart>["def"][], parts: { id: string; type: string }[], wires: [string, string][]) {
  const reg = withProjectParts(registry);
  reg.setProjectParts(defs);
  const project = parseProject({
    format: "jumper/1",
    name: "t",
    parts: [{ id: "uno", type: "arduino-uno", x: 0, y: 0 }, ...parts.map((p) => ({ ...p, x: 0, y: 0 }))],
    wires: wires.map(([a, b], i) => ({ id: `w${i}`, from: { part: a.split(".")[0]!, pin: a.split(".")[1]! }, to: { part: b.split(".")[0]!, pin: b.split(".").slice(1).join(".") } })),
  });
  return new Simulation({ project, registry: reg, backendFactory: () => undefined as never });
}

describe("compileCustomPart", () => {
  it("compiles an analog sensor with a generated drawing and an agent-made fidelity", () => {
    const c = compileCustomPart(sensor);
    expect(c.generatedSvg).toBe(true);
    expect(c.svg).toMatch(/AGENT-MADE/);
    for (const p of c.def.spec.pins) expect(c.svg).toContain(`data-pin="${p.id}" cx="${p.x}" cy="${p.y}"`);
    expect(c.def.fidelity).toMatchObject({ level: "behavioral", origin: "agent-made" });
    expect(c.def.fidelity.testOnRealDevice[0]).toMatch(/agent-made: behavioral, unverified/);
    expect(c.def.spec.props?.[0]).toMatchObject({ id: "bend", type: "number", min: 0, max: 90 });
    expect(c.def.spec.tags).toContain("agent-made");
  });

  it("runs the analog curve and comparator in the circuit (no firmware needed)", () => {
    const c = compileCustomPart(sensor);
    const sim = bench([c.def], [{ id: "flex", type: "flex-sensor" }], [["flex.VCC", "uno.5V"], ["flex.GND", "uno.GND.1"], ["flex.SIG", "uno.A0"]]);
    sim.solve();
    expect(sim.partState("flex")).toMatchObject({ bend: 0, volts: 1, powered: true, triggered: false });
    sim.setProp("flex", "bend", 60);
    sim.solve();
    expect(Number(sim.partState("flex")!.volts)).toBeCloseTo(3, 2);
    expect(sim.partState("flex")!.triggered).toBe(true);
  });

  it("an unpowered part reads off and says how to power it", () => {
    const c = compileCustomPart(sensor);
    const sim = bench([c.def], [{ id: "flex", type: "flex-sensor" }], [["flex.SIG", "uno.A0"]]);
    sim.solve();
    expect(sim.partState("flex")).toMatchObject({ powered: false, label: "off" });
    expect(sim.diagnostics().map((d) => d.message).join("\n")).toMatch(/Wire flex:VCC to 5V or 3V3/);
  });

  it("a load actuator follows the voltage across it", () => {
    const motor = compileCustomPart({
      id: "vibration-motor",
      name: "Coin vibration motor",
      category: "motor",
      description: "3 V coin motor.",
      pins: [{ id: "+", type: "passive" }, { id: "-", type: "passive" }],
      behavior: { kind: "actuator", drive: "load", plus: "+", minus: "-", rated_v: 5, rated_ma: 100, effect: { id: "rpm", at_full: 12000 } },
    });
    const sim = bench([motor.def], [{ id: "m", type: "vibration-motor" }], [["m.+", "uno.5V"], ["m.-", "uno.GND.1"]]);
    sim.solve();
    expect(sim.partState("m")).toMatchObject({ on: true, direction: 1 });
    expect(Number(sim.partState("m")!.rpm)).toBeGreaterThan(11900);
    expect(Number(sim.partState("m")!.current_ma)).toBeCloseTo(100, 0);
  });

  it("a digital input drives its pin from a boolean field (push-pull and open-drain)", () => {
    const mk = (drive: string, active_level: string) =>
      compileCustomPart({ id: `ir-${drive}`, name: "IR obstacle", category: "sensor", description: "IR obstacle module.", pins: [{ id: "VCC", type: "power" }, { id: "GND", type: "ground" }, { id: "OUT", type: "digital" }], behavior: { kind: "digital-input", output: "OUT", field: "obstacle", active_level, drive } });
    const pp = mk("push-pull", "low");
    const od = mk("open-drain", "low");
    const sim = bench([pp.def, od.def], [{ id: "a", type: "ir-push-pull" }, { id: "b", type: "ir-open-drain" }], [["a.VCC", "uno.5V"], ["a.GND", "uno.GND.1"], ["b.VCC", "uno.5V"], ["b.GND", "uno.GND.2"]]);
    sim.solve();
    expect(sim.partState("a")).toMatchObject({ obstacle: false, level: 1 });
    sim.interact("a", { kind: "set", key: "obstacle", value: true });
    sim.interact("b", { kind: "press" });
    expect(sim.partState("a")).toMatchObject({ obstacle: true, level: 0, ledOpacity: 1 });
    expect(sim.partState("b")).toMatchObject({ obstacle: true, level: 0 });
  });

  it("a display reuses a controller with its module pins, a custom resolution and a round bezel", () => {
    const c = compileCustomPart({ id: "st7789-240", name: "1.3 in ST7789 240x240 IPS", category: "display", description: "Square IPS TFT.", behavior: { kind: "display", controller: "st7735", resolution: { w: 240, h: 240 }, round: true } });
    expect(c.def.spec.pins.map((p) => p.id).sort()).toEqual(registry.get("st7735-tft")!.spec.pins.map((p) => p.id).sort());
    expect(c.svg).toContain('data-screen="240x240"');
    expect(c.svg).toContain('fill-rule="evenodd"');
    const sim = bench([c.def], [{ id: "tft", type: "st7789-240" }], [["tft.VCC", "uno.5V"], ["tft.GND", "uno.GND.1"]]);
    sim.solve();
    expect(sim.framebuffer("tft")).toMatchObject({ width: 240, height: 240 });
    const oled = compileCustomPart({ id: "oled-yellow", name: "OLED 0.96 in", category: "display", description: "SSD1306 module.", behavior: { kind: "display", controller: "ssd1306" } });
    expect(oled.def.spec.bus?.i2c?.addresses).toEqual([60, 61]);
    expect(oled.svg).toContain('data-screen="128x64"');
  });

  it("an agent SVG needs size and pin positions, and must mark a display's screen", () => {
    const withSvg = { ...sensor, size: { w: 100, h: 40 }, pins: sensor.pins.map((p, i) => ({ ...p, x: 10 + i * 20, y: 35 })) };
    const c = compileCustomPart(withSvg, '<svg viewBox="0 0 1 1"><script>x</script><rect width="100" height="40"/></svg>');
    expect(c.generatedSvg).toBe(false);
    expect(c.svg).toContain('viewBox="0 0 100 40"');
    expect(c.warnings.join("\n")).toMatch(/removed <script>/);
    expect(() => compileCustomPart(sensor, "<svg/>")).toThrow(/size: an SVG needs.*pins: VCC, GND, SIG, DO need x and y/);
    expect(() => compileCustomPart({ id: "d", name: "d", category: "display", description: "d", size: { w: 10, h: 10 }, pins: registry.get("ssd1306-oled-i2c")!.spec.pins.map((p) => ({ ...p })), behavior: { kind: "display", controller: "ssd1306" } }, "<svg/>")).toThrow(/data-screen="128x64"/);
  });

  it("explains every problem at once", () => {
    let err: unknown;
    try {
      compileCustomPart({
        id: "temp",
        name: "t",
        category: "sensor",
        description: "t",
        pins: [{ id: "VCC", type: "power" }, { id: "VCC", type: "ground" }],
        behavior: { kind: "i2c-device", address: 0x40, registers: [{ reg: 0, bytes: 2 }, { reg: 1 }] },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CustomPartError);
    const e = err as CustomPartError;
    expect(e.problems.join("\n")).toMatch(/'VCC' appears twice/);
    expect(e.problems.join("\n")).toMatch(/i2c-sda/);
    expect(e.problems.join("\n")).toMatch(/overlaps registers\[0\]/);
    expect(e.message).toMatch(/Why: .*Fix: /);
  });

  it("gc9a01 needs the built-in GC9A01 part", () => {
    const empty = createRegistry([]);
    expect(() => compileCustomPart({ id: "round", name: "r", category: "display", description: "r", behavior: { kind: "display", controller: "gc9a01" } }, undefined, { builtins: empty })).toThrow(/not available yet/);
  });

  it("the overlay lets a project part shadow a built-in id with a warning", () => {
    const reg = withProjectParts(registry);
    const c = compileCustomPart({ ...sensor, id: "flex-sensor" });
    expect(reg.setProjectParts([{ ...c.def, spec: { ...c.def.spec, id: "led" } }])[0]).toMatch(/same id as a built-in/);
    expect(reg.get("led")!.fidelity.origin).toBe("agent-made");
    expect(reg.list().filter((d) => d.spec.id === "led")).toHaveLength(1);
  });
});
