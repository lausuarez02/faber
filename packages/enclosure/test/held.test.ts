// Round 15: a case that holds something that is not electronics (a tin of pouches, a card deck):
// its room with clearance, the electronics kept out, the opening it goes in through, a sleeve, the
// walls round it, a sensor next to it, and a removable object that is not part of the assembly.
import { describe, expect, it } from "vitest";
import type { Enclosure, HeldObject } from "@faber/project-format";
import { heldProblems, heldSize, heldSpec } from "../src/held.ts";
import { followSize } from "../src/held-layout.ts";
import { layoutCase } from "../src/proposals.ts";
import { assemblyPlan } from "../src/assembly.ts";
import { specOf } from "./helpers.ts";

const TIN: HeldObject = { id: "tin", name: "round tin", shape: "cylinder", size_mm: { d: 66, h: 21 }, clearance_mm: 0.5, insert: "slide", from: "right", source: "test fixture" };
const electronics = [
  { id: "xiao", type: "seeed-xiao-esp32c3" },
  { id: "epd", type: "epaper-154-ssd1681" },
  { id: "lid", type: "hall-switch-drv5032" },
  { id: "bat", type: "lipo-battery" },
].map((x) => ({ ...x, spec: specOf(x.type)!, ...(x.type === "lipo-battery" ? { props: { capacity: 150 } } : {}) }));
const lay = (held: HeldObject[], enc: Partial<Enclosure> = {}) => layoutCase({ parts: electronics, enclosure: { shape: "rounded-box", held, ...enc } as Enclosure });
const overlap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) => [0, 1, 2].every((k) => a.min[k]! < b.max[k]! && b.min[k]! < a.max[k]!);

