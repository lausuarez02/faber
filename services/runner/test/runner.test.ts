import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFirmware, canBuildArduino, imageFor, libraryForHeader, parseCompilerOutput, PICO_IMAGE, refineWithSources, resolveLibraries, RUNNER_IMAGE, startRunnerServer, SUPPORTED_FQBNS } from "../src/index.ts";
import { sketchSetupFlags } from "../src/build.ts";

// Round 11: Docker with the image, or Faber's native toolchain (faber setup avr / rp2040).
const avrReady = canBuildArduino("arduino:avr:uno");

describe("library resolution", () => {
  it("pins bare names and adds pinned dependencies", () => {
    expect(resolveLibraries(["Adafruit SSD1306"])).toEqual(["Adafruit BusIO@1.17.4", "Adafruit GFX Library@1.13.0", "Adafruit SSD1306@2.5.17"]);
    expect(resolveLibraries(["Servo@1.2.2"])).toEqual(["Servo@1.2.2"]);
    expect(() => resolveLibraries(["Servo@latest"])).toThrow(/invalid version 'latest'.*Fix:/s);
  });
});

describe("libs3 (round 6)", () => {
  it("pins the libraries agents reach for, with their dependencies, on libs3 images", () => {
    expect(resolveLibraries(["DHT sensor library"])).toEqual(["Adafruit Unified Sensor@1.1.15", "DHT sensor library@1.4.7"]);
    expect(resolveLibraries(["Adafruit GC9A01A"])).toEqual(["Adafruit BusIO@1.17.4", "Adafruit GC9A01A@1.2.0", "Adafruit GFX Library@1.13.0"]);
    expect(resolveLibraries(["FastLED", "TFT_eSPI", "Adafruit NeoPixel"])).toEqual(["Adafruit NeoPixel@1.15.5", "FastLED@3.10.8", "TFT_eSPI@2.5.43"]);
    for (const [h, lib] of [["Adafruit_GC9A01A.h", "Adafruit GC9A01A"], ["DHT.h", "DHT sensor library"], ["FastLED.h", "FastLED"], ["TFT_eSPI.h", "TFT_eSPI"], ["Adafruit_NeoPixel.h", "Adafruit NeoPixel"]]) expect(libraryForHeader(h!)).toBe(lib);
    expect(RUNNER_IMAGE).toMatch(/-libs3-r1$/);
    expect(PICO_IMAGE).toMatch(/-libs3-r1$/);
  });

  it("puts the sketch folder on the include path only when it has a tft_setup.h", () => {
    expect(sketchSetupFlags(new Map([["main.ino", ""]]))).toEqual([]);
    expect(sketchSetupFlags(new Map([["main.ino", ""], ["tft_setup.h", "#define GC9A01_DRIVER"]]))).toEqual(["--build-property", "compiler.cpp.extra_flags=-I/work/sketch", "--build-property", "compiler.c.extra_flags=-I/work/sketch"]);
  });
});

describe("compiler output", () => {
  const map = (p: string) => (p.startsWith("/work/sketch/") ? `firmware/${p.slice(13).replace("sketch.ino", "main.ino")}` : undefined);
  it("maps gcc errors to project files with a fix hint", () => {
    const out = [
      "/work/sketch/sketch.ino: In function 'void loop()':",
      "/work/sketch/sketch.ino:7:3: error: 'foo' was not declared in this scope",
      "/work/sketch/sketch.ino:2:10: fatal error: Adafruit_SSD1306.h: No such file or directory",
      "/opt/arduino/data/packages/arduino/hardware/avr/1.8.8/cores/arduino/main.cpp:43:1: error: inside the core",
      "Sketch too big; see https://support.arduino.cc/",
      "Error during build: exit status 1",
    ].join("\n");
    const d = parseCompilerOutput(out, map);
    expect(d[0]).toMatchObject({ severity: "error", file: "firmware/main.ino", line: 7, column: 3, message: "'foo' was not declared in this scope" });
    expect(d[0]!.hint).toMatch(/declare it above this line/);
    expect(d[1]!.hint).toMatch(/add "Adafruit SSD1306" to firmware.libraries/);
    expect(d.some((x) => x.message.includes("inside the core"))).toBe(false);
    expect(d.find((x) => /too big/.test(x.message))!.hint).toMatch(/32 KB flash/);
  });
});

describe("sketch-aware hints", () => {
  it("explains Arduino's prototype trap when the type is declared in the sketch", () => {
    const d = refineWithSources([{ severity: "error", file: "firmware/main.ino", line: 74, message: "'Mood' does not name a type; did you mean 'loop'?" }], new Map([["main.ino", "enum Mood { HAPPY, SAD };\nMood mood() { return HAPPY; }\n"]]));
    expect(d[0]!.hint).toMatch(/automatic function prototypes.*move the Mood declaration into a header/s);
    const lib = refineWithSources([{ severity: "error", message: "'Adafruit_SSD1306' does not name a type", hint: "x" }], new Map([["main.ino", "void setup(){}"]]));
    expect(lib[0]!.hint).toBe("x");
  });
});

