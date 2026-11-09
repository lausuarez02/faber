import { describe, expect, it } from "vitest";
import { GROUND, decodeMonoFrame, monoPixel } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { asciiOf, frameOf, i2cWires, serialLines, unoBench } from "../../lib/firmwareBench.ts";
import { Ssd1306, createSsd1306I2c } from "./model.ts";

const def = need(registry.get("ssd1306-oled-i2c"), "ssd1306-oled-i2c");

function powered(props: Record<string, string> = {}) {
  const b = mount(def, { id: "oled", props, wiring: { VCC: "vcc", GND: GROUND, SDA: "sda", SCL: "scl" } });
  b.solve((c) => c.voltageSource("vcc", GROUND, 5, 0.01));
  return b;
}

/** Send one I2C write transaction (control byte + bytes) to the model. */
function send(b: ReturnType<typeof powered>, control: number, bytes: number[]): boolean {
  const i2c = b.model.i2c!;
  if (!i2c.i2cConnect(false, false)) return false;
  i2c.i2cWrite(control);
  for (const x of bytes) i2c.i2cWrite(x);
  i2c.i2cStop();
  return true;
}

const INIT = [0xae, 0xd5, 0x80, 0xa8, 0x3f, 0xd3, 0x00, 0x40, 0x8d, 0x14, 0x20, 0x00, 0xa1, 0xc8, 0xda, 0x12, 0x81, 0xcf, 0xd9, 0xf1, 0xdb, 0x40, 0xa4, 0xa6, 0xaf];