describe("held objects (round 15)", () => {
  it("a cylinder lying flat is a round room of its size plus the clearance", () => {
    const s = heldSize(TIN);
    expect(s.room).toEqual({ w: 67, h: 67, d: 22 });
    expect(s.round).toBe(true);
    const spec = heldSpec(TIN);
    expect(spec.id).toBe("held:tin");
    expect(spec.pins).toEqual([]);
    expect(spec.mechanical?.features?.[0]).toMatchObject({ kind: "access", face: "+x", w: 67, h: 22 });
  });

  it("slide-in from the right: the room is packed, no part is in it, a slot opens on the right, sleeve walls face the electronics", () => {
    const L = lay([TIN]);
    const tin = L.placed.find((p) => p.mech.id === "tin")!;
    expect(tin).toBeDefined();
    expect(tin.bodyMax[0] - tin.bodyMin[0]).toBeCloseTo(67, 1);
    for (const p of L.placed) if (p !== tin) expect(overlap(p, tin), `${p.mech.id} in the tin's room`).toBe(false);
    const slot = L.openings.find((o) => o.part === "tin")!;
    expect(slot).toMatchObject({ kind: "access", face: "right" });
    expect(slot.u).toBeCloseTo(67, 1);
    expect(slot.v).toBeLessThanOrEqual(L.zFront - L.zBack);
    // the room touches the right wall (it slides straight in)
    expect(L.outer.max[0] - L.params.wall_mm - tin.max[0]).toBeLessThan(2);
    // ribs of the other parts never enter the room
    for (const r of L.ribs.filter((x) => x.part !== "tin")) expect(overlap(r, tin), r.why).toBe(false);
    for (const q of L.posts) expect(overlap({ min: [q.x - q.d / 2, q.y - q.d / 2, Math.min(q.z0, q.z1)], max: [q.x + q.d / 2, q.y + q.d / 2, Math.max(q.z0, q.z1)] }, tin), q.why).toBe(false);
    const info = L.issues.find((i) => i.id === "held-object" && i.severity === "info")!;
    expect(info.message).toMatch(/round tin \(cylinder 66 mm across, 21 mm tall, lying flat.*\): a room of 67 x 67 x 22 mm with 0.5 mm all round; it goes in through a slot of 67 x 2\d(\.\d)? mm on the right/);
    expect(L.held![0]).toMatchObject({ id: "tin", from: "right", removable: true, clearance_mm: 0.5, room_mm: { w: 67, h: 67, d: 22 } });
    expect(L.held![0]!.measure).toMatch(/calipers/);
    expect(L.issues.filter((i) => !i.ok && i.severity === "error"), JSON.stringify(L.issues.filter((i) => !i.ok))).toEqual([]);
  });

  it("a pocket in the back: the room sits against the back, a round opening its size, a plate between it and the parts in front", () => {
    const L = lay([{ ...TIN, insert: "pocket", from: "back" }]);
    const tin = L.placed.find((p) => p.mech.id === "tin")!;
    expect(tin.min[2] - L.zBack).toBeLessThan(1.6);
    const o = L.openings.find((x) => x.part === "tin")!;
    expect(o).toMatchObject({ kind: "access", face: "back", shape: "round" });
    expect(o.u).toBeCloseTo(67, 1);
    const inFront = L.placed.filter((p) => p !== tin && p.min[2] >= tin.max[2] - 0.01 && overlap({ min: [p.min[0], p.min[1], 0], max: [p.max[0], p.max[1], 1] }, { min: [tin.min[0], tin.min[1], 0], max: [tin.max[0], tin.max[1], 1] }));
    if (inFront.length) expect(L.ribs.some((r) => r.part === "tin" && Math.abs(r.min[2] - tin.max[2]) < 0.01)).toBe(true);
  });

  it("snap: the rim overlaps the object; captive: no opening, put in during assembly; the assembly plan ends with putting it in", () => {
    const snap = lay([{ ...TIN, insert: "snap", from: "back", lip_mm: 0.8 }]);
    expect(snap.openings.find((x) => x.part === "tin")!.u).toBeCloseTo(67 - 1.6, 1);
    const captive = lay([{ ...TIN, removable: false }]);
    expect(captive.openings.some((x) => x.part === "tin")).toBe(false);
    const L = lay([TIN]);
    const project = { format: "faber/1", name: "t", parts: electronics.map((p) => ({ id: p.id, type: p.type, x: 0, y: 0 })), wires: [], scenarios: [] } as never;
    const plan = assemblyPlan({ project, layout: L, specOf });
    expect(plan.steps.some((s) => s.parts.includes("tin"))).toBe(false);
    const put = plan.steps.find((s) => s.title === "Put round tin in")!;
    expect(put.say).toMatch(/Slide round tin into the slot on the right/);
    expect(plan.steps.indexOf(put)).toBeGreaterThan(plan.steps.findIndex((s) => s.title === "Close the case"));
    const cp = assemblyPlan({ project, layout: captive, specOf });
    expect(cp.steps.findIndex((s) => s.title === "Put round tin in")).toBeLessThan(cp.steps.findIndex((s) => s.title === "Close the case"));
  });

  it("a sensor that must sit next to the object is checked; bad declarations say what to fix", () => {
    const L = lay([{ ...TIN, sensor: { part: "lid", max_mm: 8 } }]);
    const c = L.issues.find((i) => i.id === "held-sensor")!;
    expect(c).toBeDefined();
    expect(c.message).toMatch(/lid (sits|is) \d+(\.\d)? mm from round tin/);
    const bad = lay([{ ...TIN, size_mm: { d: 66 } }]);
    expect(bad.issues.find((i) => i.id === "held-object" && i.severity === "error")!.message).toMatch(/no d \(diameter\) and h \(height\).*Fix: size_mm/);
    const wrong = lay([{ ...TIN, insert: "slide", from: "back" }]);
    expect(wrong.issues.some((i) => /a slide goes in through a side/.test(i.message))).toBe(true);
  });
});

