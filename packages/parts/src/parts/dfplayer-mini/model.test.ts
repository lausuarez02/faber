import { describe, expect, it } from "vitest";
import { parseProject } from "@jumper/project-format";
import { Simulation } from "@jumper/sim-core";
import { registry } from "../../registry.gen.ts";
import { DF, dfFrame } from "../../lib/dfplayer.ts";
import { UartScriptMcu } from "../../lib/uartMcu.ts";

/** Uno pins driven by a script: D11 → 1k → DFPlayer RX, DFPlayer TX → D10, speaker on SPK_1 / SPK_2. */
function rig(opts: { speaker?: boolean; clips?: string; dac?: boolean } = {}) {
  const mcu = new UartScriptMcu();
  const w = (id: string, a: string, b: string) => {
    const [ap, aq] = a.split(":");
    const [bp, bq] = b.split(":");
    return { id, from: { part: ap!, pin: aq! }, to: { part: bp!, pin: bq! } };
  };
  const project = parseProject({
    format: "jumper/1",
    name: "df bench",
    parts: [
      { id: "uno", type: "arduino-uno", x: 0, y: 0 },
      { id: "df", type: "dfplayer-mini", x: 0, y: 0, props: { clips: opts.clips ?? "1: hi! I'm Eggy\n2: whoa, I'm dizzy!\n3/4: folder words" } },
      { id: "r1", type: "resistor", x: 0, y: 0, props: { resistance: 1000 } },
      ...(opts.speaker === false ? [] : [{ id: "spk", type: "speaker", x: 0, y: 0 }]),
    ],
    wires: [
      w("w1", "df:VCC", "uno:5V"),
      w("w2", "df:GND.1", "uno:GND.1"),
      w("w3", "uno:D11", "r1:1"),
      w("w4", "r1:2", "df:RX"),
      w("w5", "df:TX", "uno:D10"),
      ...(opts.speaker === false ? [] : opts.dac ? [w("w6", "spk:+", "df:DAC_R"), w("w7", "spk:-", "uno:GND.2")] : [w("w6", "spk:+", "df:SPK_1"), w("w7", "spk:-", "df:SPK_2")]),
    ],
    firmware: { board: "uno", artifact: "none.hex" },
  });
  const sim = new Simulation({ project, registry, backendFactory: () => mcu, chunkMs: 1 });
  mcu.idle("D11");
  sim.runFor(1);
  return { sim, mcu };
}

const replies = (bytes: number[]) => {
  const out: { cmd: number; param: number }[] = [];
  for (let i = 0; i + 9 < bytes.length; i++) {
    if (bytes[i] === 0x7e && bytes[i + 1] === 0xff && bytes[i + 9] === 0xef) out.push({ cmd: bytes[i + 3]!, param: (bytes[i + 5]! << 8) | bytes[i + 6]! });
  }
  return out;
};

