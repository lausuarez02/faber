// A native toolchain installed before the rename from Jumper keeps working without a reinstall.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptPreRenameLibraries, BASE_LIBRARIES, ESP32_NETWORK_LIBRARIES, nativeArduinoDir } from "../src/native/arduino.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FABER_NATIVE_HOME;
  process.env.FABER_NATIVE_HOME = mkdtempSync(join(tmpdir(), "faber-native-"));
});
afterEach(() => {
  if (saved === undefined) delete process.env.FABER_NATIVE_HOME;
  else process.env.FABER_NATIVE_HOME = saved;
});

describe("native Arduino libraries installed before the rename", () => {
  it("get the Faber shim libraries copied in and a new stamp, with no download; the old ones stay", () => {
    const user = join(nativeArduinoDir(), "user", "esp32");
    mkdirSync(join(user, "libraries", "JumperSim"), { recursive: true });
    writeFileSync(join(user, ".jumper-libs.json"), JSON.stringify({ base: BASE_LIBRARIES, net: ESP32_NETWORK_LIBRARIES, rev: 1 }));
    expect(adoptPreRenameLibraries("esp32")).toBe(true);
    expect(existsSync(join(user, "libraries", "FaberSim", "src", "FaberSim.h"))).toBe(true);
    expect(existsSync(join(user, "libraries", "FaberSim", "src", "JumperSim.h"))).toBe(true);
    expect(existsSync(join(user, "libraries", "FaberEth", "src", "faber_eth.h"))).toBe(true);
    expect(existsSync(join(user, "libraries", "JumperSim"))).toBe(true);
    expect(JSON.parse(readFileSync(join(user, ".faber-libs.json"), "utf8")).rev).toBe(1);
  });

  it("an older or different library set is not adopted (the setup installs it)", () => {
    const user = join(nativeArduinoDir(), "user", "esp32");
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, ".jumper-libs.json"), JSON.stringify({ base: [], net: [], rev: 0 }));
    expect(adoptPreRenameLibraries("esp32")).toBe(false);
    expect(adoptPreRenameLibraries("base")).toBe(false);
  });
});
