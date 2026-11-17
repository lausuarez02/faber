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
  it("copies jumper.* and jumper:* keys to their faber names", () => {
    const s = memory({ "jumper.theme": "light", "jumper:kit:region": "eu", other: "x" });
    expect(migrateLegacyStorage(s).sort()).toEqual(["faber.theme", "faber:kit:region"]);
    expect(s.getItem("faber.theme")).toBe("light");
    expect(s.getItem("faber:kit:region")).toBe("eu");
    expect(s.getItem("jumper.theme")).toBe("light"); // left in place (an older build may still read it)
  });

  it("never overwrites a setting made under the new name", () => {
    const s = memory({ "jumper.theme": "light", "faber.theme": "dark" });
    expect(migrateLegacyStorage(s)).toEqual([]);
    expect(s.getItem("faber.theme")).toBe("dark");
  });
});
