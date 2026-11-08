import { describe, expect, it } from "vitest";
import { Clock } from "./clock.ts";

describe("Clock", () => {
  it("converts cycles and ms", () => {
    const c = new Clock(16_000_000);
    expect(c.fromMs(1)).toBe(16_000);
    expect(c.toMs(8_000)).toBe(0.5);
    c.advance(c.fromMs(250));
    expect(c.cycles).toBe(4_000_000);
    expect(c.ms).toBe(250);
  });

  it("runs events in cycle order with stable ties", () => {
    const c = new Clock(1000);
    const log: string[] = [];
    c.schedule(30, () => log.push("c30"));
    c.schedule(10, () => log.push("a10"));
    c.schedule(10, () => log.push("b10"));
    c.schedule(20, (cy) => log.push(`x${cy}`));
    c.advanceTo(25);
    expect(log).toEqual(["a10", "b10", "x20"]);
    expect(c.cycles).toBe(25);
    c.advanceTo(30);
    expect(log.at(-1)).toBe("c30");
  });

  it("runs events scheduled from callbacks within the same advance, and supports cancel", () => {
    const c = new Clock(1000);
    const log: number[] = [];
    c.schedule(5, (cy) => {
      log.push(cy);
      c.scheduleIn(3, (cy2) => log.push(cy2));
    });
    const id = c.schedule(7, () => log.push(-1));
    expect(c.cancel(id)).toBe(true);
    expect(c.nextEventCycle()).toBe(5);
    c.advanceTo(100);
    expect(log).toEqual([5, 8]);
    expect(c.pendingEvents).toBe(0);
    expect(c.nextEventCycle()).toBeUndefined();
  });

  it("refuses to go backwards and resets", () => {
    const c = new Clock(1000);
    c.advance(10);
    expect(() => c.advanceTo(5)).toThrow(/backwards/);
    c.schedule(50, () => {});
    c.reset();
    expect(c.cycles).toBe(0);
    expect(c.pendingEvents).toBe(0);
  });
});
