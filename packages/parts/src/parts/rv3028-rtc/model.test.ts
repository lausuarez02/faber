import { describe, expect, it } from "vitest";
import { GROUND } from "@faber/sim-core";
import { registry } from "../../registry.gen.ts";
import { mount, need } from "../../lib/bench.ts";
import { formatTime, parseTime } from "../../lib/calendar.ts";
import { i2cWires, serialLines, unoBench } from "../../lib/firmwareBench.ts";
import { Rv3028 } from "./model.ts";

const def = need(registry.get("rv3028-rtc"), "rv3028-rtc");

/** What a Wire sketch does: write the register pointer, then read n bytes (one access). */
function readRegs(chip: Rv3028, from: number, n: number): number[] {
  chip.connect(false);
  chip.write(from);
  chip.stop();
  chip.connect(true);
  const out = Array.from({ length: n }, () => chip.read());
  chip.stop();
  return out;
}

function writeRegs(chip: Rv3028, from: number, bytes: number[]): void {
  chip.connect(false);
  chip.write(from);
  for (const b of bytes) chip.write(b);
  chip.stop();
}

describe("rv3028-rtc: registers (RV-3028-C7 application manual)", () => {
  it("counts BCD time and date from the start time, across new year", () => {
    let t = 0;
    const chip = new Rv3028(parseTime("2026-12-31T23:59:58")!, false, () => t);
    expect(readRegs(chip, 0, 7)).toEqual([0x58, 0x59, 0x23, 4, 0x31, 0x12, 0x26]); // a Thursday = 4
    t = 2500;
    expect(readRegs(chip, 0, 7)).toEqual([0x00, 0x00, 0x00, 5, 0x01, 0x01, 0x27]);
    expect(readRegs(chip, 0x28, 1)).toEqual([0x30]);
  });

  it("sets the time in one access, restarts the second, and keeps the weekday the sketch assigned", () => {
    let t = 1700;
    const chip = new Rv3028(parseTime("2026-01-01T00:00:00")!, true, () => t);
    expect(readRegs(chip, 0x0e, 1)[0]! & 1).toBe(1); // PORF after power-on
    writeRegs(chip, 0, [0x01, 0x02, 0x03, 0x00, 0x04, 0x05, 0x30]); // 2030-05-04 03:02:01, weekday 0
    expect(formatTime(chip.epoch())).toBe("2030-05-04 03:02:01");
    t = 2600;
    expect(formatTime(chip.epoch())).toBe("2030-05-04 03:02:01");
    t = 2700;
    expect(formatTime(chip.epoch())).toBe("2030-05-04 03:02:02");
    expect(readRegs(chip, 3, 1)).toEqual([0]);
    writeRegs(chip, 0x0e, [0x00]);
    expect(readRegs(chip, 0x0e, 1)[0]! & 1).toBe(0);
  });

  it("12-hour mode (Control 2 bit 1) and the address wrap at 0x3F", () => {
    const chip = new Rv3028(parseTime("2026-01-01T15:04:05")!, false, () => 0);
    writeRegs(chip, 0x10, [0x02]);
    expect(readRegs(chip, 2, 1)).toEqual([0x23]); // PM + 3
    expect(readRegs(chip, 0x3f, 2)[1]).toBe(0x05); // 0x3F then 0x00 (seconds)
  });

  it("keeps the UNIX counter apart from the calendar", () => {
    let t = 0;
    const chip = new Rv3028(parseTime("2026-01-01T00:00:00")!, false, () => t);
    writeRegs(chip, 0x1b, [0x00, 0x00, 0x00, 0x60]); // 0x60000000
    t = 3000;
    const u = readRegs(chip, 0x1b, 4);
    expect((u[0]! | (u[1]! << 8) | (u[2]! << 16) | (u[3]! << 24)) >>> 0).toBe(0x60000003);
    expect(formatTime(chip.epoch())).toBe("2026-01-01 00:00:03");
  });

  it("the backup switchover ships off; enabling it through the EEPROM interface sticks", () => {
    const chip = new Rv3028(parseTime("2026-01-01T00:00:00")!, false, () => 0);
    expect(chip.backupSwitchover).toBe("off");
    const cfg = readRegs(chip, 0x37, 1)[0]!;
    writeRegs(chip, 0x37, [(cfg & ~0x0c) | 0x0c]);
    writeRegs(chip, 0x27, [0x00]);
    writeRegs(chip, 0x27, [0x11]);
    expect(chip.backupSwitchover).toBe("level");
    expect(chip.eeprom[0x37]! & 0x0c).toBe(0x0c);
    writeRegs(chip, 0x25, [0x05, 0x42, 0x21]); // user EEPROM byte 5 = 0x42
    writeRegs(chip, 0x26, [0x00]);
    writeRegs(chip, 0x27, [0x22]);
    expect(readRegs(chip, 0x26, 1)).toEqual([0x42]);
  });
});

