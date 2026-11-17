// Round 7 (voice): a device that says things. The talking-egg example runs through the agent
// surface with its committed golden firmware (Nano + DFPlayer Mini on SoftwareSerial + speaker):
// run_tests sees the words ({"said": …}), read_speech lists them, check_design warns about a
// missing speaker or missing words, export_manufacturing writes the microSD card's files.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseProject } from "@faber/project-format";
import { registry } from "@faber/parts";
import type { BuildRequest, BuildResult } from "@faber/runner";
import { checkDesign, ProjectSession } from "../src/index.ts";
import { planDevice } from "../src/planner.ts";
import { sdCardFiles, tracksInSketch } from "../src/voice.ts";

const EXAMPLE = fileURLToPath(new URL("../../../examples/talking-egg-demo/", import.meta.url));
const noBuild = async (req: BuildRequest): Promise<BuildResult> => {
  throw new Error(`unexpected build of ${req.sketchDir}`);
};
const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(): { s: ProjectSession; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "faber-voice-"));
  dirs.push(dir);
  cpSync(EXAMPLE, dir, { recursive: true, preserveTimestamps: true, filter: (p) => !p.includes(".faber") });
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(dir, "firmware/main.hex"), later, later);
  const s = new ProjectSession({ dir, builder: noBuild, actor: "test" });
  sessions.push(s);
  return { s, dir };
}
const call = (s: ProjectSession, op: string, args: Record<string, unknown> = {}) => s.call(op, args) as Promise<Record<string, any>>;
const project = () => parseProject(JSON.parse(readFileSync(join(EXAMPLE, "faber.json"), "utf8")));

describe("talking egg (AVR, SoftwareSerial)", () => {
  it("run_tests passes and the said steps saw the words", async () => {
    const { s } = open();
    const t = await call(s, "run_tests");
    expect(t.failed, JSON.stringify(t.results)).toBe(0);
    expect(t.passed).toBe(2);
  }, 120_000);

  it("run says what it said; read_speech lists it with timing; check_design is clean", async () => {
    const { s } = open();
    const r = await call(s, "run", { ms: 3200 });
    expect(r.said).toEqual([expect.stringMatching(/^15\d\d(\.\d+)? ms df: "hi! I'm Eggy"$/)]);
    await call(s, "interact", { part: "btn1", action: "press" });
    await call(s, "run", { ms: 100 });
    await call(s, "interact", { part: "btn1", action: "release" });
    await call(s, "run", { ms: 100 });
    const sp = await call(s, "read_speech", { since: 0 });
    expect(sp.said.map((u: { text: string }) => u.text)).toEqual(["hi! I'm Eggy", "whoa, I'm dizzy!"]);
    expect(sp.said[0]).toMatchObject({ part: "df", track: 1, heard: true, volume: 22, dur_ms: 1454 });
    expect(sp.saying_now).toBe("whoa, I'm dizzy!");
    expect(sp.next).toBe(2);
    expect((await call(s, "read_speech", { since: 2 })).said).toEqual([]);
    const c = await call(s, "check_design");
    expect(c.issues.filter((i: string) => !i.startsWith("info"))).toEqual([]);
  }, 120_000);

  it("set_part_property takes clips as lines or an object and applies them live", async () => {
    const { s } = open();
    await call(s, "set_part_property", { id: "df", prop: "clips", value: { "1": "hello egg", "02": "bye" } });
    expect(s.project.parts.find((p) => p.id === "df")!.props!.clips).toBe("1: hello egg\n2: bye");
    await expect(call(s, "set_part_property", { id: "df", prop: "clips", value: "one: nope" })).rejects.toThrow(/cannot read.*Fix|N: words/);
    const r = await call(s, "run", { ms: 3200 });
    expect(r.said[0]).toMatch(/"hello egg"/);
  }, 120_000);

  it("a said step that fails says what was said instead, and why nobody heard it", async () => {
    const { s } = open();
    await call(s, "disconnect", { wire: "w6" });
    await call(s, "write_scenario", { id: "hi", steps: [{ said: "Eggy", within_ms: 3000 }] });
    const t = await call(s, "run_tests", { name: "hi" });
    expect(t.failed).toBe(1);
    expect(t.results[0].reason).toMatch(/nothing said matched "eggy".*df played "hi! I'm Eggy".*nobody heard it.*Fix: wire a speaker/);
    const c = await call(s, "check_design");
    const w = c.issues.find((i: string) => i.includes("[dfplayer-no-speaker]"));
    expect(w).toMatch(/^warning \[dfplayer-no-speaker\] DFPlayer speaks but no speaker is wired\. Why: .*Fix: /);
  }, 120_000);

  it("export_manufacturing writes sd-card/ (texts, CLIPS.md, make-clips.sh) and the BOM lists a microSD card", async () => {
    const { s } = open();
    const r = await call(s, "export_manufacturing", { zh_cn: false });
    for (const f of ["sd-card/mp3/0001.txt", "sd-card/mp3/0004.txt", "sd-card/CLIPS.md", "sd-card/make-clips.sh"]) expect(r.files).toContain(f);
    expect(readFileSync(join(r.dir, "sd-card/mp3/0002.txt"), "utf8")).toBe("whoa, I'm dizzy!\n");
    const clips = readFileSync(join(r.dir, "sd-card/CLIPS.md"), "utf8");
    expect(clips).toMatch(/\/mp3\/0002\.mp3/);
    expect(clips).toMatch(/FAT32/);
    const sh = readFileSync(join(r.dir, "sd-card/make-clips.sh"), "utf8");
    expect(sh).toMatch(/espeak-ng/);
    expect(sh).toMatch(/piper/);
    expect(sh).toMatch(/NOT shipped with Faber/);
    const bom = readFileSync(join(r.dir, "BOM.csv"), "utf8");
    expect(bom).toMatch(/microSD card/);
    expect(bom).not.toMatch(/clips=/);
    expect(readFileSync(join(r.dir, "BOM.md"), "utf8")).toMatch(/microSD card/);
    expect(r.notes.join(" ")).toMatch(/sd-card\/ holds the clip texts/);
  }, 180_000);
});

