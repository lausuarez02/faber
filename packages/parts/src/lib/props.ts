import type { PropValue } from "@jumper/project-format";

/** Read a numeric prop, falling back when missing or not a finite number. */
export function num(v: PropValue | undefined, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Read a string prop. */
export function str(v: PropValue | undefined, fallback: string): string {
  return typeof v === "string" && v !== "" ? v : fallback;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Round for visual state so tiny solver noise does not churn the DOM. */
export function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Truthy prop/interaction value: true, 1, "1", "true", "on". */
export function truthy(v: PropValue | undefined): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return ["1", "true", "on", "yes", "pressed", "closed"].includes(v.toLowerCase());
  return false;
}
