import { describe, expect, it } from "vitest";
import { routeWire, type RouteBox, type RoutePoint } from "./route.ts";

function crossesBox(pts: RoutePoint[], b: RouteBox): boolean {
  for (let i = 2; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const c = pts[i]!;
    const x0 = Math.min(a.x, c.x);
    const x1 = Math.max(a.x, c.x);
    const y0 = Math.min(a.y, c.y);
    const y1 = Math.max(a.y, c.y);
    if (x1 > b.x + 1 && x0 < b.x + b.w - 1 && y1 > b.y + 1 && y0 < b.y + b.h - 1) return true;
  }
  return false;
}

describe("routeWire", () => {
  it("leaves a top pin upwards instead of cutting through its own part", () => {
    const oled = { id: "oled", x: 0, y: 0, w: 200, h: 160 };
    const uno = { id: "uno", x: 0, y: 300, w: 500, h: 380 };
    const pts = routeWire({ x: 100, y: 10 }, { x: 300, y: 312 }, [oled, uno], "oled", "uno");
    expect(pts[1]!.y).toBeLessThan(0);
    expect(crossesBox(pts, oled)).toBe(false);
    expect(crossesBox(pts, uno)).toBe(false);
  });

  it("goes around a part that sits between the two pins", () => {
    const a = { id: "a", x: 0, y: 0, w: 40, h: 40 };
    const wall = { id: "wall", x: 100, y: -200, w: 60, h: 440 };
    const b = { id: "b", x: 260, y: 0, w: 40, h: 40 };
    const pts = routeWire({ x: 40, y: 20 }, { x: 260, y: 20 }, [a, wall, b], "a", "b");
    expect(crossesBox(pts, wall)).toBe(false);
    expect(pts[0]).toEqual({ x: 40, y: 20 });
    expect(pts.at(-1)).toEqual({ x: 260, y: 20 });
  });

  it("keeps a straight wire straight when nothing is in the way", () => {
    const pts = routeWire({ x: 40, y: 20 }, { x: 260, y: 20 }, [{ id: "a", x: 0, y: 0, w: 40, h: 40 }, { id: "b", x: 260, y: 0, w: 40, h: 40 }], "a", "b");
    expect(pts).toHaveLength(2);
  });
});
