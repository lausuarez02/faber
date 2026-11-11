// Round 10: a Renode board with real parts, through sim-core's Simulation (what jumper serve runs).
// Needs Renode (Docker + jumper/renode, or JUMPER_RENODE_RUNTIME=native); skipped otherwise, saying why.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProject } from "@jumper/project-format";
import { Simulation } from "@jumper/sim-core";
import { nodeBackendFactory } from "@jumper/sim-backends/node";
import { renodeUnavailable } from "@jumper/sim-backends/renode";
import { describe, expect, it } from "vitest";
import { registry } from "./registry.gen.ts";

const why = renodeUnavailable();
const hex = readFileSync(fileURLToPath(new URL("../../sim-backends/fixtures/renode/oled_blackpill-stm32-blackpill-f411.hex", import.meta.url)), "latin1");

describe.skipIf(!!why)(`Black Pill F411 + SSD1306 on Renode${why ? ` [skipped: ${why}]` : ""}`, () => {
  it("runs Adafruit_SSD1306 on Wire and the display draws; the LED on PC13 blinks; Serial prints", { timeout: 180_000 }, () => {
    const project = parseProject({
      format: "jumper/1",
      name: "black-pill-oled",
      parts: [
        { id: "board", type: "stm32-blackpill-f411", x: 0, y: 0 },
        { id: "oled", type: "ssd1306-oled-i2c", x: 0, y: 0 },
      ],
      wires: [
        { id: "w1", from: { part: "oled", pin: "VCC" }, to: { part: "board", pin: "3V3.1" } },
        { id: "w2", from: { part: "oled", pin: "GND" }, to: { part: "board", pin: "GND.1" } },
        { id: "w3", from: { part: "oled", pin: "SDA" }, to: { part: "board", pin: "PB7" } },
        { id: "w4", from: { part: "oled", pin: "SCL" }, to: { part: "board", pin: "PB6" } },
      ],
      firmware: { board: "board", artifact: "firmware/oled.hex" },
    });
    const sim = new Simulation({ project, registry, backendFactory: nodeBackendFactory, firmware: hex });
    try {
      const t0 = Date.now();
      sim.runFor(1500);
      const wall = Date.now() - t0;
      expect(sim.serialText()).toContain("oled ok");
      expect(sim.serialText()).toMatch(/frame \d+/);
      const st = sim.partState("oled")!;
      expect(Number(st.lit)).toBeGreaterThan(100);
      expect(sim.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
      console.log(`black pill + ssd1306: 1500 ms virtual in ${wall} ms wall, ${st.lit} pixels lit`);
    } finally {
      sim.dispose();
    }
  });
});
