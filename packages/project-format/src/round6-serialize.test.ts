import { describe, expect, it } from "vitest";
import { parseProject, serializeProject } from "./index.ts";

// Round 6 (decision 0004): assembly, power and enclosure survive a save (fabwright.json written by the session).
describe("round 6 fields round-trip through serializeProject", () => {
  it("keeps assembly, power and enclosure, after world", () => {
    const p = parseProject({
      format: "fabwright/1",
      name: "Muse",
      parts: [{ id: "xiao", type: "seeed-xiao-rp2040", x: 0, y: 0 }],
      assembly: "soldered",
      power: { usb: false },
      enclosure: { shape: "pebble", params: { wall_mm: 1.6 } },
    });
    const text = serializeProject(p);
    expect(parseProject(JSON.parse(text))).toEqual(p);
    expect(text.indexOf('"assembly"')).toBeGreaterThan(text.indexOf('"scenarios"'));
    expect(text).toMatch(/"power": \{"usb":false\}/);
  });

  it("writes nothing new for an old project", () => {
    const p = parseProject({ format: "fabwright/1", name: "old", parts: [] });
    expect(serializeProject(p)).not.toMatch(/assembly|power|enclosure/);
  });
});
