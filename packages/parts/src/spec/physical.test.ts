// Round 5 (decision 0003, C2): every shipped part carries its physical data, which plan_device sums
// into a size, weight, battery-life and price estimate. The zod schema keeps the fields optional so
// a part can land first; this test is what makes them required for parts in this repo.
import { describe, expect, it } from "vitest";
import { partDefinitions } from "../index.ts";

describe("physical data (dimensions_mm, mass_g, current_ma, price_usd, buy_links)", () => {
  it.each(partDefinitions.map((d) => [d.spec.id, d] as const))("%s has all five fields with sane values", (id, def) => {
    const s = def.spec;
    const missing = (["dimensions_mm", "mass_g", "current_ma", "price_usd", "buy_links"] as const).filter((k) => s[k] === undefined);
    expect(missing, `${id}/part.json is missing ${missing.join(", ")}. Add them (docs/part-spec.md, "Physical data").`).toEqual([]);
    const { w, h, d } = s.dimensions_mm!;
    for (const [k, v] of Object.entries({ w, h, d })) expect(v, `${id} dimensions_mm.${k}`).toBeLessThan(1000);
    expect(s.mass_g!, `${id} mass_g`).toBeLessThan(5000);
    expect(s.current_ma!.max, `${id}: current_ma.max must be ≥ typ`).toBeGreaterThanOrEqual(s.current_ma!.typ);
    expect(s.price_usd!, `${id} price_usd`).toBeLessThan(500);
    expect(s.buy_links!.length, `${id}: at least one buy link`).toBeGreaterThan(0);
    for (const l of s.buy_links!) expect(() => new URL(l.url), `${id}: ${l.url}`).not.toThrow();
  });

  it("passive parts draw no supply current of their own", () => {
    for (const d of partDefinitions.filter((p) => p.spec.category === "passive")) {
      expect(d.spec.current_ma, d.spec.id).toEqual({ typ: 0, max: 0 });
    }
  });
});
