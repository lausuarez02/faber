import { describe, expect, it } from "vitest";
import { getPart } from "./index.ts";
import { boardWiring, descriptionForBoard } from "./wiring.ts";

const spec = (id: string) => getPart(id)!.spec;

// Round 6, canvas track: the Inspector's wiring text uses the board's own bus pins.
describe("boardWiring", () => {
  it("MPU-6050 on a XIAO RP2040: SDA GP6 / SCL GP7 and 3V3, never A4 / A5", () => {
    const w = boardWiring(spec("mpu6050"), spec("seeed-xiao-rp2040"))!;
    expect(w.lines.find((l) => l.pin === "SDA")?.to).toBe("GP6");
    expect(w.lines.find((l) => l.pin === "SCL")?.to).toBe("GP7");
    expect(w.lines.find((l) => l.pin === "VCC")?.to).toBe("3V3");
    expect(w.text).toContain("SDA → GP6 (D4/SDA)");
    expect(w.text).not.toMatch(/\bA4\b|\bA5\b/);
  });

  it("the same module on an Uno: A4 / A5 and 5V; on a Pico GP4 / GP5", () => {
    const uno = boardWiring(spec("mpu6050"), spec("arduino-uno"))!;
    expect(uno.lines.find((l) => l.pin === "SDA")?.to).toBe("A4");
    expect(uno.lines.find((l) => l.pin === "VCC")?.to).toBe("5V");
    const pico = boardWiring(spec("ssd1306-oled-i2c"), spec("raspberry-pi-pico"))!;
    expect(pico.lines.find((l) => l.pin === "SCL")?.to).toBe("GP5");
  });

  it("SPI screens get the board's SPI pins; 5 V-only modules on a 3.3 V board say so", () => {
    const tft = boardWiring(spec("gc9a01-round-tft"), spec("seeed-xiao-rp2040"))!;
    expect(tft.lines.find((l) => l.pin === "SCK")?.to).toBe("GP2");
    expect(tft.lines.find((l) => l.pin === "MOSI")?.to).toBe("GP3");
    const sonar = boardWiring(spec("hc-sr04"), spec("seeed-xiao-rp2040"))!;
    expect(sonar.lines.find((l) => l.pin === "VCC")?.to).toBe("VBUS");
    expect(sonar.lines.find((l) => l.pin === "VCC")?.note).toMatch(/level shifter/);
    expect(sonar.free).toEqual(["TRIG", "ECHO"]);
  });

  it("parts with no supply or bus pins (a button) get no block; boards neither", () => {
    expect(boardWiring(spec("pushbutton"), spec("seeed-xiao-rp2040"))).toBeUndefined();
    expect(boardWiring(spec("arduino-uno"), spec("seeed-xiao-rp2040"))).toBeUndefined();
  });

  it("drops the Uno wiring sentence from a description on another board only", () => {
    const d = spec("mpu6050").description;
    expect(d).toMatch(/A4/);
    expect(descriptionForBoard(d, spec("seeed-xiao-rp2040"))).not.toMatch(/\bA4\b|\bA5\b/);
    expect(descriptionForBoard(d, spec("arduino-uno"))).toBe(d);
    expect(descriptionForBoard(spec("gc9a01-round-tft").description, spec("seeed-xiao-rp2040"))).not.toMatch(/Uno wiring|D13/);
  });
});
