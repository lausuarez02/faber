/**
 * Round 12: mounting is designed, not assumed. For every part in a layout this works out which
 * shell holds it, how it goes in (dropped, pressed onto pins, slid sideways into its opening) and
 * what keeps it there, and adds the printable features that are missing:
 *
 * - flat parts: locator ribs round the body (round 6 made them only against a wall), seat posts
 *   when the part floats above its wall, standoff pins in mounting holes (round 6), and hold-down
 *   posts from the other shell that stop it lifting (ending clear of its keep-out, so they never
 *   press on components);
 * - parts on a side wall (USB, buttons, switches): a backstop behind them (plugging a cable in or
 *   pressing a button pushes the part inwards) and guides beside them;
 * - a LiPo cell: its cradle (round 6) with two strap slots for a Kapton strap, or corner locators
 *   where a full cradle does not fit, on a foam pad.
 *
 * Every feature is placed only in free room (never into another part's envelope, never into the
 * rim round-over), in FDM-friendly sizes (ribs 1.2 mm, posts 2.4 to 3 mm, printed with the shell
 * open side up, so no supports). What cannot be made is said (foam tape or glue, and the room a
 * rib would need), and the assembly plan's checks report it.
 */
import { apply, type Mat3 } from "./mech.ts";
import type { Opening, Placed, Post, Rib } from "./layout.ts";
import type { Vec3 } from "./types.ts";

export type MountHow =
  | "window-ledge" // the front wall round the window holds the screen's bezel
  | "standoffs" // pins of the case in the part's mounting holes
  | "locators" // ribs round the body (x / y)
  | "seat-posts" // the part rests on posts above its wall
  | "wall" // it rests on the shell's wall
  | "hold-down" // posts from the other shell stop it lifting
  | "neighbour" // the part next to it in depth holds it (within 1 mm)
  | "backstop" // a rib behind a side part takes the push of a plug or a finger
  | "guides" // ribs beside a side part
  | "opening" // its port, button or lever sits in its opening
  | "cradle" // a cell in its cradle
  | "corners" // corner locators round a cell
  | "strap" // a strap (Kapton tape) through the cradle's slots
  | "foam-tape" // double-sided foam tape (no feature fits)
  | "foam-pad"; // a foam pad under a cell

export interface Mount {
  part: string;
  /** The shell it goes into when the case is assembled (open side up on the bench). */
  shell: "front" | "back";
  how: MountHow[];
  /** How it goes in: dropped in, pressed onto pins, or slid sideways so a lever goes through its hole. */
  insert: "drop" | "press" | "slide";
  /** For a slide: direction it moves at the end (case frame), how far it must move and how far it can. */
  slide?: { dir: Vec3; need_mm: number; have_mm: number; opening: string };
  /** The feature ids added for it (rib / post / cradle why strings). */
  features: string[];
  /** Plain words: how it is held. */
  say: string;
  /** What could not be made, with the room it needed (the plan's checks report it). */
  missing?: string;
}

interface Box {
  min: Vec3;
  max: Vec3;
}

export interface MountContext {
  placed: Placed[];
  openings: Opening[];
  ribs: Rib[];
  posts: Post[];
  cradles: { part: string; min: Vec3; max: Vec3; wall: number; h: number; slots?: Box[] }[];
  zFront: number;
  zBack: number;
  split: number;
  tol: number;
  /** Not overlapping any part but `ignore` (g mm clear, default 0.3). */
  free(b: Box, ignore?: Placed, g?: number): boolean;
  /** Inside the cavity's plan at the box's depth (the rim round-over and the snap lip kept clear). */
  inside(b: Box): boolean;
  /** Inside the cavity at the box's depth, the lip ignored (a part going into the back shell before the front one is on). */
  cavity(b: Box): boolean;
}

const RIB = 1.2;
const SEAT_D = 2.4;
const HOLD_D = 3;

function overlaps(a: Box, b: Box, g = 0): boolean {
  for (let k = 0; k < 3; k++) if (!(a.min[k]! < b.max[k]! + g - 1e-9 && b.min[k]! < a.max[k]! + g - 1e-9)) return false;
  return true;
}

