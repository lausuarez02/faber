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
export const ExpectSerialValueStepSchema = z
  .object({
    expect_serial_value: z
      .string()
      .regex(/^[A-Za-z_][\w.-]*$/, "must be the name the firmware prints before the number, e.g. 'hunger' for \"hunger=40\"")
      .describe("Name printed before a number on serial, e.g. 'hunger' matches \"hunger=40\", \"hunger: 40\" or \"hunger 40\". The latest printed value is compared."),
    op: CompareOpSchema.default("=="),
    value: z.number(),
    within_ms: Ms.optional(),
    ...common,
  })
  .strict();
export const ExpectDisplayStepSchema = z
  .object({
    expect_display: PartRef.describe("Display part id, e.g. 'oled1'."),
    region: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().positive(), z.number().int().positive()])
      .optional()
      .describe("[x, y, w, h] in screen pixels; default the whole screen."),
    lit: z
      .object({ min: z.number().nonnegative().optional(), max: z.number().nonnegative().optional() })
      .strict()
      .optional()
      .describe("Lit pixel count inside the region, inclusive range."),
    matches: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must be a snapshot name saved with read_display {save_as}")
      .optional()
      .describe("Name of a golden frame saved with read_display {save_as: name} (snapshots/<name>.txt)."),
    tolerance: z.number().min(0).max(1).optional().describe("matches: fraction of region pixels allowed to differ (default 0.02)."),
    within_ms: Ms.optional(),
    ...common,
  })
  .strict();
export const ExpectNoErrorsStepSchema = z
  .object({ expect_no_errors: z.literal(true).describe("Fail if any part reports an error diagnostic (overcurrent…)."), ...common })
  .strict();
/** Round 7 (voice): something a part said out loud (a DFPlayer clip's words) with a speaker wired. */
export const SaidStepSchema = z
  .object({
    said: z
      .union([
        z.string().describe("Words it must have said (case-insensitive substring of the clip's words)."),
        z.object({ contains: z.string() }).strict(),
        z.object({ regex: z.string() }).strict(),
      ])
      .describe("Words of a clip played since the previous said step (or the start), e.g. \"dizzy\" or {\"regex\": \"^hi\"}."),
    part: PartRef.optional().describe("Only this talking part (a DFPlayer id); default any."),
    within_ms: Ms.optional(),
    absent: z.boolean().optional().describe("true: it must NOT say it (within within_ms, or so far)."),
    ...common,
  })
  .strict();

const SaidMatch = z.union([z.string(), z.object({ contains: z.string() }).strict(), z.object({ regex: z.string() }).strict()]);

/**
 * Round 14: "this happened before the event, this long before": a modifier of expect_capture and
 * request. One of said / serial / capture / request, plus the gap: the last such event before the
 * checked one must be between min_ms and max_ms earlier (e.g. a spoken "picture in 10 seconds" 9 to
 * 11 s before the capture).
 */
export const PrecededBySchema = z
  .object({
    said: SaidMatch.optional().describe("Words said out loud (a clip's words, or the text the device sent to a speech API)."),
    serial: SerialMatch.optional().describe("Text printed on serial."),
    capture: z.union([PartRef, z.literal(true)]).optional().describe("A picture the camera took (part id, or true: any camera)."),
    request: z.object({ host: z.string().min(1), path: z.string().optional(), method: z.string().optional() }).strict().optional().describe("A request the device made."),
    min_ms: Ms.optional().describe("At least this long before (default 0)."),
    max_ms: Ms.optional().describe("At most this long before (default: any time since the scenario started)."),
  })
  .strict();

/** Round 10 (network): the device made this request (HTTP, WebSocket or MQTT) through the sandbox. */
export const RequestStepSchema = z
  .object({
    request: z
      .object({
        host: z.string().min(1).describe("Host the device called, e.g. api.example.com."),
        path: z.string().optional().describe("Path without the query (exact, or a prefix ending in *)."),
        method: z.string().optional(),
        status: z.number().int().optional().describe("The status the device got."),
        count: z.number().int().positive().optional().describe("At least this many (default 1), counted since the scenario started."),
        kind: z.enum(["http", "ws", "mqtt"]).optional().describe("Default http or ws."),
        content_type: z.string().optional().describe('Round 14: the Content-Type contains this, e.g. "multipart/form-data" or "application/json".'),
        body_contains: z.string().optional().describe("Round 14: the body (its text, a field value, a multipart part's name or file name) contains this, case-insensitive."),
        body_json: z.record(z.string(), z.unknown()).optional().describe('Round 14: these fields of a JSON, form or multipart body have these values: nested objects or dot paths ("messages.0.role"); "x*" = starts with x, "?" = present and not empty. A multipart file part has <name>.filename, <name>.content_type, <name>.bytes.'),
        min_bytes: z.number().int().nonnegative().optional().describe("Round 14: the body has at least this many bytes."),
      })
      .strict(),
    within_ms: Ms.optional(),
    absent: z.boolean().optional().describe("true: the device must NOT have made it (within within_ms, or so far)."),
    preceded_by: PrecededBySchema.optional().describe("Round 14: something that must have happened shortly before the matching request."),
    ...common,
  })
  .strict();

