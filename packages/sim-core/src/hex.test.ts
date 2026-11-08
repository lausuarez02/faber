import { describe, expect, it } from "vitest";
import { parseIntelHex } from "./hex.ts";
import { applyVisualState, parseBindings } from "./bindings.ts";

describe("parseIntelHex", () => {
  it("parses data records and fills gaps with 0xFF", () => {
    const hex = [":0400000001020304F2", ":02000600AABB93", ":00000001FF"].join("\n");
    const img = parseIntelHex(hex);
    expect(Array.from(img)).toEqual([1, 2, 3, 4, 0xff, 0xff, 0xaa, 0xbb]);
  });
  it("rejects bad checksums", () => {
    expect(() => parseIntelHex(":0400000001020304F3")).toThrow(/checksum/);
  });
});

describe("bindings", () => {
  it("parses data-bind specs", () => {
    expect(parseBindings("opacity:brightness, fill:color")).toEqual([
      { attr: "opacity", key: "brightness" },
      { attr: "fill", key: "color" },
    ]);
    expect(() => parseBindings("opacity")).toThrow();
  });
  it("applies visual state to bound elements", () => {
    const attrs = new Map<string, string>([["data-bind", "opacity:brightness,visible:on,text:label"]]);
    const el = {
      textContent: "" as string | null,
      getAttribute: (n: string) => attrs.get(n) ?? null,
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      removeAttribute: (n: string) => void attrs.delete(n),
    };
    applyVisualState({ querySelectorAll: () => [el] }, { brightness: 0.5, on: false, label: "hi" });
    expect(attrs.get("opacity")).toBe("0.5");
    expect(attrs.get("display")).toBe("none");
    expect(el.textContent).toBe("hi");
    applyVisualState({ querySelectorAll: () => [el] }, { on: true });
    expect(attrs.has("display")).toBe(false);
  });
});
