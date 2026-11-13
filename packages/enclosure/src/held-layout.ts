/**
 * Round 15: held objects in the layout (see held.ts): the synthetic parts, the sleeve walls that
 * keep the electronics and their wires out of the object's room, and the checks (room, opening,
 * walls, a sensor that must sit next to the object).
 */
import type { HeldObject } from "@jumper/project-format";
import { DEFAULT_CLEARANCE_MM, heldFrom, heldProblems, heldSize, heldSpec, isHeldMech, measureText, SLEEVE_WALL_MM, type HeldReport } from "./held.ts";
import type { LayoutInput, Opening, Placed, Rib } from "./layout.ts";
import { contains, rayExit, type Plan } from "./plan.ts";
import type { FitCheck, Vec3 } from "./types.ts";

const MIN_WALL = 1.2;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The input with each valid held object added as a part, its placement facing the side it goes in through. */
export function withHeld(input: LayoutInput): LayoutInput {
  const held = (input.enclosure.held ?? []).filter((h) => !heldProblems(h).length);
  if (!held.length) return input;
  const placements = { ...(input.enclosure.placements ?? {}) };
  for (const h of held) {
    const pl = placements[h.id] ?? {};
    if (!pl.face) placements[h.id] = { ...pl, face: h.removable === false ? "inside" : heldFrom(h) };
  }
  const ids = new Set(input.parts.map((p) => p.id));
  const parts = [...input.parts, ...held.filter((h) => !ids.has(h.id)).map((h) => ({ id: h.id, type: heldSpec(h).id, spec: heldSpec(h) }))];
  return { parts, enclosure: { ...input.enclosure, placements } };
}

interface Box {
  min: Vec3;
  max: Vec3;
}

const overlaps = (a: Box, b: Box, g = 0) => a.min[0] < b.max[0] + g && b.min[0] < a.max[0] + g && a.min[1] < b.max[1] + g && b.min[1] < a.max[1] + g && a.min[2] < b.max[2] + g && b.min[2] < a.max[2] + g;

export interface SleeveContext {
  placed: Placed[];
  openings: Opening[];
  ribs: Rib[];
  zFront: number;
  zBack: number;
  split: number;
  tol: number;
  plan: Plan;
  intrusion: (z0: number, z1: number) => number;
  issues: FitCheck[];
  held?: HeldObject[];
  wall?: number;
  /** The cavity's round-over at the front / back face (a pocket's rim must stay on the flat). */
  ri?: number;
  riBack?: number;
  /** Part ids → body boxes, for sensors that must sit next to an object. */
}

/**
 * Sleeve walls round each held object (on the sides that do not face the outline's own wall or its
 * opening), the held-object checks, and one report entry per object.
 */