/** Round 14: a picture the camera took (the firmware's esp_camera_fb_get), or that it did not. */
export const ExpectCaptureStepSchema = z
  .object({
    expect_capture: z.union([PartRef, z.literal(true)]).describe("The camera part (or true: the only / any camera)."),
    count: z.number().int().positive().optional().describe("At least this many pictures (default 1), counted since the last matched expect_capture (or the start of the test)."),
    within_ms: Ms.optional().describe("Keep simulating up to this long until it happens."),
    absent: z.boolean().optional().describe("true: NO picture may be taken from this step on (within within_ms)."),
    preceded_by: PrecededBySchema.optional().describe('Something that must have happened shortly before the picture, e.g. {"said": "picture", "min_ms": 9000, "max_ms": 11000}.'),
    ...common,
  })
  .strict();

/**
 * Round 14: reboot the firmware board now (reset button / power cycle) without restarting the test:
 * virtual time, the parts and the network log go on; what the firmware wrote to flash (LittleFS,
 * SPIFFS, NVS / Preferences) stays, as on the chip.
 */
export const ResetBoardStepSchema = z
  .object({ reset_board: z.literal(true).describe("Reboot the firmware board, keeping its flash."), ...common })
  .strict();

/**
 * Round 14: the date and time the device gets from NTP (configTime / SNTP) from now on, advancing with
 * virtual time, so clock-based behaviour (a post at 9:00, a daily limit) is testable.
 */
export const SetClockStepSchema = z
  .object({
    set_clock: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be a date-time such as 2026-12-24T09:00:00Z").describe('ISO 8601 date-time, e.g. "2026-12-24T09:00:00Z".'),
    ...common,
  })
  .strict();

/** Round 10 (network): a network fault on the sandbox (not a part): Wi-Fi drop, weak signal, latency, HTTP errors. */
export const NetworkFaultStepSchema = z
  .object({
    network_fault: z
      .object({
        kind: z.enum(["wifi_drop", "weak_signal", "latency", "http_error", "timeout", "dns_fail", "clear"]),
        rssi: z.number().optional(),
        ms: z.number().positive().optional(),
        status: z.number().int().optional(),
        host: z.string().optional(),
        path: z.string().optional(),
        count: z.number().int().positive().optional(),
      })
      .strict(),
    ...common,
  })
  .strict();

/**
 * Round 10 eval: a mock API answer for the rest of this scenario only (the project's mocks come back
 * after it), so one test can serve a dry forecast and another a rainy one. Same shape as add_mock_api's
 * mock; it is checked before mocks.json, so it wins over a project mock for the same request.
 */
export const NetworkMockStepSchema = z
  .object({
    network_mock: z.record(z.string(), z.unknown()).describe('A mock, as add_mock_api takes it: {"host", "method"?, "path", "response": {...}} (HTTP), or a "ws" / "mqtt" mock.'),
    ...common,
  })
  .strict();

/**
 * Round 13 (camera): what a camera sees from now on: a named test scene (test-card, color-bars, face,
 * gradient, checker, black, white, dark-room) or an image file in the project (PNG or baseline JPEG).
 */