function xyOverlap(a: Box, b: Box, g = 0): boolean {
  return a.min[0] < b.max[0] + g - 1e-9 && b.min[0] < a.max[0] + g - 1e-9 && a.min[1] < b.max[1] + g - 1e-9 && b.min[1] < a.max[1] + g - 1e-9;
}

const env = (p: Placed): Box => ({ min: p.min, max: p.max });
const body = (p: Placed): Box => ({ min: p.bodyMin, max: p.bodyMax });

function facingZ(R: Mat3): number {
  return apply(R, [0, 0, 1])[2];
}

/** Which shell a part goes into, before the close check. */
function firstShell(p: Placed, c: MountContext, open?: Opening): "front" | "back" {
  if (p.bound?.face === "front") return "front";
  if (p.bound?.face === "back") return "back";
  if (p.mech.soft) return p.min[2] - c.zBack <= c.zFront - p.max[2] ? "back" : "front";
  // a lever / knob through a side hole: the shell whose wall has the hole (both: dropped into the back)
  if (open && p.bound?.feature.passThrough) {
    const half = Math.abs(open.vAxis[2]) > 0.5 ? open.v / 2 : open.u / 2;
    if (open.at[2] - half >= c.split) return "front";
    return "back";
  }
  const cz = (p.min[2] + p.max[2]) / 2;
  return cz > (c.zFront + c.zBack) / 2 ? "front" : "back";
}

/**
 * Shells for every part such that the case can close: the front shell comes down onto the back
 * one, so a part in the front shell may not sit behind (nearer the back than) a part of the back
 * shell it overlaps in plan. A part bound to neither wall moves to the other shell to fix it.
 */
export function assignShells(c: MountContext): { shells: Map<string, "front" | "back">; blocked: { front: string; back: string }[] } {
  const shells = new Map<string, "front" | "back">();
  for (const p of c.placed) shells.set(p.mech.id, firstShell(p, c, c.openings.find((o) => o.part === p.mech.id && o.kind !== "window" && o.kind !== "grille")));
  const fixed = (p: Placed) => p.bound?.face === "front" || p.bound?.face === "back" || (p.bound?.feature.passThrough ?? false);
  const blocked: { front: string; back: string }[] = [];
  for (let pass = 0; pass < c.placed.length + 1; pass++) {
    let changed = false;
    blocked.length = 0;
    for (const a of c.placed)
      for (const b of c.placed) {
        if (a === b || shells.get(a.mech.id) !== "front" || shells.get(b.mech.id) !== "back") continue;
        // a (front shell) entirely behind b (back shell), overlapping in plan: a would pass through b when closing
        if (!xyOverlap(env(a), env(b), -0.05) || a.max[2] > b.min[2] + 0.05) continue;
        if (!fixed(a)) {
          shells.set(a.mech.id, "back");
          changed = true;
        } else if (!fixed(b)) {
          shells.set(b.mech.id, "front");
          changed = true;
        } else blocked.push({ front: a.mech.id, back: b.mech.id });
      }
    if (!changed) break;
  }
  return { shells, blocked };
}

