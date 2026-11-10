import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registry } from "@jumper/parts";
import { SimHost } from "../src/sim.ts";
import { runScenario } from "../src/scenario.ts";
import { applyInput, compactVisual, displayPng, runScenarioVisual, snapshotDevice } from "../src/visual-capture.ts";
import { buildVisualReport, loadProjectDir } from "../src/visual-report.ts";

const EX = (name: string) => fileURLToPath(new URL(`../../../examples/${name}/`, import.meta.url));

describe("visual capture", () => {
  it("returns exactly runScenario's result and one frame per step", async () => {
    const { project, hex } = loadProjectDir(EX("tamagotchi"));
    const sc = project.scenarios.find((s) => s.id === "feed-fills-food")!;
    const a = new SimHost(project, registry, hex);
    const plain = runScenario(a, sc, project, registry);
    a.dispose();
    const b = new SimHost(project, registry, hex);
    const { result, visual } = runScenarioVisual(b, sc, project, registry);
    b.dispose();
    expect(result).toEqual(plain);
    expect(visual.frames).toHaveLength(sc.steps.length);
    expect(visual.inputs.map((i) => i.kind)).toEqual(["press", "release"]);
    const press = visual.frames.find((f) => f.kind === "press")!;
    expect(press.label).toBe("press btnFeed (80 ms)");
    const oled = visual.frames[visual.frames.length - 1]!.state.displays?.oled;
    expect(oled?.type).toBe("ssd1306-oled-i2c");
    expect(typeof oled?.state.pixels).toBe("string");
    expect(compactVisual(visual).some((l) => l.includes('serial "feed food=100"'))).toBe(true);
    const png = displayPng(visual.frames[visual.frames.length - 1]!);
    expect(png?.subarray(1, 4).toString("ascii")).toBe("PNG");
  }, 30_000); // ~2 s alone; a full parallel run on a busy machine has pushed it past the 5 s default

  it("replaying the recorded inputs reaches the same device state at a frame (deterministic scrubbing)", () => {
    const { project, hex } = loadProjectDir(EX("tamagotchi"));
    const sc = project.scenarios.find((s) => s.id === "play-beeps")!;
    const h = new SimHost(project, registry, hex);
    const { visual } = runScenarioVisual(h, sc, project, registry);
    h.dispose();
    const frame = visual.frames.find((f) => f.label.startsWith("buzzer.sounding"))!;
    expect(frame.state.buzzers?.buzzer).toBe(true);
    const r = new SimHost(project, registry, hex);
    for (const inp of visual.inputs.filter((i) => i.t <= frame.t)) {
      if (inp.t > r.sim.timeMs) r.sim.runFor(inp.t - r.sim.timeMs);
      applyInput(r, inp);
    }
    if (frame.t > r.sim.timeMs) r.sim.runFor(frame.t - r.sim.timeMs);
    const again = snapshotDevice(r, project);
    r.dispose();
    expect(again.displays?.oled?.state.pixels).toBe(frame.state.displays?.oled?.state.pixels);
    expect(again.buzzers).toEqual(frame.state.buzzers);
    expect(again.serial).toBe(frame.state.serial);
  }, 30_000); // runs the scenario twice; under a loaded full run it has passed the 5 s default

  it("captures the robot pose and sonar for a rover scenario, with keyframes", async () => {
    const report = await buildVisualReport(EX("rover"), { scenario: "drives-without-crashing" });
    const s = report.scenarios[0]!;
    expect(s.passed).toBe(true);
    const last = s.frames[s.frames.length - 1]!;
    expect(last.state.robot).toBeDefined();
    expect(typeof last.state.robot!.heading).toBe("number");
    expect(s.keyframes!.length).toBeGreaterThan(3);
    expect(s.keyframes!.every((k, i, a) => i === 0 || k.t > a[i - 1]!.t)).toBe(true);
  }, 60_000);
});

describe("colour displays", () => {
  it("keeps a small RGB565 thumbnail of a TFT frame (box filtered, inversion applied)", async () => {
    const { colorThumb } = await import("../src/visual-capture.ts");
    const { base64ToBytes } = await import("@jumper/sim-core");
    const data = new Uint16Array(320 * 240).fill(0xf800); // red
    for (let y = 0; y < 240; y++) for (let x = 160; x < 320; x++) data[y * 320 + x] = 0x001f; // right half blue
    const t = colorThumb({ width: 320, height: 240, data, version: 1, on: true, inverted: false } as never, 80);
    expect([t.w, t.h]).toEqual([80, 60]);
    const px = base64ToBytes(t.b64);
    expect(px[0]! | (px[1]! << 8)).toBe(0xf800);
    expect(px[79 * 2]! | (px[79 * 2 + 1]! << 8)).toBe(0x001f);
  });
});
