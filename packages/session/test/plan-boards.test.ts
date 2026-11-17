// Round 10 live evals (weather on an ESP32, a Black Pill thermometer): plan_device rejected the
// board names people use ("esp32", "blackpill"), and an ESP32 weather-from-an-API gadget got an
// ESP-01 Wi-Fi module and a BME280 it does not need.
import { describe, expect, it } from "vitest";
import { registry } from "@fabwright/parts";
import { planDevice, resolveBoard } from "../src/index.ts";

const boards = registry.list().filter((d) => d.spec.category === "board" && d.spec.mcu);
const id = (n: string) => resolveBoard(boards, n).spec.id;

describe("board names people use", () => {
  it("resolves ids, names and short names that fit one board", () => {
    expect(id("stm32-blackpill-f411")).toBe("stm32-blackpill-f411");
    expect(id("blackpill")).toBe("stm32-blackpill-f411");
    expect(id("Black Pill")).toBe("stm32-blackpill-f411");
    expect(id("bluepill")).toBe("stm32-bluepill");
    expect(id("esp32")).toBe("esp32-devkitc");
    expect(id("ESP32 DevKitC")).toBe("esp32-devkitc");
    expect(id("pico")).toBe("raspberry-pi-pico");
    expect(id("uno")).toBe("arduino-uno");
  });

  it("a name that fits several boards says which, and an unknown one lists the boards", () => {
    expect(() => id("xiao")).toThrow(/fits several boards: .*seeed-xiao-rp2040/);
    expect(() => id("esp32-c3")).toThrow(/fits several boards: .*seeed-xiao-esp32c3.*esp32-c3-supermini|fits several boards: .*esp32-c3-supermini.*seeed-xiao-esp32c3/);
    expect(() => id("arduino mega")).toThrow(/no board 'arduino mega'.*arduino-uno/);
  });

  it("plan_device takes a short board name", () => {
    expect(planDevice("a thermometer with a bme280 and an oled", { board: "blackpill" }, registry).board.type).toBe("stm32-blackpill-f411");
  });
});

describe("a weather gadget on a Wi-Fi board", () => {
  const goal = "a little desk gadget with an esp32 that shows the weather from an api on a small screen and blinks an led when it's going to rain";

  it("uses the board's own Wi-Fi and no climate sensor", () => {
    const p = planDevice(goal, { board: "esp32-devkitc" }, registry);
    const types = p.bom.map((l) => l.type);
    expect(types).not.toContain("esp01-wifi");
    expect(types).not.toContain("bme280");
    expect(types).toEqual(expect.arrayContaining(["esp32-devkitc", "ssd1306-oled-i2c", "led"]));
    expect(p.size_budget.choices.join(" ")).toMatch(/Wi-Fi built in/);
    expect(p.size_budget.choices.join(" ")).toMatch(/weather comes from the internet/);
  });

  it("an Uno still gets the Wi-Fi module, and a weather station that measures keeps its sensor", () => {
    expect(planDevice(goal.replace("an esp32", "an arduino"), {}, registry).bom.map((l) => l.type)).toContain("esp01-wifi");
    expect(planDevice("a weather station that measures temperature and humidity and uploads it online", { board: "esp32-devkitc" }, registry).bom.map((l) => l.type)).toContain("bme280");
  });
});
