import { describe, expect, it } from "vitest";
import { filterSerial } from "./serialFilter.ts";

const OUT = "boot\nlook x=3 y=1\nmood=love pets=1\nlook x=2 y=0\nMood=scared\nlook x=";

describe("Serial filter", () => {
  it("shows everything with an empty filter", () => {
    expect(filterSerial(OUT, "  ")).toBe(OUT);
  });
  it("shows lines with every word, any case", () => {
    expect(filterSerial(OUT, "mood")).toBe("mood=love pets=1\nMood=scared\n");
    expect(filterSerial(OUT, "mood love")).toBe("mood=love pets=1\n");
  });
  it("hides lines with -word, the line being written too", () => {
    expect(filterSerial(OUT, "-look")).toBe("boot\nmood=love pets=1\nMood=scared\n");
    expect(filterSerial(OUT, "x=")).toBe("look x=3 y=1\nlook x=2 y=0\nlook x=");
  });
});
