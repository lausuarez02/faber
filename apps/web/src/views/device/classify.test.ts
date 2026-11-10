import { describe, expect, it } from "vitest";
import { parseProject } from "@jumper/project-format";
import tamagotchi from "../../../../../examples/tamagotchi/jumper.json?raw";
import rover from "../../../../../examples/rover/jumper.json?raw";
import arm from "../../../../../examples/robot-arm/jumper.json?raw";
import blink from "../../../../../examples/blink/jumper.json?raw";
import { classifyProject, lastSerialLine, serialStats } from "./classify.ts";
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
    const p = parseProject(JSON.stringify({ format: "jumper/1", name: "watch", parts: [
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
