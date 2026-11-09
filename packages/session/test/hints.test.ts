import { describe, expect, it } from "vitest";
import { getPart } from "@jumper/parts";
import { usageFor } from "../src/hints.ts";

describe("wiring hints never suggest damaging the board", () => {
  it("battery pack goes to VIN / driver supply, never 5V", () => {
    const { wiring, connect } = usageFor(getPart("battery-pack")!.spec);
    expect(wiring).toMatch(/VIN/);
    expect(wiring).toMatch(/NEVER connect a battery pack to the 5V pin/);
    expect(connect?.some((c) => c.endsWith(".5V"))).toBe(false);
  });

  it("dc motor hint names both L298N output pairs", () => {
    expect(usageFor(getPart("dc-motor")!.spec).wiring).toMatch(/OUT3\/OUT4/);
  });
});
