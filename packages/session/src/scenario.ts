import { cameraParts, cameraProps, cameraSourceSpec, pickCamera } from "./camera.ts";
import { parseScenarioStep, type Project, type Scenario, type ScenarioStep } from "@jumper/project-format";
import type { PartRegistry, VisualValue } from "@jumper/sim-core";
import { checkRequest, resolveMocks, validateMock, type Fault, type Mock, type NetView } from "@jumper/device-net";
import { fail, JumperError } from "./errors.ts";
import { findPart, resolvePin, specOf, splitRef } from "./pins.ts";
import type { Frame, SimHost } from "./sim.ts";
import { clampRegion, diffFraction, litCount, regionRows, type DisplaySnapshot } from "./snapshots.ts";
import { precededWhy, spokenSoFar, type PrecededBy } from "./scenario-events.ts";

/** Round 10 (network): the device network a scenario's request / network_fault steps use. */
export interface ScenarioNetwork {
  /** Take in what the network thread did so far (synchronous). */
  drain(): void;
  view: NetView;
}

export interface ScenarioOptions {
  /** Round 10: the device network (request and network_fault steps). */
  network?: ScenarioNetwork;
  /** Golden display frames by name (snapshots/<name>.json), for expect_display matches. */
  snapshot?: (name: string) => DisplaySnapshot | undefined;
  /** Stop (as passed) right after this step index: screenshot {scenario, at_step}. */
  stopAfter?: number;
  /** Round 13: the project folder (camera_frame images are read from it). */
  projectDir?: string;
}

export interface StepResult {
  i: number;
  step: string;
  ok: boolean;
  /** Virtual ms when the step finished. */
  t_ms: number;
  detail?: string;
}

export interface ScenarioResult {
  id: string;
  name?: string;
  passed: boolean;
  /** Virtual ms the scenario took. */
  t_ms: number;
  failed_step?: number;
  /** Why it failed, in one sentence, with what was seen instead. */
  reason?: string;
  serial_tail: string;
  steps: StepResult[];
  /** Steps that passed but probably do not test what was meant (e.g. a wait that held before the change). */
  warnings?: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Set a sensor value / prop on the running sim: props via setProp, anything else via interact("set", key). */
export function setPartValue(host: SimHost, project: Project, registry: PartRegistry, partId: string, field: string, value: VisualValue): string {
  const part = findPart(project, partId);
  const spec = specOf(registry, part);
  const prop = spec.props?.find((p) => p.id === field);
  if (prop) {
    if (prop.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) fail("bad-value", `Cannot set ${partId}.${field}`, `${JSON.stringify(value)} is not a number`, `pass a number${prop.min !== undefined ? ` between ${prop.min} and ${prop.max}` : ""}${prop.unit ? ` (${prop.unit})` : ""}`);
      if ((prop.min !== undefined && n < prop.min) || (prop.max !== undefined && n > prop.max)) {
        fail("out-of-range", `Cannot set ${partId}.${field} to ${n}`, `the allowed range is ${prop.min ?? "-∞"}..${prop.max ?? "∞"}${prop.unit ? ` ${prop.unit}` : ""}`, "pass a value inside the range");
      }
      if (!host.setNoiseBase(partId, field, n)) host.sim.setProp(partId, field, n);
      return `${partId}.${field} = ${n}${prop.unit ? ` ${prop.unit}` : ""}`;
    }
    if (prop.type === "enum" && prop.options) {
      const opts = prop.options.map((o) => (typeof o === "string" ? o : o.value));
      if (!opts.includes(String(value))) fail("bad-value", `Cannot set ${partId}.${field} to ${JSON.stringify(value)}`, `allowed values: ${opts.join(", ")}`, "pass one of them");
    }
    host.sim.setProp(partId, field, value);
    return `${partId}.${field} = ${String(value)}`;
  }
  const state = host.sim.partState(partId) ?? {};
  if (field in state || spec.bindings?.some((b) => b.key === field)) {
    host.sim.interact(partId, { kind: "set", key: field, value });
    return `${partId}.${field} = ${String(value)} (via interact set)`;
  }
  const props = (spec.props ?? []).map((p) => p.id);
  fail(
    "unknown-field",
    `Cannot set ${partId}.${field}`,
    `${spec.id} has no prop or sensor field '${field}' (settable props: ${props.join(", ") || "none"})`,
    props.length ? `use one of: ${props.map((p) => `${partId}.${p}`).join(", ")}` : `${spec.id} has nothing to set; use interact for buttons`,
  );
}

function stepText(s: unknown): string {
  return JSON.stringify(s);
}

