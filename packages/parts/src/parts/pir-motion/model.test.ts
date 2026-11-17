import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need, supply } from "../../lib/bench.ts";
import { timedMount } from "../../lib/timedBench.ts";

const def = need(registry.get("pir-motion"), "pir-motion");
const wiring = { VCC: "vcc", OUT: "out", GND: GROUND };

describe("pir-motion", () => {
  it("drives OUT to 3.3 V on motion", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 5));
    expect(b.result!.voltage("out")).toBeLessThan(0.01);
    expect(b.interact({ kind: "press" }).voltage("out")).toBeCloseTo(3.3, 1);
  });

  it("repeat mode: holds OUT until delay_s after the last motion, then blocks for 2.5 s", () => {
    const t = timedMount(def, { wiring, props: { delay_s: 3 } });
    t.set("vcc", 5);
    t.model.interact!({ kind: "press" });
    t.solve();
    expect(t.result!.voltage("out")).toBeCloseTo(3.3, 1);
    t.advance(2000);
    t.model.interact!({ kind: "release" }); // motion stops at 2 s → OUT until 5 s
    t.advance(2900);
    expect(t.model.visualState().out).toBe(true);
    t.advance(200);
    expect(t.model.visualState()).toMatchObject({ out: false, state: "blocked", triggers: 1 });
    t.model.interact!({ kind: "press" }); // ignored while blocked…
    t.advance(1000);
    expect(t.model.visualState().out).toBe(false);
    t.advance(1600); // …and picked up when the block ends
    expect(t.model.visualState()).toMatchObject({ out: true, triggers: 2 });
  });

  it("single mode: one fixed pulse even while motion continues", () => {
    const t = timedMount(def, { wiring, props: { delay_s: 3, retrigger: "single" } });
    t.set("vcc", 5);
    t.model.interact!({ kind: "set", key: "motion", value: 1 });
    t.advance(2900);
    expect(t.model.visualState().out).toBe(true);
    t.advance(200);
    expect(t.model.visualState().out).toBe(false);
    t.advance(2500);
    expect(t.model.visualState()).toMatchObject({ out: true, triggers: 2 });
  });

  it("ignores motion during warm-up", () => {
    const t = timedMount(def, { wiring, props: { warmup_s: 30 } });
    t.set("vcc", 5);
    t.model.interact!({ kind: "press" });
    t.advance(10_000);
    expect(t.model.visualState()).toMatchObject({ out: false, state: "warming up" });
    expect(t.model.diagnostics!().map((d) => d.code)).toContain("pir-warming-up");
    t.advance(20_100);
    expect(t.model.visualState().out).toBe(true);
  });

  it("does nothing on 3.3 V and says why", () => {
    const b = mount(def, { wiring });
    b.solve(supply("vcc", 3.3));
    b.interact({ kind: "press" });
    expect(b.result!.voltage("out")).toBeLessThan(0.01);
    expect(b.model.diagnostics!()[0]!.code).toBe("pir-undervoltage");
  });
});
