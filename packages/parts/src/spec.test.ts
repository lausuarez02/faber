// Validates EVERY part folder in src/parts/: schemas, pin anchors, SVG, bindings vs the model's
// visualState, and that src/registry.gen.ts is up to date. A new part folder is picked up automatically.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBindings, type PartContext } from "@jumper/sim-core";
import { PARTS_DIR, REGISTRY_FILE, listPartFolders, renderRegistry } from "../scripts/registry-codegen.ts";
import { checkPartFolder, boundKeys } from "./spec/validate.ts";
import { parseSvg } from "./spec/svg.ts";
import { mount, ScriptedMcu } from "./lib/bench.ts";
import { getPart, listParts, parts, partDefinitions, registry, searchParts } from "./index.ts";

const folders = listPartFolders();

describe("part spec", () => {
  it("has the M0 part set", () => {
    expect(folders).toEqual(
      expect.arrayContaining([
        "arduino-uno", "arduino-nano", "led", "rgb-led", "resistor",
        "pushbutton", "slide-switch", "potentiometer", "photoresistor", "buzzer",
      ]),
    );
  });

  it("src/registry.gen.ts is up to date (run `pnpm gen`)", () => {
    const { code, problems } = renderRegistry();
    expect(problems).toEqual([]);
    expect(readFileSync(REGISTRY_FILE, "utf8")).toBe(code);
    expect(partDefinitions.map((d) => d.spec.id)).toEqual(folders);
  });

  describe.each(folders)("%s", (dir) => {
    const folder = checkPartFolder(PARTS_DIR, dir);

    it("passes the static checks (part.json, fidelity.json, visual.svg, pin anchors)", () => {
      expect(folder.problems).toEqual([]);
      expect(folder.spec).toBeDefined();
      expect(folder.fidelity).toBeDefined();
      expect(folder.parsed).toBeDefined();
    });

    it("places every pin anchor inside the viewBox", () => {
      const s = folder.spec!;
      for (const p of s.pins) {
        expect(p.x, p.id).toBeGreaterThanOrEqual(0);
        expect(p.x, p.id).toBeLessThanOrEqual(s.size.w);
        expect(p.y, p.id).toBeGreaterThanOrEqual(0);
        expect(p.y, p.id).toBeLessThanOrEqual(s.size.h);
      }
    });

    it("binds only keys that the model's visualState() produces", () => {
      const def = registry.get(dir)!;
      expect(def, "in registry").toBeDefined();
      // Boards get a fake MCU so pin_* keys exist too.
      const b = mount(def, def.spec.mcu ? { mcu: new ScriptedMcu() } : {});
      b.solve();
      const state = b.model.visualState();
      for (const key of boundKeys(folder.parsed!)) expect(Object.keys(state), `data-bind key '${key}'`).toContain(key);
      // and every documented binding (except pattern keys like pin_<id>) is produced
      for (const bnd of def.spec.bindings ?? []) {
        if (bnd.key.includes("<")) continue;
        expect(Object.keys(state), `documented binding '${bnd.key}'`).toContain(bnd.key);
        expect(typeof state[bnd.key], `type of '${bnd.key}'`).toBe(bnd.type);
      }
    });

    it("model survives every prop at min/default/max and every interaction", () => {
      const def = registry.get(dir)!;
      const b = mount(def);
      b.solve();
      for (const p of def.spec.props ?? []) {
        const values = p.type === "enum" ? (p.options ?? []).map((o) => (typeof o === "string" ? o : o.value)) : [p.min, p.default, p.max].filter((v) => v !== undefined);
        for (const v of values) {
          const r = b.setProp(p.id, v as number | string | boolean);
          expect(r.converged).toBe(true);
          for (const val of Object.values(b.model.visualState())) {
            if (typeof val === "number") expect(Number.isFinite(val), `${p.id}=${String(v)}`).toBe(true);
          }
        }
      }
      if (b.model.interact) {
        for (const e of [{ kind: "press" as const }, { kind: "release" as const }, { kind: "set" as const, value: 1 }]) {
          expect(() => b.interact(e)).not.toThrow();
        }
      }
      expect(Array.isArray(b.model.diagnostics?.() ?? [])).toBe(true);
    });

    it("touches only its own pins", () => {
      const def = registry.get(dir)!;
      const asked = new Set<string>();
      const b = mount(def);
      const ctx = b.ctx as PartContext & { node(pin: string): string };
      const orig = ctx.node.bind(ctx);
      (ctx as { node: (p: string) => string }).node = (pin: string) => {
        asked.add(pin);
        return orig(pin);
      };
      b.solve();
      const pins = new Set(def.spec.pins.map((p) => p.id));
      for (const p of asked) expect(pins, p).toContain(p);
    });
  });
});

describe("svg reader", () => {
  it("rejects malformed markup with a line number", () => {
    expect(() => parseSvg('<svg viewBox="0 0 1 1"><g></svg>')).toThrow(/closes <g>/);
    expect(() => parseSvg("<svg><rect x=1/></svg>")).toThrow(/quoted/);
    expect(() => parseSvg("<g/>")).toThrow(/expected <svg>/);
    expect(() => parseSvg("<svg>\n<rect/>\n<rect")).toThrow(/line 3/);
  });
  it("collects data-bind entries", () => {
    const s = parseSvg('<svg viewBox="0 0 1 1"><circle data-bind="opacity:brightness,fill:color"/></svg>');
    expect([...boundKeys(s)]).toEqual(["brightness", "color"]);
    expect(parseBindings("transform:knobTransform")).toEqual([{ attr: "transform", key: "knobTransform" }]);
  });
});

describe("package API", () => {
  it("lists, gets and searches parts", () => {
    expect(listParts().map((d) => d.spec.id)).toEqual(folders);
    expect(listParts("board").map((d) => d.spec.id)).toEqual(["arduino-nano", "arduino-nano-33-ble", "arduino-uno", "esp32-c3-supermini", "esp32-devkitc", "esp32-s3-devkitc-1", "raspberry-pi-pico", "seeed-xiao-esp32c3", "seeed-xiao-esp32s3", "seeed-xiao-nrf52840", "seeed-xiao-rp2040", "stm32-blackpill-f411", "stm32-bluepill", "stm32-nucleo-f401re", "waveshare-rp2040-zero"]);
    expect(getPart("led")?.spec.name).toMatch(/LED/);
    expect(getPart("nope")).toBeUndefined();
    expect(parts.resistor?.spec.id).toBe("resistor");
    expect(searchParts("led")[0]!.spec.id).toBe("led");
    expect(searchParts("LED").map((d) => d.spec.id)).toContain("rgb-led");
    expect(searchParts("light sensor")[0]!.spec.id).toBe("photoresistor");
    expect(searchParts("ldr")[0]!.spec.id).toBe("photoresistor");
    expect(searchParts("uno")[0]!.spec.id).toBe("arduino-uno");
    expect(searchParts("knob")[0]!.spec.id).toBe("potentiometer");
    expect(searchParts("zzz")).toEqual([]);
    expect(searchParts("  ")).toHaveLength(folders.length);
  });
});
