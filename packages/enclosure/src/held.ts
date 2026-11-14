/**
 * Round 15: cases that hold a thing that is not electronics: a tin of mints or pouches, a lip balm,
 * a lighter, a card deck, a key. The person declares it in jumper.json enclosure.held (shape,
 * size, clearance, how it goes in) and the case engine treats it like a part with no pins: the
 * packer keeps every part out of its room, its side faces the wall it goes in through, the shell
 * gets an opening the size of the object (slide-in slot, drop-in pocket, snap pocket with a lip)
 * and a sleeve of thin walls separates it from the electronics and their wires. A removable object
 * is put in after the case is closed; a captive one is put in during assembly with no opening.
 *
 * The object is a "part" whose type starts with HELD_PREFIX: the BOM, the wiring and the
 * firmware never see it (it is not in project.parts).
 */
import type { CaseFace, HeldObject } from "@jumper/project-format";
import type { MechFeature, PartSpec } from "@jumper/sim-core";
import type { PartMech } from "./mech.ts";
import type { Vec3 } from "./types.ts";

export const HELD_PREFIX = "held:";
export const DEFAULT_CLEARANCE_MM = 0.5;
/** Round 17: a socket (engage_mm) slips on and off with less play; a press fit is tight. */
export const SOCKET_CLEARANCE_MM = 0.3;
export const PRESS_CLEARANCE_MM = 0.1;
export const SLEEVE_WALL_MM = 1.2;

export const isHeldType = (type: string) => type.startsWith(HELD_PREFIX);
export const isHeldMech = (m: Pick<PartMech, "type">) => isHeldType(m.type);

/** Round 17: the case's wall and fit tolerance, for depths measured from the outer face. */
export interface HeldCtx {
  wall: number;
  tol: number;
}
const CTX0: HeldCtx = { wall: 1.6, tol: 0.2 };

/** The resolved size of a held object and its room (object + clearance on every side), mm. */
export interface HeldSize {
  /** The object as declared (for the report and the kit). */
  object: { w: number; h: number; d: number };
  /**
   * The room the case keeps for it INSIDE the cavity: w (x) x h (y) x d (z, front to back). Round 17:
   * for an object that enters through the front or back, d is what is left behind the wall (the
   * opening through the wall is the rest), so the floor sits `depth` below the OUTER face.
   */
  room: { w: number; h: number; d: number };
  /** The room as the person thinks of it: depth along the way in measured from the outer face. */
  declared: { w: number; h: number; d: number };
  round: boolean;
  clearance: number;
  /** Round 17, front / back entry: floor depth below the outer face, mm. */
  depth?: number;
  /** Round 17: a socket (engage_mm): only part of the object goes in. */
  socket: boolean;
  /** Round 17: the object's length along the way in, mm. */
  along: number;
  /** In words: "cylinder 66 mm across, 21 mm tall, lying flat". */
  text: string;
}

/** How it goes in: round 17's fit "snap" is the snap pocket; default a pocket. */
export function heldInsert(h: HeldObject): "slide" | "pocket" | "snap" {
  if (h.fit === "snap") return "snap";
  return h.insert ?? "pocket";
}

/** Default insertion side: a slide goes in from the right, a pocket opens at the back. */
export function heldFrom(h: HeldObject): CaseFace {
  if (h.removable === false) return "back";
  return h.from ?? (heldInsert(h) === "slide" ? "right" : "back");
}

/** Clearance all round: as declared, else by fit (press 0.1, a socket 0.3, else 0.5). */
export function heldClearance(h: HeldObject): number {
  if (h.clearance_mm !== undefined) return h.clearance_mm;
  if (h.fit === "press") return PRESS_CLEARANCE_MM;
  return h.engage_mm !== undefined ? SOCKET_CLEARANCE_MM : DEFAULT_CLEARANCE_MM;
}

export function heldSize(h: HeldObject, ctx: HeldCtx = CTX0): HeldSize {
  const c = heldClearance(h);
  const s = h.size_mm;
  let object: HeldSize["object"];
  let round = false;
  let text: string;
  if (h.shape === "cylinder") {
    const D = s.d ?? 0;
    const H = s.h ?? 0;
    if (h.orientation === "upright") {
      object = { w: D, h: H, d: D };
      text = `cylinder ${D} mm across, ${H} mm tall, standing upright (its axis along the case's height)`;
    } else {
      object = { w: D, h: D, d: H };
      round = true;
      text = `cylinder ${D} mm across, ${H} mm tall, lying flat (round face to the front)`;
    }
  } else {
    object = { w: s.w ?? 0, h: s.h ?? 0, d: s.d ?? 0 };
    text = `${h.shape === "custom" ? "custom outline, room = its bounding box" : "box"} ${object.w} x ${object.h} x ${object.d} mm`;
  }
  const declared = { w: object.w + 2 * c, h: object.h + 2 * c, d: object.d + 2 * c };
  const from = heldFrom(h);
  const along = from === "front" || from === "back" ? object.d : from === "left" || from === "right" ? object.w : object.h;
  const socket = h.engage_mm !== undefined;
  const room = { ...declared };
  let depth: number | undefined;
  if (h.removable !== false && (from === "front" || from === "back")) {
    // round 17: measured from the OUTER face: the wall and the fit gap behind it are part of the depth
    depth = socket ? h.engage_mm! : declared.d;
    declared.d = depth;
    room.d = Math.max(0.6, depth - ctx.wall - ctx.tol);
    if (socket) text += `, ${h.engage_mm} mm of it in a socket`;
  }
  return { object, room, declared, round, clearance: c, ...(depth !== undefined ? { depth } : {}), socket, along, text };
}

