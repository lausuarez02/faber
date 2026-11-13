// Round 15 proof (a pouch-tin case with a lid sensor): the shopping list missed the magnet the
// Hall / reed switch senses, so the agent had to add it by hand. Any part with a magnet_d_mm prop
// now brings its magnet, with the size and grade the design was checked with.
import { describe, expect, it } from "vitest";
import type { Project } from "@jumper/project-format";
import { registry } from "@jumper/parts";
import { shoppingList } from "../src/kit/shopping.ts";

const project = (parts: Project["parts"]): Project => ({ format: "jumper/1", name: "lid", parts, wires: [], scenarios: [] }) as unknown as Project;
const shop = (p: Project) => shoppingList({ project: p, registry, soldered: true, cuts: [], region: "eu" });

describe("shopping list: magnets for magnet sensors (round 15)", () => {
  it("a Hall switch with a 6 x 2 mm N35 magnet gets that magnet", () => {
    const s = shop(project([{ id: "lid", type: "hall-switch-drv5032", x: 0, y: 0, rotation: 0, props: { magnet_d_mm: 6, magnet_t_mm: 2, magnet_grade: "N35" } }]));
    const m = s.lines.find((l) => l.id.startsWith("extra:magnet"));
    expect(m, JSON.stringify(s.lines.map((l) => l.id))).toBeDefined();
    expect(m!.qty).toBe(1);
    expect(m!.variant).toContain("6 mm across x 2 mm thick, N35");
    expect(m!.why).toContain("lid");
    expect(m!.links.some((k) => k.url.includes("amazon.de"))).toBe(true);
  });

  it("two reed switches with the default magnet share one line (qty 2); a part without the prop adds none", () => {
    const s = shop(project([
      { id: "a", type: "reed-switch", x: 0, y: 0, rotation: 0 },
      { id: "b", type: "reed-switch", x: 0, y: 0, rotation: 0 },
    ]));
    const m = s.lines.filter((l) => l.id.startsWith("extra:magnet"));
    expect(m).toHaveLength(1);
    expect(m[0]!.qty).toBe(2);
    expect(m[0]!.variant).toContain("6 mm across x 3 mm thick, N35");
    expect(shop(project([{ id: "b1", type: "pushbutton", x: 0, y: 0, rotation: 0 }])).lines.some((l) => l.id.startsWith("extra:magnet"))).toBe(false);
  });
});