/** Adds the missing mounting features to c.ribs / c.posts / c.cradles and says how each part is held. */
export function designMounts(c: MountContext): Mount[] {
  const { shells } = assignShells(c);
  const out: Mount[] = [];
  const tol = c.tol;
  const zMid = (c.zFront + c.zBack) / 2;
  // features made here are obstacles for the next ones (two parts' posts never share a spot)
  const made: Box[] = [
    ...c.ribs.map((r) => ({ min: r.min, max: r.max })),
    ...c.posts.map((q) => ({ min: [q.x - q.d / 2, q.y - q.d / 2, q.z0] as Vec3, max: [q.x + q.d / 2, q.y + q.d / 2, q.z1] as Vec3 })),
    ...c.cradles.map((r) => ({ min: [r.min[0] - r.wall, r.min[1] - r.wall, r.min[2]] as Vec3, max: [r.max[0] + r.wall, r.max[1] + r.wall, r.max[2]] as Vec3 })),
  ];
  const insertBoxes: Box[] = c.openings.filter((o) => o.insert).map((o) => {
    const ins = o.insert!;
    const r = ins.flange_d / 2 + 0.3;
    const a = ins.base;
    const b: Vec3 = [a[0] + o.n[0] * ins.length, a[1] + o.n[1] * ins.length, a[2] + o.n[2] * ins.length];
    return { min: [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r], max: [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r] };
  });
  const clear = (b: Box, p: Placed, strictSelf = true) => c.free(b, p) && (!strictSelf || !overlaps(b, env(p), -0.01)) && !insertBoxes.some((x) => overlaps(x, b)) && !made.some((x) => overlaps(x, b, 0.2)) && c.inside(b);
  const colBox = (x: number, y: number, d: number, z0: number, z1: number): Box => ({ min: [x - d / 2, y - d / 2, Math.min(z0, z1)], max: [x + d / 2, y + d / 2, Math.max(z0, z1)] });

  for (const p of c.placed) {
    const id = p.mech.id;
    const shell = shells.get(id)!;
    const how: MountHow[] = [];
    const features: string[] = [];
    const missing: string[] = [];
    let insert: Mount["insert"] = "drop";
    let slide: Mount["slide"];
    const own = (r: { why: string; part?: string }) => r.part === id || r.why.endsWith(` ${id}`);
    const fz = facingZ(p.R);

    // ---------------------------------------------------------------- a cell
    if (p.mech.soft) {
      const cr = c.cradles.find((x) => x.part === id);
      if (cr) {
        how.push("cradle");
        features.push(`cradle for ${id}`);
        // two strap slots across the longer walls, for a Kapton (or hook-and-loop) strap over the cell
        const long = cr.max[0] - cr.min[0] >= cr.max[1] - cr.min[1] ? 0 : 1;
        const across = 1 - long;
        const mid = (cr.min[long]! + cr.max[long]!) / 2;
        const w = Math.min(8, (cr.max[long]! - cr.min[long]!) * 0.4);
        cr.slots = [-1, 1].map((s) => {
          const edge = s < 0 ? cr.min[across]! - cr.wall - 0.5 : cr.max[across]! - 0.5;
          const min: Vec3 = [0, 0, c.zBack - 1];
          const max: Vec3 = [0, 0, c.zBack + cr.h + 1];
          min[long] = mid - w / 2;
          max[long] = mid + w / 2;
          min[across] = edge;
          max[across] = edge + cr.wall + 1;
          return { min, max };
        });
        how.push("strap");
      } else {
        // corner locators: an L of two short ribs at each corner that has room
        const bz0 = shell === "back" ? c.zBack : Math.max(p.bodyMin[2], c.zFront - 3);
        const bz1 = shell === "back" ? Math.min(p.bodyMax[2], c.zBack + 3) : c.zFront;
        let n = 0;
        for (const sx of [-1, 1])
          for (const sy of [-1, 1]) {
            // (a cell keeps 0.25 mm all round: it is soft and may be a little larger than typical)
            const CR = 1.0;
            const cx = sx < 0 ? p.bodyMin[0] - 0.25 : p.bodyMax[0] + 0.25;
            const cy = sy < 0 ? p.bodyMin[1] - 0.25 : p.bodyMax[1] + 0.25;
            // two arms that overlap in the corner square (an L, one solid: never two boxes touching on an edge)
            const qx: [number, number] = sx < 0 ? [cx - CR, cx] : [cx, cx + CR];
            const qy: [number, number] = sy < 0 ? [cy - CR, cy] : [cy, cy + CR];
            const a: Box = { min: [Math.min(qx[0], cx - sx * 4), qy[0], bz0], max: [Math.max(qx[1], cx - sx * 4), qy[1], bz1] };
            const b: Box = { min: [qx[0], Math.min(qy[0], cy - sy * 4), bz0], max: [qx[1], Math.max(qy[1], cy - sy * 4), bz1] };
            if ([a, b].every((x) => c.free(x, p, 0.2) && !overlaps(x, env(p), -0.01) && !insertBoxes.some((q) => overlaps(q, x)) && !made.some((q) => overlaps(q, x, 0.2)) && c.inside(x))) {
              for (const x of [a, b]) {
                c.ribs.push({ min: x.min, max: x.max, shell, why: `corner of ${id}`, part: id, kind: "corner" });
                made.push(x);
              }
              n++;
            }
          }
        if (n >= 2) {
          how.push("corners");
          features.push(`${n} corner locators for ${id}`);
        } else missing.push(`no room for a cradle or corner locators round the cell (a corner locator needs 1.45 mm free beside two of its corners)`);
        how.push("strap");
      }
      how.push("foam-pad");
      out.push({ part: id, shell, how, insert, features, say: cellSay(id, how), ...(missing.length ? { missing: missing.join("; ") } : {}) });
      continue;
    }

    const open = c.openings.find((o) => o.part === id);
    if (open?.kind === "window") how.push("window-ledge");
    if (open && open.kind !== "window") how.push("opening");

    if (Math.abs(fz) > 0.5 && !(p.bound && ["left", "right", "top", "bottom"].includes(p.bound.face))) {
      // ---------------------------------------------------------------- a part lying flat
      const standoffs = c.posts.filter((q) => own(q) && (q.kind ?? "standoff") === "standoff");
      if (standoffs.length) {
        how.push("standoffs");
        insert = "press";
        features.push(...standoffs.map((q) => q.why));
      }
      const locs = c.ribs.filter((r) => own(r));
      // near wall: the one of its shell
      const gapNear = shell === "back" ? p.min[2] - c.zBack : c.zFront - p.max[2];
      const nearFaceBody = shell === "back" ? p.bodyMin[2] : p.bodyMax[2];
      if (!standoffs.length) {
        if (gapNear <= 0.8) how.push("wall");
        else {
          // seat posts at the corners of the board, from the wall to its underside
          const wallZ = shell === "back" ? c.zBack : c.zFront;
          const top = shell === "back" ? nearFaceBody - 0.05 : nearFaceBody + 0.05;
          let n = 0;
          const ins = 1.8;
          for (const [x, y] of spots(p, ins)) {
            if (n >= 4) break;
            const b = colBox(x, y, SEAT_D, wallZ, top);
            if (!c.free(b, p) || insertBoxes.some((q) => overlaps(q, b)) || made.some((q) => overlaps(q, b, 0.2)) || !c.inside(b)) continue;
            c.posts.push({ x, y, z0: Math.min(wallZ, top), z1: Math.max(wallZ, top), d: SEAT_D, shell, why: `seat for ${id}`, part: id, kind: "seat" });
            made.push(b);
            n++;
          }
          if (n >= 2) {
            how.push("seat-posts");
            features.push(`${n} seat posts for ${id}`);
          } else missing.push(`it sits ${gapNear.toFixed(1)} mm off the ${shell} wall and no seat post fits under it (each needs a ${SEAT_D} mm column clear of the other parts)`);
        }
      }
      if (!locs.length && !standoffs.length) {
        // locator ribs beside the body, from its shell's wall up past the part's near face
        const z0 = shell === "back" ? c.zBack : Math.max(p.bodyMin[2] - 0.5, nearFaceBody - 1.5);
        const z1 = shell === "back" ? Math.min(p.bodyMax[2] + 0.5, nearFaceBody + 1.5) : c.zFront;
        const cx = (p.bodyMin[0] + p.bodyMax[0]) / 2;
        const cy = (p.bodyMin[1] + p.bodyMax[1]) / 2;
        const L0 = Math.min(6, (p.bodyMax[1] - p.bodyMin[1]) * 0.6);
        const L1 = Math.min(6, (p.bodyMax[0] - p.bodyMin[0]) * 0.6);
        const cand: Box[] = [
          { min: [p.bodyMin[0] - tol - RIB, cy - L0 / 2, z0], max: [p.bodyMin[0] - tol, cy + L0 / 2, z1] },
          { min: [p.bodyMax[0] + tol, cy - L0 / 2, z0], max: [p.bodyMax[0] + tol + RIB, cy + L0 / 2, z1] },
          { min: [cx - L1 / 2, p.bodyMin[1] - tol - RIB, z0], max: [cx + L1 / 2, p.bodyMin[1] - tol, z1] },
          { min: [cx - L1 / 2, p.bodyMax[1] + tol, z0], max: [cx + L1 / 2, p.bodyMax[1] + tol + RIB, z1] },
        ];
        let n = 0;
        // (a side of the body with its port or opening is held by the opening: skip the rib there)
        for (const b of cand) {
          if (!clear(b, p)) continue;
          c.ribs.push({ min: b.min, max: b.max, shell, why: `locates ${id}`, part: id, kind: "locator" });
          made.push(b);
          n++;
        }
        if (n >= 2) {
          how.push("locators");
          features.push(`${n} locator ribs for ${id}`);
        } else if (!open || open.kind === "window") missing.push(`no room for locator ribs beside it (a ${RIB} mm rib needs ${(RIB + tol + 0.3).toFixed(1)} mm beside the body)`);
      } else if (locs.length) {
        how.push("locators");
        features.push(`${locs.length} locator ribs for ${id}`);
      }
      // far side: what stops it lifting towards the open side of its shell
      const farFace = shell === "back" ? p.max[2] : p.min[2];
      let gapFar = shell === "back" ? c.zFront - farFace : farFace - c.zBack;
      let by = "the other shell";
      for (const q of c.placed) {
        if (q === p || !xyOverlap(env(q), env(p), -0.2)) continue;
        const gq = shell === "back" ? q.min[2] - farFace : farFace - q.max[2];
        if (gq >= -0.05 && gq < gapFar) {
          gapFar = gq;
          by = q.mech.id;
        }
      }
      if (gapFar <= 1.0) {
        how.push(by === "the other shell" ? "wall" : "neighbour");
        if (by !== "the other shell") features.push(`held down by ${by} (${Math.max(0, gapFar).toFixed(1)} mm)`);
      } else {
        const other = shell === "back" ? "front" : "back";
        const wallZ = other === "front" ? c.zFront : c.zBack;
        const end = shell === "back" ? farFace + 0.3 : farFace - 0.3;
        let n = 0;
        const ins = 2.5;
        const used: [number, number][] = [];
        for (const [x, y] of spots(p, ins)) {
          if (n >= 2) break;
          // (two hold-downs far apart, not side by side)
          if (used.some(([ux, uy]) => Math.hypot(ux - x, uy - y) < Math.max(4, Math.min(p.bodyMax[0] - p.bodyMin[0], p.bodyMax[1] - p.bodyMin[1]) * 0.5))) continue;
          const b = colBox(x, y, HOLD_D, wallZ, end);
          if (!c.free(b, p) || insertBoxes.some((q) => overlaps(q, b)) || made.some((q) => overlaps(q, b, 0.2)) || !c.inside(b)) continue;
          c.posts.push({ x, y, z0: Math.min(wallZ, end), z1: Math.max(wallZ, end), d: HOLD_D, shell: other, why: `holds down ${id}`, part: id, kind: "hold-down" });
          used.push([x, y]);
          made.push(b);
          n++;
        }
        if (n) {
          how.push("hold-down");
          features.push(`${n} hold-down post${n > 1 ? "s" : ""} for ${id} from the ${other} shell`);
        } else {
          how.push("foam-tape");
          missing.push(`it could lift ${gapFar.toFixed(1)} mm and no hold-down post fits over it (a ${HOLD_D} mm post needs a free column to the ${other} wall)`);
        }
      }
    } else {
      // ---------------------------------------------------------------- a part standing on a side wall (or on its edge)
      const face = p.bound && ["left", "right", "top", "bottom"].includes(p.bound.face) ? p.bound.face : undefined;
      const n: Vec3 = face === "left" ? [-1, 0, 0] : face === "right" ? [1, 0, 0] : face === "top" ? [0, 1, 0] : face === "bottom" ? [0, -1, 0] : [0, 0, 0];
      const ax = Math.abs(n[0]) > 0.5 ? 0 : 1; // the axis to the wall
      const along = 1 - ax;
      const zc = (p.bodyMin[2] + p.bodyMax[2]) / 2;
      const z0 = shell === "back" ? c.zBack : Math.min(zc, c.zFront - 0.5);
      const z1 = shell === "back" ? Math.max(zc, c.zBack + 0.5) : c.zFront;
      if (face) {
        const s = n[ax]!;
        // a lever / knob through its hole: slid sideways at the end, when its hole is in one shell
        const o = open;
        if (o && p.bound!.feature.passThrough) {
          const half = Math.abs(o.vAxis[2]) > 0.5 ? o.v / 2 : o.u / 2;
          const straddles = o.at[2] - half < c.split && o.at[2] + half > c.split;
          if (!straddles) {
            insert = "slide";
            const need = p.bound!.feature.protrude + 0.5;
            // the room behind the part as it slides in (its body moved away from the wall): the cavity
            // and the ribs / posts of its own shell; the other parts are ordered by the assembly plan
            const sameShell = [...c.ribs.filter((r) => r.shell === shell && r.part !== id).map((r) => ({ min: r.min, max: r.max })), ...c.posts.filter((q) => q.shell === shell && q.part !== id).map((q) => colBox(q.x, q.y, q.d, q.z0, q.z1))];
            let have = 0;
            for (let d = 0.25; d <= need + 2; d += 0.25) {
              const moved: Box = { min: [p.bodyMin[0] - n[0] * d, p.bodyMin[1] - n[1] * d, p.bodyMin[2]], max: [p.bodyMax[0] - n[0] * d, p.bodyMax[1] - n[1] * d, p.bodyMax[2]] };
              if (sameShell.some((b) => overlaps(b, moved))) break;
              // (until it has moved the lever's length the lever is still in its hole: only the room past that counts)
              if (!c.cavity(moved)) {
                if (d < need - 0.5) continue;
                break;
              }
              have = d;
            }
            slide = { dir: n, need_mm: Math.round(need * 10) / 10, have_mm: Math.round(have * 10) / 10, opening: `${o.kind} on the ${o.face}` };
          }
        }
        // backstop: a rib behind the envelope (the side away from the wall). A part that slides in
        // needs that room free while it goes in, so its backstop comes down with the other shell.
        const bShell: "front" | "back" = insert === "slide" ? (shell === "back" ? "front" : "back") : shell;
        const bz0 = bShell === "back" ? c.zBack : Math.min(zc, c.zFront - 0.5);
        const bz1 = bShell === "back" ? Math.max(zc, c.zBack + 0.5) : c.zFront;
        const back = s > 0 ? p.min[ax]! : p.max[ax]!;
        const bs: Box = { min: [0, 0, bz0], max: [0, 0, bz1] };
        bs.min[along] = p.bodyMin[along]! + 0.3;
        bs.max[along] = p.bodyMax[along]! - 0.3;
        bs.min[ax] = s > 0 ? back - 0.1 - 1.6 : back + 0.1;
        bs.max[ax] = s > 0 ? back - 0.1 : back + 0.1 + 1.6;
        if (bs.max[along]! - bs.min[along]! > 1.5 && clear(bs, p)) {
          c.ribs.push({ min: bs.min, max: bs.max, shell: bShell, why: `backstop for ${id}`, part: id, kind: "backstop" });
          made.push(bs);
          how.push("backstop");
          features.push(`backstop behind ${id}${bShell !== shell ? ` (from the ${bShell} shell, so it can slide in)` : ""}`);
        } else if (p.bound!.feature.kind === "connector" || p.bound!.feature.kind === "button" || p.bound!.feature.kind === "switch") missing.push(`no room for a backstop behind it (a 1.6 mm rib needs 1.9 mm behind the part; plugging a cable in or pressing it pushes the part inwards)`);
        // guides on both ends along the wall
        let gN = 0;
        for (const e of [-1, 1]) {
          const gb: Box = { min: [0, 0, z0], max: [0, 0, z1] };
          gb.min[ax] = Math.min(p.bodyMin[ax]!, p.bodyMax[ax]!) + 0.3;
          gb.max[ax] = Math.max(p.bodyMin[ax]!, p.bodyMax[ax]!) - 0.3;
          gb.min[along] = e < 0 ? p.bodyMin[along]! - tol - RIB : p.bodyMax[along]! + tol;
          gb.max[along] = e < 0 ? p.bodyMin[along]! - tol : p.bodyMax[along]! + tol + RIB;
          if (gb.max[ax]! - gb.min[ax]! < 1 || !clear(gb, p)) continue;
          c.ribs.push({ min: gb.min, max: gb.max, shell, why: `guide for ${id}`, part: id, kind: "guide" });
          made.push(gb);
          gN++;
        }
        if (gN) {
          how.push("guides");
          features.push(`${gN} guide rib${gN > 1 ? "s" : ""} beside ${id}`);
        }
      }
      // under it: a seat block when it floats above its wall
      const gapNear = shell === "back" ? p.min[2] - c.zBack : c.zFront - p.max[2];
      if (gapNear > 0.8) {
        const x = (p.bodyMin[0] + p.bodyMax[0]) / 2;
        const y = (p.bodyMin[1] + p.bodyMax[1]) / 2;
        const wallZ = shell === "back" ? c.zBack : c.zFront;
        const top = shell === "back" ? p.bodyMin[2] - 0.05 : p.bodyMax[2] + 0.05;
        const b = colBox(x, y, SEAT_D, wallZ, top);
        if (c.free(b, p) && !insertBoxes.some((q) => overlaps(q, b)) && !made.some((q) => overlaps(q, b, 0.2)) && c.inside(b)) {
          c.posts.push({ x, y, z0: Math.min(wallZ, top), z1: Math.max(wallZ, top), d: SEAT_D, shell, why: `seat for ${id}`, part: id, kind: "seat" });
          made.push(b);
          how.push("seat-posts");
          features.push(`seat post under ${id}`);
        }
      } else how.push("wall");
      if (!how.includes("backstop") && !how.includes("guides") && !how.includes("opening")) {
        how.push("foam-tape");
        missing.push("it stands on its edge with nothing beside it to hold it");
      }
    }
    void zMid;
    out.push({ part: id, shell, how, insert, ...(slide ? { slide } : {}), features, say: partSay(id, how, shell, insert), ...(missing.length ? { missing: missing.join("; ") } : {}) });
  }
  return out;
}

