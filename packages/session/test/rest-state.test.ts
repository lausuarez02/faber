// Round 10 live weather eval: the agent placed a blue LED and its screenshot (and the canvas) drew
// it red, because nothing bound the LED's lens before a run. Parts now show their props at rest.
import { describe, expect, it } from "vitest";
import { registry } from "@fabwright/parts";
import { restVisualState } from "@fabwright/sim-core";
import { composeSvg } from "../src/screenshot.ts";

describe("parts at rest look like their props", () => {
  it("restVisualState: a blue LED has a blue lens and is off", () => {
    const led = registry.get("led")!;
    expect(restVisualState(led, "led1", { color: "blue" })).toMatchObject({ lens: "#12305A", color: "#4DA3FF" });
    expect(restVisualState(led, "led1")).toBeUndefined();
    expect(restVisualState(led, "led1", { color: "red" })).toBeUndefined();
  });

  it("never throws, and a board does not look powered before a run", () => {
    for (const d of registry.list()) expect(() => restVisualState(d, "x", { anything: 1 })).not.toThrow();
    expect(restVisualState(registry.get("stm32-blackpill-f411")!, "pill", {})).toBeUndefined();
  });

  it("composeSvg before any run draws the blue LED's lens blue", () => {
    const project = { format: "fabwright/1", name: "t", parts: [{ id: "led1", type: "led", x: 0, y: 0, rotation: 0, props: { color: "blue" } }], wires: [], scenarios: [] } as never;
    const svg = composeSvg(project, registry);
    expect(svg).toContain("#12305A");
    expect(svg).not.toContain('fill="#5A1712"');
  });
});
