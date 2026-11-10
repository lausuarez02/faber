import { describe, expect, it } from "vitest";
import { stableOrder } from "./order.ts";

describe("stable card order", () => {
  it("keeps the first order when the server re-sorts, new cards first", () => {
    const mem: string[] = [];
    const c = (id: string) => ({ id });
    expect(stableOrder([c("a"), c("b"), c("c")], mem).map((x) => x.id)).toEqual(["a", "b", "c"]);
    // Opening c made it the newest on the server.
    expect(stableOrder([c("c"), c("a"), c("b")], mem).map((x) => x.id)).toEqual(["a", "b", "c"]);
    // A new copy appears: it goes first, the rest stay put.
    expect(stableOrder([c("d"), c("b"), c("c"), c("a")], mem).map((x) => x.id)).toEqual(["d", "a", "b", "c"]);
    // A card that went away is just left out.
    expect(stableOrder([c("c"), c("d")], mem).map((x) => x.id)).toEqual(["d", "c"]);
  });
});
