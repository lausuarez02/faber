// Round 10 live weather eval: the agent placed a blue LED and its screenshot (and the canvas) drew
// it red, because nothing bound the LED's lens before a run. Parts now show their props at rest.
import { describe, expect, it } from "vitest";
import { registry } from "@jumper/parts";
import { restVisualState } from "@jumper/sim-core";
import { composeSvg } from "../src/screenshot.ts";

describe("parts at rest look like their props", () => {
  it("restVisualState: a blue LED has a blue lens and is off", () => {
    const led = registry.get("led")!;
    expect(restVisualState(led, "led1", { color: "blue" })).toMatchObject({ lens: "#12305A", brightness: 0, on: false });
    expect(restVisualState(led, "led1")).toMatchObject({ lens: "#5A1712" });
  });

  it("a board model that needs a simulation gives no rest state instead of throwing", () => {
    for (const d of registry.list()) expect(() => restVisualState(d, "x")).not.toThrow();
  });

  it("composeSvg before any run draws the blue LED's lens blue", () => {
    const project = { format: "jumper/1", name: "t", parts: [{ id: "led1", type: "led", x: 0, y: 0, rotation: 0, props: { color: "blue" } }], wires: [], scenarios: [] } as never;
    const svg = composeSvg(project, registry);
    expect(svg).toContain("#12305A");
    expect(svg).not.toContain('fill="#5A1712"');
  });
});