function compare(actual: unknown, op: string, expected: VisualValue): boolean {
  switch (op) {
    case "==":
      return typeof expected === "number" ? Math.abs(Number(actual) - expected) < 1e-9 : String(actual) === String(expected);
    case "!=":
      return typeof expected === "number" ? Math.abs(Number(actual) - expected) >= 1e-9 : String(actual) !== String(expected);
    case ">":
      return Number(actual) > Number(expected);
    case ">=":
      return Number(actual) >= Number(expected);
    case "<":
      return Number(actual) < Number(expected);
    case "<=":
      return Number(actual) <= Number(expected);
    case "contains":
      return String(actual).includes(String(expected));
    case "matches":
      return new RegExp(String(expected)).test(String(actual));
    default:
      return false;
  }
}

/** Check a scenario's references against the project before running it (errors name the step). */
export function validateScenario(s: Scenario, project: Project, registry: PartRegistry, opts: ScenarioOptions = {}): ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  s.steps.forEach((raw, i) => {
    const r = parseScenarioStep(raw, `scenarios.${s.id}.steps[${i}]`);
    if (!r.ok) fail("bad-step", `Scenario '${s.id}' step ${i} is invalid`, r.issues.map((x) => `${x.path}: ${x.message}`).join("; "), "fix that step (write_scenario replaces the whole scenario)");
    const step = r.step as Record<string, unknown>;
    try {
      for (const k of ["press", "release", "inject_fault"]) if (typeof step[k] === "string") findPart(project, step[k] as string);
      if (typeof step.expect_pin === "string") {
        const { part, rest } = splitRef(step.expect_pin);
        resolvePin(part, specOf(registry, findPart(project, part)), rest);
      }
      if (typeof step.set === "string") findPart(project, splitRef(step.set).part);
      const pb = step.preceded_by as PrecededBy | undefined;
      if ("said" in step || pb?.said !== undefined) {
        // Round 7 (voice): only parts with a clip table can say anything; round 14: or the device
        // speaks through a speech API (the text it sends counts), which needs a device network.
        const talkers = project.parts.filter((p) => registry.get(p.type)?.spec.props?.some((x) => x.id === "clips"));
        if ("said" in step && typeof step.part === "string") {
          const part = findPart(project, step.part);
          if (!talkers.includes(part)) fail("cannot-talk", `said … part ${part.id}`, `${part.id} is a ${part.type}, which cannot say anything`, talkers.length ? `use "part": "${talkers[0]!.id}" or leave "part" out` : "place a dfplayer-mini and a speaker first, or leave \"part\" out to check what the device sent to a speech API");
        } else if (!talkers.length && !project.network) {
          fail("cannot-talk", "said", "no part in this project can talk (a dfplayer-mini with its clips says words) and it has no device network (the text a device sends to a speech API such as /v1/audio/speech also counts)", 'place_part dfplayer-mini and a speaker (search_parts "voice") and set its clips ("1: hello!"), or give the project a network (set_network) and a speech API mock, then the words the firmware sends are what it said');
        }
      }
      if ("expect_capture" in step && typeof step.expect_capture === "string") pickCamera(project, registry, step.expect_capture);
      else if ("expect_capture" in step && !cameraParts(project, registry).length) pickCamera(project, registry);
      if (typeof pb?.capture === "string") pickCamera(project, registry, pb.capture);
      if ("reset_board" in step && !project.firmware) fail("no-firmware", "reset_board", "this project has no firmware board to reboot", "write firmware first (write_file) and point jumper.json firmware at the board");
      if (typeof step.expect_display === "string") {
        const part = findPart(project, step.expect_display);
        const spec = specOf(registry, part);
        const hasScreen = (t: string) => /data-screen="/.test(registry.get(t)?.svg ?? "");
        if (!spec.bindings?.some((b) => b.key === "pixels") && !/oled|lcd|display|tft/.test(spec.id) && !hasScreen(part.type)) {
          const displays = [...new Set(project.parts.map((p) => p.type).filter((t) => hasScreen(t)))];
          const catalog = registry.list().filter((d) => d.spec.category !== "board" && /data-screen="/.test(d.svg)).map((d) => d.spec.id);
          fail("not-a-display", `expect_display ${part.id}`, `${part.id} is a ${spec.id}, which has no screen`, displays.length ? `point expect_display at a display on this canvas: ${project.parts.filter((p) => displays.includes(p.type)).map((p) => p.id).join(", ")}` : `place a display part first (${catalog.join(", ")}) and point expect_display at it`);
        }
        if (typeof step.matches === "string" && opts.snapshot && !opts.snapshot(step.matches)) {
          fail("no-snapshot", `expect_display matches '${step.matches}'`, `there is no snapshot '${step.matches}' (snapshots/${step.matches}.json)`, `run until the screen shows it, then read_display {"part": "${part.id}", "save_as": "${step.matches}"} (optionally with "region": [x, y, w, h]) to save it`);
        }
      }
      if ("camera_frame" in step) {
        pickCamera(project, registry, typeof step.part === "string" ? step.part : undefined);
        const src = cameraSourceSpec(step.camera_frame as string | { scene?: string; image?: string });
        if ("image" in src && !opts.projectDir) fail("no-project-dir", `camera_frame ${src.image}`, "this run has no project folder to read the image from", 'use a test scene such as "face"');
        cameraProps(opts.projectDir ?? ".", src);
      }
      if ("network_mock" in step) {
        try {
          const nm = validateMock(step.network_mock as Mock, "network_mock");
          if (nm.kind === "openapi") resolveMocks([nm], opts.projectDir ?? ".", "network_mock");
        } catch (e) {
          const ce = e as { message: string; why?: string; fix?: string };
          fail("bad-mock", `network_mock: ${ce.message}`, ce.why ?? "the mock is not valid", ce.fix ? `use e.g. ${ce.fix}` : 'use the add_mock_api shape: {"host", "path", "response": {...}}');
        }
      }
      if (typeof step.expect_part === "string") {
        const ref = splitRef(step.expect_part).part;
        if (ref === "world" && !project.parts.some((p) => p.id === "world")) {
          if (!project.world) fail("no-world", `expect_part ${step.expect_part}`, "'world.<field>' reads the robot / arm physics, but this project has no world block", "add one with set_world (arena + robot, or arm), or check a part's field instead (e.g. chassis.collisions)");
        } else findPart(project, ref);
      }
    } catch (err) {
      if (err instanceof JumperError) fail(err.code, `Scenario '${s.id}' step ${i} ${stepText(raw)}`, `${err.what} (${err.why})`, err.fix);
      throw err;
    }
    steps.push(r.step);
  });
  return steps;
}

