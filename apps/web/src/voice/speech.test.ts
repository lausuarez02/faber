import { afterEach, describe, expect, it } from "vitest";
import { parseProject } from "@fabwright/project-format";
import { canSpeak, setSpeechMuted, speakerOf, speechMuted, VoiceLayer } from "./speech.ts";

const project = parseProject({
  format: "fabwright/1",
  name: "t",
  parts: [
    { id: "df", type: "dfplayer-mini", x: 0, y: 0 },
    { id: "spk", type: "speaker", x: 0, y: 0 },
    { id: "df2", type: "dfplayer-mini", x: 0, y: 0 },
  ],
  wires: [
    { id: "w1", from: { part: "spk", pin: "+" }, to: { part: "df", pin: "SPK_1" } },
    { id: "w2", from: { part: "spk", pin: "-" }, to: { part: "df", pin: "SPK_2" } },
  ],
});

afterEach(() => {
  setSpeechMuted(false);
  document.body.innerHTML = "";
});

describe("speech bubble", () => {
  it("finds the speaker a DFPlayer drives, else the DFPlayer itself", () => {
    expect(speakerOf(project, "df")).toBe("spk");
    expect(speakerOf(project, "df2")).toBe("df2");
  });

  it("shows the words on the speaker while speaking and removes them after", () => {
    const els: Record<string, HTMLElement> = { spk: document.createElement("div"), df: document.createElement("div") };
    for (const e of Object.values(els)) document.body.append(e);
    const v = new VoiceLayer(() => project, (id) => els[id]);
    v.update("df", { saying: "hi! I'm Eggy", speaking: true, saidCount: 1 });
    const b = els.spk!.querySelector('[data-testid="speech-bubble-spk"]');
    expect(b?.textContent).toBe("hi! I'm Eggy");
    v.update("df", { saying: "(track 7: no words set)", speaking: true, saidCount: 2 });
    expect((b as HTMLElement).dataset.missing).toBe("true");
    v.update("df", { saying: "", speaking: false, saidCount: 2 });
    expect(els.spk!.querySelector(".speech-bubble")).toBeNull();
    // Playing with no speaker wired (speaking false): no bubble.
    v.update("df", { saying: "hi", speaking: false, saidCount: 3 });
    expect(document.querySelector(".speech-bubble")).toBeNull();
    v.dispose();
  });

  it("the mute toggle flips and is remembered; nothing speaks without speechSynthesis or under a test driver", () => {
    const el = document.createElement("div");
    document.body.append(el);
    const v = new VoiceLayer(() => project, () => el);
    v.update("df", { saying: "hi", speaking: true, saidCount: 1 });
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="speech-mute"]')!;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    btn.click();
    expect(speechMuted()).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(canSpeak()).toBe(false);
    v.dispose();
  });
});
