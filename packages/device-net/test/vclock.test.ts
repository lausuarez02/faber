// The gateway clock on the simulation's virtual time: sleeps wait for virtual time, not wall time,
// and the log's t_ms is virtual once a simulation drives it.
import { describe, expect, it } from "vitest";
import { newVirtualTimeBuffer, sharedClock } from "../src/vclock.ts";

describe("virtual clock", () => {
  it("is wall time until driven, then sleeps until the simulation's time has passed", async () => {
    const sab = newVirtualTimeBuffer();
    const c = sharedClock(sab);
    expect(c.now()).toBeLessThan(50);
    const f = new Float64Array(sab);
    f[0] = 1000;
    expect(c.now()).toBe(1000);
    let done = false;
    const p = c.sleep(300).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false); // wall time passed, virtual time did not
    f[0] = 1200;
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    f[0] = 1300;
    await p;
    expect(done).toBe(true);
    // Undriven again: a pending sleep is released (no simulation to wait for).
    const q = c.sleep(10_000);
    f[0] = Number.NaN;
    await q;
  });
});
