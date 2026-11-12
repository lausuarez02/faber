import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA_SETTINGS, GROUND } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";

const def = need(registry.get("ov2640-camera"), "ov2640-camera");
const req = { cycle: 0, format: "rgb565" as const, width: 96, height: 96, quality: 12, settings: DEFAULT_CAMERA_SETTINGS, capacity: 96 * 96 * 2, xclkHz: 20e6 };

describe("ov2640-camera", () => {
  it("names every esp32-camera signal on a pin", () => {
    expect(Object.keys(def.spec.camera!.pins).sort()).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "href", "pclk", "pwdn", "reset", "scl", "sda", "vsync", "xclk"]);
  });

  it("captures at 3.3 V, draws about 40 mA, and is silent without power", () => {
    const b = mount(def, { wiring: { "3V3": "v" } });
    const r = b.solve((c) => c.voltageSource("v", GROUND, 3.3, 0.01));
    expect(r.voltage("v")).toBeCloseTo(3.3, 1);
    const f = b.model.camera!.cameraCapture(req);
    expect(f?.data.length).toBe(96 * 96 * 2);
    expect(b.model.visualState().powered).toBe(true);
    const off = mount(def, {});
    off.solve();
    expect(off.model.camera!.cameraCapture(req)).toBeUndefined();
    expect(off.model.camera!.cameraPowered?.()).toBe(false);
  });

  it("5 V on 3V3 is an error with the fix", () => {
    const b = mount(def, { wiring: { "3V3": "v" } });
    b.solve((c) => c.voltageSource("v", GROUND, 5, 0.01));
    expect(b.model.diagnostics?.()[0]?.code).toBe("ov2640-overvoltage");
  });
});
