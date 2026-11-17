// Round 7 (voice): real compiled firmware talks to the DFPlayer Mini through the board's hardware
// UART pins, both ways, on both backends: the Nano's USART (D1 TX → 1k → RX, TX → D0) and the XIAO
// RP2040's Serial1 (GP0 / GP1). Each sketch plays track 2, waits for the module's 0x3D "finished"
// reply and only then plays track 1, so the second clip proves the reply reached the firmware.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProject } from "@fabwright/project-format";
import { Simulation } from "@fabwright/sim-core";
import { backendFactory } from "@fabwright/sim-backends";
import { registry } from "./registry.gen.ts";

const CLIPS = "1: hi! I'm Eggy\n2: whoa, I'm dizzy!";

function sim(board: { id: string; type: string; tx: string; rx: string; v: string; gnd: string }, hex: string) {
  const w = (id: string, a: string, b: string) => {
    const [ap, aq] = a.split(":");
    const [bp, bq] = b.split(":");
    return { id, from: { part: ap!, pin: aq! }, to: { part: bp!, pin: bq! } };
  };
  const project = parseProject({
    format: "fabwright/1",
    name: "df firmware",
    parts: [
      { id: board.id, type: board.type, x: 0, y: 0 },
      { id: "df", type: "dfplayer-mini", x: 0, y: 0, props: { clips: CLIPS } },
      { id: "r1", type: "resistor", x: 0, y: 0, props: { resistance: 1000 } },
      { id: "spk", type: "speaker", x: 0, y: 0 },
    ],
    wires: [
      w("w1", "df:VCC", `${board.id}:${board.v}`),
      w("w2", "df:GND.1", `${board.id}:${board.gnd}`),
      w("w3", `${board.id}:${board.tx}`, "r1:1"),
      w("w4", "r1:2", "df:RX"),
      w("w5", "df:TX", `${board.id}:${board.rx}`),
      w("w6", "spk:+", "df:SPK_1"),
      w("w7", "spk:-", "df:SPK_2"),
    ],
    firmware: { board: board.id, artifact: "x.hex" },
  });
  return new Simulation({ project, registry, backendFactory, firmware: readFileSync(new URL(hex, import.meta.url), "utf8"), chunkMs: 1 });
}

describe("DFPlayer Mini on hardware UART pins", () => {
  it("Arduino Nano hardware Serial (D1 / D0): plays 2, hears 0x3D, plays 1", () => {
    const s = sim({ id: "nano", type: "arduino-nano", tx: "D1", rx: "D0", v: "5V", gnd: "GND.1" }, "./parts/dfplayer-mini/fixtures/nano_hwserial/nano_hwserial.hex");
    s.runFor(1700);
    expect(s.partState("df")).toMatchObject({ online: true, saying: "whoa, I'm dizzy!", speaking: true, volume: 25, badFrames: 0 });
    s.runFor(2000);
    const said = s.speech();
    expect(said.map((u) => u.text)).toEqual(["whoa, I'm dizzy!", "hi! I'm Eggy"]);
    // The reply went out right after clip 2 ended and the next command came straight back.
    expect(said[1]!.t_ms - (said[0]!.t_ms + said[0]!.dur_ms)).toBeLessThan(60);
    expect(s.diagnostics().filter((d) => d.partId === "df" && d.severity !== "info")).toEqual([]);
  }, 60_000);

  it("Seeed XIAO RP2040 Serial1 (GP0 / GP1): plays 2, hears 0x3D, plays 1", () => {
    const s = sim({ id: "xiao", type: "seeed-xiao-rp2040", tx: "GP0", rx: "GP1", v: "VBUS", gnd: "GND.1" }, "./parts/dfplayer-mini/fixtures/xiao_serial1/xiao_serial1.hex");
    s.runFor(4500);
    const said = s.speech();
    expect(said.map((u) => u.text)).toEqual(["whoa, I'm dizzy!", "hi! I'm Eggy"]);
    expect(said.every((u) => u.audible)).toBe(true);
    expect(s.serialText()).toContain("player online");
    expect(s.serialText()).toContain("done 2");
  }, 120_000);
});
