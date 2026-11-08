import { describe, expect, it } from "vitest";
import { createProject, parseProject } from "@jumper/project-format";
import { createJumperStore, withoutItems } from "./store.ts";

const base = () =>
  parseProject({
    format: "jumper/1",
    name: "t",
    parts: [
      { id: "uno", type: "arduino-uno", x: 0, y: 0 },
      { id: "led1", type: "led", x: 100, y: 0 },
    ],
    wires: [{ id: "w1", from: { part: "uno", pin: "D13" }, to: { part: "led1", pin: "A" } }],
    firmware: { board: "uno", artifact: "firmware/blink.hex" },
  });

describe("project store", () => {
  it("adds parts with unique ids and undoes/redoes", () => {
    const store = createJumperStore(createProject("x"));
    const a = store.getState().addPart("led", 0, 0);
    const b = store.getState().addPart("led", 20, 0);
    expect([a, b]).toEqual(["led1", "led2"]);
    store.getState().undo();
    expect(store.getState().project.parts.map((p) => p.id)).toEqual(["led1"]);
    store.getState().redo();
    expect(store.getState().project.parts.map((p) => p.id)).toEqual(["led1", "led2"]);
  });

  it("connects pins once and cycles wire colors", () => {
    const store = createJumperStore(base());
    const id = store.getState().connect({ part: "uno", pin: "GND.1" }, { part: "led1", pin: "C" });
    expect(id).toBe("w2");
    expect(store.getState().connect({ part: "led1", pin: "C" }, { part: "uno", pin: "GND.1" })).toBeUndefined();
    expect(store.getState().connect({ part: "led1", pin: "C" }, { part: "led1", pin: "C" })).toBeUndefined();
    const c0 = store.getState().project.wires[1]!.color;
    store.getState().cycleWireColor("w2");
    expect(store.getState().project.wires[1]!.color).not.toBe(c0);
  });

  it("removing a part removes its wires and the firmware block of its board", () => {
    const p = withoutItems(base(), ["uno"], []);
    expect(p.wires).toEqual([]);
    expect(p.firmware).toBeUndefined();
    expect(() => parseProject(p)).not.toThrow();
  });

  it("drag = one undo step (checkpoint + live updates)", () => {
    const store = createJumperStore(base());
    store.getState().checkpoint();
    for (let x = 0; x <= 50; x += 10)
      store.getState().setLive((p) => ({ ...p, parts: p.parts.map((q) => (q.id === "led1" ? { ...q, x: 100 + x } : q)) }));
    expect(store.getState().project.parts[1]!.x).toBe(150);
    store.getState().undo();
    expect(store.getState().project.parts[1]!.x).toBe(100);
  });

  it("a click without a move does not cost an undo step", () => {
    const store = createJumperStore(createProject("x"));
    store.getState().addPart("led", 0, 0);
    store.getState().checkpoint(); // drag start, no move
    store.getState().undo();
    expect(store.getState().project.parts).toEqual([]);
  });
});