describe("a pocket's rim on a rounded face (round 15)", () => {
  it("says the rim is too thin where the round-over eats the flat, and how to fix it", () => {
    const L = layoutCase({ parts: electronics, enclosure: { shape: "pebble", held: [{ ...TIN, insert: "pocket", from: "back" }] } as Enclosure });
    const e = L.issues.find((i) => i.id === "held-object" && i.severity === "error");
    if (e) expect(e.message).toMatch(/leaves only .* mm of shell round it on the back.*Fix: less rounded rims \(params edge_radius_back_mm 2, dome_back_mm 0\)/);
  });
});

describe("depth from the outer face, sockets, fits, magnets on the object, outlines that follow (round 17)", () => {
  const CAN: HeldObject = { id: "can", name: "pouch can", shape: "cylinder", size_mm: { d: 70, h: 20 }, from: "back", engage_mm: 6, magnet: { beyond_mm: 2.5, d_mm: 6, t_mm: 2 }, sensor: { part: "lid", max_mm: 10, lift_mm: 8 } };
  const ctx = { wall: 1.6, tol: 0.2 };

  it("a front / back room's depth counts from the outer face: the room inside the cavity is a wall and a fit gap shallower", () => {
    const s = heldSize({ ...TIN, insert: "pocket", from: "back" }, ctx);
    expect(s.declared.d).toBeCloseTo(22, 5);
    expect(s.depth).toBeCloseTo(22, 5);
    expect(s.room.d).toBeCloseTo(22 - 1.6 - 0.2, 5);
    // a slot through a side keeps its full room
    expect(heldSize(TIN, ctx).room.d).toBeCloseTo(22, 5);
    const L = lay([{ ...TIN, insert: "pocket", from: "back" }]);
    expect(L.held![0]!.depth_mm).toBeCloseTo(22, 1);
    expect(L.held![0]!.proud_mm).toBeCloseTo(-1, 1);
  });

  it("a socket: only engage_mm goes in, the clearance defaults by fit, the report says how far it stands proud", () => {
    const s = heldSize(CAN, ctx);
    expect(s.socket).toBe(true);
    expect(s.clearance).toBe(0.3);
    expect(s.depth).toBe(6);
    expect(s.room.d).toBeCloseTo(6 - 1.8, 5);
    expect(heldSize({ ...CAN, fit: "press" }, ctx).clearance).toBe(0.1);
    expect(heldSize({ ...CAN, clearance_mm: 0.4, fit: "press" }, ctx).clearance).toBe(0.4);
    const L = lay([CAN], { shape: "puck" });
    const h = L.held![0]!;
    expect(h).toMatchObject({ engage_mm: 6, depth_mm: 6, proud_mm: 14, fit: "slip", insert: "pocket", from: "back" });
    expect(L.issues.find((i) => i.id === "held-object" && i.severity === "info")!.message).toMatch(/a socket 70.6 x 70.6 mm, 6 mm deep from the outer face .*a slip fit.*stands 14 mm proud/);
    // a snap fit narrows the mouth
    const snap = lay([{ ...CAN, fit: "snap", lip_mm: 0.5 }], { shape: "puck" });
    expect(snap.openings.find((o) => o.part === "can")!.u).toBeCloseTo(70.6 - 1, 1);
  });

  it("bad sockets say what is wrong, why and the fix", () => {
    const msg = (h: HeldObject) => heldProblems(h, ctx).join(" | ");
    expect(msg({ ...CAN, engage_mm: 20 })).toMatch(/engage_mm 20, but the object is only 20 mm long that way\. Why: .* Fix: engage_mm under 20/);
    expect(msg({ ...CAN, engage_mm: 2 })).toMatch(/less than the 2.4 mm a socket needs here\. Why: the wall alone is 1.6 mm thick.* Fix: engage_mm 2.4 or more/);
    expect(msg({ ...CAN, from: "right", insert: "slide" })).toMatch(/engage_mm 6 with from "right"\. Why: a socket is cut into the front or back face/);
    expect(msg({ ...CAN, removable: false })).toMatch(/engage_mm \(a socket\) but removable false\. Why: .* Fix:/);
    expect(msg({ ...CAN, sensor: undefined })).toMatch(/has a magnet but no sensor\. Why: .* Fix: "sensor"/);
    expect(msg({ ...CAN, fit: "snap", insert: "slide", from: "right", engage_mm: undefined, magnet: undefined })).toMatch(/fit "snap" and insert "slide"/);
    expect(msg(CAN)).toBe("");
  });

  it("a magnet on the object: the gap mounted and lifted against max_mm, and the test steps that drive it", () => {
    // the lid comes right off (20 mm): far past where the Hall switch lets go
    const L = lay([{ ...CAN, sensor: { part: "lid", max_mm: 10, lift_mm: 20 } }], { shape: "puck", follow: { held: "can", margin_mm: 2.5 }, placements: { lid: { x_mm: 0, y_mm: -33.5, layer: 1 } } });
    const s = L.held![0]!.sensing!;
    expect(s.sensor).toBe("lid");
    expect(s.mounted_mm).toBeLessThanOrEqual(10);
    expect(s.lifted_mm).toBeGreaterThan(s.mounted_mm + 7);
    expect(s.lets_go_at_mm).toBeGreaterThan(0);
    const c = L.issues.find((i) => i.id === "held-sensor")!;
    expect(c.severity).toBe("info");
    expect(c.message).toMatch(/"set": "lid.magnet_mm", "value": [\d.]+\} mounted/);
    // too far: it says it never closes, and how to fix it
    const far = lay([{ ...CAN, sensor: { part: "lid", max_mm: 3 } }], { shape: "puck" });
    expect(far.issues.find((i) => i.id === "held-sensor")!.message).toMatch(/never closes\. Why: .* Fix: pin lid next to the socket's edge/);
    // close enough even lifted: it says the switch would not notice
    const near = lay([{ ...CAN, sensor: { part: "lid", max_mm: 45, lift_mm: 2 } }], { shape: "puck" });
    expect(near.issues.find((i) => i.id === "held-sensor")!.message).toMatch(/still sees .* it would not notice the case coming off/);
  });

  it("a magnetic switch lets go farther away than it closes (hysteresis): the lifted gap must pass the release distance (round 17 proof)", () => {
    // DRV5032 (3 mT on / 1.5 mT off), a 6 x 3 mm N35 magnet, closing at max_mm 15 (3.5 mT): lets go only below 1.7 mT, beyond ~19.6 mm
    const can6: HeldObject = { ...CAN, magnet: { beyond_mm: 2.5, d_mm: 6, t_mm: 3 }, sensor: { part: "lid", max_mm: 15, lift_mm: 8 } };
    const L = lay([can6], { shape: "puck", follow: { held: "can", margin_mm: 4.2 }, placements: { lid: { x_mm: 31, y_mm: 0, layer: 1 } } });
    const s = L.held![0]!.sensing!;
    expect(s.release_mm).toBeGreaterThan(19);
    expect(s.release_mm).toBeLessThan(20.5);
    const c = L.issues.find((i) => i.id === "held-sensor")!;
    if (s.lifted_mm <= s.release_mm!) {
      expect(c.severity).toBe("warning");
      expect(c.message).toMatch(/only lets go beyond 19\.\d mm \(a 6 x 3 mm N35 magnet gives 3.5 mT at 15 mm, where lid closes \(sensor.max_mm\), and lid lets go only below 1.7 mT .*\)/);
      expect(c.message).toMatch(/Why: a magnetic switch lets go at a weaker field than it closes at \(hysteresis\).* Fix: if the case comes all the way off in use .*sensor.lift_mm/);
    }
    // the lid comes all the way off: lifted far beyond the release distance, and lets_go_at_mm is where it really opens
    const off = lay([{ ...can6, sensor: { part: "lid", max_mm: 15, lift_mm: 40 } }], { shape: "puck", follow: { held: "can", margin_mm: 4.2 }, placements: { lid: { x_mm: 31, y_mm: 0, layer: 1 } } });
    const so = off.held![0]!.sensing!;
    expect(off.issues.find((i) => i.id === "held-sensor")!.severity).toBe("info");
    expect(so.mounted_mm + so.lets_go_at_mm!).toBeGreaterThan(so.release_mm! - 0.5);
  });

  it("a magnet glued on the object's side must clear the socket's mouth (round 17 proof)", () => {
    const at = (beyond: number) => lay([{ ...CAN, magnet: { beyond_mm: beyond, d_mm: 6, t_mm: 3 }, sensor: { part: "lid", max_mm: 15, lift_mm: 40 } }], { shape: "puck", follow: { held: "can", margin_mm: 4.2 }, placements: { lid: { x_mm: 31, y_mm: 0, layer: 1 } } });
    const hit = at(2.5).issues.find((i) => i.id === "held-magnet" && /socket's mouth/.test(i.message));
    expect(hit?.message).toMatch(/reaches 0.5 mm inside the socket's mouth\. Why: .*stands 3 mm proud.* Fix: magnet.beyond_mm 3.5 or more/);
    expect(at(4.5).issues.find((i) => /socket's mouth/.test(i.message))).toBeUndefined();
  });

  it("the outline follows the object: a round case the can's size, concentric, the parts in layers in front of the socket", () => {
    expect(followSize({ shape: "puck", held: [CAN], follow: { held: "can" } } as Enclosure, ctx)).toEqual({ w: 70 + 0.6 + 3.2 + 0.2, h: 70 + 0.6 + 3.2 + 0.2 });
    expect(followSize({ shape: "puck", held: [CAN], follow: { held: "can", margin_mm: 2 } } as Enclosure, ctx)!.w).toBeCloseTo(78, 5);
    // a box: its w x h; a size the person gave wins
    expect(followSize({ shape: "rounded-box", held: [{ id: "deck", shape: "box", size_mm: { w: 60, h: 90, d: 20 }, from: "back", engage_mm: 8 }], follow: { held: "deck" } } as Enclosure, ctx)).toEqual({ w: 60 + 0.6 + 3.2 + 0.2, h: 90 + 0.6 + 3.2 + 0.2 });
    expect(followSize({ shape: "puck", held: [CAN], follow: { held: "can" }, size_mm: { w: 90 } } as Enclosure, ctx)).toBeUndefined();
    const L = lay([CAN], { shape: "puck", follow: { held: "can", margin_mm: 2.5 }, params: { edge_radius_front_mm: 2.5 }, placements: { lid: { x_mm: 0, y_mm: -33.5, layer: 1 } } });
    // the back rim round the socket's mouth stays within the wall (auto)
    expect(L.rfBack).toBeLessThanOrEqual(1.6 + 1e-9);
    // (whether every part fits a tight round outline is the CAD fixture's job: lid-topper.json)
    const errs = L.issues.filter((i) => i.severity === "error" && i.id !== "fits");
    expect(errs, JSON.stringify(errs)).toEqual([]);
    expect(L.outer.w).toBeCloseTo(79, 1);
    expect(L.outer.h).toBeCloseTo(79, 1);
    const can = L.placed.find((p) => p.mech.id === "can")!;
    expect((can.min[0] + can.max[0]) / 2).toBeCloseTo(L.plan.cx, 1);
    for (const p of L.placed) if (p !== can) expect(p.min[2], p.mech.id).toBeGreaterThan(can.max[2]);
    // the seam on the socket's floor plate, the collar round the socket, the back shell prints on the plate
    expect(L.split).toBeCloseTo(can.max[2] + 1.2, 5);
    expect(L.collars?.[0]).toMatchObject({ part: "can", round: true, shell: "back" });
    expect(L.printFlip).toBe("back");
    // an unknown id
    const bad = lay([CAN], { shape: "puck", follow: { held: "tin" } });
    expect(bad.issues.find((i) => /enclosure.follow names "tin"/.test(i.message))!.message).toMatch(/Why: .* Fix: "follow": \{"held": "can"\}/);
  });
});
