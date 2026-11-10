import { describe, expect, it } from "vitest";
import { DF, DfFrameDecoder, dfChecksum, dfFrame, estimateClipMs, formatClips, normalizeClipKey, parseClips } from "./dfplayer.ts";

describe("DFPlayer frames", () => {
  it("checksum is 0 - (FF + 06 + CMD + FB + PH + PL): play track 1 → 0xFEF7", () => {
    // 0xFF + 0x06 + 0x03 + 0x00 + 0x00 + 0x01 = 0x109 → 0x10000 - 0x109 = 0xFEF7
    expect(dfChecksum(0x03, 0, 1)).toBe(0xfef7);
    expect(dfFrame(DF.PLAY_TRACK, 1)).toEqual([0x7e, 0xff, 0x06, 0x03, 0x00, 0x00, 0x01, 0xfe, 0xf7, 0xef]);
    // Reset with feedback: 0xFF + 6 + 0x0C + 1 = 0x112 → 0xFEEE
    expect(dfFrame(DF.RESET, 0, 1)).toEqual([0x7e, 0xff, 0x06, 0x0c, 0x01, 0x00, 0x00, 0xfe, 0xee, 0xef]);
    expect(dfFrame(DF.PLAY_FOLDER, 0x0203).slice(5, 7)).toEqual([0x02, 0x03]);
  });

  it("decodes 10-byte and 8-byte frames, skips noise, reports malformed ones", () => {
    const d = new DfFrameDecoder();
    const feed = (bytes: number[]) => bytes.map((b) => d.push(b)).filter((x) => x !== undefined);
    expect(feed([0x00, 0x55, ...dfFrame(DF.VOLUME, 20)])).toEqual([{ ok: true, frame: { cmd: 6, feedback: false, param: 20, checksum: true } }]);
    expect(d.skipped).toBe(2);
    expect(feed([0x7e, 0xff, 0x06, 0x03, 0x01, 0x00, 0x05, 0xef])).toEqual([{ ok: true, frame: { cmd: 3, feedback: true, param: 5, checksum: false } }]);
    const bad = dfFrame(DF.PLAY_TRACK, 2);
    bad[7] = 0;
    expect(feed(bad)[0]).toMatchObject({ ok: false, error: expect.stringMatching(/checksum of command 0x03/) });
    expect(feed([0x7e, 0xff, 0x05])[0]).toMatchObject({ ok: false, error: expect.stringMatching(/length/) });
    const noEnd = dfFrame(DF.STOP);
    noEnd[9] = 0x00;
    expect(feed(noEnd)[0]).toMatchObject({ ok: false, error: expect.stringMatching(/ends with 0x00/) });
    // Still in sync afterwards.
    expect(feed(dfFrame(DF.PAUSE))[0]).toMatchObject({ ok: true, frame: { cmd: DF.PAUSE } });
  });
});

describe("clip table", () => {
  it("parses lines and JSON, normalises keys, reports bad lines", () => {
    const r = parseClips("1: hi! I'm Eggy\n# comment\n02 = whoa, I'm dizzy!\n03/005: folder\nnot a clip");
    expect([...r.clips]).toEqual([
      ["1", "hi! I'm Eggy"],
      ["2", "whoa, I'm dizzy!"],
      ["3/5", "folder"],
    ]);
    expect(r.problems).toHaveLength(1);
    expect([...parseClips('{"1": "a", "0002": "b"}').clips]).toEqual([
      ["1", "a"],
      ["2", "b"],
    ]);
    expect([...parseClips({ "7": "x" }).clips]).toEqual([["7", "x"]]);
    expect(normalizeClipKey("x")).toBeUndefined();
  });

  it("formats in track order, folders last", () => {
    expect(formatClips({ "10": "ten", "2": "two", "1/3": "f", "1": "one" })).toBe("1: one\n2: two\n10: ten\n1/3: f");
  });

  it("estimates 2.6 words per second plus 0.3 s", () => {
    expect(estimateClipMs("hi! I'm Eggy")).toBe(1454);
    expect(estimateClipMs("")).toBe(300);
  });
});
