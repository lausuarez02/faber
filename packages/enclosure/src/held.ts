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
export const SLEEVE_WALL_MM = 1.2;

export const isHeldType = (type: string) => type.startsWith(HELD_PREFIX);
export const isHeldMech = (m: Pick<PartMech, "type">) => isHeldType(m.type);

/** The resolved size of a held object and its room (object + clearance on every side), mm. */
export interface HeldSize {
  /** The object as declared (for the report and the kit). */
  object: { w: number; h: number; d: number };
  /** The room the case leaves for it: w (x) x h (y) x d (z, front to back), clearance included. */
  room: { w: number; h: number; d: number };
  round: boolean;
  clearance: number;
  /** In words: "cylinder 66 mm across, 21 mm tall, lying flat". */
  text: string;
}

/** Default insertion side: a slide goes in from the right, a pocket opens at the back. */
export function heldFrom(h: HeldObject): CaseFace {
  if (h.removable === false) return "back";
  return h.from ?? (h.insert === "slide" ? "right" : "back");
}

export function heldSize(h: HeldObject): HeldSize {
  const c = h.clearance_mm ?? DEFAULT_CLEARANCE_MM;
  const s = h.size_mm;
  if (h.shape === "cylinder") {
    const D = s.d ?? 0;
    const H = s.h ?? 0;
    if (h.orientation === "upright") {
      return { object: { w: D, h: H, d: D }, room: { w: D + 2 * c, h: H + 2 * c, d: D + 2 * c }, round: false, clearance: c, text: `cylinder ${D} mm across, ${H} mm tall, standing upright (its axis along the case's height)` };
    }
    return { object: { w: D, h: D, d: H }, room: { w: D + 2 * c, h: D + 2 * c, d: H + 2 * c }, round: true, clearance: c, text: `cylinder ${D} mm across, ${H} mm tall, lying flat (round face to the front)` };
  }
  const w = s.w ?? 0;
  const hh = s.h ?? 0;
  const d = s.d ?? 0;
  return { object: { w, h: hh, d }, room: { w: w + 2 * c, h: hh + 2 * c, d: d + 2 * c }, round: false, clearance: c, text: `${h.shape === "custom" ? "custom outline, room = its bounding box" : "box"} ${w} x ${hh} x ${d} mm` };
}

/** Problems with a declaration, each with what is wrong, why and the fix. */
export function heldProblems(h: HeldObject): string[] {
  const out: string[] = [];
  const s = h.size_mm;
  const ex = h.shape === "cylinder" ? '{"d": 66, "h": 21}' : '{"w": 60, "h": 40, "d": 15}';
  if (h.shape === "cylinder" && !(s.d! > 0 && s.h! > 0)) out.push(`held object "${h.id}" is a cylinder but size_mm has no d (diameter) and h (height). Why: the case needs both to make its room. Fix: size_mm ${ex}, measured with calipers.`);
  if (h.shape !== "cylinder" && !(s.w! > 0 && s.h! > 0 && s.d! > 0)) out.push(`held object "${h.id}" (${h.shape}) needs size_mm w, h and d. Why: the case makes a room of that size. Fix: size_mm ${ex}, measured with calipers.`);
  const from = heldFrom(h);
  if (h.insert === "slide" && (from === "front" || from === "back")) out.push(`held object "${h.id}" slides in from the ${from}, but a slide goes in through a side (left, right, top, bottom). Why: from the ${from} it drops into a pocket. Fix: "insert": "pocket" (or "snap"), or "from": "right".`);
  return out;
}

/** The part frame face (and feature centre) that looks toward the insertion side, with the object lying as the case frame expects. */
function accessFeature(h: HeldObject, sz: HeldSize): MechFeature {
  const f = accessFace(h, sz);
  return h.insert === "snap" ? { ...f, lip_mm: h.lip_mm ?? 0.6 } : f;
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
export function heldSpec(h: HeldObject): PartSpec {
  const sz = heldSize(h);
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
  insert: HeldObject["insert"];
  from: CaseFace;
  removable: boolean;
  object_mm: { w: number; h: number; d: number };
  clearance_mm: number;
  room_mm: { w: number; h: number; d: number };
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
export function measureText(h: HeldObject): string {
  const sz = heldSize(h);
  const c = sz.clearance;
  const dims = h.shape === "cylinder" ? `the diameter at the widest point (the lid's rim is often wider than the body) and the height with the lid on` : "the width, the height and the thickness at the widest points";
  return `Measure your own ${h.name ?? h.id} with calipers: ${dims}. The case leaves ${c} mm all round (${sz.room.w} x ${sz.room.h} x ${sz.room.d} mm of room). If yours is bigger, or the print comes out tight, raise clearance_mm (0.3 to 0.5 more for PETG or a tight printer) or put your measurement in size_mm, then design_case again; if it rattles, lower clearance_mm. Print a test ring of the opening first (2 mm tall) to check the fit in a few minutes.`;
}