describe("rv3028-rtc: the part", () => {
  const powered = (props: Record<string, string | number | boolean> = {}) => {
    const b = mount(def, { id: "rtc", props, wiring: { VCC: "v", GND: GROUND } });
    const r = b.solve((c) => c.voltageSource("v", GROUND, 3.3, 0.01, { id: "src" }));
    return { b, r };
  };

  it("draws 45 nA and shows the time", () => {
    const { b, r } = powered();
    // 45 nA at 5 V scaled to 3.3 V (about 30 nA), plus the solver's tiny leakage to ground
    const nA = r.current("src") * 1e9;
    expect(nA).toBeGreaterThan(25);
    expect(nA).toBeLessThan(40);
    expect(b.model.visualState()).toMatchObject({ time: "2026-01-01 12:00:00", clock: "12:00:00", running: true, backupSwitchover: "off", lostPower: false });
  });

  it("follows a set time (a scenario's clock / set_clock) across midnight", () => {
    const { b } = powered();
    b.model.interact!({ kind: "set", key: "time", value: "2026-11-13T23:59:59" });
    expect(b.model.visualState()).toMatchObject({ time: "2026-11-13 23:59:59" });
    let t = 0;
    const chip = new Rv3028(0, false, () => t);
    chip.setTime(parseTime("2026-11-13T23:59:59")!);
    t = 1000;
    expect(readRegs(chip, 0, 7)).toEqual([0x00, 0x00, 0x00, 6, 0x14, 0x11, 0x26]); // Saturday 14 Nov
  });

  it("says when the real chip would lose the time, and when it would charge its silver-oxide cell", () => {
    const { b } = powered();
    b.model.i2c!.i2cConnect(true, false);
    b.model.i2c!.i2cRead(false);
    b.model.i2c!.i2cStop();
    const off = b.model.diagnostics!().find((d) => d.code === "rtc-backup-switchover-off");
    expect(off?.message).toMatch(/would not keep the time.*Fix: once in setup\(\), write 0x37 with BSM = 11/);
    b.model.i2c!.i2cConnect(false, false);
    b.model.i2c!.i2cWrite(0x37);
    b.model.i2c!.i2cWrite(0x10 | 0x0c | 0x20);
    b.model.i2c!.i2cStop();
    const codes = b.model.diagnostics!().map((d) => d.code);
    expect(codes).toContain("rtc-trickle-charge-primary-cell");
    expect(codes).not.toContain("rtc-backup-switchover-off");
  });
});

describe("rv3028-rtc: real firmware (plain Wire, example.ino)", { timeout: 120_000 }, () => {
  it("prints the time every second", () => {
    const sim = unoBench({ parts: [{ id: "rv", type: "rv3028-rtc", x: 0, y: 0 }], wires: i2cWires("rv"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(2100);
    expect(serialLines(sim)).toEqual(["2026-01-01 12:00:00", "2026-01-01 12:00:01", "2026-01-01 12:00:02"]);
  });

  it("after a power loss it sets the time and turns the backup switchover on, so the warning goes", () => {
    const sim = unoBench({ parts: [{ id: "rv", type: "rv3028-rtc", x: 0, y: 0, props: { lostPower: true } }], wires: i2cWires("rv"), hex: "./example.hex", base: import.meta.url });
    sim.runFor(1100);
    const lines = serialLines(sim);
    expect(lines[0]).toBe("RTC lost power, setting the time");
    expect(lines[1]).toBe("2030-05-04 03:02:01");
    expect(sim.partState("rv")).toMatchObject({ lostPower: false, backupSwitchover: "level", trickleCharge: false });
    expect(sim.diagnostics().some((d) => d.code === "rtc-backup-switchover-off")).toBe(false);
  });
});
