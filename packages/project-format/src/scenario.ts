import { z } from "zod";

/**
 * Scenario tests: a list of steps run against the simulation, deterministic (virtual time only).
 * Each step is one object with exactly one action key plus its modifiers, e.g.
 *
 *   { "press": "btn1", "hold_ms": 50 }
 *   { "expect_serial": "LED on", "within_ms": 1100 }
 *   { "expect_pin": "uno.D13", "level": "high" }
 *   { "expect_part": "oled1.blank", "op": "==", "value": false, "within_ms": 500 }
 *
 * `within_ms` on an expect step means "keep simulating up to this long until it holds"; without it
 * the expectation is checked once, right now.
 */

/** "part.field" or "part.pin": the part id, a dot, then the pin/field id (which may itself contain dots, e.g. "uno.GND.1"). */
const DottedRef = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*\.[^\s]+$/, "must look like 'part.pin' or 'part.field', e.g. 'uno.D13' or 'oled1.blank'");
const PartRef = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must be a part id, e.g. 'btn1'");
const Ms = z.number().nonnegative();
const Value = z.union([z.string(), z.number(), z.boolean()]);

export const COMPARE_OPS = ["==", "!=", ">", ">=", "<", "<=", "contains", "matches"] as const;
export const CompareOpSchema = z.enum(COMPARE_OPS);

const common = {
  name: z.string().optional().describe("Optional label shown in test results."),
};

export const RunStepSchema = z
  .object({ run_ms: Ms.describe("Advance virtual time by this many ms."), ...common })
  .strict();
export const WaitStepSchema = z
  .object({ wait_ms: Ms.describe("Same as run_ms: advance virtual time."), ...common })
  .strict();
export const PressStepSchema = z
  .object({
    press: PartRef.describe("Part to press (button, switch)."),
    hold_ms: Ms.optional().describe("If set: hold this long, then release."),
    ...common,
  })
  .strict();
export const ReleaseStepSchema = z.object({ release: PartRef, ...common }).strict();
export const SetStepSchema = z
  .object({
    set: DottedRef.describe("'part.field': a prop or sensor field, e.g. 'pot1.position', 'sonar1.distance'."),
    value: Value,
    ...common,
  })
  .strict();
export const SerialWriteStepSchema = z
  .object({ serial_write: z.string().describe("Text sent to the board's serial RX."), ...common })
  .strict();
export const FaultStepSchema = z
  .object({
    inject_fault: PartRef,
    kind: z.string().describe("disconnect | noisy | i2c_nack | i2c_nack_data | i2c_garbage | clear"),
    field: z.string().optional().describe("noisy: which numeric field jitters (default: the first)."),
    amplitude: z.number().positive().optional().describe("noisy: jitter amplitude in the field's unit (default ±5% of its range)."),
    ...common,
  })
  .strict();

const SerialMatch = z.union([
  z.string().describe("Substring the serial output must contain."),
  z.object({ contains: z.string() }).strict(),
  z.object({ regex: z.string() }).strict(),
]);

export const ExpectSerialStepSchema = z
  .object({
    expect_serial: SerialMatch,
    within_ms: Ms.optional(),
    absent: z.boolean().optional().describe("true: the text must NOT appear (within within_ms, or now)."),
    ...common,
  })
  .strict();
export const ExpectPinStepSchema = z
  .object({
    expect_pin: DottedRef.describe("'part.pin', e.g. 'uno.D13'."),
    level: z.enum(["high", "low"]).optional(),
    voltage: z
      .object({ min: z.number().optional(), max: z.number().optional() })
      .strict()
      .optional()
      .describe("Volts range, inclusive."),
    within_ms: Ms.optional(),
    ...common,
  })
  .strict();
export const ExpectPartStepSchema = z
  .object({
    expect_part: DottedRef.describe("'part.field' where field is a key of the part's state (see get_part 'state'), or 'world.field' for the robot / arm physics (collisions, min_clearance_cm, travelled_cm, x, y, heading, sonar_cm, gripper_x, gripper_y, reached)."),
    op: CompareOpSchema.default("=="),
    value: Value,
    within_ms: Ms.optional(),
    ...common,
  })
  .strict();
export const ExpectNoErrorsStepSchema = z
  .object({ expect_no_errors: z.literal(true).describe("Fail if any part reports an error diagnostic (overcurrent…)."), ...common })
  .strict();

export const ScenarioStepSchema = z.union([
  RunStepSchema,
  WaitStepSchema,
  PressStepSchema,
  ReleaseStepSchema,
  SetStepSchema,
  SerialWriteStepSchema,
  FaultStepSchema,
  ExpectSerialStepSchema,
  ExpectPinStepSchema,
  ExpectPartStepSchema,
  ExpectNoErrorsStepSchema,
]);

