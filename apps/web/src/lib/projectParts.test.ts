import { describe, expect, it } from "vitest";
import { registry, tftTypeFor } from "./parts.ts";
import { compilePayload, createProjectPartsSync, servedBase, unknownTypes } from "./projectParts.ts";

const SOIL = {
  id: "soil-x",
  name: "Soil",
  category: "sensor",
  description: "Soil probe.",
  pins: [{ id: "VCC", type: "power" }, { id: "GND", type: "ground" }, { id: "AOUT", type: "analog" }],
  behavior: { kind: "analog-sensor", output: "AOUT", quantity: { id: "moisture", min: 0, max: 100, default: 40 }, curve: [{ value: 0, volts: 3 }, { value: 100, volts: 1.2 }] },
};
const TFT = { id: "square-tft", name: "Square TFT", category: "display", description: "240x240.", behavior: { kind: "display", controller: "st7735", resolution: { w: 240, h: 240 } } };

describe("project parts in the web app", () => {
  it("finds the served server from ?follow / ?local", () => {
    expect(servedBase("?follow=ws%3A%2F%2Flocalhost%3A7780%2Flive", "http://localhost:5173")).toBe("http://localhost:7780");
    expect(servedBase("?local", "http://localhost:7780")).toBe("http://localhost:7780");
    expect(servedBase("?example=blink", "http://localhost:5173")).toBeUndefined();
  });

  it("compiles the payload, re-sanitizes agent SVGs and maps TFT displays to their renderer", () => {
    const r = compilePayload({
      parts: [
        { id: "soil-x", part: SOIL as never, svg: "<svg>generated</svg>", generated: true },
        { id: "square-tft", part: TFT as never, svg: "", generated: true },
        { id: "bad", part: { id: "bad" } as never, svg: "" },
      ],
    });
    expect(r.defs.map((d) => d.spec.id)).toEqual(["soil-x", "square-tft"]);
    expect(r.defs[0]!.svg).toContain("AGENT-MADE");
    expect(r.tftBase).toEqual({ "square-tft": "st7735-tft" });
    expect(r.errors[0]).toMatch(/^bad: The part definition is invalid/);
    const evil = compilePayload({ parts: [{ id: "soil-x", part: { ...SOIL, size: { w: 60, h: 40 }, pins: SOIL.pins.map((p, i) => ({ ...p, x: 10 + i * 20, y: 30 })) } as never, svg: '<svg><script>alert(1)</script><rect width="60" height="40" onclick="x()"/></svg>' }] });
    expect(evil.defs[0]!.svg).not.toMatch(/script|onclick/);
  });

  it("loads parts into the registry when the project shows an unknown type", async () => {
    const body = JSON.stringify({ parts: [{ id: "soil-x", part: SOIL, svg: "", generated: true }, { id: "square-tft", part: TFT, svg: "", generated: true }] });
    let fetches = 0;
    const fake = (async () => {
      fetches++;
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const changed: string[][] = [];
    const sync = createProjectPartsSync("http://x", (t) => changed.push([...t]), (m) => {
      throw new Error(m);
    }, fake);
    const project = { format: "faber/1", name: "p", parts: [{ id: "s", type: "soil-x", x: 0, y: 0, rotation: 0 }], wires: [], scenarios: [] } as never;
    expect(unknownTypes(project)).toEqual(["soil-x"]);
    expect(await sync.check(project)).toBe(true);
    expect(registry.get("soil-x")?.fidelity.origin).toBe("agent-made");
    expect(tftTypeFor("square-tft")).toBe("st7735-tft");
    expect(tftTypeFor("ili9341-tft")).toBe("ili9341-tft");
    expect(changed[0]).toEqual(expect.arrayContaining(["soil-x", "square-tft"]));
    expect(await sync.check(project)).toBe(false); // same answer: nothing changes
    expect(fetches).toBe(2);
  });
});
