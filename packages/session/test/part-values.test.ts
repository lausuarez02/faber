// Round 6b: values (resistance, capacitance, chip variant, ...) everywhere a factory looks: BOM.md,
// BOM.csv, the KiCad netlist's value field and WIRING.md.
import { describe, expect, it } from "vitest";
import { registry } from "@jumper/parts";
import type { Project } from "@jumper/project-format";
import { engValue, partValue, wiringMarkdown } from "../src/exporter.ts";
import { bomCsv, bomLines, bomMd, kicadNetlist } from "../src/manufacturing.ts";

const project: Project = {
  name: "Values",
  board: "seeed-xiao-rp2040",
  parts: [
    { id: "xiao", type: "seeed-xiao-rp2040", x: 0, y: 0 },
    { id: "rtop", type: "resistor", x: 0, y: 0, props: { resistance: 100000 } },
    { id: "rbot", type: "resistor", x: 0, y: 0, props: { resistance: 100000 } },
    { id: "rled", type: "resistor", x: 0, y: 0, props: { resistance: 4700 } },
    { id: "ldo", type: "ldo-regulator", x: 0, y: 0, props: { variant: "AP2112K-3.3" } },
    { id: "bat", type: "lipo-battery", x: 0, y: 0, props: { capacity: 500 } },
  ],
  wires: [{ id: "w1", from: { part: "rtop", pin: "1" }, to: { part: "rbot", pin: "1" } }],
  scenarios: [],
} as unknown as Project;

describe("part values", () => {
  it("formats values the way they are written on parts", () => {
    expect(engValue(100000)).toBe("100k");
    expect(engValue(4700)).toBe("4.7k");
    expect(engValue(220)).toBe("220");
    expect(engValue(1e6)).toBe("1M");
    expect(engValue(1e-6)).toBe("1u");
    expect(engValue(1e-7)).toBe("100n");
  });
  it("reads them from the props (or the part's default)", () => {
    const v = (id: string) => partValue(project.parts.find((p) => p.id === id)!, registry);
    expect(v("rtop")).toBe("100k");
    expect(v("rled")).toBe("4.7k");
    expect(v("ldo")).toBe("AP2112K-3.3");
    expect(v("bat")).toBe("500mAh");
    expect(v("xiao")).toBeUndefined();
    expect(partValue({ id: "r", type: "resistor", x: 0, y: 0 } as never, registry)).toBe("220");
  });
  it("puts them in BOM.md, BOM.csv, the KiCad netlist and WIRING.md", () => {
    const lines = bomLines(project, registry, { soldered: true, cuts: [] });
    const md = bomMd(lines, "Values");
    expect(md).toMatch(/\| rtop rbot \| 2 \| Resistor \| 100k \|/);
    expect(md).toMatch(/\| rled \| 1 \| Resistor \| 4\.7k \|/);
    expect(md).not.toContain("value as in the BOM");
    expect(bomCsv(lines).split("\n")[0]).toContain("name,value,mpn");
    expect(bomCsv(lines)).toContain(",100k,");
    const net = kicadNetlist(project, registry);
    expect(net).toMatch(/\(ref "rtop"\)\n\s+\(value "100k"\)/);
    expect(net).toMatch(/\(ref "ldo"\)\n\s+\(value "AP2112K-3.3"\)/);
    const wiring = wiringMarkdown(project, registry);
    expect(wiring).toContain("| rtop | Resistor | 100k |");
    expect(wiring).toContain("rtop [100k].1");
  });
});
