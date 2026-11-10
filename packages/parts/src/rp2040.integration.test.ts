// End to end without a browser, for the RP2040 boards: the real part registry, the real rp2040js
// backend (with Jumper's own boot ROM) and golden arduino-pico firmware from
// packages/sim-backends/fixtures (see BUILD.md there). Like blink.integration.test.ts for the Uno.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject, type ProjectInput } from "@jumper/project-format";
import { colorFrameAverage, monoPixel, Simulation } from "@jumper/sim-core";
import { backendFactory } from "@jumper/sim-backends";
import { registry } from "./registry.gen.ts";
import { asciiOf, frameOf, serialLines } from "./lib/firmwareBench.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../sim-backends/fixtures/${name}.hex`, import.meta.url)), "utf8");

function sim(board: { id: string; type: string }, parts: NonNullable<ProjectInput["parts"]>, wires: [string, string][], hex: string): Simulation {
  const project = parseProject({
    format: "jumper/1",
    name: "rp2040-it",
    parts: [{ ...board, x: 0, y: 0 }, ...parts],
    wires: wires.map(([a, b], i) => {
      const [pa, pina] = a.split(":");
      const [pb, pinb] = b.split(":");
      return { id: `w${i + 1}`, from: { part: pa!, pin: pina! }, to: { part: pb!, pin: pinb! } };
    }),
    firmware: { board: board.id, artifact: "firmware/main.hex" },
  });
  return new Simulation({ project, registry, backendFactory, firmware: hex });
}

const XIAO = { id: "xiao", type: "seeed-xiao-rp2040" };
const PICO = { id: "pico", type: "raspberry-pi-pico" };

describe("Seeed XIAO RP2040 + LED: golden blink", { timeout: 60_000 }, () => {
  const hex = fixture("xiao_blink");
  const build = () =>
    sim(
      XIAO,
      [
        { id: "r1", type: "resistor", x: 0, y: 0, props: { resistance: 220 } },
        { id: "led1", type: "led", x: 0, y: 0 },
      ],
      [
        ["xiao:GP26", "r1:1"],
        ["r1:2", "led1:A"],
        ["led1:C", "xiao:GND.1"],
      ],
      hex,
    );

  it("blinks D0 (GP26) 500 ms on / off at ~4.5 mA, the red user LED in step, USB serial in order", () => {
    const s = build();
    expect(s.boardId).toBe("xiao");
    s.runFor(250);
    const on = s.partState("led1")!;
    expect(on.on).toBe(true);
    expect(Number(on.currentmA)).toBeGreaterThan(3.5);
    expect(Number(on.currentmA)).toBeLessThan(5.5);
    expect(s.partState("xiao")).toMatchObject({ running: true, led_r: 1, pin_GP26: 1 });
    s.runFor(500); // t = 750 ms
    expect(s.partState("led1")).toMatchObject({ on: false });
    expect(s.partState("xiao")).toMatchObject({ led_r: 0 });
    s.runFor(500); // t = 1250 ms
    expect(s.partState("led1")).toMatchObject({ on: true });
    // The USB host enumerates after ~15 ms, so the first "LED on 0" is lost, as on a real board
    // without while (!Serial).
    expect(serialLines(s)).toEqual(["LED off 500", "LED on 1"]);
    expect(s.diagnostics().filter((d) => d.severity !== "info")).toEqual([]);
    s.dispose();
  });

  it("toggles the pin exactly every 500 ms of virtual time (deterministic clock)", () => {
    const s = build();
    const edges: number[] = [];
    let last = -1;
    s.every(1, (t) => {
      const v = Number(s.partState("xiao")!.pin_GP26);
      if (v !== last) edges.push(Math.round(t));
      last = v;
    });
    s.runFor(2100);
    // Sampled every 1 ms, so each interval reads 500 ± 1.
    const gaps = edges.slice(1, 5).map((t, i, a) => (i ? t - a[i - 1]! : 0)).slice(1);
    expect(gaps).toHaveLength(3);
    for (const g of gaps) expect(Math.abs(g - 500)).toBeLessThanOrEqual(1);
  });

  it("is deterministic under animation-frame slicing", () => {
    const a = build();
    const b = build();
    a.runFor(1100);
    for (let i = 0; i < 68; i++) b.runFor(16);
    b.runFor(12);
    expect(a.traceHash()).toBe(b.traceHash());
    expect(a.serialText()).toBe(b.serialText());
  });
});

