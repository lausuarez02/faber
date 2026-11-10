// Round 6, track power (decision 0004, R2): check_design's power-path rules on the pocket Muse and
// on the ways a battery path goes wrong.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registry } from "@jumper/parts";
import { parseProject, type Project, type Wire } from "@jumper/project-format";
import { checkDesign } from "../src/drc.ts";

const MUSE = fileURLToPath(new URL("../../../examples/agent-built/claude-pocket-muse/jumper.json", import.meta.url));
const muse = (): Project => parseProject(JSON.parse(readFileSync(MUSE, "utf8")));
const codes = (p: Project) => checkDesign(p, registry).map((i) => `${i.severity}:${i.code}`);
const w = (id: string, a: string, b: string): Wire => {
  const [ap, an] = [a.slice(0, a.indexOf(".")), a.slice(a.indexOf(".") + 1)];
  const [bp, bn] = [b.slice(0, b.indexOf(".")), b.slice(b.indexOf(".") + 1)];
  return { id, from: { part: ap, pin: an }, to: { part: bp, pin: bn } };
};
/** The Muse without its new power path (switch + diode): the round-5 wiring. */
function round5(): Project {
  const p = muse();
  return { ...p, power: undefined, parts: p.parts.filter((x) => x.id !== "pwr" && x.id !== "d1"), wires: p.wires.filter((x) => !["w20", "w21", "w22"].includes(x.id)), scenarios: [] };
}

describe("check_design power path (round 6)", () => {
  it("the re-wired pocket Muse (cell → TP4056 → switch → Schottky → XIAO 5V) has 0 errors", () => {
    const issues = checkDesign(muse(), registry);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.map((i) => i.code)).not.toContain("parallel-regulators");
    expect(issues.map((i) => i.code)).not.toContain("usb-backfeed");
    // The XIAO's LDO behind a Schottky: says at which cell voltage 3V3 sags and where the board stops.
    const drop = issues.find((i) => i.code === "ldo-dropout")!;
    expect(drop.severity).toBe("warning");
    expect(drop.message).toMatch(/below a cell voltage of 3\.85 V the 3V3 rail falls under 3\.3 V/);
    expect(drop.message).toMatch(/stops .* at a cell voltage of about 3\.25 V/);
  });

  it("the round-5 wiring: no parallel-regulators false positive, the TP4056 IN is never sent to the board's 5V, and it says the battery powers nothing", () => {
    const issues = checkDesign(round5(), registry);
    const all = issues.map((i) => i.message).join("\n");
    expect(issues.map((i) => i.code)).not.toContain("parallel-regulators");
    expect(all).not.toMatch(/chg\.VIN → xiao\.5V|chg\.VIN → xiao\.VBUS|chg\.GND\.1 →/);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const npp = issues.find((i) => i.code === "no-power-path")!;
    expect(npp.severity).toBe("warning");
    expect(npp.message).toMatch(/chg\.OUT → slide-switch 2 \(COM\), slide-switch 1 → schottky-diode A, schottky-diode C \(stripe\) → xiao\.VBUS/);
  });

  it("USB unplugged with no battery path is an error (no-power-path)", () => {
    expect(codes({ ...round5(), power: { usb: false } })).toContain("error:no-power-path");
  });

  it("charger OUT straight on VBUS is usb-backfeed (error), not parallel-regulators", () => {
    const p = round5();
    p.wires.push(w("wx", "chg.OUT", "xiao.VBUS"));
    const c = codes(p);
    expect(c).toContain("error:usb-backfeed");
    expect(c).not.toContain("warning:parallel-regulators");
    const msg = checkDesign(p, registry).find((i) => i.code === "usb-backfeed")!.message;
    expect(msg).toMatch(/schottky-diode between them: A on the battery side, C \(stripe\) on xiao\.VBUS/);
  });

  it("a switch alone does not stop back-feeding; a diode does", () => {
    const p = muse();
    p.wires = p.wires.filter((x) => !["w21", "w22"].includes(x.id));
    p.wires.push(w("wx", "pwr.1", "xiao.VBUS"));
    expect(codes(p)).toContain("error:usb-backfeed");
  });

  it("a diode turned the wrong way blocks the battery (diode-reversed, no-power-path)", () => {
    const p = muse();
    p.wires = p.wires.filter((x) => !["w21", "w22"].includes(x.id));
    p.wires.push(w("wa", "pwr.1", "d1.C"), w("wb", "d1.A", "xiao.VBUS"));
    const c = codes(p);
    expect(c).toContain("warning:diode-reversed");
    expect(c).toContain("error:no-power-path");
  });

  it("battery reversed: NEG on the charger's B+ is battery-reversed", () => {
    const p = muse();
    p.wires = p.wires.map((x) => (x.id === "w17" ? w("w17", "bat.NEG", "chg.BAT") : x.id === "w18" ? w("w18", "bat.POS", "chg.GND.2") : x));
    const issues = checkDesign(p, registry);
    expect(issues.map((i) => i.code)).toContain("battery-reversed");
    expect(issues.find((i) => i.code === "battery-reversed")!.message).toMatch(/swap its two wires/);
  });

  it("a 4.2 V cell straight on the XIAO's 3V3 pin is battery-overvoltage", () => {
    const p = round5();
    p.wires.push(w("wx", "chg.OUT", "xiao.3V3"));
    const i = checkDesign(p, registry).find((x) => x.code === "battery-overvoltage")!;
    expect(i.severity).toBe("error");
    expect(i.message).toMatch(/xiao\.3V3 takes at most 3\.4 V, but bat puts up to 4\.2 V on it/);
  });

  it("a Pico on VSYS needs no diode and has no LDO dropout", () => {
    const p = parseProject({
      format: "jumper/1",
      name: "pico-cell",
      parts: [
        { id: "pico", type: "raspberry-pi-pico", x: 0, y: 0 },
        { id: "bat", type: "lipo-battery", x: 300, y: 0 },
        { id: "chg", type: "tp4056-charger", x: 300, y: 200 },
      ],
      wires: [w("w1", "bat.POS", "chg.BAT"), w("w2", "bat.NEG", "chg.GND.2"), w("w3", "chg.OUT", "pico.VSYS"), w("w4", "chg.GND.3", "pico.GND.1")],
      power: { usb: false },
    });
    const c = codes(p);
    expect(c.filter((x) => x.startsWith("error:"))).toEqual([]);
    expect(c.join()).not.toMatch(/usb-backfeed|ldo-dropout|no-power-path|parallel-regulators/);
  });
});
