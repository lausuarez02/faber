// Visual test capture: what the device looked like at every check of a scenario.
//
// runScenarioVisual() runs a scenario exactly like runScenario() (same host, same result) and, on
// the side, records for every step: the exact virtual time, the checked value, compact display
// framebuffers, LEDs / buzzer / buttons / servos, the robot pose and sonar, the arm pose and the last
// serial line. It also records every input (press, release, set, serial write, fault) with its
// exact virtual time, so a viewer can replay the scenario from t = 0 to any frame deterministically
// (the web app's filmstrip scrubbing does that).
//
// How: the host is wrapped in a Proxy that notes each input and each run() end. A check that does
// not wait reads the state as it was after the last run() or input, so the snapshot taken then is
// exactly what the check saw. No change to runScenario is needed.
//
// ProjectSession.runTests uses runScenarioVisual: each result gets compactVisual() lines, the
// session keeps the report for GET /api/visual-report, and images: true writes displayPng() files.
import { deflateSync } from "node:zlib";
import type { Project, Scenario } from "@jumper/project-format";
import { base64ToBytes, bytesToBase64, decodeMonoFrame, monoPixel, rgb565ToRgb, type ColorFrame, type PartRegistry, type VisualState } from "@jumper/sim-core";
import { runScenario, type ScenarioOptions, type ScenarioResult } from "./scenario.ts";
import type { Frame, SimHost } from "./sim.ts";

/** Part types whose state is captured in full as a display (painted by the web's display painters). */
const DISPLAY_TYPES = new Set(["ssd1306-oled-i2c", "lcd1602-i2c", "ili9341-tft"]);
/** Colour panels are kept as a small RGB565 thumbnail (base64) in state.thumb: {w, h, rgb565}. */
const COLOR_THUMB_W = 80;
const DROP_KEYS = /Transform$|Opacity$|^label$/;

export interface VisualInput {
  /** Exact virtual ms (not rounded) when the input was applied. */
  t: number;
  kind: "press" | "release" | "set" | "serial_write" | "inject_fault";
  part?: string;
  field?: string;
  value?: unknown;
  /** serial_write byte, inject_fault kind/options. */
  data?: unknown;
}

export interface VisualState3 {
  /** Display part states (pixels base64, width, height, on, brightness, color, contrast, LCD text…). */
  displays?: Record<string, { type: string; state: VisualState }>;
  leds?: Record<string, { brightness: number; color?: string }>;
  buzzers?: Record<string, boolean>;
  buttons?: Record<string, boolean>;
  servos?: Record<string, number>;
  motors?: Record<string, number>;
  robot?: { x: number; y: number; heading: number; sonar_cm?: number; collisions?: number; min_clearance_cm?: number; travelled_cm?: number };
  arm?: { angles: number[]; end: { x: number; y: number }; reached: string[] };
  /** Last complete serial line. */
  serial?: string;
}

export interface VisualFrame {
  /** Step index in the scenario. */
  step: number;
  /** "expect_serial", "press", "run_ms"… */
  kind: string;
  /** Short human label: `oled.lit > 200`, `serial "Pet hatched"`, `press btnFeed (80 ms)`. */
  label: string;
  ok: boolean;
  /** Exact virtual ms of the snapshot (the moment the step finished). */
  t: number;
  /** What the check saw (the step result's detail). */
  value?: string;
  state: VisualState3;
}

export interface VisualScenario {
  id: string;
  name?: string;
  passed: boolean;
  t_ms: number;
  reason?: string;
  failed_step?: number;
  /** Every input with its exact time: replay these from t = 0 to reach any frame. */
  inputs: VisualInput[];
  frames: VisualFrame[];
  /** Evenly spaced snapshots between the checks (replayed from the inputs), for the timeline. */
  keyframes?: { t: number; state: VisualState3 }[];
  /** Faults cannot be replayed by viewers without the session's fault layer. */
  replayable: boolean;
}

export interface VisualReport {
  format: "jumper-visual-report/1";
  project: string;
  passed: number;
  failed: number;
  scenarios: VisualScenario[];
}

