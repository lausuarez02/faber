// Round 14 (no emulator): battery life from duty cycles with a target (check_design battery-life,
// estimate_power, set_power, the build kit), the camera capture-indicator check, the new scenario
// steps' validation, the event timeline (preceded_by, speech-API text as "said") and test seeds.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScenarioStep, type Project } from "@jumper/project-format";
import { registry } from "@jumper/parts";
import type { NetEvent, NetView } from "@jumper/device-net";
import { checkDesign, ProjectSession } from "../src/index.ts";
import { powerBudget } from "../src/power-budget.ts";
import { precededWhy, speechTextOf, spokenSoFar } from "../src/scenario-events.ts";
import { scenarioSeed } from "../src/session.ts";
import type { SimHost } from "../src/sim.ts";

const NET_CAM = `#include <WiFi.h>
#include "esp_camera.h"
void setup() { esp_camera_init(nullptr); WiFi.begin("x", "y"); }
void loop() {}
`;

function starLike(extra: Partial<Project> = {}, parts: Project["parts"] = []): Project {
  return {
    format: "jumper/1",
    name: "cam keychain",
    parts: [
      { id: "sense", type: "seeed-xiao-esp32s3-sense", x: 0, y: 0 },
      { id: "bat", type: "lipo-battery", x: 200, y: 0, props: { capacity: 250 } },
      { id: "amp", type: "max98357a", x: 300, y: 0 },
      { id: "spk", type: "speaker-20mm", x: 400, y: 0 },
      ...parts,
    ],
    wires: [
      { id: "w1", from: { part: "bat", pin: "POS" }, to: { part: "sense", pin: "BAT" } },
      { id: "w2", from: { part: "bat", pin: "NEG" }, to: { part: "sense", pin: "GND.2" } },
    ],
    scenarios: [],
    firmware: { board: "sense", dir: "firmware", sketch: "main.ino", artifact: "firmware/main.bin", build: { tool: "arduino-cli", fqbn: "esp32:esp32:XIAO_ESP32S3:PSRAM=opi" } },
    ...extra,
  } as unknown as Project;
}