/** Where posts may land on a part, best first: the four corners (inset), then the middles of the edges, then the centre. */
function spots(p: Placed, ins: number): [number, number][] {
  const [x0, y0, x1, y1] = [p.bodyMin[0] + ins, p.bodyMin[1] + ins, p.bodyMax[0] - ins, p.bodyMax[1] - ins];
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const out: [number, number][] = [
    [x0, y0],
    [x1, y1],
    [x1, y0],
    [x0, y1],
    [mx, y0],
    [mx, y1],
    [x0, my],
    [x1, my],
    [mx, my],
  ];
  return x1 > x0 && y1 > y0 ? out : [[(p.bodyMin[0] + p.bodyMax[0]) / 2, (p.bodyMin[1] + p.bodyMax[1]) / 2]];
}

function cellSay(id: string, how: MountHow[]): string {
  const where = how.includes("cradle") ? "in its cradle" : how.includes("corners") ? "between its corner locators" : "flat on the wall";
  return `${id} lies ${where} on a 1 mm foam pad, held by a Kapton strap${how.includes("cradle") ? " through the cradle's two slots" : ""}; nothing presses on it (10 % room to swell).`;
}

function partSay(id: string, how: MountHow[], shell: string, insert: Mount["insert"]): string {
  const bits: string[] = [];
  if (how.includes("window-ledge")) bits.push("its bezel rests on the ledge round the window");
  if (how.includes("standoffs")) bits.push("it presses onto the case's pins through its mounting holes");
  if (how.includes("locators")) bits.push("ribs round it keep it in place");
  if (how.includes("corners")) bits.push("corner locators keep it in place");
  if (how.includes("seat-posts")) bits.push("it rests on seat posts");
  if (how.includes("opening")) bits.push("its port / button / lever sits in its opening");
  if (how.includes("backstop")) bits.push("a backstop behind it takes the push of a plug or a finger");
  if (how.includes("guides")) bits.push("guide ribs beside it");
  if (how.includes("hold-down")) bits.push("posts from the other shell stop it lifting when the case is closed");
  if (how.includes("neighbour")) bits.push("the part next to it stops it lifting");
  if (how.includes("foam-tape")) bits.push("a strip of 1 mm foam tape holds it (no clip fits)");
  const verb = insert === "slide" ? "slides into" : insert === "press" ? "presses into" : "drops into";
  return `${id} ${verb} the ${shell} shell: ${bits.join("; ") || "it is held by the parts round it"}.`;
}
