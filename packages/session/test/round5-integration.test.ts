import { describe, expect, it } from "vitest";
import { registry } from "@jumper/parts";
import { parseProject } from "@jumper/project-format";
import { composeSvg, validateScenario } from "../src/index.ts";

// Round 5 merge: pieces from different tracks that only meet after the merge.

const project = parseProject(
  JSON.stringify({
    format: "jumper/1",
    name: "watch",
    parts: [
      { id: "pico", type: "raspberry-pi-pico", x: 0, y: 0 },
      { id: "face", type: "gc9a01-round-tft", x: 300, y: 0 },
      { id: "tft", type: "st7735-tft", x: 600, y: 0 },
      { id: "led1", type: "led", x: 0, y: 300 },
    ],
    wires: [],
  }),
);

describe("round 5 integration", () => {
  it("screenshots clip the round GC9A01 frame to its circle, square TFTs stay square", () => {
    const frame = (w: number, h: number) => ({ width: w, height: h, data: new Uint16Array(w * h).fill(0xf800), version: 1, on: true, inverted: false });
    const svg = composeSvg(project, registry, { framebuffers: { face: frame(240, 240), tft: frame(128, 160) } });
    expect(svg.match(/<clipPath id="jumper-round-\d+"><ellipse /g)).toHaveLength(1);
    expect(svg.match(/<image [^>]*clip-path="url\(#jumper-round-\d+\)"/g)).toHaveLength(1);
    expect(svg.match(/<image [^>]*href="data:image\/png/g)).toHaveLength(2);
  });

  it("expect_display accepts every screen part and names the displays when pointed at an LED", () => {
    expect(() => validateScenario({ name: "s", steps: [{ expect_display: "face" }] } as never, project, registry)).not.toThrow();
    expect(() => validateScenario({ name: "s", steps: [{ expect_display: "led1" }] } as never, project, registry)).toThrow(/led1 is a led, which has no screen.*display on this canvas: face, tft/);
  });
});
