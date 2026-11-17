// Round 6, frames track (decision 0004, R7): the libs3 library set. Each sketch in
// packages/parts/fixtures/libs3/ (built with the pinned faber/arduino-runner / arduino-pico libs3
// images, see BUILD.md there) runs on the simulator with the part it drives, so an agent that
// reaches for Adafruit_GC9A01A, TFT_eSPI, the DHT library, FastLED or Adafruit NeoPixel gets the
// same pixels, readings and LED colours the real hardware would show.
//
// When Docker and the libs3 images are present, the sketches are also rebuilt and must match the
// committed hexes byte for byte (the images are pinned), and the Adafruit NeoPixel sketches (LGPL-3.0:
// no binary of them is committed) are built and run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject, type ProjectInput } from "@faber/project-format";
import { colorFrameStats, colorFrameAverage, Simulation } from "@faber/sim-core";
import { backendFactory } from "@faber/sim-backends";
import { buildFirmware, canBuildArduino } from "@faber/runner";
import { registry } from "./registry.gen.ts";
import { serialLines } from "./lib/firmwareBench.ts";

const FIX = new URL("../fixtures/libs3/", import.meta.url);
const hexOf = (name: string) => readFileSync(new URL(`${name}.hex`, FIX), "utf8");

type Board = "uno" | "xiao";
const BOARD: Record<Board, { type: string; fqbn: string }> = {
  uno: { type: "arduino-uno", fqbn: "arduino:avr:uno" },
  xiao: { type: "seeed-xiao-rp2040", fqbn: "rp2040:rp2040:seeed_xiao_rp2040" },
};

function bench(board: Board, parts: NonNullable<ProjectInput["parts"]>, wires: [string, string][], hex: string): Simulation {
  const project = parseProject({
    format: "faber/1",
    name: "libs3",
    parts: [{ id: board, type: BOARD[board].type, x: 0, y: 0 }, ...parts],
    wires: wires.map(([a, b], i) => {
      const [pa, pina] = a.split(":");
      const [pb, pinb] = b.split(":");
      return { id: `w${i + 1}`, from: { part: pa!, pin: pina! }, to: { part: pb!, pin: pinb! } };
    }),
    firmware: { board, artifact: "firmware/main.hex" },
  });
  return new Simulation({ project, registry, backendFactory, firmware: hex });
}

const tftWires = (board: Board): [string, string][] =>
  board === "uno"
    ? [["eye:VCC", "uno:5V"], ["eye:GND", "uno:GND.1"], ["eye:SCK", "uno:D13"], ["eye:MOSI", "uno:D11"], ["eye:RST", "uno:D8"], ["eye:DC", "uno:D9"], ["eye:CS", "uno:D10"]]
    : [["eye:VCC", "xiao:3V3"], ["eye:GND", "xiao:GND.1"], ["eye:SCK", "xiao:GP2"], ["eye:MOSI", "xiao:GP3"], ["eye:RST", "xiao:GP28"], ["eye:DC", "xiao:GP29"], ["eye:CS", "xiao:GP1"]];

/** The orange disc with two dark eyes and a blue mouth every round-TFT sketch draws. */
function expectFace(s: Simulation): void {
  const f = s.framebuffer("eye")!;
  expect(f.on).toBe(true);
  expect(colorFrameStats(f).lit).toBeGreaterThan(15_000);
  const orange = colorFrameAverage(f, 115, 60, 10, 10);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(orange.slice(i, i + 2), 16));
  expect(r).toBeGreaterThan(200);
  expect(g).toBeGreaterThan(100);
  expect(g).toBeLessThan(200);
  expect(b).toBeLessThan(40);
  expect(colorFrameAverage(f, 86, 96, 8, 8)).toBe("#000000"); // left eye
  expect(colorFrameAverage(f, 110, 152, 20, 6)).toMatch(/^#0000[F-f][0-9A-F]$/i); // mouth: blue
  expect(colorFrameAverage(f, 2, 2, 6, 6)).toBe("#000000"); // a corner, outside the disc
}

/** The strip the fastled_* / neopixel_* sketches light: red, green, blue, then dim white. */
function expectStrip(lib: "fastled" | "neopixel", board: Board, hex: string): void {
  const wires: [string, string][] = board === "uno" ? [["strip:VCC", "uno:5V"], ["strip:GND", "uno:GND.1"], ["strip:DIN", "uno:D6"]] : [["strip:VCC", "xiao:VBUS"], ["strip:GND", "xiao:GND.1"], ["strip:DIN", "xiao:GP26"]];
  const s = bench(board, [{ id: "strip", type: "ws2812-strip", x: 0, y: 0, props: { count: 8 } }], wires, hex);
  s.runFor(board === "uno" ? 300 : 800);
  // RP2040: the USB host enumerates after setup() printed, so only the Uno's line is checked.
  if (board === "uno") expect(serialLines(s)).toContain(`${lib} shown`);
  expect(s.partState("strip")).toMatchObject({ colors: "#FF0000 #00FF00 #0000FF #101010 #101010 #101010 #101010 #101010", lit: 8 });
  // FastLED's RP2040 PIO driver sends a few 0 bits at ~0.216 µs HIGH, just under the 0.22 µs floor
  // of the WS2812B-V5 datasheet; the sim reports that honestly (a handful of bits, not all).
  const warn = s.diagnostics().filter((d) => d.severity !== "info");
  if (lib === "fastled" && board === "xiao") expect(warn.every((d) => d.code === "ws2812-timing")).toBe(true);
  else expect(warn).toEqual([]);
  s.dispose();
}