/** Problems with a declaration, each with what is wrong, why and the fix. */
export function heldProblems(h: HeldObject, ctx: HeldCtx = CTX0): string[] {
  const out: string[] = [];
  const s = h.size_mm;
  const ex = h.shape === "cylinder" ? '{"d": 66, "h": 21}' : '{"w": 60, "h": 40, "d": 15}';
  if (h.shape === "cylinder" && !(s.d! > 0 && s.h! > 0)) out.push(`held object "${h.id}" is a cylinder but size_mm has no d (diameter) and h (height). Why: the case needs both to make its room. Fix: size_mm ${ex}, measured with calipers.`);
  if (h.shape !== "cylinder" && !(s.w! > 0 && s.h! > 0 && s.d! > 0)) out.push(`held object "${h.id}" (${h.shape}) needs size_mm w, h and d. Why: the case makes a room of that size. Fix: size_mm ${ex}, measured with calipers.`);
  const from = heldFrom(h);
  const ins = heldInsert(h);
  if (ins === "slide" && (from === "front" || from === "back")) out.push(`held object "${h.id}" slides in from the ${from}, but a slide goes in through a side (left, right, top, bottom). Why: from the ${from} it drops into a pocket. Fix: "insert": "pocket" (or "snap"), or "from": "right".`);
  if (h.fit === "snap" && h.insert === "slide") out.push(`held object "${h.id}" has fit "snap" and insert "slide". Why: a snap rim catches an object pushed straight in, not one slid sideways. Fix: "insert": "pocket" with "fit": "snap", or "fit": "slip" for the slot.`);
  if (h.engage_mm !== undefined) {
    const e = h.engage_mm;
    if (h.removable === false) out.push(`held object "${h.id}" has engage_mm (a socket) but removable false. Why: a socket holds an object that stays partly outside, so it cannot be shut inside. Fix: leave out engage_mm for a captive object, or removable true.`);
    if (from !== "front" && from !== "back") out.push(`held object "${h.id}" has engage_mm ${e} with from "${from}". Why: a socket is cut into the front or back face (the flat faces the depth is measured from); a side wall is curved and too thin. Fix: "from": "back" (the case sits on the object) or "front", or leave out engage_mm for a slot through the ${from}.`);
    else {
      const sz = heldSize({ ...h, engage_mm: undefined }, ctx);
      if (e >= sz.along) out.push(`held object "${h.id}" has engage_mm ${e}, but the object is only ${sz.along} mm long that way. Why: a socket holds part of it; all of it is a pocket. Fix: engage_mm under ${sz.along} (how deep the case goes over it), or leave engage_mm out for a full pocket.`);
      const min = Math.round((ctx.wall + ctx.tol + 0.6) * 10) / 10;
      if (e < min) out.push(`held object "${h.id}" has engage_mm ${e}, less than the ${min} mm a socket needs here. Why: the wall alone is ${ctx.wall} mm thick, so a shallower socket would only be a recess in it and would not hold the object. Fix: engage_mm ${min} or more, or a thinner wall (params.wall_mm).`);
    }
  }
  if (h.magnet && !h.sensor) out.push(`held object "${h.id}" has a magnet but no sensor. Why: the magnet is there for a reed or Hall switch in the case to see. Fix: "sensor": {"part": "<the switch's id>", "max_mm": 10}, or remove magnet.`);
  return out;
}

/** The part frame face (and feature centre) that looks toward the insertion side, with the object lying as the case frame expects. */
function accessFeature(h: HeldObject, sz: HeldSize): MechFeature {
  const f = accessFace(h, sz);
  return heldInsert(h) === "snap" ? { ...f, lip_mm: h.lip_mm ?? 0.6 } : f;
}

