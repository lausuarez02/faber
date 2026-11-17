// Round 6 (decision 0004, R1): the "mechanical" and "sourcing" blocks. The zod schema keeps them
// optional; this test makes them required where a case or a factory BOM needs them, and checks that
// every feature sits on the face it names, inside the part's box.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { partDefinitions } from "../index.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const NEED_MECH = new Set(["board", "display", "input", "sensor", "power", "output", "communication"]);

function exampleTypes(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "fabwright.json") for (const part of (JSON.parse(readFileSync(p, "utf8")) as { parts: { type: string }[] }).parts) out.add(part.type);
    }
  };
  walk(join(ROOT, "examples"));
  return out;
}

describe("mechanical data (R1)", () => {
  const used = exampleTypes();

  it("every part used by a shipped example in a case-relevant category has a mechanical block", () => {
    const missing = partDefinitions.filter((d) => used.has(d.spec.id) && NEED_MECH.has(d.spec.category) && !d.spec.mechanical).map((d) => d.spec.id);
    expect(missing, `add "mechanical" to ${missing.join(", ")} (docs/part-spec.md, "Mechanical and sourcing")`).toEqual([]);
  });

  it("every shipped part says what to buy in plain words (sourcing.generic)", () => {
    const missing = partDefinitions.filter((d) => !d.spec.sourcing?.generic).map((d) => d.spec.id);
    expect(missing, `add sourcing.generic to ${missing.join(", ")}`).toEqual([]);
  });

  it.each(partDefinitions.filter((d) => d.spec.mechanical).map((d) => [d.spec.id, d] as const))("%s: features sit on their face inside the box", (id, def) => {
    const { w, h, d } = def.spec.dimensions_mm!;
    const m = def.spec.mechanical!;
    const ids = new Set<string>();
    const eps = 0.01;
    for (const f of m.features ?? []) {
      expect(ids.has(f.id), `${id}: duplicate feature id ${f.id}`).toBe(false);
      ids.add(f.id);
      if (f.face === "+x") expect(f.x, `${id}.${f.id} on +x must have x = w`).toBeCloseTo(w, 2);
      if (f.face === "-x") expect(f.x, `${id}.${f.id} on -x must have x = 0`).toBeCloseTo(0, 2);
      if (f.face === "+y") expect(f.y, `${id}.${f.id} on +y must have y = h`).toBeCloseTo(h, 2);
      if (f.face === "-y") expect(f.y, `${id}.${f.id} on -y must have y = 0`).toBeCloseTo(0, 2);
      if (!f.face.endsWith("z")) expect(f.z, `${id}.${f.id}: side faces need z (height of the centre)`).toBeDefined();
      expect(f.x, `${id}.${f.id}.x`).toBeGreaterThanOrEqual(-eps);
      expect(f.x, `${id}.${f.id}.x`).toBeLessThanOrEqual(w + eps);
      expect(f.y, `${id}.${f.id}.y`).toBeGreaterThanOrEqual(-eps);
      expect(f.y, `${id}.${f.id}.y`).toBeLessThanOrEqual(h + eps);
      if (f.z !== undefined) expect(f.z, `${id}.${f.id}.z`).toBeLessThanOrEqual(d + eps);
      const size = f.shape === "round" ? f.d : f.w;
      expect(size ?? f.d, `${id}.${f.id}: a size (w / h, or d for round)`).toBeDefined();
    }
    for (const hole of m.mounting_holes ?? []) {
      expect(hole.x, `${id} hole x`).toBeGreaterThan(0);
      expect(hole.x, `${id} hole x`).toBeLessThan(w);
      expect(hole.y, `${id} hole y`).toBeGreaterThan(0);
      expect(hole.y, `${id} hole y`).toBeLessThan(h);
    }
    for (const p of m.outline_parts ?? []) {
      if (p.shape === "rect") {
        expect(p.x + p.w, `${id} outline rect`).toBeLessThanOrEqual(w + eps);
        expect(p.y + p.h, `${id} outline rect`).toBeLessThanOrEqual(h + eps);
      } else {
        expect(p.x + p.d / 2, `${id} outline disc`).toBeLessThanOrEqual(w + 0.5);
        expect(p.y + p.d / 2, `${id} outline disc`).toBeLessThanOrEqual(h + 0.5);
      }
    }
  });

  it("LCSC numbers are only written with a source we checked (none guessed)", () => {
    // R1: unknown = omitted. When a number is added, add it here with where it was checked.
    const checked: Record<string, string> = {};
    for (const d of partDefinitions) if (d.spec.sourcing?.lcsc) expect(checked[d.spec.id], `${d.spec.id}: LCSC ${d.spec.sourcing.lcsc} has no recorded check`).toBe(d.spec.sourcing.lcsc);
  });

  it("soft cells never get mounting holes", () => {
    for (const d of partDefinitions.filter((p) => p.spec.mechanical?.soft)) expect(d.spec.mechanical!.mounting_holes ?? [], d.spec.id).toEqual([]);
  });
});
