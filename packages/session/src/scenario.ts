import { parseScenarioStep, type Project, type Scenario, type ScenarioStep } from "@jumper/project-format";
import type { PartRegistry, VisualValue } from "@jumper/sim-core";
import { fail, JumperError } from "./errors.ts";
import { findPart, resolvePin, specOf, splitRef } from "./pins.ts";
import type { Frame, SimHost } from "./sim.ts";

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
export function validateScenario(s: Scenario, project: Project, registry: PartRegistry): ScenarioStep[] {
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
export function runScenario(host: SimHost, s: Scenario, project: Project, registry: PartRegistry, onFrame?: (f: Frame) => void): ScenarioResult {
  const steps = validateScenario(s, project, registry);
  const results: StepResult[] = [];
  const timeout = s.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  let serialCursor = 0;
  const sim = host.sim;
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
  });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Record<string, unknown> & ScenarioStep;
    const text = stepText(s.steps[i]);
    if (sim.timeMs > timeout) return done(false, i, `timed out: virtual time ${Math.round(sim.timeMs)} ms passed timeout_ms ${timeout} before step ${i}`);
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
        ok = check();
        if (!ok && typeof step.within_ms === "number") {
          run(step.within_ms, check);
          ok = check();
        }
        const r = host.pin(part, pin);
        detail = `${part}.${pin} is ${r.level} (${r.voltage} V${r.mode ? `, mode ${r.mode}` : ""})`;
        if (!ok) detail = `expected ${lv ?? ""}${vr ? ` ${vr.min ?? "-∞"}..${vr.max ?? "∞"} V` : ""} but ${detail}${typeof step.within_ms === "number" ? ` after waiting ${step.within_ms} ms` : ""}`;
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
        ok = check();
        if (!ok && typeof step.within_ms === "number") {
          run(step.within_ms, check);
          ok = check();
        }
        const actual = read();
        detail = `${part}.${field} = ${JSON.stringify(typeof actual === "string" && actual.length > 60 ? `${actual.slice(0, 60)}…` : actual)}`;
        if (!ok) detail = `expected ${part}.${field} ${op} ${JSON.stringify(step.value)} but it is ${JSON.stringify(actual)}${typeof step.within_ms === "number" ? ` after waiting ${step.within_ms} ms` : ""}`;
      } else if ("expect_no_errors" in step) {
        const errs = sim.diagnostics().filter((d) => d.severity === "error");
        ok = errs.length === 0;
        if (!ok) detail = errs.map((d) => `${d.partId}: ${d.message}`).join("; ");
      }
    } catch (err) {
      ok = false;
      detail = err instanceof Error ? err.message : String(err);
    }
    const r: StepResult = { i, step: text, ok, t_ms: Math.round(sim.timeMs * 1000) / 1000 };
    if (detail) r.detail = detail;
    results.push(r);
    if (!ok) return done(false, i, `step ${i} ${text} failed: ${detail}`);
  }
  return done(true);
}