/** Action key → its schema. Used to give one precise error instead of a union dump. */
export const STEP_KINDS = {
  run_ms: RunStepSchema,
  wait_ms: WaitStepSchema,
  press: PressStepSchema,
  release: ReleaseStepSchema,
  set: SetStepSchema,
  serial_write: SerialWriteStepSchema,
  inject_fault: FaultStepSchema,
  expect_serial: ExpectSerialStepSchema,
  expect_pin: ExpectPinStepSchema,
  expect_part: ExpectPartStepSchema,
  expect_no_errors: ExpectNoErrorsStepSchema,
} as const;
export type StepKind = keyof typeof STEP_KINDS;

export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;
export type CompareOp = z.infer<typeof CompareOpSchema>;

export const STEP_EXAMPLES: Record<StepKind, string> = {
  run_ms: `{ "run_ms": 500 }`,
  wait_ms: `{ "wait_ms": 500 }`,
  press: `{ "press": "btn1", "hold_ms": 50 }`,
  release: `{ "release": "btn1" }`,
  set: `{ "set": "pot1.position", "value": 0.5 }`,
  serial_write: `{ "serial_write": "feed\\n" }`,
  inject_fault: `{ "inject_fault": "oled1", "kind": "disconnect" } or { "inject_fault": "pot1", "kind": "noisy", "field": "position", "amplitude": 0.02 }`,
  expect_serial: `{ "expect_serial": "LED on", "within_ms": 1100 }`,
  expect_pin: `{ "expect_pin": "uno.D13", "level": "high", "within_ms": 50 }`,
  expect_part: `{ "expect_part": "oled1.blank", "op": "==", "value": false, "within_ms": 500 }`,
  expect_no_errors: `{ "expect_no_errors": true }`,
};

export interface StepIssue {
  path: string;
  message: string;
}

/**
 * Validate one step and say exactly what is wrong (which action key, which field), with an example
 * of the right shape. Returns the parsed step or the issues.
 */
export function parseScenarioStep(raw: unknown, path = "step"): { ok: true; step: ScenarioStep; kind: StepKind } | { ok: false; issues: StepIssue[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ path, message: `a step must be an object such as ${STEP_EXAMPLES.expect_serial}` }] };
  }
  const keys = Object.keys(raw).filter((k) => k in STEP_KINDS) as StepKind[];
  if (keys.length !== 1) {
    const list = Object.keys(STEP_KINDS).join(", ");
    return {
      ok: false,
      issues: [
        {
          path,
          message:
            keys.length === 0
              ? `no action key found (got keys: ${Object.keys(raw).join(", ") || "none"}); use exactly one of: ${list}`
              : `has ${keys.length} action keys (${keys.join(", ")}); split it into one step per action`,
        },
      ],
    };
  }
  const kind = keys[0]!;
  const res = STEP_KINDS[kind].safeParse(raw);
  if (res.success) {
    const step = res.data as ScenarioStep;
    if (kind === "expect_pin") {
      const s = step as z.infer<typeof ExpectPinStepSchema>;
      if (!s.level && !s.voltage) {
        return { ok: false, issues: [{ path, message: `expect_pin needs "level" ("high"/"low") or "voltage" ({min,max}); e.g. ${STEP_EXAMPLES.expect_pin}` }] };
      }
    }
    if (kind === "expect_serial") {
      const m = (step as z.infer<typeof ExpectSerialStepSchema>).expect_serial;
      if (typeof m === "object" && "regex" in m) {
        try {
          new RegExp(m.regex);
        } catch (err) {
          return { ok: false, issues: [{ path: `${path}.expect_serial.regex`, message: `invalid regular expression: ${(err as Error).message}` }] };
        }
      }
    }
    return { ok: true, step, kind };
  }
  return {
    ok: false,
    issues: res.error.issues.map((i) => {
      const sub = i.path.map(String).join(".");
      let message = i.message;
      if (i.code === "unrecognized_keys") message = `unknown field(s) ${(i as { keys?: string[] }).keys?.map((k) => `'${k}'`).join(", ")} for a ${kind} step`;
      return { path: sub ? `${path}.${sub}` : path, message: `${message}; expected shape: ${STEP_EXAMPLES[kind]}` };
    }),
  };
}

export const ScenarioSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must start with a letter and contain only letters, digits, '_' or '-'")
      .describe("Unique scenario id, e.g. 'blinks'."),
    name: z.string().optional(),
    description: z.string().optional(),
    steps: z.array(z.unknown()).default([]).describe("Steps run in order. See ScenarioStep."),
    timeout_ms: Ms.optional().describe("Abort when virtual time passes this (default 60000)."),
  })
  .catchall(z.unknown())
  .superRefine((s, ctx) => {
    s.steps.forEach((raw, i) => {
      const r = parseScenarioStep(raw, `steps[${i}]`);
      if (!r.ok) for (const issue of r.issues) ctx.addIssue({ code: "custom", path: [], message: `${issue.path}: ${issue.message}` });
    });
  });

export type Scenario = z.infer<typeof ScenarioSchema>;