export const CameraFrameStepSchema = z
  .object({
    camera_frame: z
      .union([
        z.string().min(1),
        z.object({ scene: z.string().min(1).optional(), image: z.string().min(1).optional() }).strict(),
      ])
      .describe('A test scene name ("face", "test-card", ...) or an image path in the project ("tests/cat.jpg"); or {"scene": ...} / {"image": ...}.'),
    part: PartRef.optional().describe("The camera part (default: the only camera in the project)."),
    ...common,
  })
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
  ExpectSerialValueStepSchema,
  ExpectDisplayStepSchema,
  ExpectNoErrorsStepSchema,
  SaidStepSchema,
  RequestStepSchema,
  NetworkFaultStepSchema,
  NetworkMockStepSchema,
  CameraFrameStepSchema,
  ExpectCaptureStepSchema,
  ResetBoardStepSchema,
  SetClockStepSchema,
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
  expect_serial_value: ExpectSerialValueStepSchema,
  expect_display: ExpectDisplayStepSchema,
  expect_no_errors: ExpectNoErrorsStepSchema,
  said: SaidStepSchema,
  request: RequestStepSchema,
  network_fault: NetworkFaultStepSchema,
  network_mock: NetworkMockStepSchema,
  camera_frame: CameraFrameStepSchema,
  expect_capture: ExpectCaptureStepSchema,
  reset_board: ResetBoardStepSchema,
  set_clock: SetClockStepSchema,
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
  expect_serial: `{ "expect_serial": "LED on", "within_ms": 1100 } (text), or { "expect_serial": { "regex": "MOOD \\\\w+ -> sad" }, "within_ms": 1100 } (regular expression: put it INSIDE expect_serial)`,
  expect_pin: `{ "expect_pin": "uno.D13", "level": "high", "within_ms": 50 }`,
  expect_part: `{ "expect_part": "oled1.blank", "op": "==", "value": false, "within_ms": 500 }`,
  expect_serial_value: `{ "expect_serial_value": "energy", "op": ">=", "value": 60, "within_ms": 1500 }`,
  expect_display: `{ "expect_display": "oled1", "region": [40, 16, 48, 32], "lit": { "min": 20 } } or { "expect_display": "oled1", "matches": "sad-face", "within_ms": 2000 }`,
  expect_no_errors: `{ "expect_no_errors": true }`,
  request: `{ "request": { "host": "api.example.com", "path": "/v1/now", "status": 200 }, "within_ms": 5000 } (the device made it through the sandbox), or { "request": { "host": "mqtt.example.com", "kind": "mqtt" }, "within_ms": 8000 }, or { "request": { "host": "api.example.com" }, "absent": true }`,
  network_fault: `{ "network_fault": { "kind": "wifi_drop" } }, then later { "network_fault": { "kind": "clear" } }; or { "network_fault": { "kind": "http_error", "status": 503, "count": 1 } }`,
  network_mock: `{ "network_mock": { "host": "api.example.com", "path": "/v1/forecast", "response": { "body": { "rain": 0 } } } } (this answer for the rest of this scenario only, ahead of network/mocks.json)`,
  camera_frame: `{ "camera_frame": "face" } (a test scene: test-card, color-bars, face, gradient, checker, black, white, dark-room), or { "camera_frame": { "image": "tests/cat.jpg" }, "part": "cam1" } (a PNG / JPEG in the project); then e.g. { "expect_part": "cam1.camera_frames", "op": ">=", "value": 1, "within_ms": 2000 }`,
  said: `{ "said": "dizzy", "within_ms": 500 } (words a DFPlayer clip said with a speaker wired, or text the device sent to a speech API such as /v1/audio/speech), or { "said": { "regex": "^hi" }, "part": "df", "within_ms": 2000 }, or { "said": "goodbye", "absent": true, "within_ms": 1000 }`,
  expect_capture: `{ "expect_capture": "cam", "within_ms": 60000, "preceded_by": { "said": "picture", "min_ms": 9000, "max_ms": 11000 } } (a picture taken, 9 to 11 s after it said so), or { "expect_capture": true, "absent": true, "within_ms": 12000 } (no picture)`,
  reset_board: `{ "reset_board": true } (reboot the board now; flash files survive), then e.g. { "expect_serial": "queue: 1 photo", "within_ms": 3000 }`,
  set_clock: `{ "set_clock": "2026-12-24T09:00:00Z" } (the time NTP gives the device from now on)`,
};

/**
 * Forms agents guess first, rewritten to the canonical step (and what was changed, for the result):
 * a sibling or standalone "regex" goes inside expect_serial.
 */