/** One step's short label for the filmstrip. */
export function stepLabel(step: Record<string, unknown>): { kind: string; label: string } {
  const q = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.length > 34 ? `${v.slice(0, 33)}…` : v) : JSON.stringify(v));
  const within = typeof step.within_ms === "number" ? ` ≤${step.within_ms} ms` : "";
  if ("expect_serial" in step) {
    const m = step.expect_serial as string | { contains?: string; regex?: string };
    const text = typeof m === "string" ? q(m) : m.regex !== undefined ? `/${m.regex}/` : q(m.contains);
    return { kind: "expect_serial", label: `${step.absent ? "no " : ""}serial ${text}${within}` };
  }
  if ("expect_part" in step) return { kind: "expect_part", label: `${String(step.expect_part)} ${String(step.op ?? "==")} ${q(step.value)}${within}` };
  if ("expect_pin" in step) return { kind: "expect_pin", label: `${String(step.expect_pin)} ${step.level ? String(step.level) : "in range"}${within}` };
  if ("expect_serial_value" in step) return { kind: "expect_serial_value", label: `${String(step.expect_serial_value)} ${String(step.op ?? "==")} ${String(step.value)}${within}` };
  if ("expect_display" in step) return { kind: "expect_display", label: `${String(step.expect_display)} ${step.matches ? `matches ${String(step.matches)}` : "lit"}${within}` };
  if ("expect_no_errors" in step) return { kind: "expect_no_errors", label: "no errors" };
  if ("press" in step) return { kind: "press", label: `press ${String(step.press)}${typeof step.hold_ms === "number" ? ` (${step.hold_ms} ms)` : ""}` };
  if ("release" in step) return { kind: "release", label: `release ${String(step.release)}` };
  if ("set" in step) return { kind: "set", label: `set ${String(step.set)} = ${q(step.value)}` };
  if ("serial_write" in step) return { kind: "serial_write", label: `type ${q(step.serial_write)}` };
  if ("inject_fault" in step) return { kind: "inject_fault", label: `fault ${String(step.inject_fault)} ${String(step.kind)}` };
  if ("run_ms" in step) return { kind: "run_ms", label: `run ${String(step.run_ms)} ms` };
  if ("wait_ms" in step) return { kind: "wait_ms", label: `wait ${String(step.wait_ms)} ms` };
  return { kind: Object.keys(step)[0] ?? "step", label: JSON.stringify(step).slice(0, 40) };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function lastLine(text: string): string {
  const lines = text.slice(-300).split(/\r?\n/);
  lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim()) return lines[i]!.trim().slice(0, 120);
  return "";
}

/** Box-filtered RGB565 thumbnail of a colour frame (inversion and power applied), base64. */
export function colorThumb(f: ColorFrame, w: number): { w: number; h: number; b64: string } {
  const h = Math.max(1, Math.round((w * f.height) / f.width));
  const out = new Uint8Array(w * h * 2);
  const inv = f.inverted ? 0xffff : 0;
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor((ty * f.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * f.height) / h));
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor((tx * f.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * f.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      if (f.on) {
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const [cr, cg, cb] = rgb565ToRgb(f.data[y * f.width + x]! ^ inv);
            r += cr;
            g += cg;
            b += cb;
            n++;
          }
      }
      const c = n ? ((Math.round(r / n) >> 3) << 11) | ((Math.round(g / n) >> 2) << 5) | (Math.round(b / n) >> 3) : 0;
      out[(ty * w + tx) * 2] = c & 0xff;
      out[(ty * w + tx) * 2 + 1] = c >> 8;
    }
  }
  return { w, h, b64: bytesToBase64(out) };
}