describe("battery life from duty cycles", () => {
  it("adds every load with its duty and source, and says what it assumed from the firmware", () => {
    const b = powerBudget(starLike({}, [{ id: "eyes", type: "gc9a01-round-tft", x: 0, y: 200 }] as Project["parts"]), registry, NET_CAM);
    const byLoad = Object.fromEntries(b.loads.map((l) => [l.load.split(" (")[0], l]));
    expect(Object.keys(byLoad)).toEqual(expect.arrayContaining(["Wi-Fi", "camera", "board CPU", "screen", "audio amplifier"]));
    expect(byLoad.camera!.duty).toBe(1); // never deinit → always on
    expect(byLoad.camera!.source).toContain("datasheet");
    expect(byLoad["Wi-Fi"]!.source).toContain("ESP32-S3 datasheet");
    expect(byLoad["audio amplifier"]!.duty).toBeCloseTo(5 / 600, 2);
    expect(b.assumptions.join(" ")).toContain("camera stays on all the time");
    expect(b.avg_ma).toBeGreaterThan(100);
    expect(b.hours).toBeCloseTo((250 * 0.8) / b.avg_ma, 1);
    expect(b.peak_ma).toBeGreaterThan(340);
  });

  it("duty cycles from jumper.json change the estimate; deep sleep shrinks the CPU's share", () => {
    const always = powerBudget(starLike(), registry, NET_CAM);
    const periodic = powerBudget(starLike({ power: { duty: { camera: { on_s: 2, every_s: 600 }, wifi: { on_s: 10, every_s: 3600 } }, sleep: "light" } } as never), registry, NET_CAM);
    expect(periodic.hours!).toBeGreaterThan(always.hours! * 5);
    expect(periodic.assumptions.join(" ")).not.toContain("camera stays on");
    const cpu = periodic.loads.find((l) => l.load.startsWith("board CPU"))!;
    expect(cpu.idle_ma).toBeCloseTo(0.24, 2);
    expect(cpu.duty_text).toContain("light sleep otherwise");
  });

  it("check_design warns under power.target_hours with the cell and the duty change that would help; info when met", () => {
    const short = checkDesign(starLike({ power: { usb: false, target_hours: 24 } } as never), registry, NET_CAM).find((i) => i.code === "battery-life")!;
    expect(short.severity).toBe("warning");
    expect(short.message).toContain("short of the 24 h target");
    expect(short.message).toMatch(/Fix: .*(camera down between pictures|connect to Wi-Fi only to upload|mAh)/);
    expect(short.message).toContain("estimate_power");
    const met = checkDesign(starLike({ power: { target_hours: 1, duty: { camera: { on_s: 2, every_s: 600 }, wifi: { on_s: 10, every_s: 3600 } }, sleep: "light" } } as never), registry, NET_CAM).find((i) => i.code === "battery-life")!;
    expect(met.severity).toBe("info");
    expect(met.message).toContain("meets the 1 h target");
    // no target: no battery-life issue at all (other projects' checks are unchanged)
    expect(checkDesign(starLike(), registry, NET_CAM).some((i) => i.code === "battery-life")).toBe(false);
  });

  it("suggests a bigger cell when a duty change is not enough", () => {
    const b = powerBudget(starLike({ power: { target_hours: 8, duty: { camera: { on_s: 2, every_s: 600 }, wifi: { on_s: 10, every_s: 3600 } } } } as never), registry, NET_CAM);
    expect(b.hours!).toBeLessThan(8);
    expect(b.suggestions[0]).toMatch(/a (500|1000) mAh cell .* set_part_property bat capacity (500|1000)/);
  });

  it("estimate_power and set_power {target_hours, duty} through the session; bad duties say how to fix", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "jumper-r14-power-"));
    const s = new ProjectSession({ dir, actor: "test" });
    try {
      await s.call("new_project", { template: "xiao-esp32s3-sense" });
      await s.call("place_part", { type: "lipo-battery", id: "bat", props: { capacity: 250 } });
      await s.call("write_file", { path: "firmware/main.ino", content: NET_CAM });
      const e = (await s.call("estimate_power", { target_hours: 48 })) as Record<string, any>;
      expect(e.summary).toContain("target 48 h: NOT met");
      expect(e.loads.length).toBeGreaterThan(1);
      const what = (await s.call("estimate_power", { duty: { camera: "off", wifi: "off" } })) as Record<string, any>;
      expect(what.hours).toBeGreaterThan(e.hours);
      await expect(s.call("estimate_power", { duty: { camera: { on_s: 5, every_s: 2 } } })).rejects.toThrow(/on_s <= every_s/);
      const set = (await s.call("set_power", { target_hours: 12, duty: { camera: { on_s: 2, every_s: 600 } } })) as Record<string, any>;
      expect(set.power).toMatchObject({ target_hours: 12, duty: { camera: { on_s: 2, every_s: 600 } } });
      expect(s.project.power).toMatchObject({ target_hours: 12 });
      const issues = (await s.call("check_design", {})) as Record<string, any>;
      expect(JSON.stringify(issues)).toContain("battery-life");
      const kit = (await s.call("get_build_kit", {})) as Record<string, any>;
      expect(kit.power?.target_hours ?? kit.kit?.power?.target_hours).toBe(12);
    } finally {
      s.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("camera capture indicator (privacy)", () => {
  const sense = (parts: Project["parts"] = [], src = "") => checkDesign(starLike({}, parts), registry, src).find((i) => i.code === "camera-indicator");
  it("warns when a camera has no LED, screen or board LED in use, with the fix", () => {
    const w = sense();
    expect(w?.severity).toBe("warning");
    expect(w?.message).toContain("nothing on the device shows when it does");
    expect(w?.message).toContain("place_part led");
    expect(w?.message).toContain("LED_BUILTIN");
  });
  it("is quiet with a screen, an LED, or the board's LED driven by the firmware", () => {
    expect(sense([{ id: "eyes", type: "gc9a01-round-tft", x: 0, y: 200 }] as Project["parts"])).toBeUndefined();
    expect(sense([{ id: "led1", type: "led", x: 0, y: 200 }] as Project["parts"])).toBeUndefined();
    expect(sense([], "void setup(){ pinMode(LED_BUILTIN, OUTPUT); }")).toBeUndefined();
  });
  it("applies to any camera project (an ESP32 with an OV2640 module too)", () => {
    const p = { format: "jumper/1", name: "t", parts: [{ id: "esp", type: "esp32-devkitc", x: 0, y: 0 }, { id: "cam", type: "ov2640-camera", x: 300, y: 0 }], wires: [], scenarios: [] } as unknown as Project;
    expect(checkDesign(p, registry, "").some((i) => i.code === "camera-indicator")).toBe(true);
  });
});

describe("scenario steps of round 14", () => {
  it("parses expect_capture / preceded_by / reset_board / set_clock / request body checks, and explains mistakes", () => {
    expect(parseScenarioStep({ expect_capture: "sense", within_ms: 60000, preceded_by: { said: "picture", min_ms: 9000, max_ms: 11000 } }).ok).toBe(true);
    expect(parseScenarioStep({ expect_capture: true, absent: true, within_ms: 12000 }).ok).toBe(true);
    expect(parseScenarioStep({ reset_board: true }).ok).toBe(true);
    expect(parseScenarioStep({ set_clock: "2026-12-24T09:00:00Z" }).ok).toBe(true);
    expect(parseScenarioStep({ request: { host: "api.social.test", method: "POST", path: "/v1/posts", content_type: "multipart/form-data", body_json: { photo: { content_type: "image/jpeg" } }, min_bytes: 1000 }, within_ms: 5000, preceded_by: { capture: true, max_ms: 600000 } }).ok).toBe(true);
    const two = parseScenarioStep({ expect_capture: true, preceded_by: { said: "a", serial: "b" } });
    expect(two.ok).toBe(false);
    expect(JSON.stringify(two)).toContain("exactly one of said, serial, capture, request");
    const swapped = parseScenarioStep({ expect_capture: true, preceded_by: { said: "a", min_ms: 5, max_ms: 1 } });
    expect(JSON.stringify(swapped)).toContain("swap them");
    expect(parseScenarioStep({ set_clock: "christmas" }).ok).toBe(false);
  });

  it("each test gets a fixed seed from its id unless it names one", () => {
    expect(scenarioSeed({ id: "random-photo" })).toBe(scenarioSeed({ id: "random-photo" }));
    expect(scenarioSeed({ id: "random-photo" })).not.toBe(scenarioSeed({ id: "skip-photo" }));
    expect(scenarioSeed({ id: "x", seed: 42 })).toBe(42);
  });
});

describe("the event timeline", () => {
  const ev = (seq: number, t: number, path: string, body?: NetEvent["body"]): NetEvent => ({ seq, t_ms: t, kind: "http", host: "api.voice.test", method: "POST", path, summary: "", ...(body ? { body } : {}) });
  const log: NetEvent[] = [
    ev(1, 1000, "/v1/audio/speech", { bytes: 60, fields: { model: "tts-1", input: "I'm taking a picture in 10 seconds" } }),
    ev(2, 4000, "/v1/chat/completions", { bytes: 60, fields: { input: "not speech" } }),
    ev(3, 30_000, "/v1/text:synthesize", { bytes: 60, fields: { "input.text": "<speak>Smile!</speak>" } }),
  ];
  const view = { log: { since: (s = 0) => log.filter((e) => e.seq > s) } } as unknown as NetView;
  const net = { view, drain: () => {} };
  const captures = [{ partId: "sense", t_ms: 11_200 }, { partId: "sense", t_ms: 31_000 }];
  const host = {
    sim: { speech: () => [{ partId: "df", t_ms: 20_000, dur_ms: 800, text: "hello", audible: true, track: 1, clip: "1" }], serialText: () => "boot\ncountdown 10\nsnap\n", serialTimeAt: (i: number) => (i < 5 ? 100 : i < 19 ? 1100 : 11_150) },
    captures: (id?: string) => captures.filter((c) => !id || c.partId === id),
  } as unknown as SimHost;
  const c = { host, net, netStartSeq: 0 };

  it("reads speech-API text as what the device said, in time order with clips", () => {
    expect(speechTextOf(log[0]!)).toBe("I'm taking a picture in 10 seconds");
    expect(speechTextOf(log[1]!)).toBeUndefined();
    expect(speechTextOf(log[2]!)).toBe("Smile!");
    expect(spokenSoFar(host, net).map((u) => `${u.t_ms} ${u.via} ${u.text}`)).toEqual(["1000 speech-api I'm taking a picture in 10 seconds", "20000 clip hello", "30000 speech-api Smile!"]);
  });

  it("preceded_by: the named event within the window before, or why not", () => {
    expect(precededWhy({ said: "picture in 10", min_ms: 9000, max_ms: 11_000 }, 11_200, c, "the picture")).toBeUndefined();
    expect(precededWhy({ said: "picture in 10", min_ms: 9000, max_ms: 11_000 }, 31_000, c, "the picture")).toBe('the picture at 31000 ms came 30000 ms after said "picture in 10" (at 1000 ms), wanted 9000..11000 ms before');
    expect(precededWhy({ said: "cheese" }, 31_000, c, "the picture")).toContain('was not preceded by said "cheese"');
    expect(precededWhy({ serial: "countdown", min_ms: 9000 }, 11_200, c, "the picture")).toBeUndefined();
    expect(precededWhy({ capture: "sense", max_ms: 25_000 }, 31_000, c, "the upload")).toBeUndefined();
    expect(precededWhy({ request: { host: "api.voice.test", path: "/v1/audio/speech" }, max_ms: 5000 }, 31_000, c, "the picture")).toContain("came 30000 ms after");
  });
});
