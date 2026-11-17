import { describe, expect, it } from "vitest";
import type { Project } from "@fabwright/project-format";
import { useLive } from "./liveStore.ts";
import { ReplayPlayer, entryDuration, fidelityView, parseLog, type CanvasPort, type LogEntry, type Timers } from "./player.ts";

const proj = (parts: string[], wires: number): Project => ({
  format: "fabwright/1",
  name: "t",
  parts: parts.map((id) => ({ id, type: "led", x: 0, y: 0, rotation: 0 })),
  wires: Array.from({ length: wires }, (_, i) => ({ id: `w${i + 1}`, from: { part: parts[0]!, pin: "A" }, to: { part: parts[0]!, pin: "C" } })),
  scenarios: [],
});

function fakePort() {
  const log: string[] = [];
  let project = proj([], 0);
  const port: CanvasPort = {
    getProject: () => project,
    loadProject: (p) => {
      project = p;
      log.push(`load ${p.parts.length}p ${p.wires.length}w`);
    },
    showStates: (s, _l, vt) => log.push(`states ${Object.keys(s ?? {}).join(",")} @${vt}`),
    resetStates: () => log.push("reset"),
    appendSerial: (t) => log.push(`serial ${JSON.stringify(t)}`),
    clearSerial: () => log.push("clear"),
    highlightNew: (p, w) => log.push(`new ${p.join(",")}|${w.join(",")}`),
    fit: () => {},
  };
  return { port, log };
}

/** Manual clock: run all timers in time order. */
function manualTimers() {
  let now = 0;
  const q: { at: number; cb: () => void; id: number }[] = [];
  let seq = 0;
  const t: Timers & { runAll(): void } = {
    set: (cb, ms) => {
      q.push({ at: now + ms, cb, id: ++seq });
      return seq;
    },
    clear: (id) => {
      const i = q.findIndex((x) => x.id === id);
      if (i >= 0) q.splice(i, 1);
    },
    runAll() {
      while (q.length) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = q.shift()!;
        now = next.at;
        next.cb();
      }
    },
  };
  return t;
}

const entries: LogEntry[] = [
  { seq: 1, t: "", op: "place_part", ok: true, summary: "placed led1", step: { id: 1, why: "light" }, target: { part: "led1" }, project: proj(["led1"], 0), steps: [{ id: 1, why: "light", status: "pending", ops: ["place_part led1"] }] },
  { seq: 2, t: "", op: "connect", ok: true, target: { part: "led1", pin: "C" }, project: proj(["led1"], 1) },
  { seq: 3, t: "", op: "get_project", ok: true },
  { seq: 4, t: "", op: "write_file", ok: true, file: { path: "firmware/main.ino", content: "void setup(){}" }, project: proj(["led1"], 1) },
  { seq: 5, t: "", op: "run", ok: true, frames: [{ vt: 0, states: { led1: { on: false } } }, { vt: 500, serial: "LED on\r\n", states: { led1: { on: true } } }] },
  { seq: 6, t: "", op: "run_tests", ok: true, result: { passed: 1, failed: 0, results: [{ id: "blinks", passed: true }] } },
];

describe("replay player", () => {
  it("applies projects, highlights new parts and wires, plays frames, ends done", () => {
    const { port, log } = fakePort();
    const timers = manualTimers();
    const p = new ReplayPlayer(entries, port, 2, timers);
    p.play();
    timers.runAll();
    expect(log).toContain("new led1|");
    expect(log).toContain("new |w1");
    expect(log).toContain('serial "LED on\\r\\n"');
    expect(log.indexOf("clear")).toBeLessThan(log.indexOf('serial "LED on\\r\\n"'));
    const live = useLive.getState();
    expect(live.replay).toMatchObject({ done: true, index: 6, total: 6 });
    expect(live.code?.path).toBe("firmware/main.ino");
    expect(live.tests).toMatchObject({ passed: 1, failed: 0 });
    expect(live.steps[0]?.why).toBe("light");
    expect((globalThis as { __fabwrightReplay?: { done: boolean } }).__fabwrightReplay?.done).toBe(true);
  });

  it("paces ops for video and parses logs with torn lines", () => {
    expect(entryDuration(entries[0]!)).toBe(1000);
    expect(entryDuration(entries[4]!)).toBe(900);
    expect(parseLog('{"seq":1,"t":"","op":"x","ok":true}\n{"seq":2,"t":')).toHaveLength(1);
  });
});

describe("fidelityView", () => {
  it("keeps the summary, the areas that apply and the real-device checks", () => {
    const v = fidelityView({
      summary: "0 exact, 2 behavioral",
      areas: { logic: { level: "ok" }, timing: { level: "approx" }, radio: { level: "n/a" } },
      testOnRealDevice: ["uno: total current", 3],
    });
    expect(v).toEqual({ summary: "0 exact, 2 behavioral", areas: [{ name: "logic", level: "ok" }, { name: "timing", level: "approx" }], realDevice: ["uno: total current"] });
    expect(fidelityView({ nope: 1 })).toBeUndefined();
  });
});

describe("caption of the person's own change (round 6b)", () => {
  it("says what happened, never the raw op label", async () => {
    const { applyEntry } = await import("./player.ts");
    const { useLive } = await import("./liveStore.ts");
    const port = { loadProject() {}, getProject: () => ({ parts: [], wires: [] }), highlightNew() {}, resetStates() {}, fit() {}, clearSerial() {}, showStates() {}, appendSerial() {} } as never;
    applyEntry({ seq: 1, t: "", op: "design_case", actor: "web", ok: true, args: { shape: "rounded-box" }, summary: "case: rounded-box 58.9 x 52.4 x 25 mm, all checks ok", step: { id: 3, why: "design_case rounded-box" } } as never, port);
    expect(useLive.getState().caption?.title).toBe("case: rounded-box 58.9 x 52.4 x 25 mm, all checks ok");
  });
});