/** Compact snapshot of everything a viewer needs to draw the device at this moment. */
export function snapshotDevice(host: SimHost, project: Project): VisualState3 {
  const out: VisualState3 = {};
  const sim = host.sim;
  for (const p of project.parts) {
    let st: VisualState | undefined;
    try {
      st = sim.partState(p.id);
    } catch {
      st = undefined;
    }
    if (!st) continue;
    let fb: ColorFrame | undefined;
    try {
      fb = sim.framebuffer?.(p.id);
    } catch {
      fb = undefined;
    }
    if (DISPLAY_TYPES.has(p.type) || typeof st.pixels === "string" || fb) {
      const keep: VisualState = {};
      for (const [k, v] of Object.entries(st)) if (!DROP_KEYS.test(k)) keep[k] = v;
      if (fb) {
        const t = colorThumb(fb, COLOR_THUMB_W);
        keep.thumbW = t.w;
        keep.thumbH = t.h;
        keep.thumb = t.b64;
      }
      (out.displays ??= {})[p.id] = { type: p.type, state: keep };
    } else if (p.type === "led" || p.type === "rgb-led") {
      (out.leds ??= {})[p.id] = { brightness: r3(Number(st.brightness ?? 0)), ...(typeof st.color === "string" ? { color: st.color } : {}) };
    } else if (p.type === "buzzer") (out.buzzers ??= {})[p.id] = st.sounding === true;
    else if (p.type === "pushbutton") (out.buttons ??= {})[p.id] = st.pressed === true;
    else if (p.type === "servo-sg90") (out.servos ??= {})[p.id] = r3(Number(st.angle ?? 0));
    else if (p.type === "dc-motor") (out.motors ??= {})[p.id] = r3(Number(st.rpm ?? 0));
  }
  const phys = host.physics;
  if (phys) {
    const snap = phys.snapshot();
    if (snap.robot) {
      const s = snap.stats;
      out.robot = {
        x: r3(snap.robot.pose.x),
        y: r3(snap.robot.pose.y),
        heading: r3(snap.robot.pose.heading),
        ...(snap.robot.sonar ? { sonar_cm: r3(snap.robot.sonar.distanceCm) } : {}),
        collisions: s.collisions,
        ...(Number.isFinite(s.minClearanceCm) ? { min_clearance_cm: r3(s.minClearanceCm) } : {}),
        travelled_cm: r3(s.travelledCm),
      };
    }
    if (snap.arm) out.arm = { angles: snap.arm.servoAngles.map(r3), end: { x: r3(snap.arm.pose.end.x), y: r3(snap.arm.pose.end.y) }, reached: snap.arm.pose.reached };
  }
  const line = lastLine(sim.serialText());
  if (line) out.serial = line;
  return out;
}

/**
 * Run a scenario (fresh host at t = 0, as runScenario expects) and capture a frame per step.
 * The ScenarioResult is the one runScenario returns, unchanged.
 */
export interface VisualOptions {
  /** Also replay the inputs on a fresh host and snapshot every `everyMs` (at most `max`, default 24). */
  keyframes?: { everyMs?: number; max?: number; makeHost: () => SimHost };
}