function accessFace(h: HeldObject, sz: HeldSize): MechFeature {
  const { w, h: hh, d } = sz.room;
  const from = heldFrom(h);
  const id = "access";
  const desc = `${h.name ?? h.id} goes in here`;
  switch (from) {
    case "front":
      return sz.round ? { id, kind: "access", face: "+z", x: w / 2, y: hh / 2, shape: "round", d: w, description: desc } : { id, kind: "access", face: "+z", x: w / 2, y: hh / 2, w, h: hh, description: desc };
    case "back":
      return sz.round ? { id, kind: "access", face: "-z", x: w / 2, y: hh / 2, shape: "round", d: w, description: desc } : { id, kind: "access", face: "-z", x: w / 2, y: hh / 2, w, h: hh, description: desc };
    case "right":
      return { id, kind: "access", face: "+x", x: w, y: hh / 2, z: d / 2, w: hh, h: d, description: desc };
    case "left":
      return { id, kind: "access", face: "-x", x: 0, y: hh / 2, z: d / 2, w: hh, h: d, description: desc };
    case "top":
      return { id, kind: "access", face: "-y", x: w / 2, y: 0, z: d / 2, w, h: d, description: desc };
    default:
      return { id, kind: "access", face: "+y", x: w / 2, y: hh, z: d / 2, w, h: d, description: desc };
  }
}

/** The held object as a part spec the layout packs (no pins, its room as the body). */
export function heldSpec(h: HeldObject, ctx: HeldCtx = CTX0): PartSpec {
  const sz = heldSize(h, ctx);
  const captive = h.removable === false;
  return {
    id: `${HELD_PREFIX}${h.id}`,
    name: h.name ?? h.id,
    category: "misc",
    description: `What the case holds: ${sz.text}.`,
    pins: [],
    size: { w: 10, h: 10 },
    dimensions_mm: { ...sz.room },
    mechanical: {
      outline: sz.round ? "round" : "rect",
      ...(captive ? {} : { features: [accessFeature(h, sz)] }),
      source: h.source ?? "declared in jumper.json enclosure.held (measure your own with calipers)",
    },
  };
}

export interface HeldReport {
  id: string;
  name: string;
  shape: HeldObject["shape"];
  insert: "slide" | "pocket" | "snap";
  /** Round 17: how it grips (slip, press, snap). */
  fit: "slip" | "press" | "snap";
  from: CaseFace;
  removable: boolean;
  object_mm: { w: number; h: number; d: number };
  clearance_mm: number;
  room_mm: { w: number; h: number; d: number };
  /**
   * Round 17, front / back entry, measured on the layout: how far below the OUTER face of the entry
   * wall the floor of the pocket / socket is, and how far the object stands out of it (negative =
   * sunk below the face).
   */
  depth_mm?: number;
  proud_mm?: number;
  /** Round 17: a socket (engage_mm): the case rides on the object. */
  engage_mm?: number;
  /** Round 17: a magnet on the object and the switch's gap to it, mounted and with the case lifted off. */
  sensing?: { sensor: string; mounted_mm: number; lifted_mm: number; lift_mm: number; lets_go_at_mm?: number; max_mm: number; release_mm?: number };
  /** The opening in the shell, mm (absent for a captive object). */
  opening_mm?: { w: number; h: number; shape: "rect" | "round" };
  /** Thinnest wall between the room and the outside / the electronics, mm. */
  wall_mm: number;
  /** Sleeve walls made (sides that face electronics). */
  sleeve: string[];
  /** Where the size came from. */
  source: string;
  /** What the person should check, in words (calipers, clearance). */
  measure: string;
  /** Where it sits in the case frame (box min / max). */
  min: Vec3;
  max: Vec3;
}

/** How to check a held object's size and what to change: for the report, the kit and the errors. */
export function measureText(h: HeldObject, ctx: HeldCtx = CTX0): string {
  const sz = heldSize(h, ctx);
  const c = sz.clearance;
  const dims = h.shape === "cylinder" ? `the diameter at the widest point (the lid's rim is often wider than the body) and the height with the lid on` : "the width, the height and the thickness at the widest points";
  const r = (v: number) => Math.round(v * 10) / 10;
  const sock = sz.socket ? ` The socket is ${h.engage_mm} mm deep from the outer face: measure how far the part it holds reaches (a lid's skirt) and set engage_mm a little under it, so the edge still comes free.` : "";
  return `Measure your own ${h.name ?? h.id} with calipers: ${dims}. The case leaves ${c} mm all round (${r(sz.declared.w)} x ${r(sz.declared.h)} x ${r(sz.declared.d)} mm of room${sz.depth !== undefined ? ", its depth measured from the outer face" : ""}).${sock} If yours is bigger, or the print comes out tight, raise clearance_mm (0.3 to 0.5 more for PETG or a tight printer) or put your measurement in size_mm, then design_case again; if it rattles, lower clearance_mm. Print a test ring of the opening first (2 mm tall) to check the fit in a few minutes.`;
}
