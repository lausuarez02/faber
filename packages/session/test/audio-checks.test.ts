// Round 13 (audio): check_design for an I2S amplifier and its speaker, the parts behind any device
// that plays sound from its firmware (tones, clips, speech an API returned). XIAO ESP32-S3 +
// MAX98357A + a small speaker, as a keychain would have them.
import { describe, expect, it } from "vitest";
import { parseProject } from "@jumper/project-format";
import { registry } from "@jumper/parts";
import { checkDesign } from "../src/index.ts";
import { usageFor } from "../src/hints.ts";

const w = (id: string, a: string, b: string) => {
  const [ap, aq] = a.split(".");
  const [bp, bq] = b.split(".");
  return { id, from: { part: ap!, pin: aq! }, to: { part: bp!, pin: bq! } };
};

function project(o: { speaker?: string; spkProps?: Record<string, unknown>; ampProps?: Record<string, unknown>; vin?: string; extra?: ReturnType<typeof w>[]; noSpeaker?: boolean } = {}) {
  return parseProject({
    format: "jumper/1",
    name: "talker",
    parts: [
      { id: "xiao", type: "seeed-xiao-esp32s3", x: 0, y: 0 },
      { id: "amp", type: "max98357a", x: 200, y: 0, ...(o.ampProps ? { props: o.ampProps } : {}) },
      ...(o.noSpeaker ? [] : [{ id: "spk", type: o.speaker ?? "speaker-20mm", x: 400, y: 0, ...(o.spkProps ? { props: o.spkProps } : {}) }]),
    ],
    wires: [
      w("p1", "amp.VIN", o.vin ?? "xiao.5V"),
      w("p2", "amp.GND", "xiao.GND"),
      w("i1", "amp.BCLK", "xiao.GPIO2"),
      w("i2", "amp.LRC", "xiao.GPIO3"),
      w("i3", "amp.DIN", "xiao.GPIO4"),
      ...(o.noSpeaker ? [] : [w("s1", "spk.+", "amp.OUT+"), w("s2", "spk.-", "amp.OUT-")]),
      ...(o.extra ?? []),
    ],
    firmware: { board: "xiao", artifact: "firmware/main.bin" },
  });
}

const codes = (p: ReturnType<typeof project>) => checkDesign(p, registry).filter((i) => i.code.startsWith("amp-"));

describe("check_design: I2S amplifier and speaker", () => {
  it("a 0.5 W speaker on a MAX98357A at 5 V: full-scale audio overdrives it; says how loud is safe and how to fix it", () => {
    const issues = codes(project());
    expect(issues.map((i) => i.code)).toEqual(["amp-speaker-overpower"]);
    // The XIAO's 5V pin is rated to 5.5 V: the output clips at ~0.9 x 5.5 V peak = 3.5 V RMS, 1.53 W
    // into 8 ohm against 0.5 W, so at most 57 % of full scale (-5 dBFS).
    expect(issues[0]!.message).toMatch(/about 1\.53 W into spk \(8 Ω, rated 0\.5 W\) at full-scale audio \(5\.5 V on VIN, 9 dB gain\)/);
    expect(issues[0]!.message).toMatch(/at or below 57 % of full scale \(-5 dBFS/);
    expect(issues[0]!.message).toMatch(/Fix: .*GAIN to VIN = 6 dB/);
  });

  it("a 3 W speaker, or the amp at 3.3 V with 3 dB gain into a 1 W speaker, is fine", () => {
    expect(codes(project({ speaker: "speaker", spkProps: { rated_w: 3 } }))).toEqual([]);
    expect(codes(project({ speaker: "speaker", spkProps: { rated_w: 1 }, vin: "xiao.3V3", ampProps: { gain_db: "3" } }))).toEqual([]);
  });

  it("no speaker across OUT+ / OUT-: a warning with the wiring", () => {
    const issues = codes(project({ noSpeaker: true }));
    expect(issues.map((i) => i.code)).toEqual(["amp-no-speaker"]);
    expect(issues[0]!.message).toMatch(/Fix: place_part speaker-20mm .*amp\.OUT\+ → speaker \+/);
  });

  it("OUT- on ground is a short (bridge-tied output); a 2 ohm speaker is below its minimum load", () => {
    expect(codes(project({ extra: [w("g", "amp.OUT-", "xiao.GND")] })).map((i) => i.code)).toContain("amp-out-shorted");
    expect(codes(project({ speaker: "speaker", spkProps: { ohms: "2" } })).map((i) => i.code)).toContain("amp-speaker-impedance");
  });
});

describe("get_part hints for audio parts", () => {
  it("the amplifier says how to play what an API returns, and which decoders are GPL", () => {
    const u = usageFor(registry.get("max98357a")!.spec);
    expect(u.example).toContain("i2s.setPins(D1, D2, D3)");
    expect(u.example).toContain("useHTTP10(true)");
    expect(u.wiring).toMatch(/minimp3 \(CC0/);
    expect(u.wiring).toMatch(/libhelix-mp3.*RPSL/);
    expect(u.wiring).toMatch(/ESP32-audioI2S, ESP8266Audio and arduino-audio-tools are GPL-3\.0/);
  });
  it("the microphone covers the XIAO ESP32-S3 Sense's PDM mic", () => {
    expect(usageFor(registry.get("inmp441")!.spec).wiring).toMatch(/setPinsPdmRx\(42, 41\)/);
  });
});
