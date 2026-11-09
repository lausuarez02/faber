import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFirmware, parseCompilerOutput, refineWithSources, resolveLibraries, startRunnerServer } from "../src/index.ts";

const dockerUp = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

describe("library resolution", () => {
  it("pins bare names and adds pinned dependencies", () => {
    expect(resolveLibraries(["Adafruit SSD1306"])).toEqual(["Adafruit BusIO@1.17.4", "Adafruit GFX Library@1.13.0", "Adafruit SSD1306@2.5.17"]);
    expect(resolveLibraries(["Servo@1.2.2"])).toEqual(["Servo@1.2.2"]);
    expect(() => resolveLibraries(["Servo@latest"])).toThrow(/invalid version 'latest'.*Fix:/s);
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

describe.skipIf(!dockerUp)("Docker builds", () => {
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
