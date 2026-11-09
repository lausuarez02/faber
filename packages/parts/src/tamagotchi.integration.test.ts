// The tamagotchi reference project (examples/tamagotchi) end to end: real compiled firmware
// (Adafruit_SSD1306 over Wire) on the simulated Uno, the OLED, three buttons and the buzzer.
// The scenario tests in its jumper.json cover the same behaviour through the scenario runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProject } from "@jumper/project-format";
import { Simulation, monoPixel } from "@jumper/sim-core";
import { backendFactory } from "@jumper/sim-backends";
import { registry } from "./registry.gen.ts";
import { frameOf, serialLines } from "./lib/firmwareBench.ts";

const base = new URL("../../../examples/tamagotchi/", import.meta.url);
const project = parseProject(readFileSync(new URL("jumper.json", base), "utf8"));
const hex = readFileSync(new URL("firmware/tamagotchi.hex", base), "utf8");
const boot = () => new Simulation({ project, registry, backendFactory, firmware: hex });

function press(sim: Simulation, id: string, ms = 60) {
  sim.interact(id, { kind: "press" });
  sim.runFor(ms);
  sim.interact(id, { kind: "release" });
}

describe("examples/tamagotchi", { timeout: 120_000 }, () => {
  it("is a valid project with scenarios for every behaviour", () => {
    expect(project.parts.map((p) => p.type).sort()).toEqual(["arduino-uno", "buzzer", "pushbutton", "pushbutton", "pushbutton", "ssd1306-oled-i2c"]);
    expect(project.scenarios.map((s) => s.id)).toEqual([
      "boots-and-draws",
      "feed-fills-food",
      "play-beeps",
      "sleep-and-wake",
      "neglect-makes-it-sad",
      "runs-headless-without-display",
    ]);
  });

  it("hatches, draws the pet and the stat bars, logs every second", () => {
    const sim = boot();
    sim.runFor(2100);
    expect(serialLines(sim)).toEqual([
      "Pet hatched",
      "t=1 food=78 happy=79 energy=79 mood=happy sleeping=0",
      "t=2 food=76 happy=78 energy=78 mood=happy sleeping=0",
    ]);
    const f = frameOf(sim, "oled");
    expect(monoPixel(f, 0, 0)).toBe(true); // the 'F' of the food bar
    expect(monoPixel(f, 64, 15)).toBe(true); // top of the pet's head
    expect(Number(sim.partState("oled")!.lit)).toBeGreaterThan(300);
    expect(sim.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
  });

  it("feeds, plays (with a beep) and sleeps on the buttons", () => {
    const sim = boot();
    sim.runFor(1500);
    press(sim, "btnFeed");
    press(sim, "btnPlay", 50);
    expect(sim.partState("buzzer")!.sounding).toBe(true);
    sim.runFor(200);
    expect(sim.partState("buzzer")!.sounding).toBe(false);
    press(sim, "btnSleep");
    sim.runFor(1000);
    const lines = serialLines(sim);
    expect(lines).toContain("feed food=100");
    expect(lines).toContain("play happy=99");
    expect(lines).toContain("sleep");
    expect(lines.at(-1)).toMatch(/mood=asleep sleeping=1$/);
    expect(sim.partState("oled")!.contrast).toBe(0x10);
  });

  it("idles with an animation (the frame keeps changing without input)", () => {
    const sim = boot();
    sim.runFor(1000);
    const a = sim.partState("oled")!.frame;
    sim.runFor(600);
    expect(sim.partState("oled")!.frame).not.toBe(a);
  });

  it("keeps running headless when the OLED NACKs", () => {
    const sim = boot();
    sim.setBusFault("oled", "nack");
    sim.runFor(1100);
    expect(serialLines(sim).slice(0, 3)).toEqual(["OLED not found at 0x3C, running headless", "Pet hatched", "t=1 food=78 happy=79 energy=79 mood=happy sleeping=0"]);
    expect(sim.partState("oled")!.blank).toBe(true);
  });
});