describe("libs3 sketches on the simulator", { timeout: 120_000 }, () => {
  for (const board of ["uno", "xiao"] as const) {
    it(`Adafruit_GC9A01A draws on the round TFT (${board})`, () => {
      const s = bench(board, [{ id: "eye", type: "gc9a01-round-tft", x: 0, y: 0, ...(board === "xiao" ? { props: { logic: "3v3-only" } } : {}) }], tftWires(board), hexOf(`gc9a01a_${board}`));
      s.runFor(1500);
      expect(serialLines(s)).toContain("gc9a01a drawn");
      expectFace(s);
      expect(s.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
      s.dispose();
    });

    it(`the DHT sensor library reads the DHT22 (${board})`, () => {
      const pin = board === "uno" ? "uno:D2" : "xiao:GP26";
      const s = bench(board, [{ id: "dht", type: "dht22", x: 0, y: 0, props: { temperature: 23.4, humidity: 41.5 } }], [["dht:VCC", board === "uno" ? "uno:5V" : "xiao:3V3"], ["dht:GND", board === "uno" ? "uno:GND.1" : "xiao:GND.1"], ["dht:DATA", pin]], hexOf(`dht_${board}`));
      s.runFor(4800);
      const lines = serialLines(s).filter((l) => l.startsWith("t=") || l.includes("failed"));
      expect(lines.length).toBeGreaterThan(0);
      // The DHT22 hands out the measurement of the previous read (datasheet), so look at the last line.
      expect(lines.at(-1)).toBe("t=23.4 h=41.5");
      s.dispose();
    });
  }

  for (const board of ["uno", "xiao"] as const)
    it(`FastLED drives the WS2812B strip (${board}${board === "xiao" ? ", RP2040 PIO" : ""})`, () => expectStrip("fastled", board, hexOf(`fastled_${board}`)));

  it("TFT_eSPI with a sketch tft_setup.h draws on the round TFT (xiao)", () => {
    const s = bench("xiao", [{ id: "eye", type: "gc9a01-round-tft", x: 0, y: 0, props: { logic: "3v3-only" } }], tftWires("xiao"), hexOf("tft_espi_xiao"));
    s.runFor(1500);
    expect(serialLines(s)).toContain("tft_espi drawn");
    expectFace(s);
    s.dispose();
  });
});

// Rebuilding needs Docker and the libs3 images (CI builds them; locally `ensureImage` builds them
// on first use, a few minutes). FABER_TEST_LIBS3=1 forces it on.
// Round 11: or Faber's native toolchain (faber setup avr rp2040), same pinned cores and libraries.
const imagesReady = process.env.FABER_TEST_LIBS3 === "1" || (canBuildArduino("arduino:avr:uno").ok && canBuildArduino("rp2040:rp2040:seeed_xiao_rp2040").ok);

const SKETCHES: [string, Board, string[]][] = [
  ["gc9a01a_uno", "uno", ["Adafruit GC9A01A"]],
  ["gc9a01a_xiao", "xiao", ["Adafruit GC9A01A"]],
  ["dht_uno", "uno", ["DHT sensor library"]],
  ["dht_xiao", "xiao", ["DHT sensor library"]],
  ["fastled_uno", "uno", ["FastLED"]],
  ["fastled_xiao", "xiao", ["FastLED"]],
  ["tft_espi_xiao", "xiao", ["TFT_eSPI"]],
];
const build = (name: string, board: Board, libraries: string[]) => buildFirmware({ sketchDir: fileURLToPath(new URL(name, FIX)), fqbn: BOARD[board].fqbn, libraries });

describe.skipIf(!imagesReady)("libs3 sketches build with the pinned images", () => {
  for (const [name, board, libraries] of SKETCHES) {
    it(
      `${name} builds byte-identical to its committed hex (native: or behaves the same)`,
      async () => {
        const r = await build(name, board, libraries);
        expect(r.ok, r.logTail).toBe(true);
        if (r.hex !== hexOf(name) && canBuildArduino(BOARD[board].fqbn).runtime === "native") {
          // Round 11: a native build uses the same compiler versions built for another host (macOS
          // vs the image's Linux). Most sketches come out byte-identical; FastLED's differs by a
          // few bytes of register allocation (GCC is not bit-reproducible across host libcs), so
          // the native build must do what the committed one does instead.
          expect(Math.abs(r.hex!.length - hexOf(name).length) / hexOf(name).length).toBeLessThan(0.01);
          expect(name.startsWith("fastled_"), `${name}: native bytes differ and no behaviour check is defined`).toBe(true);
          expectStrip("fastled", board, r.hex!);
          return;
        }
        expect(r.hex).toBe(hexOf(name));
      },
      600_000,
    );
  }

  // Adafruit NeoPixel is LGPL-3.0, so no binary linking it is committed (NOTICE): built here, then run.
  for (const board of ["uno", "xiao"] as const) {
    it(
      `Adafruit NeoPixel builds and drives the WS2812B strip (${board})`,
      async () => {
        const r = await build(`neopixel_${board}`, board, ["Adafruit NeoPixel"]);
        expect(r.ok, r.logTail).toBe(true);
        expectStrip("neopixel", board, r.hex!);
      },
      600_000,
    );
  }

  it(
    "every pinned display / sensor library builds for RP2040 too",
    async () => {
      const r = await build("all_xiao", "xiao", ["Adafruit SSD1306", "Adafruit ST7735 and ST7789 Library", "Adafruit ILI9341", "Adafruit GC9A01A", "Adafruit MPU6050", "DHT sensor library"]);
      expect(r.ok, r.logTail).toBe(true);
    },
    600_000,
  );
});