export function runScenarioVisual(host: SimHost, s: Scenario, project: Project, registry: PartRegistry, onFrame?: (f: Frame) => void, opts: ScenarioOptions = {}, vopts: VisualOptions = {}): { result: ScenarioResult; visual: VisualScenario } {
  const inputs: VisualInput[] = [];
  /** Snapshots after each run() end and each input, in time order. */
  const marks: { t: number; state: VisualState3 }[] = [];
  const sim = host.sim;
  const mark = () => marks.push({ t: sim.timeMs, state: snapshotDevice(host, project) });

  const simProxy = new Proxy(sim, {
    get(target, prop) {
      if (prop === "interact") {
        return (partId: string, ev: { kind: string; key?: string; value?: unknown }, o?: unknown) => {
          const r = (target.interact as (...a: unknown[]) => unknown)(partId, ev, o);
          if (ev.kind === "press" || ev.kind === "release") inputs.push({ t: target.timeMs, kind: ev.kind, part: partId });
          else if (ev.kind === "set") inputs.push({ t: target.timeMs, kind: "set", part: partId, field: String(ev.key), value: ev.value });
          mark();
          return r;
        };
      }
      if (prop === "setProp") {
        return (partId: string, key: string, value: unknown) => {
          const r = (target.setProp as (...a: unknown[]) => unknown)(partId, key, value);
          inputs.push({ t: target.timeMs, kind: "set", part: partId, field: key, value, data: "prop" });
          mark();
          return r;
        };
      }
      if (prop === "writeSerial") {
        return (byte: number) => {
          const r = (target.writeSerial as (b: number) => unknown)(byte);
          inputs.push({ t: target.timeMs, kind: "serial_write", data: byte });
          return r;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  let faults = false;
  const hostProxy = new Proxy(host, {
    get(target, prop) {
      if (prop === "sim") return simProxy;
      if (prop === "run") {
        return (...a: unknown[]) => {
          const r = (target.run as (...x: unknown[]) => unknown).apply(target, a);
          mark();
          return r;
        };
      }
      if (prop === "injectFault") {
        return (...a: unknown[]) => {
          const r = (target.injectFault as (...x: unknown[]) => unknown).apply(target, a);
          faults = true;
          inputs.push({ t: target.sim.timeMs, kind: "inject_fault", part: String(a[0]), data: { kind: a[1], ...(a[2] as object) } });
          mark();
          return r;
        };
      }
      if (prop === "setNoiseBase") {
        return (partId: string, field: string, value: number) => {
          const ok = (target.setNoiseBase as (...x: unknown[]) => boolean).call(target, partId, field, value);
          if (ok) {
            inputs.push({ t: target.sim.timeMs, kind: "set", part: partId, field, value, data: "noise-base" });
            mark();
          }
          return ok;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });

  mark(); // t = 0
  const result = runScenario(hostProxy, s, project, registry, onFrame, opts);
  mark(); // the end (a failed check's moment)

  // Each step result has its finish time rounded to 1 µs; its frame is the latest mark at or before it.
  const frames: VisualFrame[] = result.steps.map((sr) => {
    let m = marks[0]!;
    for (const x of marks) {
      if (x.t <= sr.t_ms + 5e-4) m = x;
      else break;
    }
    const raw = (s.steps[sr.i] ?? {}) as Record<string, unknown>;
    const { kind, label } = stepLabel(raw);
    return { step: sr.i, kind, label, ok: sr.ok, t: m.t, ...(sr.detail ? { value: sr.detail } : {}), state: m.state };
  });
  const visual: VisualScenario = {
    id: result.id,
    ...(result.name ? { name: result.name } : {}),
    passed: result.passed,
    t_ms: result.t_ms,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.failed_step !== undefined ? { failed_step: result.failed_step } : {}),
    inputs,
    frames,
    replayable: !faults,
  };
  if (vopts.keyframes) {
    const max = vopts.keyframes.max ?? 24;
    const every = Math.max(vopts.keyframes.everyMs ?? Math.ceil(result.t_ms / max / 50) * 50, 50);
    const h = vopts.keyframes.makeHost();
    try {
      visual.keyframes = replayKeyframes(h, project, inputs, sim.timeMs, every, max);
    } finally {
      h.dispose();
    }
  }
  return { result, visual };
}

/** Apply one recorded input to a host (the same calls the scenario made). */
export function applyInput(host: SimHost, inp: VisualInput): void {
  if (inp.kind === "press" || inp.kind === "release") host.sim.interact(inp.part!, { kind: inp.kind });
  else if (inp.kind === "serial_write") host.sim.writeSerial(Number(inp.data) & 0xff);
  else if (inp.kind === "inject_fault") {
    const d = (inp.data ?? {}) as { kind?: string; field?: string; amplitude?: number };
    host.injectFault(inp.part!, String(d.kind), { ...(d.field !== undefined ? { field: d.field } : {}), ...(d.amplitude !== undefined ? { amplitude: d.amplitude } : {}) });
  } else if (inp.kind === "set") {
    if (inp.data === "noise-base") host.setNoiseBase(inp.part!, inp.field!, Number(inp.value));
    else if (inp.data === "prop") host.sim.setProp(inp.part!, inp.field!, inp.value as never);
    else host.sim.interact(inp.part!, { kind: "set", key: inp.field!, value: inp.value as never });
  }
}

/** Replay inputs from t = 0 on a fresh host and snapshot every `every` ms up to `end`. */
export function replayKeyframes(host: SimHost, project: Project, inputs: readonly VisualInput[], end: number, every: number, max: number): { t: number; state: VisualState3 }[] {
  const out: { t: number; state: VisualState3 }[] = [];
  let i = 0;
  let nextKey = every;
  const runTo = (t: number) => {
    const dt = t - host.sim.timeMs;
    if (dt > 1e-9) host.run(dt);
  };
  while (out.length < max && nextKey <= end + 1e-9) {
    while (i < inputs.length && inputs[i]!.t <= nextKey) {
      runTo(inputs[i]!.t);
      applyInput(host, inputs[i]!);
      i++;
    }
    runTo(nextKey);
    out.push({ t: host.sim.timeMs, state: snapshotDevice(host, project) });
    nextKey += every;
  }
  return out;
}

/** A few lines per scenario for MCP / CLI output: one per check, with time and what it saw. */
export function compactVisual(v: VisualScenario, max = 12): string[] {
  const checks = v.frames.filter((f) => f.kind.startsWith("expect") || !f.ok);
  const lines = checks.slice(0, max).map((f) => {
    const bits: string[] = [];
    const st = f.state;
    // Colour screens (thumb) are always fully lit, so the lit count says nothing there.
    for (const [id, d] of Object.entries(st.displays ?? {})) if (typeof d.state.lit === "number" && typeof d.state.thumb !== "string") bits.push(`${id} ${d.state.lit} px lit`);
    if (st.robot) bits.push(`robot (${st.robot.x.toFixed(0)}, ${st.robot.y.toFixed(0)}) ${st.robot.heading.toFixed(0)}°${st.robot.sonar_cm !== undefined ? ` sonar ${st.robot.sonar_cm.toFixed(1)} cm` : ""}`);
    if (st.arm) bits.push(`arm end (${st.arm.end.x.toFixed(1)}, ${st.arm.end.y.toFixed(1)})`);
    return `${f.ok ? "ok  " : "FAIL"} ${Math.round(f.t)}ms  ${f.label}${f.value ? ` → ${f.value.slice(0, 80)}` : ""}${bits.length ? `  [${bits.join("; ")}]` : ""}`;
  });
  if (checks.length > max) lines.push(`… ${checks.length - max} more checks`);
  return lines;
}

// ------------------------------------------------------------------------------ PNG images

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGB pixels as a PNG (no dependencies). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

/**
 * PNG of a frame's first monochrome display (OLED), upscaled with dark pixel gaps like the real
 * panel; undefined when the frame has no pixel display. For MCP image content.
 */
export function displayPng(frame: VisualFrame, scale = 3): Buffer | undefined {
  const color = Object.values(frame.state.displays ?? {}).find((d) => typeof d.state.thumb === "string");
  if (color) {
    const w = Number(color.state.thumbW);
    const h = Number(color.state.thumbH);
    const src = base64ToBytes(String(color.state.thumb));
    const W = w * scale;
    const H = h * scale;
    const rgb = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (Math.floor(y / scale) * w + Math.floor(x / scale)) * 2;
        const [r, g, b] = rgb565ToRgb(src[i]! | (src[i + 1]! << 8));
        const o = (y * W + x) * 3;
        rgb[o] = r;
        rgb[o + 1] = g;
        rgb[o + 2] = b;
      }
    return encodePng(W, H, rgb);
  }
  const entry = Object.values(frame.state.displays ?? {}).find((d) => typeof d.state.pixels === "string");
  if (!entry) return undefined;
  const st = entry.state;
  const w = Number(st.width) || 128;
  const h = Number(st.height) || 64;
  const W = w * scale;
  const H = h * scale;
  const rgb = new Uint8Array(W * H * 3);
  const off = [5, 7, 10];
  const on = st.color === "blue" ? [79, 195, 255] : [232, 244, 255];
  const k = Math.min(1, Math.max(0.2, Number(st.brightness) || 1));
  const lit = on.map((c, i) => Math.round(off[i]! + (c - off[i]!) * k));
  const f = st.on && typeof st.pixels === "string" && st.pixels ? decodeMonoFrame(st.pixels, w, h) : undefined;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = Math.floor(x / scale);
      const py = Math.floor(y / scale);
      const gap = scale >= 3 && (x % scale === scale - 1 || y % scale === scale - 1);
      const c = f && monoPixel(f, px, py) ? (gap ? lit.map((v) => v * 0.55) : lit) : off;
      const i = (y * W + x) * 3;
      rgb[i] = c[0]!;
      rgb[i + 1] = c[1]!;
      rgb[i + 2] = c[2]!;
    }
  }
  return encodePng(W, H, rgb);
}
