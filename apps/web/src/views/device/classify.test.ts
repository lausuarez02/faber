import { describe, expect, it } from "vitest";
import { parseProject } from "@fabwright/project-format";
import tamagotchi from "../../../../../examples/tamagotchi/fabwright.json?raw";
import rover from "../../../../../examples/rover/fabwright.json?raw";
import arm from "../../../../../examples/robot-arm/fabwright.json?raw";
import blink from "../../../../../examples/blink/fabwright.json?raw";
import { caseLabel, classifyProject, lastSerialLine, screenBlankOf, screenTypeOf, serialStats, type CaseModel, type CaseOpening } from "./classify.ts";
import { buttonLabel } from "./scene/Handheld.tsx";

describe("device view: classifyProject", () => {
  it("presents each example as the right physical thing", () => {
    const t = classifyProject(parseProject(tamagotchi));
    expect(t.kind).toBe("handheld");
    expect(t.screen).toEqual({ id: "oled", type: "ssd1306-oled-i2c" });
    expect(t.buttons.map((b) => b.id)).toEqual(["btnFeed", "btnPlay", "btnSleep"]); // canvas x order
    expect(t.buzzers.map((b) => b.id)).toEqual(["buzzer"]);
    expect(classifyProject(parseProject(rover)).kind).toBe("rover");
    expect(classifyProject(parseProject(arm)).kind).toBe("arm");
    const b = classifyProject(parseProject(blink));
    expect(b.kind).toBe("board");
    expect(b.leds).toHaveLength(1);
  });

  it("a pocket RP2040 board with a round TFT and a passive buzzer is a handheld with a colour screen", () => {
    const p = parseProject(JSON.stringify({ format: "fabwright/1", name: "watch", parts: [
      { id: "xiao", type: "seeed-xiao-rp2040", x: 0, y: 0 },
      { id: "face", type: "gc9a01-round-tft", x: 200, y: 0 },
      { id: "btn", type: "pushbutton", x: 0, y: 200 },
      { id: "bz", type: "passive-buzzer", x: 100, y: 200 },
    ], wires: [] }));
    const l = classifyProject(p);
    expect(l).toMatchObject({ kind: "handheld", screen: { id: "face", type: "gc9a01-round-tft" }, board: { id: "xiao", type: "seeed-xiao-rp2040" } });
    expect(l.why).toBe("TFT + 1 button → handheld");
    expect(l.buzzers).toEqual([{ id: "bz" }]);
  });

  // A talking egg: OLED + 1 button + an LED + a speaker, with a custom (egg) case the Case view built.
  const egg = parseProject(JSON.stringify({ format: "fabwright/1", name: "Talking Egg", parts: [
    { id: "xiao", type: "seeed-xiao-rp2040", x: 0, y: 0 },
    { id: "eyes", type: "ssd1306-oled-i2c", x: 200, y: 0 },
    { id: "btn", type: "pushbutton", x: 0, y: 200 },
    { id: "nose", type: "led", x: 100, y: 200, props: { color: "green" } },
    { id: "spk", type: "speaker-20mm", x: 300, y: 200 },
  ], wires: [], enclosure: { shape: "custom", params: { color: "#F4EAD5" }, outline: "M 0 -40 C 17 -40 28 -16 28 5 C 28 23 16 33 0 33 C -16 33 -28 23 -28 5 C -28 -16 -17 -40 0 -40 Z" } }));
  const op = (part: string, kind: string, extra: Partial<CaseOpening> = {}): CaseOpening => ({ part, feature: kind, kind, face: "front", n: [0, 0, 1], at: [0, 0, 6], shape: "rect", u: 4, v: 4, uAxis: [1, 0, 0], vAxis: [0, 1, 0], depth: 1.6, standoff: 0, ...extra });
  const body = (name: string, kind: "shell" | "cap" | "part") => ({ body: name, kind, color: "#F4EAD5", positions: "", indices: "", explode: [0, 0, 0] as [number, number, number] });
  const built: CaseModel = {
    hash: "a068c55b88d27a60",
    engine: "case-5",
    stale: false,
    shape: "custom",
    color: "#F4EAD5",
    size_mm: { w: 84.5, h: 110.2, d: 17.5 },
    mesh: { hash: "a068c55b88d27a60", bodies: [body("front", "shell"), body("back", "shell"), body("cap-btn", "cap"), body("light-pipe-nose", "cap"), body("part-eyes", "part")] },
    openings: [
      op("eyes", "window", { u: 22.3, v: 11.5, at: [-0.68, 24.2, 6.15], screen: { u: 21.7, v: 10.9, shape: "rect" } }),
      op("btn", "button", { face: "right", n: [1, 0, 0], at: [38.8, 6.2, 0.4], insert: { kind: "cap", d: 3.5, travel: 0.25, protrude: 1, length: 3.8 } }),
      op("nose", "light-pipe", { at: [0, 40, 6] }),
      op("spk", "grille", { face: "back", n: [0, 0, -1], holes: 13 }),
      op("xiao", "connector", { face: "left", n: [-1, 0, 0] }),
    ],
  };

  it("a project with a built case is shown as THAT case, its parts mapped onto the case's openings", () => {
    const l = classifyProject(egg, built);
    expect(l.kind).toBe("case");
    expect(l.why).toBe("Custom case from the Case view · OLED + 1 button");
    const c = l.case!;
    expect(c.model).toBe(built);
    expect(c.screen).toMatchObject({ id: "eyes", type: "ssd1306-oled-i2c", window: { kind: "window", screen: { u: 21.7, v: 10.9 } } });
    expect(c.buttons).toEqual([{ id: "btn", opening: built.openings[1], cap: "cap-btn" }]);
    expect(c.leds).toEqual([{ id: "nose", color: "green", opening: built.openings[2], pipe: "light-pipe-nose" }]);
    expect(c.grilles.map((g) => g.part)).toEqual(["spk"]);
    expect(c.connectors.map((g) => g.part)).toEqual(["xiao"]);
    // a button the case has no opening for still gets its key (no opening, no cap)
    const two = parseProject(JSON.stringify({ ...JSON.parse(JSON.stringify(egg)), parts: [...egg.parts, { id: "btnB", type: "pushbutton", x: 50, y: 200 }] }));
    expect(classifyProject(two, built).case!.buttons).toEqual([{ id: "btn", opening: built.openings[1], cap: "cap-btn" }, { id: "btnB" }]);
    expect(caseLabel("pebble")).toBe("Pebble case");
    expect(caseLabel("round-body")).toBe("Round-body case");
  });

  it("no built case → the generic handheld stays the fallback; robots and arms stay in their worlds", () => {
    expect(classifyProject(egg).kind).toBe("handheld");
    expect(classifyProject(egg, null).kind).toBe("handheld");
    const { enclosure: _e, ...noCase } = JSON.parse(JSON.stringify(egg));
    void _e;
    expect(classifyProject(parseProject(JSON.stringify(noCase)), built).kind).toBe("handheld"); // a stale answer for a project whose case was removed
    expect(classifyProject(parseProject(rover), built).kind).toBe("rover");
    expect(classifyProject(parseProject(arm), built).kind).toBe("arm");
    // a board with LEDs and a case is shown in its case too
    const b = parseProject(blink);
    expect(classifyProject({ ...b, enclosure: { shape: "pebble" } }, { ...built, openings: [], shape: "pebble" }).kind).toBe("case");
  });

  it("reads stats and the last line from serial (ignores the line still printing)", () => {
    const text = "boot\r\nt=1 food=78 happy=79\r\nfeed food=100\r\nt=2 fo";
    expect(serialStats(text)).toEqual([
      { key: "t", value: "1" },
      { key: "food", value: "78" },
      { key: "happy", value: "79" },
    ]);
    expect(lastSerialLine(text)).toBe("feed food=100");
  });

  it("prints button labels from part ids", () => {
    expect(buttonLabel("btnFeed")).toBe("FEED");
    expect(buttonLabel("button_a")).toBe("A");
    expect(buttonLabel("reset")).toBe("RESET");
  });
});

