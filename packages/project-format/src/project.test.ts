import { describe, expect, it } from "vitest";
import {
  ProjectParseError,
  buildNets,
  createProject,
  netIndex,
  parseProject,
  projectJsonSchema,
  safeParseProject,
  serializeProject,
  type ProjectInput,
} from "./index.ts";

const blink: ProjectInput = {
  format: "faber/1",
  name: "Blink",
  description: "The classic.",
  parts: [
    { id: "uno", type: "arduino-uno", x: 0, y: 0, rotation: 0 },
    { id: "r1", type: "resistor", x: 300, y: 40, rotation: 90, props: { resistance: 220 } },
    { id: "led1", type: "led", x: 360, y: 40, rotation: 0, props: { color: "red" } },
  ],
  wires: [
    { id: "w1", from: { part: "uno", pin: "D13" }, to: { part: "r1", pin: "1" }, color: "#FF4D2E" },
    { id: "w2", from: { part: "r1", pin: "2" }, to: { part: "led1", pin: "A" } },
    { id: "w3", from: { part: "led1", pin: "C" }, to: { part: "uno", pin: "GND.1" }, waypoints: [{ x: 400, y: 200 }] },
  ],
  firmware: {
    board: "uno",
    dir: "firmware",
    sketch: "blink.ino",
    artifact: "firmware/blink.hex",
    build: { tool: "arduino-cli", fqbn: "arduino:avr:uno" },
  },
  scenarios: [],
};

describe("parseProject", () => {
  it("parses a valid project and fills defaults", () => {
    const p = parseProject({ format: "faber/1", name: "x", parts: [{ id: "a", type: "led", x: 1, y: 2 }] });
    expect(p.parts[0]!.rotation).toBe(0);
    expect(p.wires).toEqual([]);
    expect(p.scenarios).toEqual([]);
  });

  it("reports readable errors with paths", () => {
    const res = safeParseProject({
      format: "faber/2",
      name: "",
      parts: [{ id: "a", type: "led", x: 0, y: 0, rotation: 45 }],
      wires: [{ id: "w", from: { part: "a", pin: "A" }, to: { part: "ghost", pin: "1" } }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const paths = res.issues.map((i) => i.path);
    expect(paths).toContain("format");
    expect(paths).toContain("name");
    expect(paths).toContain("parts[0].rotation");
  });

  it("reports dangling wire ends and duplicate ids", () => {
    const res = safeParseProject({
      format: "faber/1",
      name: "x",
      parts: [
        { id: "a", type: "led", x: 0, y: 0 },
        { id: "a", type: "led", x: 0, y: 0 },
      ],
      wires: [{ id: "w", from: { part: "a", pin: "A" }, to: { part: "ghost", pin: "1" } }],
      firmware: { board: "nope", artifact: "x.hex" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues).toContainEqual({ path: "parts[1].id", message: "duplicate part id 'a'" });
    expect(res.issues.find((i) => i.path === "wires[0].to.part")?.message).toMatch(/ghost/);
    expect(res.issues.find((i) => i.path === "firmware.board")?.message).toMatch(/nope/);
  });

  it("throws ProjectParseError for bad JSON", () => {
    expect(() => parseProject("{not json")).toThrow(ProjectParseError);
    try {
      parseProject("{not json");
    } catch (e) {
      expect((e as ProjectParseError).issues[0]!.message).toMatch(/not valid JSON/);
    }
  });
});

describe("serializeProject", () => {
  it("round trips", () => {
    const p = parseProject(blink);
    const text = serializeProject(p);
    expect(parseProject(text)).toEqual(p);
    expect(serializeProject(parseProject(text))).toBe(text);
  });

  it("is stable regardless of input key order", () => {
    const shuffled = JSON.parse(
      JSON.stringify({
        wires: blink.wires,
        scenarios: [],
        firmware: { artifact: "firmware/blink.hex", board: "uno", build: { fqbn: "arduino:avr:uno", tool: "arduino-cli" }, sketch: "blink.ino", dir: "firmware" },
        parts: blink.parts!.map((p) => ({ props: p.props, rotation: p.rotation, y: p.y, x: p.x, type: p.type, id: p.id })),
        description: blink.description,
        name: blink.name,
        format: blink.format,
      }),
    );
    expect(serializeProject(parseProject(shuffled))).toBe(serializeProject(parseProject(blink)));
  });

  it("puts each part and wire on one line, 2-space indent, trailing newline", () => {
    const text = serializeProject(parseProject(blink));
    expect(text.endsWith("}\n")).toBe(true);
    const lines = text.split("\n");
    expect(lines).toContain('    { "id": "led1", "type": "led", "x": 360, "y": 40, "rotation": 0, "props": { "color": "red" } }');
    expect(lines).toContain(
      '    { "id": "w2", "from": { "part": "r1", "pin": "2" }, "to": { "part": "led1", "pin": "A" } },',
    );
    expect(lines[1]).toBe('  "format": "faber/1",');
    // moving one part changes exactly one line
    const moved = parseProject(blink);
    moved.parts[1]!.x = 310;
    const diff = serializeProject(moved).split("\n").filter((l, i) => l !== lines[i]);
    expect(diff).toHaveLength(1);
  });

  it("serializes an empty project", () => {
    expect(serializeProject(createProject("Empty"))).toBe(
      '{\n  "format": "faber/1",\n  "name": "Empty",\n  "parts": [],\n  "wires": [],\n  "scenarios": []\n}\n',
    );
  });
});

describe("buildNets", () => {
  it("groups connected pins with union-find", () => {
    const nets = buildNets(parseProject(blink));
    expect(nets).toHaveLength(3);
    const idx = netIndex(nets);
    expect(idx.get("uno:D13")).toBe(idx.get("r1:1"));
    expect(idx.get("r1:2")).toBe(idx.get("led1:A"));
    expect(idx.get("led1:C")).toBe(idx.get("uno:GND.1"));
    expect(idx.get("uno:D13")).not.toBe(idx.get("led1:A"));
  });

  it("merges chains and is deterministic", () => {
    const p = parseProject({
      format: "faber/1",
      name: "chain",
      parts: ["a", "b", "c", "d"].map((id) => ({ id, type: "x", x: 0, y: 0 })),
      wires: [
        { id: "w1", from: { part: "d", pin: "1" }, to: { part: "c", pin: "1" } },
        { id: "w2", from: { part: "b", pin: "1" }, to: { part: "a", pin: "1" } },
        { id: "w3", from: { part: "c", pin: "1" }, to: { part: "b", pin: "1" } },
      ],
    });
    const nets = buildNets(p, { extraPins: [{ part: "a", pin: "2" }] });
    expect(nets).toEqual([
      { id: "n0", pins: [{ part: "a", pin: "1" }, { part: "b", pin: "1" }, { part: "c", pin: "1" }, { part: "d", pin: "1" }] },
      { id: "n1", pins: [{ part: "a", pin: "2" }] },
    ]);
  });
});

describe("JSON Schema", () => {
  it("exports a draft 2020-12 schema", () => {
    const s = projectJsonSchema();
    expect(s.$schema).toMatch(/2020-12/);
    expect((s.properties as Record<string, unknown>).parts).toBeDefined();
  });
});