describe("voice design checks", () => {
  it("missing words for a track the sketch plays", () => {
    const p = project();
    const issues = checkDesign(p, registry, "void loop(){ dfSend(0x03, 7); }");
    const w = issues.find((i) => i.code === "dfplayer-no-words");
    expect(w?.message).toMatch(/no words for track 7 \(the sketch plays it\)\. Why: .*Fix: set_part_property df clips/);
  });

  it("speaker on a board pin is an error; SPK_2 to GND is an error", () => {
    const p = project();
    p.wires = p.wires.map((w) => (w.id === "w6" ? { ...w, to: { part: "nano", pin: "D9" } } : w.id === "w7" ? { ...w, to: { part: "nano", pin: "GND.2" }, from: { part: "df", pin: "SPK_2" } } : w));
    const issues = checkDesign(p, registry, "");
    expect(issues.find((i) => i.code === "speaker-on-pin")?.severity).toBe("error");
    expect(issues.find((i) => i.code === "dfplayer-spk-shorted")?.message).toMatch(/df\.SPK_2 is wired to nano\.GND\.2.*Fix:/);
    expect(issues.find((i) => i.code === "dfplayer-no-speaker")).toBeTruthy();
  });

  it("reads the tracks a sketch plays", () => {
    expect(tracksInSketch("dfSend(0x03, 2); dfSend(dfSerial, 0x12, 15); player.play(3); player.playFolder(2, 5); // dfSend(0x03, 9)").sort()).toEqual(["15", "2", "2/5", "3"]);
  });

  it("sdCardFiles names folder clips 02/005", () => {
    const p = project();
    p.parts = p.parts.map((x) => (x.id === "df" ? { ...x, props: { clips: "1: a\n2/5: b" } } : x));
    const f = sdCardFiles(p, registry);
    expect(Object.keys(f).sort()).toEqual(["CLIPS.md", "make-clips.sh", "02/005.txt", "mp3/0001.txt"].sort());
  });
});

describe("plan_device", () => {
  it("picks a DFPlayer Mini + speaker + 1k when the goal talks", () => {
    const p = planDevice("an egg shaped pocket device with eyes and a speaker to say stuff", { pocket: true }, registry);
    const types = p.bom.map((l) => l.type);
    expect(types).toEqual(expect.arrayContaining(["dfplayer-mini", "resistor"]));
    expect(types).toContain("speaker-20mm"); // round 8: a pocket device gets the smallest speaker that is clear for speech
    expect(p.bom.find((l) => l.type === "dfplayer-mini")!.why).toMatch(/says words/);
    expect(types).not.toContain("buzzer");
    // "eyes" means a screen to draw them on (round 7: the user asked for eyes and a voice)
    expect(types.some((t) => /oled|tft/.test(t ?? ""))).toBe(true);
    const r = planDevice("a toy that can talk", {}, registry);
    expect(r.bom.map((l) => l.type)).toContain("dfplayer-mini");
  });
});

describe("example files", () => {
  it("ships a golden hex", () => {
    expect(existsSync(join(EXAMPLE, "firmware/main.hex"))).toBe(true);
  });
});