export function normalizeScenarioStep(raw: unknown): { step: unknown; note?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { step: raw };
  const o = raw as Record<string, unknown>;
  if (typeof o.regex === "string") {
    const actions = Object.keys(o).filter((k) => k in STEP_KINDS);
    const es = o.expect_serial;
    if ((actions.length === 0 || (actions.length === 1 && actions[0] === "expect_serial")) && (es === undefined || typeof es === "string" || es === true)) {
      const { regex, ...rest } = o;
      delete rest.expect_serial;
      return { step: { expect_serial: { regex }, ...rest }, note: `moved "regex" inside expect_serial: {"expect_serial": {"regex": ${JSON.stringify(regex)}}}${typeof es === "string" ? ` (the text ${JSON.stringify(es)} was dropped: the regex decides)` : ""}` };
    }
  }
  return { step: raw };
}

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
  const obj = normalizeScenarioStep(raw).step as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => k in STEP_KINDS) as StepKind[];
  if (keys.length !== 1) {
    const list = Object.keys(STEP_KINDS).join(", ");
    return {
      ok: false,
      issues: [
        {
          path,
          message:
            keys.length === 0
              ? `no action key found (got keys: ${Object.keys(obj).join(", ") || "none"}); use exactly one of: ${list}${"pattern" in obj || "contains" in obj ? `. Fix: serial checks are {"expect_serial": "text"} or {"expect_serial": {"regex": "..."}}` : ""}`
              : `has ${keys.length} action keys (${keys.join(", ")}); split it into one step per action`,
        },
      ],
    };
  }
  const kind = keys[0]!;
  const res = STEP_KINDS[kind].safeParse(obj);
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
    const pb = (step as { preceded_by?: z.infer<typeof PrecededBySchema> }).preceded_by;
    if (pb) {
      const events = (["said", "serial", "capture", "request"] as const).filter((k) => pb[k] !== undefined);
      if (events.length !== 1) return { ok: false, issues: [{ path: `${path}.preceded_by`, message: `needs exactly one of said, serial, capture, request (got ${events.length ? events.join(", ") : "none"}); e.g. {"preceded_by": {"said": "picture", "min_ms": 9000, "max_ms": 11000}}` }] };
      if (pb.min_ms !== undefined && pb.max_ms !== undefined && pb.min_ms > pb.max_ms) return { ok: false, issues: [{ path: `${path}.preceded_by`, message: `min_ms ${pb.min_ms} is more than max_ms ${pb.max_ms}; swap them` }] };
      for (const k of ["said", "serial"] as const) {
        const m = pb[k];
        if (m && typeof m === "object" && "regex" in m) {
          try {
            new RegExp(m.regex, "i");
          } catch (err) {
            return { ok: false, issues: [{ path: `${path}.preceded_by.${k}.regex`, message: `invalid regular expression: ${(err as Error).message}` }] };
          }
        }
      }
    }
    if (kind === "said") {
      const m = (step as z.infer<typeof SaidStepSchema>).said;
      if (typeof m === "object" && "regex" in m) {
        try {
          new RegExp(m.regex, "i");
        } catch (err) {
          return { ok: false, issues: [{ path: `${path}.said.regex`, message: `invalid regular expression: ${(err as Error).message}` }] };
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
      if (i.code === "unrecognized_keys") {
        const bad = (i as { keys?: string[] }).keys ?? [];
        message = `unknown field(s) ${bad.map((k) => `'${k}'`).join(", ")} for a ${kind} step`;
        const allowed = Object.keys((STEP_KINDS[kind] as unknown as { shape: Record<string, unknown> }).shape);
        message += ` (allowed: ${allowed.join(", ")})`;
        if (kind === "expect_serial" && bad.some((k) => /^(pattern|regexp?|re|match)$/i.test(k))) message += `. Fix: put the pattern inside expect_serial: {"expect_serial": {"regex": "..."}}`;
        if (kind === "expect_serial" && bad.some((k) => /^(op|value)$/.test(k))) message += `. Fix: to compare a printed number use {"expect_serial_value": "energy", "op": ">=", "value": 60}`;
        if (kind === "expect_part" && bad.includes("level")) message += `. Fix: pin levels use {"expect_pin": "uno.D13", "level": "high"}`;
      }
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
    seed: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Round 14: seed of the board's hardware random numbers (esp_random, random()) for this test; the default is fixed per scenario id, so 'random' firmware repeats every run. Change it to try another sequence."),
    clock: z
      .string()
      .refine((v) => !Number.isNaN(Date.parse(v)), "must be a date-time such as 2026-12-24T09:00:00Z")
      .optional()
      .describe("Round 14: the date and time NTP gives the device at the start of this test (advancing with virtual time). Default: this computer's clock."),
  })
  .catchall(z.unknown())
  .superRefine((s, ctx) => {
    s.steps.forEach((raw, i) => {
      const r = parseScenarioStep(raw, `steps[${i}]`);
      if (!r.ok) for (const issue of r.issues) ctx.addIssue({ code: "custom", path: [], message: `${issue.path}: ${issue.message}` });
    });
  });

export type Scenario = z.infer<typeof ScenarioSchema>;