describe.skipIf(!avrReady.ok)(`Arduino builds (${avrReady.runtime ?? "skipped: " + avrReady.why})`, () => {
  it(
    "builds the Blink example byte-identical to the golden hex, then serves it from cache",
    async () => {
      const dir = fileURLToPath(new URL("../../../examples/blink/firmware/blink", import.meta.url));
      const golden = readFileSync(fileURLToPath(new URL("../../../examples/blink/firmware/blink.hex", import.meta.url)), "utf8");
      const r = await buildFirmware({ sketchDir: dir, fqbn: "arduino:avr:uno", displayPrefix: "firmware/blink/" });
      expect(r.ok).toBe(true);
      expect(createHash("sha256").update(r.hex!).digest("hex")).toBe(createHash("sha256").update(golden).digest("hex"));
      const again = await buildFirmware({ sketchDir: dir, fqbn: "arduino:avr:uno" });
      expect(again.cached).toBe(true);
    },
    300_000,
  );

  it(
    "answers over HTTP with compile errors for inline sources",
    async () => {
      const server = await startRunnerServer(0);
      const addr = server.address() as { port: number };
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/build`, { method: "POST", body: JSON.stringify({ fqbn: "arduino:avr:uno", files: { "main.ino": "void setup(){ nope(); }\nvoid loop(){}\n" } }) });
        const body = (await res.json()) as { ok: boolean; diagnostics: { file: string; line: number }[] };
        expect(body.ok).toBe(false);
        expect(body.diagnostics[0]).toMatchObject({ file: "main.ino", line: 1 });
        const health = await (await fetch(`http://127.0.0.1:${addr.port}/health`)).json();
        expect(health).toMatchObject({ ok: true });
      } finally {
        server.close();
      }
    },
    300_000,
  );
});

// RP2040 builds use the arduino-pico image. It is ~1 GB, so these run only when it is already built
// (ensureImage(log, PICO_IMAGE), or the docker build lines in packages/parts/fixtures/libs3/BUILD.md)
// or FABER_TEST_PICO=1. CI builds it.
const picoReady = canBuildArduino("rp2040:rp2040:seeed_xiao_rp2040");
const picoImage = process.env.FABER_TEST_PICO === "1" || picoReady.ok;

describe("RP2040 image selection", () => {
  it("builds rp2040:rp2040:* with the arduino-pico image and AVR boards with the runner image", () => {
    expect(imageFor("rp2040:rp2040:seeed_xiao_rp2040")).toBe(PICO_IMAGE);
    expect(imageFor("rp2040:rp2040:rpipico")).toBe(PICO_IMAGE);
    expect(imageFor("arduino:avr:uno")).toBe(RUNNER_IMAGE);
    expect(SUPPORTED_FQBNS).toEqual(expect.arrayContaining(["arduino:avr:uno", "rp2040:rp2040:rpipico", "rp2040:rp2040:seeed_xiao_rp2040", "rp2040:rp2040:waveshare_rp2040_zero"]));
  });
});

describe.skipIf(!picoImage)(`RP2040 builds (arduino-pico, ${picoReady.runtime ?? "forced"})`, () => {
  it(
    "builds the XIAO RP2040 blink fixture byte-identical to the golden Intel HEX (flash at 0x10000000)",
    async () => {
      const dir = fileURLToPath(new URL("../../../packages/sim-backends/fixtures/xiao_blink", import.meta.url));
      const golden = readFileSync(fileURLToPath(new URL("../../../packages/sim-backends/fixtures/xiao_blink.hex", import.meta.url)), "utf8");
      const r = await buildFirmware({ sketchDir: dir, fqbn: "rp2040:rp2040:seeed_xiao_rp2040", cache: false });
      expect(r.ok, r.logTail).toBe(true);
      expect(r.hex!.split(/\r?\n/)[0]).toBe(":020000041000EA");
      expect(createHash("sha256").update(r.hex!).digest("hex")).toBe(createHash("sha256").update(golden).digest("hex"));
      expect(r.size).toMatchObject({ flashMax: 2093056, ramMax: 262144 });
    },
    600_000,
  );

  it(
    "reports RP2040 compile errors at the sketch line",
    async () => {
      const server = await startRunnerServer(0);
      const addr = server.address() as { port: number };
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/build`, { method: "POST", body: JSON.stringify({ fqbn: "rp2040:rp2040:rpipico", files: { "main.ino": "void setup(){ pinMode(25, OUTPUT); nope(); }\nvoid loop(){}\n" } }) });
        const body = (await res.json()) as { ok: boolean; diagnostics: { file: string; line: number; message: string }[] };
        expect(body.ok).toBe(false);
        expect(body.diagnostics[0]).toMatchObject({ file: "main.ino", line: 1 });
        expect(body.diagnostics[0]!.message).toMatch(/nope/);
      } finally {
        server.close();
      }
    },
    600_000,
  );
});