describe("dfplayer-mini", () => {
  it("starts in about 1 s and sends 0x3F online (TF card)", () => {
    const { sim, mcu } = rig();
    expect(sim.partState("df")?.online).toBe(false);
    sim.runFor(1100);
    expect(sim.partState("df")?.online).toBe(true);
    sim.runFor(50);
    expect(replies(mcu.received("D10"))).toEqual([{ cmd: DF.ONLINE, param: 0x0002 }]);
  });

  it("play track 2 says its words: utterance, BUSY low while playing, 0x3D when done", () => {
    const { sim, mcu } = rig();
    sim.runFor(1200);
    mcu.send("D11", dfFrame(DF.VOLUME, 20));
    mcu.send("D11", dfFrame(DF.PLAY_TRACK, 2));
    sim.runFor(40);
    const st = sim.partState("df")!;
    expect(st.playing).toBe(true);
    expect(st.saying).toBe("whoa, I'm dizzy!");
    expect(st.speaking).toBe(true);
    expect(st.volume).toBe(20);
    expect(sim.pinVoltage("df", "BUSY")).toBeLessThan(0.5);
    expect(sim.partState("spk")?.sounding).toBe(true);
    const said = sim.speech();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ partId: "df", track: 2, clip: "2", text: "whoa, I'm dizzy!", audible: true, volume: 20 });
    // 3 words: 3 / 2.6 s + 0.3 s ≈ 1454 ms
    expect(said[0]!.dur_ms).toBe(1454);
    sim.runFor(1500);
    expect(sim.partState("df")?.playing).toBe(false);
    expect(sim.partState("df")?.saying).toBe("");
    expect(sim.pinVoltage("df", "BUSY")).toBeGreaterThan(3);
    sim.runFor(30);
    expect(replies(mcu.received("D10")).map((r) => r.cmd)).toEqual([DF.ONLINE, DF.TRACK_DONE]);
    expect(replies(mcu.received("D10"))[1]!.param).toBe(2);
  });

  it("FEEDBACK = 1 gets a 0x41 ACK; queries answer; folder and mp3-folder plays use their clip keys", () => {
    const { sim, mcu } = rig();
    sim.runFor(1200);
    mcu.send("D11", dfFrame(DF.Q_VOLUME, 0, 1));
    sim.runFor(80);
    mcu.send("D11", dfFrame(DF.PLAY_FOLDER, (3 << 8) | 4));
    sim.runFor(40);
    expect(sim.partState("df")?.saying).toBe("folder words");
    mcu.send("D11", dfFrame(DF.STOP));
    mcu.send("D11", dfFrame(DF.PLAY_MP3, 1));
    sim.runFor(60);
    expect(sim.partState("df")?.saying).toBe("hi! I'm Eggy");
    const cmds = replies(mcu.received("D10")).map((r) => r.cmd);
    expect(cmds.slice(0, 3)).toEqual([DF.ONLINE, DF.ACK, DF.Q_VOLUME]);
    expect(replies(mcu.received("D10"))[2]!.param).toBe(30);
    expect(sim.speech().map((u) => u.clip)).toEqual(["3/4", "1"]);
    // Stopping cut the first clip short.
    expect(sim.speech()[0]!.dur_ms).toBeLessThan(1000);
  });

  it("8-byte frames without a checksum work; a bad checksum is dropped with a visible warning", () => {
    const { sim, mcu } = rig();
    sim.runFor(1200);
    const f = dfFrame(DF.PLAY_TRACK, 1);
    mcu.send("D11", [...f.slice(0, 7), 0xef]);
    sim.runFor(40);
    expect(sim.partState("df")?.saying).toBe("hi! I'm Eggy");
    const bad = dfFrame(DF.PLAY_TRACK, 2);
    bad[8] = (bad[8]! + 1) & 0xff;
    mcu.send("D11", bad);
    sim.runFor(40);
    expect(sim.partState("df")?.badFrames).toBe(1);
    expect(sim.speech()).toHaveLength(1);
    const d = sim.diagnostics().find((x) => x.code === "dfplayer-bad-frame");
    expect(d?.message).toMatch(/checksum/);
    expect(d?.message).toMatch(/Why:.*Fix:/);
  });

  it("a track with no words says so, and warns", () => {
    const { sim, mcu } = rig();
    sim.runFor(1200);
    mcu.send("D11", dfFrame(DF.PLAY_TRACK, 7));
    sim.runFor(40);
    expect(sim.partState("df")?.saying).toBe("(track 7: no words set)");
    expect(sim.speech()[0]!.missing).toBe(true);
    expect(sim.diagnostics().find((x) => x.code === "dfplayer-no-words")?.message).toMatch(/track 7.*Fix: set_part_property df clips/);
  });

  it("no speaker: it plays (BUSY low) but nobody hears it, no bubble, a warning", () => {
    const { sim, mcu } = rig({ speaker: false });
    sim.runFor(1200);
    mcu.send("D11", dfFrame(DF.PLAY_TRACK, 1));
    sim.runFor(40);
    const st = sim.partState("df")!;
    expect(st.playing).toBe(true);
    expect(st.speaking).toBe(false);
    expect(sim.speech()[0]!.audible).toBe(false);
    expect(sim.diagnostics().find((x) => x.code === "dfplayer-silent")?.message).toMatch(/speaker \+ to df\.SPK_1/);
  });

  it("a speaker on the DAC output counts as audible (quiet)", () => {
    const { sim, mcu } = rig({ dac: true });
    sim.runFor(1200);
    mcu.send("D11", dfFrame(DF.PLAY_TRACK, 1));
    sim.runFor(40);
    expect(sim.partState("df")?.speaking).toBe(true);
  });

  it("commands sent while it is still starting are ignored and reported", () => {
    const { sim, mcu } = rig();
    sim.runFor(100);
    mcu.send("D11", dfFrame(DF.PLAY_TRACK, 1));
    sim.runFor(1200);
    expect(sim.speech()).toHaveLength(0);
    expect(sim.diagnostics().find((x) => x.code === "dfplayer-not-ready")?.message).toMatch(/delay\(1500\)/);
  });

  it("pause keeps the words and the clock; resume finishes the clip", () => {
    const { sim, mcu } = rig();
    sim.runFor(1200);
    mcu.send("D11", dfFrame(DF.PLAY_TRACK, 2));
    sim.runFor(300);
    mcu.send("D11", dfFrame(DF.PAUSE));
    sim.runFor(3000);
    expect(sim.partState("df")).toMatchObject({ paused: true, playing: false, saying: "whoa, I'm dizzy!" });
    mcu.send("D11", dfFrame(DF.RESUME));
    sim.runFor(2000);
    expect(sim.partState("df")?.saying).toBe("");
    expect(replies(mcu.received("D10")).map((r) => r.cmd)).toContain(DF.TRACK_DONE);
  });

  it("clips can change live (set_part_property) and accept JSON", () => {
    const { sim, mcu } = rig();
    sim.runFor(1200);
    sim.setProp("df", "clips", JSON.stringify({ "5": "new words" }));
    mcu.send("D11", dfFrame(DF.PLAY_TRACK, 5));
    sim.runFor(40);
    expect(sim.partState("df")?.saying).toBe("new words");
  });
});