describe("device view: screens it knows only by their drawing (round 17)", () => {
  it("an e-paper or memory LCD is a panel screen, drawn on its blank glass until it has frames", () => {
    expect(screenTypeOf("epaper-154-ssd1681")).toMatchObject({ kind: "panel", screen: "200x200", aspect: 1, label: "E-paper" });
    expect(screenTypeOf("sharp-memory-lcd-128")).toMatchObject({ kind: "panel", screen: "128x128", label: "Memory LCD" });
    expect(screenTypeOf("ssd1306-oled-i2c")?.kind).toBe("oled");
    expect(screenTypeOf("led")).toBeUndefined();
    expect(screenBlankOf("epaper-154-ssd1681")).toBe("#ECEAE2");
    const p = parseProject({ format: "fabwright/1", name: "mood", parts: [{ id: "xiao", type: "seeed-xiao-esp32c3", x: 0, y: 0 }, { id: "epd", type: "epaper-154-ssd1681", x: 0, y: 0 }, { id: "b", type: "pushbutton", x: 0, y: 0 }], wires: [] });
    const l = classifyProject(p);
    expect(l.screen).toEqual({ id: "epd", type: "epaper-154-ssd1681" });
    expect(l.why).toBe("E-paper + 1 button → handheld");
  });
});