describe("Seeed XIAO RP2040 + SSD1306 OLED on Wire (I2C1, D4/D5): golden oled", { timeout: 60_000 }, () => {
  const hex = fixture("xiao_oled");
  const wires: [string, string][] = [
    ["oled:GND", "xiao:GND.1"],
    ["oled:VCC", "xiao:3V3"],
    ["oled:SDA", "xiao:GP6"],
    ["oled:SCL", "xiao:GP7"],
  ];

  it("draws the title, the counter and a bar whose length follows sinf() through the ROM float routines", () => {
    const s = sim(XIAO, [{ id: "oled", type: "ssd1306-oled-i2c", x: 0, y: 0 }], wires, hex);
    s.runFor(1100);
    const lines = serialLines(s);
    // "oled ok" goes out before the USB host has enumerated, as on a board without while (!Serial).
    // bar = 64 + (int)(20·sinf(frame / 4)).
    expect(lines.slice(0, 4)).toEqual(["frame 0 bar 64", "frame 1 bar 68", "frame 2 bar 73", "frame 3 bar 77"]);
    expect(s.i2c.list()).toEqual([{ partId: "oled", address: 0x3c }]);
    const f = frameOf(s, "oled");
    const art = asciiOf(s, "oled");
    expect(art.split("\n").slice(0, 16).join("\n")).toMatch(/#/); // "Pocket" in size-2 text
    const bar = Number(/bar (\d+)$/.exec(lines.at(-1)!)![1]);
    expect(monoPixel(f, 0, 44)).toBe(true);
    expect(monoPixel(f, bar - 1, 44)).toBe(true);
    expect(monoPixel(f, bar + 1, 44)).toBe(false);
    expect(s.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
  });

  it("the OLED on the wrong pins is not on the bus, and Jumper says which wires are missing", () => {
    const s = sim(
      XIAO,
      [{ id: "oled", type: "ssd1306-oled-i2c", x: 0, y: 0 }],
      [
        ["oled:GND", "xiao:GND.1"],
        ["oled:VCC", "xiao:3V3"],
        ["oled:SDA", "xiao:GP26"],
        ["oled:SCL", "xiao:GP27"],
      ],
      hex,
    );
    s.runFor(50);
    const d = s.diagnostics().find((x) => x.code === "i2c-not-connected");
    expect(d?.message).toContain("xiao:GP6");
    expect(d?.message).toContain("xiao:GP7");
  });
});

describe("Seeed XIAO RP2040 I/O probe: button, PWM, ADC, Serial1 to an ESP-01, SPI", { timeout: 60_000 }, () => {
  const hex = fixture("xiao_io_probe");
  const build = (extraWires: [string, string][] = []) =>
    sim(
      XIAO,
      [
        { id: "btn", type: "pushbutton", x: 0, y: 0 },
        { id: "pot", type: "potentiometer", x: 0, y: 0, props: { position: 0.25 } },
        { id: "r1", type: "resistor", x: 0, y: 0, props: { resistance: 220 } },
        { id: "led1", type: "led", x: 0, y: 0 },
      ],
      [
        ["btn:1a", "xiao:GP26"],
        ["btn:2a", "xiao:GND.1"],
        ["pot:1", "xiao:3V3"],
        ["pot:2", "xiao:GND.1"],
        ["pot:W", "xiao:GP28"],
        ["xiao:GP27", "r1:1"],
        ["r1:2", "led1:A"],
        ["led1:C", "xiao:GND.1"],
        ...extraWires,
      ],
      hex,
    );

  it("reads the button through INPUT_PULLUP and the pot through the 12-bit ADC (10-bit analogRead)", () => {
    const s = build();
    s.runFor(250);
    // position 0.25 puts the wiper a quarter of the way from pin 2 (GND) to pin 1 (3V3)... see the
    // potentiometer part: the reading is 3/4 of full scale here, 1/4 after moving it to 0.75.
    expect(serialLines(s).find((l) => l.startsWith("btn"))).toMatch(/^btn 1 adc 76[0-9]$/);
    s.interact("btn", { kind: "press" });
    s.setProp("pot", "position", 0.75);
    s.runFor(200);
    expect(serialLines(s).filter((l) => l.startsWith("btn")).at(-1)).toMatch(/^btn 0 adc 25[0-9]$/);
  });

  it("drives the LED on D1 with 25 % PWM at arduino-pico's 1 kHz", () => {
    const s = build();
    s.runFor(100);
    const p = s.pwm("xiao", "GP27")!;
    expect(p.duty).toBeGreaterThan(0.24);
    expect(p.duty).toBeLessThan(0.26);
    expect(p.freqHz).toBeGreaterThan(990);
    expect(p.freqHz).toBeLessThan(1010);
    expect(Number(s.partState("led1")!.brightness)).toBeGreaterThan(0.15);
  });

  it("talks to an ESP-01 on Serial1 through the wires: D6 (TX) → ESP RX, ESP TX → D7 (RX), 115200 baud", () => {
    const s = sim(
      XIAO,
      [{ id: "esp", type: "esp01-wifi", x: 0, y: 0 }],
      [
        ["esp:VCC", "xiao:3V3"],
        ["esp:GND", "xiao:GND.1"],
        ["esp:EN", "xiao:3V3"],
        ["esp:RST", "xiao:3V3"],
        ["esp:TX", "xiao:GP1"],
        ["esp:RX", "xiao:GP0"],
      ],
      hex,
    );
    s.runFor(800);
    const rx = serialLines(s).filter((l) => l.startsWith("rx "));
    // The module's boot chatter (74880 baud) reads as garbage first, like on hardware.
    expect(rx).toContain("rx ready");
    expect(rx.slice(rx.indexOf("rx ready"))).toEqual(expect.arrayContaining(["rx AT", "rx OK"]));
    expect(s.diagnostics().filter((d) => d.code === "esp-baud-mismatch")).toEqual([]);
  });

  it("clocks SPI: with nothing on MISO every byte reads 0xFF", () => {
    const s = build();
    s.runFor(250);
    expect(serialLines(s)).toContain("spi FF FF FF");
  });
});

describe("Raspberry Pi Pico gadget: ST7735 TFT on SPI0, MPU6050 on Wire, button + passive buzzer", { timeout: 120_000 }, () => {
  const hex = fixture("pico_gadget");
  const build = () =>
    sim(
      PICO,
      [
        { id: "tft", type: "st7735-tft", x: 0, y: 0 },
        { id: "imu", type: "mpu6050", x: 0, y: 0, props: { accelX: 0, accelY: 0, accelZ: 1 } },
        { id: "btn", type: "pushbutton", x: 0, y: 0 },
        { id: "bz", type: "buzzer", x: 0, y: 0 },
      ],
      [
        ["tft:VCC", "pico:3V3"],
        ["tft:GND", "pico:GND.1"],
        ["tft:LED", "pico:3V3"],
        ["tft:SCK", "pico:GP18"],
        ["tft:MOSI", "pico:GP19"],
        ["tft:CS", "pico:GP17"],
        ["tft:DC", "pico:GP20"],
        ["tft:RST", "pico:GP21"],
        ["imu:VCC", "pico:3V3"],
        ["imu:GND", "pico:GND.2"],
        ["imu:SDA", "pico:GP4"],
        ["imu:SCL", "pico:GP5"],
        ["btn:1a", "pico:GP14"],
        ["btn:2a", "pico:GND.3"],
        ["bz:POS", "pico:GP15"],
        ["bz:NEG", "pico:GND.4"],
      ],
      hex,
    );

  it("draws the title bar and the accelerometer reading on the TFT and prints it on serial", () => {
    const s = build();
    // Adafruit_ST7735::initR() waits ~1.3 s in its init sequence before the first frame.
    s.runFor(1800);
    const lines = serialLines(s);
    expect(lines.some((l) => l === "accel 0.00 0.00 1.00")).toBe(true);
    const f = s.framebuffer("tft")!;
    expect([f.width, f.height, f.on]).toEqual([128, 160, true]);
    expect(colorFrameAverage(f, 100, 2, 20, 14)).toBe("#0000FF");
    expect(s.i2c.list()).toEqual([{ partId: "imu", address: 0x68 }]);
    s.setProp("imu", "accelZ", -1);
    s.runFor(300);
    expect(serialLines(s).at(-1)).toBe("accel 0.00 0.00 -1.00");
  });

  it("plays a 1 kHz tone() on GP15 while the button is held", () => {
    const s = build();
    s.runFor(1700);
    s.interact("btn", { kind: "press" });
    s.runFor(300);
    expect(serialLines(s)).toContain("beep");
    const p = s.pwm("pico", "GP15")!;
    expect(p.freqHz).toBeGreaterThan(990);
    expect(p.freqHz).toBeLessThan(1010);
    // tone() runs on a PIO state machine (arduino-pico's tone2 program): the edges come from PIO1.
    // The part here is the active `buzzer`, which the parts track's passive buzzer will replace;
    // the square wave is what a passive one needs.
  });
});