describe("ssd1306-oled-i2c: controller", () => {
  it("answers at 0x3C by default and 0x3D with the address prop", () => {
    expect(powered().model.i2c!.i2cAddress()).toBe(0x3c);
    expect(powered({ address: "0x3D" }).model.i2c!.i2cAddress()).toBe(0x3d);
  });

  it("is dark until DISPLAY ON with the charge pump; then shows RAM", () => {
    const b = powered();
    expect(b.model.visualState().on).toBe(false);
    send(b, 0x00, [0x8d, 0x14, 0xa1, 0xc8, 0xaf]);
    expect(b.model.visualState().on).toBe(true);
    expect(b.model.visualState().lit).toBe(0);
    // page mode at reset: page 0, column 0; 0xFF lights a column of 8 pixels
    send(b, 0x40, [0xff, 0x01]);
    const f = decodeMonoFrame(String(b.model.visualState().pixels), 128, 64);
    expect(b.model.visualState().lit).toBe(9);
    for (let y = 0; y < 8; y++) expect(monoPixel(f, 0, y)).toBe(true);
    expect(monoPixel(f, 1, 0)).toBe(true);
    expect(monoPixel(f, 1, 1)).toBe(false);
  });

  it("warns when the panel is switched on without the charge pump", () => {
    const b = powered();
    send(b, 0x00, [0xaf]);
    expect(b.model.visualState().on).toBe(false);
    expect(b.model.diagnostics!().map((d) => d.code)).toContain("ssd1306-charge-pump-off");
  });

  it("horizontal addressing wraps inside the column/page window", () => {
    const chip = new Ssd1306();
    const dev = createSsd1306I2c(chip, () => true, () => 0x3c);
    dev.i2cConnect(false, false);
    dev.i2cWrite(0x00);
    for (const c of [0x20, 0x00, 0x21, 10, 11, 0x22, 2, 3]) dev.i2cWrite(c);
    dev.i2cStop();
    dev.i2cConnect(false, false);
    dev.i2cWrite(0x40);
    for (const d of [1, 2, 3, 4, 5]) dev.i2cWrite(d);
    dev.i2cStop();
    const at = (page: number, col: number) => chip.s.ram[page * 128 + col];
    expect([at(2, 10), at(2, 11), at(3, 10), at(3, 11), at(2, 10 + 0)]).toEqual([5, 2, 3, 4, 5]);
  });

  it("vertical addressing goes down the pages first", () => {
    const chip = new Ssd1306();
    for (const c of [0x20, 0x01, 0x21, 0, 127, 0x22, 0, 7]) chip.command(c);
    for (let i = 0; i < 9; i++) chip.data(i + 1);
    expect(chip.s.ram[7 * 128 + 0]).toBe(8);
    expect(chip.s.ram[0 * 128 + 1]).toBe(9);
  });

  it("Co = 1 control bytes carry one byte each", () => {
    const chip = new Ssd1306();
    const dev = createSsd1306I2c(chip, () => true, () => 0x3c);
    dev.i2cConnect(false, false);
    for (const x of [0x80, 0x8d, 0x80, 0x14, 0x80, 0xaf, 0xc0, 0xaa]) dev.i2cWrite(x);
    dev.i2cStop();
    expect(chip.s.chargePump).toBe(true);
    expect(chip.s.displayOn).toBe(true);
    expect(chip.s.ram[0]).toBe(0xaa);
  });

  it("applies segment remap, COM scan, inverse and entire-display-on to the image", () => {
    const chip = new Ssd1306();
    for (const c of [0x8d, 0x14, 0xaf]) chip.command(c);
    chip.data(0x01); // RAM row 0, column 0
    const px = (x: number, y: number) => monoPixel({ width: 128, height: 64, data: chip.render(true) }, x, y);
    // At reset (0xA0, 0xC0) a standard module shows the image rotated by 180 degrees.
    expect(px(127, 63)).toBe(true);
    chip.command(0xa1);
    expect(px(0, 63)).toBe(true);
    chip.command(0xc8); // 0xA1 + 0xC8: upright, what Adafruit_SSD1306 and U8g2 send
    expect(px(0, 0)).toBe(true);
    chip.command(0xa7);
    expect(px(0, 0)).toBe(false);
    expect(px(127, 63)).toBe(true);
    chip.command(0xa6);
    chip.command(0xa5);
    expect(chip.render(true).every((b) => b === 0xff)).toBe(true);
    expect(chip.render(false).every((b) => b === 0)).toBe(true);
  });

  it("does not answer and explains why when unpowered", () => {
    const b = mount(def, { id: "oled", wiring: { VCC: "vcc", GND: GROUND } });
    b.solve();
    expect(b.model.i2c!.i2cConnect(false, false)).toBe(false);
    const d = b.model.diagnostics!();
    expect(d[0]!.code).toBe("i2c-module-unpowered");
    expect(d[0]!.message).toMatch(/Wire oled:VCC to the board's 5V/);
  });

  it("init sequence of Adafruit_SSD1306 leaves a lit, blank 128x64 panel", () => {
    const b = powered({ color: "blue" });
    send(b, 0x00, INIT);
    const v = b.model.visualState();
    expect(v).toMatchObject({ on: true, lit: 0, contrast: 0xcf, color: "blue", width: 128, height: 64, screenOpacity: 1 });
  });
});

describe("ssd1306-oled-i2c: real firmware", { timeout: 120_000 }, () => {
  it("Adafruit_SSD1306 example draws a frame, the title and a counter", () => {
    const sim = unoBench({ parts: [{ id: "oled", type: "ssd1306-oled-i2c", x: 0, y: 0 }], wires: i2cWires("oled"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(1200);
    expect(serialLines(sim).slice(0, 3)).toEqual(["SSD1306 ready", "count 0", "count 1"]);
    const f = frameOf(sim, "oled");
    // drawRect(0, 0, 128, 64): all four corners and edges lit
    for (const [x, y] of [[0, 0], [127, 0], [0, 63], [127, 63], [64, 0], [0, 32]] as const) expect(monoPixel(f, x, y), `${x},${y}`).toBe(true);
    expect(monoPixel(f, 64, 60)).toBe(false);
    const art = asciiOf(sim, "oled");
    // "Jumper" in size-2 text sits in rows 8..23
    const title = art.split("\n").slice(8, 24).join("\n");
    expect(title).toMatch(/#/);
    expect(sim.diagnostics().filter((d) => d.severity !== "info")).toEqual([]);
    expect(sim.i2c.list()).toEqual([{ partId: "oled", address: 0x3c }]);
  });

  it("U8g2 example draws a frame and a box, and toggles inverse", () => {
    const sim = unoBench({ parts: [{ id: "oled", type: "ssd1306-oled-i2c", x: 0, y: 0 }], wires: i2cWires("oled"), hex: "./example-u8g2.hex", base: import.meta.url });
    sim.runFor(400);
    expect(serialLines(sim)).toContain("u8g2 ready");
    let f = frameOf(sim, "oled");
    expect(monoPixel(f, 0, 0)).toBe(true);
    expect(monoPixel(f, 127, 63)).toBe(true);
    expect(monoPixel(f, 10, 8)).toBe(true); // inside drawBox(4, 4, 20, 10)
    expect(monoPixel(f, 4, 4)).toBe(true);
    expect(monoPixel(f, 24, 8)).toBe(false);
    expect(monoPixel(f, 40, 30)).toBe(false);
    sim.runFor(600);
    expect(serialLines(sim).at(-1)).toBe("inverse");
    expect(sim.partState("oled")!.inverted).toBe(true);
    f = frameOf(sim, "oled");
    expect(monoPixel(f, 40, 30)).toBe(true);
  });

  it("the sketch reports a missing display when the bus NACKs", () => {
    const sim = unoBench({ parts: [{ id: "oled", type: "ssd1306-oled-i2c", x: 0, y: 0 }], wires: i2cWires("oled"), hex: "./example.hex", base: import.meta.url });
    sim.setBusFault("oled", "nack");
    sim.runFor(300);
    expect(serialLines(sim)[0]).toBe("SSD1306 not found at 0x3C: check wiring");
  });
});
