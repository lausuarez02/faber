import { describe, expect, it } from "vitest";
import { runSummary } from "../src/index.ts";

// Round 6, switch track: the run summary people read ("ran 3000 ms (now 3000 ms)" was jargon).
describe("run summary", () => {
  it("says how long the device ran in seconds", () => {
    expect(runSummary(3000, 3000)).toBe("ran the device for 3 s");
    expect(runSummary(1200, 1200)).toBe("ran the device for 1.2 s");
    expect(runSummary(2000, 5000)).toBe("ran 2 s more (device clock at 5 s)");
    expect(runSummary(250, 12_345)).toBe("ran 0.3 s more (device clock at 12.3 s)");
  });
});
