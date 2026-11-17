import { describe, expect, it } from "vitest";
import { migrateLegacyStorage } from "./legacyStorage.ts";

function memory(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

describe("pre-rename browser settings", () => {
  it("copies jumper.* and jumper:* keys to their fabwright names", () => {
    const s = memory({ "jumper.theme": "light", "jumper:kit:region": "eu", other: "x" });
    expect(migrateLegacyStorage(s).sort()).toEqual(["fabwright.theme", "fabwright:kit:region"]);
    expect(s.getItem("fabwright.theme")).toBe("light");
    expect(s.getItem("fabwright:kit:region")).toBe("eu");
    expect(s.getItem("jumper.theme")).toBe("light"); // left in place (an older build may still read it)
  });

  it("never overwrites a setting made under the new name", () => {
    const s = memory({ "jumper.theme": "light", "fabwright.theme": "dark" });
    expect(migrateLegacyStorage(s)).toEqual([]);
    expect(s.getItem("fabwright.theme")).toBe("dark");
  });
});
