// The visual test report as the web app reads it (written by packages/session/src/visual-capture.ts;
// format "faber-visual-report/1"). Kept as plain types here because the web app does not depend
// on the Node session package.
import type { VisualState } from "@faber/sim-core";

export interface VisualInput {
  /** Exact virtual ms. */
  t: number;
  kind: "press" | "release" | "set" | "serial_write" | "inject_fault";
  part?: string;
  field?: string;
  value?: unknown;
  data?: unknown;
}

export interface DeviceSnapshot {
  displays?: Record<string, { type: string; state: VisualState }>;
  leds?: Record<string, { brightness: number; color?: string }>;
  buzzers?: Record<string, boolean>;
  buttons?: Record<string, boolean>;
  servos?: Record<string, number>;
  motors?: Record<string, number>;
  robot?: { x: number; y: number; heading: number; sonar_cm?: number; collisions?: number; min_clearance_cm?: number; travelled_cm?: number };
  arm?: { angles: number[]; end: { x: number; y: number }; reached: string[] };
  serial?: string;
}

export interface VisualFrame {
  step: number;
  kind: string;
  label: string;
  ok: boolean;
  t: number;
  value?: string;
  state: DeviceSnapshot;
}

export interface VisualScenario {
  id: string;
  name?: string;
  passed: boolean;
  t_ms: number;
  reason?: string;
  failed_step?: number;
  inputs: VisualInput[];
  frames: VisualFrame[];
  keyframes?: { t: number; state: DeviceSnapshot }[];
  replayable: boolean;
}

export interface VisualReport {
  format: "faber-visual-report/1";
  project: string;
  passed: number;
  failed: number;
  scenarios: VisualScenario[];
}

export function isVisualReport(x: unknown): x is VisualReport {
  // "jumper-visual-report/1": the same report saved before the rename from Jumper.
  const format = (x as { format?: unknown } | null)?.format;
  return typeof x === "object" && x !== null && (format === "faber-visual-report/1" || format === "jumper-visual-report/1") && Array.isArray((x as VisualReport).scenarios);
}