/** Run one scenario on a fresh SimHost (created by the caller at t = 0). Deterministic. */
export function runScenario(host: SimHost, s: Scenario, project: Project, registry: PartRegistry, onFrame?: (f: Frame) => void, opts: ScenarioOptions = {}): ScenarioResult {
  const steps = validateScenario(s, project, registry, opts);
  const results: StepResult[] = [];
  const warnings: string[] = [];
  const timeout = s.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  let serialCursor = 0;
  // round 10 network: request steps count only what this scenario's run did
  opts.network?.drain();
  const netStartSeq = opts.network ? (opts.network.view.log.since(0).at(-1)?.seq ?? 0) : 0;
  const sim = host.sim;
  // round 14: the NTP clock this test starts from (deterministic dates), and the event timeline
  if (s.clock && opts.network?.view.setClock) opts.network.view.setClock(Date.parse(s.clock));
  const evCtx = { host, ...(opts.network ? { net: { view: opts.network.view, drain: () => opts.network!.drain() } } : {}), netStartSeq };
  let saidFloor = -Infinity; // round 14: utterances are matched in time order (clips and speech-API text)
  const saidUsed = new Set<string>();
  const captureCursor = new Map<string, number>();
  const tail = () => sim.serialText().slice(-400);
  const run = (ms: number, until?: () => boolean) => host.run(ms, { ...(until ? { until, stepMs: 1 } : {}), ...(onFrame ? { onFrame, frameMs: 50 } : {}) });
  const done = (passed: boolean, failed?: number, reason?: string): ScenarioResult => ({
    id: s.id,
    ...(s.name ? { name: s.name } : {}),
    passed,
    t_ms: Math.round(sim.timeMs * 1000) / 1000,
    ...(failed !== undefined ? { failed_step: failed, reason: reason! } : {}),
    serial_tail: tail(),
    steps: results,
    ...(warnings.length ? { warnings } : {}),
  });
  const once = (t: number) => ` (checked once at ${Math.round(t)} ms; add within_ms to wait for the firmware to update it)`;
  /** Last value each check saw, by subject ("part:buzzer1.sounding"), so a later warning can tell a real change from a stale value. */
  const observed = new Map<string, unknown>();
  /**
   * An expect with within_ms that already held right after an input step may have tested the old
   * value, not the change. Not when an earlier check saw this subject with a value that fails the
   * same condition: then the value did change since, and the check is fine.
   */
  const heldBefore = (i: number, step: Record<string, unknown>, waited: boolean, key?: string, holdsFor?: (v: unknown) => boolean) => {
    if (waited || typeof step.within_ms !== "number" || i === 0) return;
    const prev = steps[i - 1] as Record<string, unknown>;
    const input = ["set", "press", "release", "serial_write", "inject_fault"].find((k) => k in prev);
    if (!input) return;
    if (key && holdsFor && observed.has(key) && !holdsFor(observed.get(key))) return;
    warnings.push(`step ${i} ${stepText(s.steps[i])} already held 0 ms after step ${i - 1} (${input}), so it did not wait for the firmware to react: it may test the old value. Fix: wait for the side the value moves toward (e.g. "<" when it should drop), or add {"run_ms": …} before it.`);
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Record<string, unknown> & ScenarioStep;
    const text = stepText(s.steps[i]);
    if (sim.timeMs > timeout) {
      const waits = steps.slice(0, i).reduce((sum, st) => {
        const r = st as Record<string, unknown>;
        return sum + (Number(r.run_ms ?? r.wait_ms ?? 0) || 0) + (Number(r.hold_ms ?? 0) || 0);
      }, 0);
      return done(
        false,
        i,
        `timed out: virtual time ${Math.round(sim.timeMs)} ms passed timeout_ms ${timeout} before step ${i} (run_ms / wait_ms / hold_ms steps so far add up to ${waits} ms; the rest is within_ms waiting). Fix: raise the scenario's "timeout_ms" (write_scenario {"id": "${s.id}", "timeout_ms": ${Math.ceil((sim.timeMs + 5000) / 1000) * 1000}, "steps": [...]}), or shorten the waits; a within_ms check that never held also uses up its whole wait`,
      );
    }
    let ok = true;
    let detail: string | undefined;
    try {
      if ("run_ms" in step) run(step.run_ms as number);
      else if ("wait_ms" in step) run(step.wait_ms as number);
      else if ("press" in step) {
        sim.interact(step.press as string, { kind: "press" });
        if (typeof step.hold_ms === "number") {
          run(step.hold_ms);
          sim.interact(step.press as string, { kind: "release" });
        }
      } else if ("release" in step) sim.interact(step.release as string, { kind: "release" });
      else if ("set" in step) {
        const { part, rest } = splitRef(step.set as string);
        detail = setPartValue(host, project, registry, part, rest, step.value as VisualValue);
      } else if ("serial_write" in step) {
        for (const ch of step.serial_write as string) sim.writeSerial(ch.charCodeAt(0) & 0xff);
      } else if ("inject_fault" in step) {
        detail = host.injectFault(step.inject_fault as string, step.kind as string, { ...(typeof step.field === "string" ? { field: step.field } : {}), ...(typeof step.amplitude === "number" ? { amplitude: step.amplitude } : {}) });
      } else if ("expect_serial" in step) {
        const m = step.expect_serial as string | { contains?: string; regex?: string };
        const re = typeof m === "object" && m.regex !== undefined ? new RegExp(m.regex) : undefined;
        const needle = typeof m === "string" ? m : m.contains;
        const find = (): { end: number } | undefined => {
          const text = sim.serialText().slice(serialCursor);
          if (re) {
            const mm = re.exec(text);
            return mm ? { end: serialCursor + mm.index + mm[0].length } : undefined;
          }
          const idx = text.indexOf(needle!);
          return idx >= 0 ? { end: serialCursor + idx + needle!.length } : undefined;
        };
        const want = re ? `/${re.source}/` : JSON.stringify(needle);
        const t0 = sim.timeMs;
        let hit = find();
        if (step.absent) {
          if (!hit && typeof step.within_ms === "number") run(step.within_ms, () => !!(hit = find()));
          ok = !hit;
          if (!ok) detail = `serial printed ${want} at ~${Math.round(sim.timeMs)} ms but it must not appear`;
        } else {
          if (!hit && typeof step.within_ms === "number") run(step.within_ms, () => !!(hit = find()));
          ok = !!hit;
          if (hit) {
            serialCursor = hit.end;
            detail = `seen after ${Math.round(sim.timeMs - t0)} ms`;
          } else {
            const seen = sim.serialText().slice(serialCursor).slice(-160);
            detail = `serial never printed ${want}${typeof step.within_ms === "number" ? ` within ${step.within_ms} ms` : " (checked once; add within_ms to wait)"}; unread serial since the last match: ${seen ? JSON.stringify(seen) : "nothing"}`;
          }
        }
      } else if ("expect_pin" in step) {
        const { part, rest } = splitRef(step.expect_pin as string);
        const pin = resolvePin(part, specOf(registry, findPart(project, part)), rest).id;
        const lv = step.level as "high" | "low" | undefined;
        const vr = step.voltage as { min?: number; max?: number } | undefined;
        const check = () => {
          const r = host.pin(part, pin);
          if (lv && r.level !== lv) return false;
          if (vr && ((vr.min !== undefined && r.voltage < vr.min) || (vr.max !== undefined && r.voltage > vr.max))) return false;
          return true;
        };
        const tCheck = sim.timeMs;
        ok = check();
        const pinKey = `pin:${part}.${pin}`;
        heldBefore(i, step, !ok, pinKey, (v) => {
          const o = v as { level: string; voltage: number };
          return !((lv && o.level !== lv) || (vr && ((vr.min !== undefined && o.voltage < vr.min) || (vr.max !== undefined && o.voltage > vr.max))));
        });
        if (!ok && typeof step.within_ms === "number") {
          run(step.within_ms, check);
          ok = check();
        }
        const r = host.pin(part, pin);
        observed.set(pinKey, { level: r.level, voltage: r.voltage });
        detail = `${part}.${pin} is ${r.level} (${r.voltage} V${r.mode ? `, mode ${r.mode}` : ""})`;
        if (!ok) detail = `expected ${lv ?? ""}${vr ? ` ${vr.min ?? "-∞"}..${vr.max ?? "∞"} V` : ""} but ${detail}${typeof step.within_ms === "number" ? ` after waiting ${step.within_ms} ms` : once(tCheck)}`;
      } else if ("expect_part" in step) {
        const { part, rest: field } = splitRef(step.expect_part as string);
        const op = (step.op as string) ?? "==";
        const isWorld = part === "world" && !project.parts.some((x) => x.id === "world");
        const stateOf = (): Record<string, unknown> => (isWorld ? (host.worldFields() ?? {}) : (sim.partState(part) ?? {}));
        const read = () => {
          const st = stateOf();
          if (field in st) return st[field];
          const p = project.parts.find((x) => x.id === part);
          return p?.props?.[field];
        };
        const st0 = stateOf();
        if (!(field in st0) && project.parts.find((x) => x.id === part)?.props?.[field] === undefined) {
          const keys = Object.keys(st0).filter((k) => !/Transform$/.test(k));
          fail("unknown-field", `expect_part ${part}.${field}`, `${part} has no ${isWorld ? "world" : "state"} field '${field}' (fields: ${keys.join(", ") || "none"})`, `use one of those fields, e.g. "${part}.${keys[0] ?? "on"}"`);
        }
        const check = () => compare(read(), op, step.value as VisualValue);
        const tCheck = sim.timeMs;
        ok = check();
        const partKey = `part:${part}.${field}`;
        heldBefore(i, step, !ok, partKey, (v) => compare(v, op, step.value as VisualValue));
        if (!ok && typeof step.within_ms === "number") {
          run(step.within_ms, check);
          ok = check();
        }
        const actual = read();
        observed.set(partKey, actual);
        detail = `${part}.${field} = ${JSON.stringify(typeof actual === "string" && actual.length > 60 ? `${actual.slice(0, 60)}…` : actual)}`;
        if (!ok) detail = `expected ${part}.${field} ${op} ${JSON.stringify(step.value)} but it is ${JSON.stringify(actual)}${typeof step.within_ms === "number" ? ` after waiting ${step.within_ms} ms` : once(tCheck)}`;
        if (!ok && isWorld && host.firstCollisionNote && /collision|clearance|touching/.test(field)) detail += `; ${host.firstCollisionNote}`;
      } else if ("expect_serial_value" in step) {
        const name = step.expect_serial_value as string;
        const op = (step.op as string) ?? "==";
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(?:^|[^A-Za-z0-9_])${esc}\\s*[=:]?\\s*(-?\\d+(?:\\.\\d+)?)`, "g");
        const latest = (): number | undefined => {
          let v: number | undefined;
          for (const m of sim.serialText().matchAll(re)) v = Number(m[1]);
          return v;
        };
        const check = () => {
          const v = latest();
          return v !== undefined && compare(v, op, step.value as number);
        };
        const tCheck = sim.timeMs;
        ok = check();
        const valKey = `serial:${name}`;
        heldBefore(i, step, !ok, valKey, (v) => v !== undefined && compare(v, op, step.value as number));
        if (!ok && typeof step.within_ms === "number") {
          run(step.within_ms, check);
          ok = check();
        }
        const v = latest();
        observed.set(valKey, v);
        detail = v === undefined ? `serial never printed a number after "${name}" (looked for "${name}=12", "${name}: 12" or "${name} 12")` : `latest ${name} = ${v}`;
        if (!ok) detail = v === undefined ? `${detail}${typeof step.within_ms === "number" ? ` within ${step.within_ms} ms` : once(tCheck)}; serial tail: ${JSON.stringify(sim.serialText().slice(-160))}` : `expected ${name} ${op} ${step.value} but the latest printed value is ${v}${typeof step.within_ms === "number" ? ` after waiting ${step.within_ms} ms` : once(tCheck)}`;
      } else if ("expect_display" in step) {
        const part = step.expect_display as string;
        const lit = step.lit as { min?: number; max?: number } | undefined;
        const matches = step.matches as string | undefined;
        const tol = typeof step.tolerance === "number" ? step.tolerance : 0.02;
        const snap = matches ? opts.snapshot?.(matches) : undefined;
        if (matches && !snap) fail("no-snapshot", `expect_display matches '${matches}'`, `snapshots/${matches}.json was not found`, `save it with read_display {"part": "${part}", "save_as": "${matches}"}`);
        if (!lit && !matches) fail("bad-step", `expect_display ${part} checks nothing`, "it needs \"lit\" ({min, max} lit pixels) and/or \"matches\" (a saved snapshot)", `e.g. {"expect_display": "${part}", "region": [40, 16, 48, 32], "lit": {"min": 20}}`);
        const region = (snap?.region ?? step.region) as number[] | undefined;
        const measure = () => {
          const f = host.displayFrame(part);
          const rect = clampRegion(f, step.region ? (step.region as number[]) : region, `expect_display ${part}`);
          const rows = regionRows(f, rect);
          return { rect, rows, lit: litCount(rows), diff: snap ? diffFraction(rows, snap.rows) : 0 };
        };
        const holds = () => {
          const m = measure();
          if (lit && ((lit.min !== undefined && m.lit < lit.min) || (lit.max !== undefined && m.lit > lit.max))) return false;
          if (snap && m.diff > tol) return false;
          return true;
        };
        const tCheck = sim.timeMs;
        ok = holds();
        const dispKey = `display:${part}:${JSON.stringify(step.region ?? region ?? null)}`;
        heldBefore(i, step, !ok, snap ? undefined : dispKey, (v) => !(lit && ((lit.min !== undefined && Number(v) < lit.min) || (lit.max !== undefined && Number(v) > lit.max))));
        if (!ok && typeof step.within_ms === "number") {
          run(step.within_ms, holds);
          ok = holds();
        }
        const m = measure();
        observed.set(dispKey, m.lit);
        detail = `${part} region [${m.rect.join(", ")}]: ${m.lit} lit${snap ? `, ${(m.diff * 100).toFixed(1)}% differs from '${matches}'` : ""}`;
        if (!ok) {
          const want = [lit ? `${lit.min ?? 0}..${lit.max ?? "∞"} lit pixels` : "", snap ? `at most ${(tol * 100).toFixed(1)}% different from snapshot '${matches}'` : ""].filter(Boolean).join(" and ");
          detail = `expected ${want} but ${detail}${typeof step.within_ms === "number" ? ` after waiting ${step.within_ms} ms` : once(tCheck)}; read_display {"part": "${part}"} shows the screen now`;
        }
      } else if ("reset_board" in step) {
        // Round 14: reboot the board now; time, parts, logs and flash go on.
        host.resetBoard();
        detail = `rebooted the board at ${Math.round(sim.timeMs)} ms (flash kept)`;
      } else if ("set_clock" in step) {
        const net = opts.network;
        if (!net?.view.setClock) {
          ok = false;
          detail = "this project has no device network, so the device gets no time from NTP: set_clock sets what the sandbox's NTP answers. Fix: give the project a network (set_network) and call configTime() in the firmware";
        } else {
          net.view.setClock(Date.parse(step.set_clock as string));
          detail = `NTP now answers ${new Date(Date.parse(step.set_clock as string)).toISOString()} (advancing with virtual time)`;
        }
      } else if ("expect_capture" in step) {
        // Round 14: pictures the camera took (each esp_camera_fb_get), with their times.
        const cam = typeof step.expect_capture === "string" ? step.expect_capture : undefined;
        const key = cam ?? "*";
        const want = typeof step.count === "number" ? step.count : 1;
        const pb = step.preceded_by as PrecededBy | undefined;
        const camLabel = cam ?? (host.cameraParts().length === 1 ? host.cameraParts()[0]! : "the camera");
        if (step.absent) {
          const from = host.captures(cam).length;
          const t0 = sim.timeMs;
          const newOnes = () => host.captures(cam).slice(from);
          if (typeof step.within_ms === "number") run(step.within_ms, () => newOnes().length > 0);
          const n = newOnes();
          ok = n.length === 0;
          detail = ok ? `no picture from ${camLabel} in ${Math.round(sim.timeMs - t0)} ms, as expected` : `${camLabel} took a picture at ${Math.round(n[0]!.t_ms)} ms (${Math.round(n[0]!.t_ms - t0)} ms after this step began) but must not`;
          captureCursor.set(key, host.captures(cam).length);
        } else {
          const from = captureCursor.get(key) ?? 0;
          const fitting = () => {
            const list = host.captures(cam).slice(from);
            if (!pb) return { list, good: list };
            return { list, good: list.filter((c) => precededWhy(pb, c.t_ms, evCtx, "the picture") === undefined) };
          };
          let f = fitting();
          const t0 = sim.timeMs;
          if (f.good.length < want && typeof step.within_ms === "number") run(step.within_ms, () => (f = fitting()).good.length >= want);
          f = fitting();
          ok = f.good.length >= want;
          if (ok) {
            const last = f.good[want - 1]!;
            captureCursor.set(key, host.captures(cam).indexOf(last) + 1);
            detail = `${camLabel} took ${want > 1 ? `${want} pictures, the last` : "a picture"} at ${Math.round(last.t_ms)} ms${pb ? " (preceded as required)" : ""}`;
          } else if (f.list.length >= want && pb) {
            detail = f.list.map((c) => precededWhy(pb, c.t_ms, evCtx, `the picture`)).filter(Boolean).slice(-2).join("; ");
            detail += `. Fix: the firmware must ${pb.said !== undefined ? "say it" : "do that"} ${pb.min_ms ?? 0}${pb.max_ms !== undefined ? ` to ${pb.max_ms}` : "+"} ms before it takes the picture, or change preceded_by`;
          } else {
            detail = `${camLabel} took ${f.list.length} picture(s)${want > 1 ? `, ${want} wanted` : ""}${typeof step.within_ms === "number" ? ` in ${Math.round(sim.timeMs - t0)} ms` : " (checked once; add within_ms to wait)"}${host.captures(cam).length ? `; ${host.captures(cam).length} since the start, the last at ${Math.round(host.captures(cam).at(-1)!.t_ms)} ms` : ""}. Fix: check the firmware reaches esp_camera_fb_get() (read_serial), or wait longer`;
          }
        }
      } else if ("request" in step) {
        // Round 10 (network): the device made this request through the sandbox.
        const net = opts.network;
        if (!net) {
          ok = false;
          detail = "this project has no device network: only boards with a network card in the emulator (ESP32 family) make requests; read_network shows what is on the sandbox network";
        } else {
          const want = step.request as Parameters<typeof checkRequest>[1];
          const pb = step.preceded_by as PrecededBy | undefined;
          const check = () => {
            net.drain();
            const r = checkRequest(net.view, { ...want, sinceSeq: netStartSeq });
            if (!pb || !r.entries?.length) return r;
            // round 14: of the matching requests, at least `count` must follow the named event in time
            const good = r.entries.filter((e) => precededWhy(pb, e.t_ms, evCtx, "the request") === undefined);
            if (good.length >= (want.count ?? 1)) return { ...r, matched: good.length };
            return { ok: false, matched: good.length, why: r.entries.map((e) => precededWhy(pb, e.t_ms, evCtx, `${e.method ?? ""} ${e.host}${e.path ?? ""}`)).filter(Boolean).slice(-2).join("; "), fix: "make the firmware do it in that order and timing, or change preceded_by" };
          };
          let r = check();
          if (step.absent) {
            if (r.ok === false && typeof step.within_ms === "number") run(step.within_ms, () => check().ok);
            r = check();
            ok = !r.ok;
            detail = ok ? `no ${want.method ?? ""} ${want.host}${want.path ?? ""} request, as expected` : `the device made ${r.matched} matching request(s) but must not`;
          } else {
            if (!r.ok && typeof step.within_ms === "number") run(step.within_ms, () => check().ok);
            r = check();
            ok = r.ok;
            detail = ok ? `${r.matched} matching request(s)` : `${r.why}${typeof step.within_ms === "number" ? ` (waited ${step.within_ms} ms)` : " (checked once; add within_ms to wait)"}. Fix: ${r.fix}`;
          }
        }
      } else if ("camera_frame" in step) {
        const cam = pickCamera(project, registry, typeof step.part === "string" ? step.part : undefined);
        const src = cameraSourceSpec(step.camera_frame as string | { scene?: string; image?: string });
        sim.setProps(cam, cameraProps(opts.projectDir ?? ".", src));
        detail = `${cam} sees ${"scene" in src ? `the "${src.scene}" scene` : src.image}`;
      } else if ("network_mock" in step) {
        const net = opts.network;
        const m = step.network_mock as Mock;
        if (!net) {
          ok = false;
          detail = "this project has no device network to mock: only boards with a network card in the emulator (ESP32 family) make requests";
        } else {
          net.view.scenarioMock(m);
          detail = `mock ${(m as { kind?: string }).kind ?? "http"} ${m.host}${"path" in m && m.path ? m.path : ""} for the rest of this scenario`;
        }
      } else if ("network_fault" in step) {
        const net = opts.network;
        if (!net) {
          ok = false;
          detail = "this project has no device network to fault";
        } else {
          const f = step.network_fault as Fault | { kind: "clear" };
          if (f.kind === "clear") net.view.clearFaults();
          else net.view.inject(f as Fault);
          detail = `network fault ${f.kind}`;
        }
      } else if ("said" in step) {
        // Round 7 (voice): words a talking part (DFPlayer) played with a speaker wired.
        const m = step.said as string | { contains?: string; regex?: string };
        const re = typeof m === "object" && m.regex !== undefined ? new RegExp(m.regex, "i") : undefined;
        const needle = (typeof m === "string" ? m : (m.contains ?? "")).toLowerCase();
        const who = step.part as string | undefined;
        const want = re ? `/${re.source}/i` : JSON.stringify(needle);
        // round 14: clips and the text sent to speech APIs, in time order
        const all = () => spokenSoFar(host, opts.network, netStartSeq);
        const hits = (u: { text: string }) => (re ? re.test(u.text) : u.text.toLowerCase().includes(needle));
        const uKey = (u: { partId: string; t_ms: number; text: string }) => `${u.partId}|${u.t_ms}|${u.text}`;
        const find = (): number => {
          const l = all();
          for (let k = 0; k < l.length; k++) {
            const u = l[k]!;
            if (u.t_ms < saidFloor || saidUsed.has(uKey(u))) continue;
            if ((!who || u.partId === who) && u.audible && hits(u)) return k;
          }
          return -1;
        };
        const t0 = sim.timeMs;
        let hit = find();
        if (hit < 0 && typeof step.within_ms === "number") run(step.within_ms, () => (hit = find()) >= 0);
        const recent = all().filter((u) => u.t_ms >= saidFloor && !saidUsed.has(uKey(u)) && (!who || u.partId === who));
        const heard = recent.filter((u) => u.audible).map((u) => `${JSON.stringify(u.text)} at ${Math.round(u.t_ms)} ms`);
        const unheard = recent.filter((u) => !u.audible);
        const unheardNote = unheard.length
          ? `; ${unheard.map((u) => `${u.partId} played ${JSON.stringify(u.text)} at ${Math.round(u.t_ms)} ms`).join(", ")} but nothing is wired to its speaker outputs (SPK_1 / SPK_2 or DAC), so nobody heard it. Fix: wire a speaker, + to SPK_1 and - to SPK_2`
          : "";
        if (step.absent) {
          ok = hit < 0;
          if (!ok) {
            const u = all()[hit]!;
            detail = `${u.partId} said ${JSON.stringify(u.text)} at ${Math.round(u.t_ms)} ms but ${want} must not be said`;
          }
        } else {
          ok = hit >= 0;
          if (ok) {
            const u = all()[hit]!;
            saidFloor = u.t_ms;
            saidUsed.add(uKey(u));
            detail = `${u.partId} said ${JSON.stringify(u.text)} at ${Math.round(u.t_ms)} ms (${u.via === "speech-api" ? "text sent to a speech API" : `${(u.dur_ms / 1000).toFixed(2)} s`}), ${Math.round(sim.timeMs - t0)} ms after this step began`;
          } else {
            detail = `nothing said matched ${want}${typeof step.within_ms === "number" ? ` within ${step.within_ms} ms` : " (checked once; add within_ms to wait)"}; said since the last match: ${heard.length ? heard.join(", ") : "nothing"}${unheardNote}`;
          }
        }
      } else if ("expect_no_errors" in step) {
        const errs = sim.diagnostics().filter((d) => d.severity === "error");
        ok = errs.length === 0;
        if (!ok) detail = errs.map((d) => `${d.partId}: ${d.message}`).join("; ");
      }
    } catch (err) {
      ok = false;
      detail = err instanceof Error ? err.message : String(err);
    }
    if (!ok && i > 0 && /^expect_(pin|part|display|serial_value)$/.test(Object.keys(step).find((k) => k.startsWith("expect_")) ?? "")) {
      const prev = steps[i - 1] as Record<string, unknown>;
      if (typeof prev.press === "string" && typeof prev.hold_ms === "number" && prev.hold_ms > 0) {
        detail = `${detail ?? "failed"}. Note: step ${i - 1} held ${prev.press} for ${prev.hold_ms} ms and released it before this check began, so a reaction that started and ended during the hold (shorter than ${prev.hold_ms} ms) is not seen here. Fix: {"press": "${prev.press}"} without hold_ms, then this check with within_ms, then {"release": "${prev.press}"}`;
      }
    }
    const r: StepResult = { i, step: text, ok, t_ms: Math.round(sim.timeMs * 1000) / 1000 };
    if (detail) r.detail = detail;
    results.push(r);
    if (!ok) return done(false, i, `step ${i} ${text} failed: ${detail}`);
    if (opts.stopAfter !== undefined && i >= opts.stopAfter) return done(true);
  }
  return done(true);
}