export function sleeveFor(c: SleeveContext): HeldReport[] {
  const out: HeldReport[] = [];
  const T = SLEEVE_WALL_MM;
  for (const h of c.held ?? []) for (const m of heldProblems(h)) c.issues.push({ id: "held-object", ok: false, severity: "error", message: m, parts: [h.id] });
  for (const p of c.placed) {
    if (!isHeldMech(p.mech)) continue;
    const h = (c.held ?? []).find((x) => x.id === p.mech.id);
    if (!h) continue;
    const sz = heldSize(h);
    const room: Box = { min: p.min, max: p.max };
    const open = c.openings.find((o) => o.part === p.mech.id && o.feature === "access");
    const others = c.placed.filter((q) => q !== p);
    const clash = others.filter((q) => overlaps(room, q, -0.01));
    if (clash.length) c.issues.push({ id: "held-object", ok: false, severity: "error", message: `${h.name ?? h.id}'s room overlaps ${clash.map((q) => q.mech.id).join(", ")}. Why: a part was pinned into it. Fix: remove that part's placements so Jumper packs it elsewhere, or make the case bigger.`, parts: [h.id, ...clash.map((q) => q.mech.id)] });
    // ---- the sleeve: a wall on each side that faces the inside of the case
    const made: string[] = [];
    const skipped: string[] = [];
    const sides: { name: string; axis: 0 | 1 | 2; dir: -1 | 1 }[] = [
      { name: "left", axis: 0, dir: -1 },
      { name: "right", axis: 0, dir: 1 },
      { name: "bottom", axis: 1, dir: -1 },
      { name: "top", axis: 1, dir: 1 },
      { name: "back", axis: 2, dir: -1 },
      { name: "front", axis: 2, dir: 1 },
    ];
    for (const sd of sides) {
      if (open && open.face === sd.name) continue; // its way in
      const min: Vec3 = [room.min[0] - T, room.min[1] - T, room.min[2]];
      const max: Vec3 = [room.max[0] + T, room.max[1] + T, room.max[2]];
      if (sd.axis === 2) {
        // a plate in front of / behind it, unless it lies against that face of the case
        if (sd.dir < 0 ? room.min[2] <= c.zBack + 0.5 : room.max[2] >= c.zFront - 0.5) continue;
        min[2] = sd.dir < 0 ? room.min[2] - T : room.max[2];
        max[2] = sd.dir < 0 ? room.min[2] : room.max[2] + T;
      } else {
        // against the outline's own wall here: the wall is the sleeve
        const mid: [number, number] = [(room.min[0] + room.max[0]) / 2, (room.min[1] + room.max[1]) / 2];
        const edge = sd.dir < 0 ? room.min[sd.axis]! : room.max[sd.axis]!;
        const probe: [number, number] = [...mid];
        probe[sd.axis] = edge + sd.dir * (T + 0.6);
        if (!contains(c.plan, probe[0], probe[1], c.intrusion(room.min[2], room.max[2]))) continue;
        min[sd.axis] = sd.dir < 0 ? edge - T : edge;
        max[sd.axis] = sd.dir < 0 ? edge : edge + T;
        // the full depth of the case where it is free (a partition from wall to wall), else the object's own
        const full: Box = { min: [min[0], min[1], c.zBack], max: [max[0], max[1], c.zFront] };
        if (!others.some((q) => overlaps(full, q, 0.2))) {
          min[2] = c.zBack;
          max[2] = c.zFront;
        }
      }
      const box: Box = { min, max };
      const blocker = others.find((q) => overlaps(box, q, 0.2));
      if (blocker) {
        skipped.push(`${sd.name} (${blocker.mech.id} is in the way)`);
        continue;
      }
      // each piece belongs to one shell: split at the seam, a little clear of it
      const pieces: { z0: number; z1: number; shell: "front" | "back" }[] = [];
      if (min[2] < c.split - c.tol) pieces.push({ z0: min[2], z1: Math.min(max[2], c.split - c.tol / 2), shell: "back" });
      if (max[2] > c.split + c.tol) pieces.push({ z0: Math.max(min[2], c.split + c.tol / 2), z1: max[2], shell: "front" });
      for (const pc of pieces) {
        if (pc.z1 - pc.z0 < 0.6) continue;
        // a plate floats unless it is in the shell whose walls reach its height
        c.ribs.push({ min: [min[0], min[1], pc.z0], max: [max[0], max[1], pc.z1], shell: pc.shell, why: `sleeve for ${h.id}`, part: h.id, kind: "guide" });
      }
      made.push(sd.name);
    }
    if (skipped.length) c.issues.push({ id: "held-object", ok: true, severity: "warning", message: `${h.name ?? h.id} has no sleeve wall on the ${skipped.join(", ")}: there is no ${T} mm of free room between it and that part. Why: wires could reach the object's room there and the object rests on the part. Fix: more wiring room (params.gap_mm 2), or let Jumper place that part (remove its placements).`, parts: [h.id] });
    // ---- the walls round the room and the rim round the opening
    const wall = c.wall ?? MIN_WALL;
    let rim = Infinity;
    if (open && (open.face === "front" || open.face === "back")) {
      const cx = open.at[0];
      const cy = open.at[1];
      for (let a = 0; a < 360; a += 10) {
        const ux = Math.cos((a * Math.PI) / 180);
        const uy = Math.sin((a * Math.PI) / 180);
        const half = open.shape === "round" ? open.u / 2 : Math.min(Math.abs(open.u / 2 / (ux || 1e-9)), Math.abs(open.v / 2 / (uy || 1e-9)));
        // the flat of the face ends where the rim's round-over starts
        rim = Math.min(rim, rayExit(c.plan, cx, cy, ux, uy) - (open.face === "back" ? (c.riBack ?? 0) : (c.ri ?? 0)) - half + wall);
      }
    } else if (open) {
      // a slot through a side: what is left above and below it, to the front and back faces
      rim = Math.min((c.zFront - c.zBack - open.v) / 2 + wall, wall + 1e9);
    }
    const thinnest = Math.min(wall, made.length ? T : wall, rim);
    if (Number.isFinite(rim) && rim < MIN_WALL) c.issues.push({ id: "held-object", ok: false, severity: "error", message: `The opening for ${h.name ?? h.id} leaves only ${r1(rim)} mm of shell round it on the ${open!.face}. Why: the object is nearly as big as the case there, so the rim would break or not print. Fix: ${open!.face === "back" || open!.face === "front" ? `less rounded rims (params edge_radius_${open!.face}_mm 2, dome_${open!.face === "back" ? "back_" : ""}mm 0) so the ${open!.face} stays flat round the opening, or ` : ""}a bigger case (size_mm), or a smaller clearance_mm; FDM needs ${MIN_WALL} mm or more.`, parts: [h.id] });
    // ---- a sensor that must sit next to it (a reed / Hall switch for the lid's magnet)
    if (h.sensor) {
      const sp = c.placed.find((q) => q.mech.id === h.sensor!.part);
      const max = h.sensor.max_mm ?? 8;
      if (!sp) c.issues.push({ id: "held-sensor", ok: false, severity: "warning", message: `${h.name ?? h.id}'s sensor "${h.sensor.part}" is not in the case. Why: there is no such part, or it is excluded. Fix: place it (place_part {"type": "reed-switch", "id": "${h.sensor.part}"}) or correct enclosure.held[].sensor.part.`, parts: [h.id] });
      else {
        const gap = sensorGap({ min: sp.bodyMin, max: sp.bodyMax }, room);
        const side = (["left", "right", "bottom", "top"] as const).map((n, i) => ({ n, d: i % 2 ? sp.bodyMin[i >> 1]! - room.max[i >> 1]! : room.min[i >> 1]! - sp.bodyMax[i >> 1]! })).sort((a, b) => b.d - a.d)[0]!.n;
        if (gap > max) c.issues.push({ id: "held-sensor", ok: false, severity: "warning", message: `${sp.mech.id} is ${r1(gap)} mm from ${h.name ?? h.id}, farther than the ${max} mm it can sense across. Why: the packer put it where it fit best (on the object's ${side} side, too far). Fix: pin it against the object with placements, e.g. {"${sp.mech.id}": {"layer": ${sp.layer}}} and x_mm / y_mm next to the object's edge, or use a stronger magnet and raise sensor.max_mm.`, parts: [sp.mech.id, h.id], facts: { gap_mm: r1(gap), max_mm: max } });
        else c.issues.push({ id: "held-sensor", ok: true, severity: "info", message: `${sp.mech.id} sits ${r1(gap)} mm from ${h.name ?? h.id} (within ${max} mm): it can sense it.`, parts: [sp.mech.id, h.id], facts: { gap_mm: r1(gap), max_mm: max } });
      }
    }
    const opening = open ? { w: r1(open.u), h: r1(open.shape === "round" ? open.u : open.v), shape: open.shape } : undefined;
    const lip = h.insert === "snap" ? (h.lip_mm ?? 0.6) : 0;
    const from = heldFrom(h);
    c.issues.push({
      id: "held-object",
      ok: true,
      severity: "info",
      message: `${h.name ?? h.id} (${sz.text}): a room of ${r1(sz.room.w)} x ${r1(sz.room.h)} x ${r1(sz.room.d)} mm with ${sz.clearance} mm all round; ${h.removable === false ? "it goes in during assembly and stays (no opening)" : `it goes in through ${h.insert === "slide" ? "a slot" : "an opening"} of ${opening!.w} x ${opening!.h} mm on the ${from}${lip ? `, its rim ${lip} mm over the object each side (it snaps in: PETG or PLA flexes that much; test-print the rim)` : ""}`}; no part or wire in its room${made.length ? `, sleeve walls on the ${made.join(", ")}` : ""}; thinnest wall round it ${r1(thinnest)} mm.`,
      parts: [h.id],
      facts: { room_w: r1(sz.room.w), room_h: r1(sz.room.h), room_d: r1(sz.room.d), clearance_mm: sz.clearance, wall_mm: r1(thinnest) },
    });
    out.push({
      id: h.id,
      name: h.name ?? h.id,
      shape: h.shape,
      insert: h.insert,
      from,
      removable: h.removable !== false,
      object_mm: sz.object,
      clearance_mm: sz.clearance ?? DEFAULT_CLEARANCE_MM,
      room_mm: { w: r1(sz.room.w), h: r1(sz.room.h), d: r1(sz.room.d) },
      ...(opening && h.removable !== false ? { opening_mm: opening } : {}),
      wall_mm: r1(thinnest),
      sleeve: made,
      source: h.source ?? "declared in jumper.json enclosure.held",
      measure: measureText(h),
      min: room.min,
      max: room.max,
    });
  }
  return out;
}

/** Round 15: a sensor (reed, Hall switch) that must sit next to a held object (its lid's magnet): how far its body is from the object's room. */
export function sensorGap(sensor: Box, room: Box): number {
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const g = Math.max(room.min[k]! - sensor.max[k]!, sensor.min[k]! - room.max[k]!, 0);
    d2 += g * g;
  }
  return Math.sqrt(d2);
}
