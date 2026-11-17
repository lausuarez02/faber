// Round 12 fixtures: the talking egg a real Claude built (an SVG egg outline, 13 parts, inline
// resistors) and a puffy star (a concave custom outline).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@faber/project-format";

/** A puffy 5-point star (concave), as points through which a smooth curve runs (y up). */
export function starPoints(n = 5, R = 40, r = 22): [number, number][] {
  return Array.from({ length: 2 * n }, (_, i) => {
    const a = Math.PI / 2 + (i * Math.PI) / n;
    const rr = i % 2 ? r : R;
    return [Math.round(rr * Math.cos(a) * 10) / 10, Math.round(rr * Math.sin(a) * 10) / 10];
  });
}

export function egg(): Project {
  const p = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/talking-egg-2.json"), "utf8")) as Project;
  return { ...p, scenarios: [] };
}

