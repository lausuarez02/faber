/**
 * Round 15: held objects in the layout (see held.ts): the synthetic parts, the sleeve walls that
 * keep the electronics and their wires out of the object's room, and the checks (room, opening,
 * walls, a sensor that must sit next to the object).
 */
import type { HeldObject } from "@fabwright/project-format";
import { heldFrom, heldInsert, heldProblems, heldSize, heldSpec, isHeldMech, measureText, SLEEVE_WALL_MM, type HeldCtx, type HeldReport } from "./held.ts";
import type { LayoutInput, Opening, Placed, Rib } from "./layout.ts";
import { contains, rayExit, type Plan } from "./plan.ts";
import type { FitCheck, Vec3 } from "./types.ts";

const MIN_WALL = 1.2;
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The input with each valid held object added as a part, its placement facing the side it goes in
 * through. Round 17: `ctx` (wall, fit tolerance) makes a front / back room's depth count from the
 * OUTER face; enclosure.follow sizes the outline from the held object's footprint.
 */
export function withHeld(input: LayoutInput, ctx?: HeldCtx): LayoutInput {
  const held = (input.enclosure.held ?? []).filter((h) => !heldProblems(h, ctx).length);
  if (!held.length) return input;
  const placements = { ...(input.enclosure.placements ?? {}) };
  for (const h of held) {
    const pl = placements[h.id] ?? {};
    if (!pl.face) placements[h.id] = { ...pl, face: h.removable === false ? "inside" : heldFrom(h) };
  }
  const ids = new Set(input.parts.map((p) => p.id));
  const parts = [...input.parts, ...held.filter((h) => !ids.has(h.id)).map((h) => ({ id: h.id, type: heldSpec(h, ctx).id, spec: heldSpec(h, ctx) }))];
  const enclosure = { ...input.enclosure, placements };
  const fs = followSize(input.enclosure, ctx);
  if (fs) {
    enclosure.size_mm = { ...(input.enclosure.size_mm ?? {}), w: fs.w, h: fs.h };
    // centred: the object's room is the outline's middle
    const f = input.enclosure.follow!.held;
    const pl = placements[f]!;
    if (pl.x_mm === undefined && pl.y_mm === undefined) placements[f] = { ...pl, x_mm: 0, y_mm: 0 };
  }
  return { parts, enclosure };
}

/**
 * Round 17: the outline that follows a held object (enclosure.follow): its front-view footprint +
 * clearance + margin + the wall on each side. Undefined when there is no follow, the object is not
 * declared (sleeveFor reports it), or the person fixed size_mm w / h themselves (they win).
 */
export function followSize(enc: LayoutInput["enclosure"], ctx: HeldCtx = { wall: 1.6, tol: 0.2 }): { w: number; h: number } | undefined {
  const f = enc.follow;
  if (!f) return undefined;
  const h = (enc.held ?? []).find((x) => x.id === f.held);
  if (!h || heldProblems(h, ctx).length) return undefined;
  if (enc.size_mm?.w !== undefined || enc.size_mm?.h !== undefined) return undefined;
  const sz = heldSize(h, ctx);
  const m = f.margin_mm ?? 0;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  // + 0.1 mm a side: the packer's round-outline tests are conservative by about that much
  return { w: r2(sz.object.w + 2 * sz.clearance + 2 * m + 2 * ctx.wall + 0.2), h: r2(sz.object.h + 2 * sz.clearance + 2 * m + 2 * ctx.wall + 0.2) };
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
  /** Round 17: the case rides on this held object through a socket, the seam on its floor plate. */
  socket?: { part: string; face: "front" | "back"; plate: [number, number] };
  /** Round 17: the outline follows this held object (enclosure.follow). */
  follow?: LayoutInput["enclosure"]["follow"];
}

/**
 * Sleeve walls round each held object (on the sides that do not face the outline's own wall or its
 * opening), the held-object checks, and one report entry per object.
 */
export function sleeveFor(c: SleeveContext): HeldReport[] {
  const out: HeldReport[] = [];
  const T = SLEEVE_WALL_MM;
  const ctx: HeldCtx = { wall: c.wall ?? MIN_WALL, tol: c.tol };
  for (const h of c.held ?? []) for (const m of heldProblems(h, ctx)) c.issues.push({ id: "held-object", ok: false, severity: "error", message: m, parts: [h.id] });
  if (c.follow && !(c.held ?? []).some((h) => h.id === c.follow!.held)) c.issues.push({ id: "held-object", ok: false, severity: "error", message: `enclosure.follow names "${c.follow.held}", but there is no held object with that id. Why: the outline follows a held object's footprint. Fix: "follow": {"held": "${(c.held ?? [])[0]?.id ?? "can"}"} with the id from enclosure.held, or remove follow.`, parts: [c.follow.held] });
  for (const p of c.placed) {
    if (!isHeldMech(p.mech)) continue;
    const h = (c.held ?? []).find((x) => x.id === p.mech.id);
    if (!h) continue;
    const sz = heldSize(h, ctx);
    const room: Box = { min: p.min, max: p.max };
    const open = c.openings.find((o) => o.part === p.mech.id && o.feature === "access");
    const others = c.placed.filter((q) => q !== p);
    const clash = others.filter((q) => overlaps(room, q, -0.01));
    if (clash.length) c.issues.push({ id: "held-object", ok: false, severity: "error", message: `${h.name ?? h.id}'s room overlaps ${clash.map((q) => q.mech.id).join(", ")}. Why: a part was pinned into it. Fix: remove that part's placements so Fabwright packs it elsewhere, or make the case bigger.`, parts: [h.id, ...clash.map((q) => q.mech.id)] });
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
    const followed = c.follow?.held === h.id;
    for (const sd of sides) {
      if (open && open.face === sd.name) continue; // its way in
      // round 17: a case that follows the object: its own wall (and a socket's collar) is the sleeve
      if (followed && sd.axis !== 2) continue;
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
        // (round 17: a sleeve that would leave a sliver under 2 mm to the wall is not made: no wire or
        // part fits there, and the sliver's thin walls break OpenCascade's fuse)
        probe[sd.axis] = edge + sd.dir * (T + 2);
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
      // round 17: the socket's floor plate ends flush on the seam (the shell prints standing on it)
      if (c.socket?.part === h.id && sd.axis === 2) for (const pc of pieces) {
        if (pc.shell === "back" && Math.abs(max[2] - c.split) < 0.05) pc.z1 = c.split;
        if (pc.shell === "front" && Math.abs(min[2] - c.split) < 0.05) pc.z0 = c.split;
      }
      for (const pc of pieces) {
        if (pc.z1 - pc.z0 < 0.6) continue;
        // a plate floats unless it is in the shell whose walls reach its height
        c.ribs.push({ min: [min[0], min[1], pc.z0], max: [max[0], max[1], pc.z1], shell: pc.shell, why: `sleeve for ${h.id}`, part: h.id, kind: "guide" });
      }
      made.push(sd.name);
    }
    if (skipped.length) c.issues.push({ id: "held-object", ok: true, severity: "warning", message: `${h.name ?? h.id} has no sleeve wall on the ${skipped.join(", ")}: there is no ${T} mm of free room between it and that part. Why: wires could reach the object's room there and the object rests on the part. Fix: more wiring room (params.gap_mm 2), or let Fabwright place that part (remove its placements).`, parts: [h.id] });
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
    // ---- round 17: how deep the floor really is below the outer face, and how far the object stands out
    const from = heldFrom(h);
    const wallT = c.wall ?? MIN_WALL;
    let depth: number | undefined;
    if (h.removable !== false && (from === "front" || from === "back")) depth = from === "front" ? c.zFront + wallT - room.min[2] : room.max[2] - (c.zBack - wallT);
    const proud = depth !== undefined ? sz.along - depth : undefined;
    // ---- a sensor that must sit next to it (a reed / Hall switch for the lid's magnet)
    let sensing: HeldReport["sensing"];
    if (h.sensor) {
      const sp = c.placed.find((q) => q.mech.id === h.sensor!.part);
      let max = h.sensor.max_mm ?? 8;
      if (!sp) c.issues.push({ id: "held-sensor", ok: false, severity: "warning", message: `${h.name ?? h.id}'s sensor "${h.sensor.part}" is not in the case. Why: there is no such part, or it is excluded. Fix: place it (place_part {"type": "reed-switch", "id": "${h.sensor.part}"}) or correct enclosure.held[].sensor.part.`, parts: [h.id] });
      else if (h.magnet) {
        // round 17: the magnet is on the object, outside the case: the gap mounted, lifted off, and where it lets go
        const sens: Box = { min: sp.bodyMin, max: sp.bodyMax };
        const mg = magnetAt(h, sz, room, sens, from, c.zFront + wallT, c.zBack - wallT);
        // round 17 proof: a magnet glued on the object's side sticks out of it, so its edge must stay
        // clear of the socket (the case's rim would land on it and the case would not sit fully on)
        {
          const md = h.magnet.d_mm ?? 6;
          const mt = h.magnet.t_mm ?? 3;
          const outside = h.magnet.radial_mm === undefined || h.magnet.radial_mm > (sz.round ? sz.object.w / 2 : Math.min(sz.object.w, sz.object.h) / 2);
          const edge = h.magnet.beyond_mm - md / 2;
          const need = md / 2 + 0.5;
          if (outside && edge < 0.5) c.issues.push({ id: "held-magnet", ok: false, severity: "warning", message: `The magnet on ${h.name ?? h.id} (${md} x ${mt} mm, centre ${h.magnet.beyond_mm} mm beyond the ${from} face) reaches ${r1(Math.abs(edge))} mm ${edge < 0 ? "inside" : "short of"} the socket's mouth. Why: glued on the object's side it stands ${mt} mm proud of it, so the case's rim lands on it and the case cannot go fully on. Fix: magnet.beyond_mm ${r1(need)} or more (its edge 0.5 mm clear of the case), and below anything on the object that moves with the case (a lid's skirt): beyond_mm at least (skirt length - engage_mm) + ${r1(md / 2 + 0.5)}.`, parts: [h.sensor.part, h.id], facts: { magnet_edge_mm: r1(edge), min_beyond_mm: r1(need) } });
        }
        const lift = h.sensor.lift_mm ?? 10;
        const gapAt = (l: number) => Math.max(0, sensorGap(sens, { min: shiftZ(mg.at, mg.dir * l), max: shiftZ(mg.at, mg.dir * l) }) - mg.t / 2);
        const mounted = gapAt(0);
        const lifted = gapAt(lift);
        // round 17 proof: a magnetic switch has hysteresis. It closes once the field reaches its operate
        // point and only lets go below the lower release point, so it must be farther away to open than
        // to close. With the switch's fields and the magnet's size, both are distances (on the magnet's axis).
        const ms = sp.mech.magnetSwitch;
        let field: { operate_mm: number; release_mm: number; why: string } | undefined;
        if (ms) {
          const d = h.magnet.d_mm ?? 6;
          const t = h.magnet.t_mm ?? 3;
          // a max_mm the person gave is where it closes (their switch, their magnet); it lets go where the
          // field falls to release / operate of the field there
          const given = h.sensor.max_mm;
          const operate = given ?? distanceForFieldMt(ms.operate_mT, d, t, N35_BR);
          const closeMt = given !== undefined ? discFieldMt(given, d, t, N35_BR) : ms.operate_mT;
          const releaseMt = closeMt * (ms.release_mT / ms.operate_mT);
          const release = distanceForFieldMt(releaseMt, d, t, N35_BR);
          field = { operate_mm: operate, release_mm: release, why: `a ${d} x ${t} mm N35 magnet gives ${r1(closeMt)} mT at ${r1(operate)} mm, where ${sp.mech.id} closes${given !== undefined ? " (sensor.max_mm)" : ""}, and ${sp.mech.id} lets go only below ${r1(releaseMt)} mT (${ms.release_mT} / ${ms.operate_mT} mT release / operate), at ${r1(release)} mm, on the magnet's axis` };
          max = operate;
        }
        const openAt = field ? Math.max(field.release_mm, max) : max;
        let letsGo: number | undefined;
        if (mounted <= max) {
          let lo = 0;
          let hi = 200;
          if (gapAt(hi) > openAt) {
            for (let i = 0; i < 40; i++) {
              const mid = (lo + hi) / 2;
              if (gapAt(mid) > openAt) hi = mid;
              else lo = mid;
            }
            letsGo = hi;
          }
        }
        sensing = { sensor: sp.mech.id, mounted_mm: r1(mounted), lifted_mm: r1(lifted), lift_mm: lift, ...(letsGo !== undefined ? { lets_go_at_mm: r1(letsGo) } : {}), max_mm: r1(max), ...(field ? { release_mm: r1(field.release_mm) } : {}) };
        const where = `the magnet ${Math.abs(mg.beyond)} mm ${mg.beyond >= 0 ? "beyond" : "inside"} the ${from} face, ${Math.round(mg.angle)}° round ${h.name ?? h.id} (${mg.angle < 45 || mg.angle >= 315 ? "right" : mg.angle < 135 ? "top" : mg.angle < 225 ? "left" : "bottom"} side)`;
        const steps = `Test steps: {"set": "${sp.mech.id}.magnet_mm", "value": ${r1(mounted)}} mounted, {"set": "${sp.mech.id}.magnet_mm", "value": ${r1(lifted)}} lifted ${lift} mm.`;
        const facts = { mounted_mm: r1(mounted), lifted_mm: r1(lifted), lift_mm: lift, max_mm: r1(max), ...(field ? { release_mm: r1(field.release_mm) } : {}), ...(letsGo !== undefined ? { lets_go_at_mm: r1(letsGo) } : {}) };
        const physics = field ? ` (${field.why})` : "";
        if (mounted > max) c.issues.push({ id: "held-sensor", ok: false, severity: "warning", message: `${sp.mech.id} is ${r1(mounted)} mm from ${where} with ${h.name ?? h.id} mounted, farther than the ${r1(max)} mm it senses across${physics}: it never closes. Why: the switch sits too far from the magnet (inside the case, above the socket floor). Fix: pin ${sp.mech.id} next to the socket's edge on that side (placements x_mm / y_mm, layer near the ${from}), move the magnet closer to the socket edge (magnet.beyond_mm smaller), or a stronger magnet and a larger sensor.max_mm.`, parts: [sp.mech.id, h.id], facts });
        else if (lifted <= openAt) c.issues.push({ id: "held-sensor", ok: false, severity: "warning", message: `${sp.mech.id} still sees ${where} with the case lifted ${lift} mm: ${r1(lifted)} mm away, and it only lets go beyond ${r1(openAt)} mm${physics}, so it would not notice the case coming off that far. Why: ${field && lifted > max ? "a magnetic switch lets go at a weaker field than it closes at (hysteresis), so opening needs more distance than closing" : "the magnet is strong enough to reach it at that lift"}. Fix: if the case comes all the way off in use (a lid pulled off), set sensor.lift_mm to that real lift; otherwise a smaller or weaker magnet (magnet.d_mm / t_mm), or the magnet farther from the socket edge (magnet.beyond_mm).${letsGo !== undefined ? ` It lets go after about ${r1(letsGo)} mm of lift.` : ""} Test steps: {"set": "${sp.mech.id}.magnet_mm", "value": ${r1(mounted)}} mounted, {"set": "${sp.mech.id}.magnet_mm", "value": ${r1(openAt + 1)}} off.`, parts: [sp.mech.id, h.id], facts });
        else c.issues.push({ id: "held-sensor", ok: true, severity: "info", message: `${sp.mech.id} is ${r1(mounted)} mm from ${where} when mounted (within ${r1(max)} mm: closed) and ${r1(lifted)} mm when the case is lifted ${lift} mm (open${field ? `: beyond the ${r1(openAt)} mm where it lets go` : ""})${physics}${letsGo !== undefined ? `; it lets go after about ${r1(letsGo)} mm of lift` : ""}. ${steps}`, parts: [sp.mech.id, h.id], facts });
      } else {
        const gap = sensorGap({ min: sp.bodyMin, max: sp.bodyMax }, room);
        const side = (["left", "right", "bottom", "top"] as const).map((n, i) => ({ n, d: i % 2 ? sp.bodyMin[i >> 1]! - room.max[i >> 1]! : room.min[i >> 1]! - sp.bodyMax[i >> 1]! })).sort((a, b) => b.d - a.d)[0]!.n;
        if (gap > max) c.issues.push({ id: "held-sensor", ok: false, severity: "warning", message: `${sp.mech.id} is ${r1(gap)} mm from ${h.name ?? h.id}, farther than the ${max} mm it can sense across. Why: the packer put it where it fit best (on the object's ${side} side, too far). Fix: pin it against the object with placements, e.g. {"${sp.mech.id}": {"layer": ${sp.layer}}} and x_mm / y_mm next to the object's edge, or use a stronger magnet and raise sensor.max_mm.`, parts: [sp.mech.id, h.id], facts: { gap_mm: r1(gap), max_mm: max } });
        else c.issues.push({ id: "held-sensor", ok: true, severity: "info", message: `${sp.mech.id} sits ${r1(gap)} mm from ${h.name ?? h.id} (within ${max} mm): it can sense it.`, parts: [sp.mech.id, h.id], facts: { gap_mm: r1(gap), max_mm: max } });
      }
    }
    const opening = open ? { w: r1(open.u), h: r1(open.shape === "round" ? open.u : open.v), shape: open.shape } : undefined;
    const ins = heldInsert(h);
    const lip = ins === "snap" ? (h.lip_mm ?? 0.6) : 0;
    const fit = h.fit ?? (ins === "snap" ? "snap" : "slip");
    const stands = proud === undefined ? "" : proud > 0.05 ? `; the floor is ${r1(depth!)} mm below the outer ${from} face, so ${h.name ?? h.id} stands ${r1(proud)} mm proud of it` : `; the floor is ${r1(depth!)} mm below the outer ${from} face, so ${h.name ?? h.id} sits ${r1(-proud)} mm below it`;
    c.issues.push({
      id: "held-object",
      ok: true,
      severity: "info",
      message: `${h.name ?? h.id} (${sz.text}): ${sz.socket ? `a socket ${r1(sz.declared.w)} x ${r1(sz.declared.h)} mm, ${r1(sz.declared.d)} mm deep from the outer face` : `a room of ${r1(sz.declared.w)} x ${r1(sz.declared.h)} x ${r1(sz.declared.d)} mm`} with ${sz.clearance} mm all round${h.fit || sz.socket ? ` (${fit === "press" ? "a press fit: print a test ring first" : fit === "snap" ? "a snap fit" : "a slip fit"})` : ""}; ${h.removable === false ? "it goes in during assembly and stays (no opening)" : sz.socket ? `the case goes on it through a ${opening!.w} x ${opening!.h} mm opening on the ${from}${lip ? `, its rim ${lip} mm over the object each side (it clicks over the edge: test-print the rim)` : ""}` : `it goes in through ${ins === "slide" ? "a slot" : "an opening"} of ${opening!.w} x ${opening!.h} mm on the ${from}${lip ? `, its rim ${lip} mm over the object each side (it snaps in: PETG or PLA flexes that much; test-print the rim)` : ""}`}${stands}; no part or wire in its room${made.length ? `, sleeve walls on the ${made.join(", ")}` : ""}; thinnest wall round it ${r1(thinnest)} mm.`,
      parts: [h.id],
      facts: { room_w: r1(sz.declared.w), room_h: r1(sz.declared.h), room_d: r1(sz.declared.d), clearance_mm: sz.clearance, wall_mm: r1(thinnest), ...(depth !== undefined ? { depth_mm: r1(depth), proud_mm: r1(proud!) } : {}) },
    });
    out.push({
      id: h.id,
      name: h.name ?? h.id,
      shape: h.shape,
      insert: ins,
      fit,
      from,
      removable: h.removable !== false,
      object_mm: sz.object,
      clearance_mm: sz.clearance,
      room_mm: { w: r1(sz.declared.w), h: r1(sz.declared.h), d: r1(sz.declared.d) },
      ...(depth !== undefined ? { depth_mm: r1(depth), proud_mm: r1(proud!) } : {}),
      ...(sz.socket ? { engage_mm: h.engage_mm! } : {}),
      ...(sensing ? { sensing } : {}),
      ...(opening && h.removable !== false ? { opening_mm: opening } : {}),
      wall_mm: r1(thinnest),
      sleeve: made,
      source: h.source ?? "declared in fabwright.json enclosure.held",
      measure: measureText(h, ctx),
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

const shiftZ = (p: Vec3, dz: number): Vec3 => [p[0], p[1], p[2] + dz];

/**
 * Round 17: where a magnet declared on a held object is in the case frame (mounted): `beyond_mm`
 * from the outer face of the entry wall along the object (outwards positive), at `angle_deg` round
 * its axis (default: towards the sensor), `radial_mm` from the axis (default on the outside of its
 * side). `dir` is the way the object moves relative to the case when the case is lifted off it.
 */
function magnetAt(h: HeldObject, sz: ReturnType<typeof heldSize>, room: Box, sensor: Box, from: string, zOutF: number, zOutB: number): { at: Vec3; dir: 1 | -1; t: number; beyond: number; angle: number } {
  const m = h.magnet!;
  const t = m.t_mm ?? 3;
  const cx = (room.min[0] + room.max[0]) / 2;
  const cy = (room.min[1] + room.max[1]) / 2;
  const sx = (sensor.min[0] + sensor.max[0]) / 2;
  const sy = (sensor.min[1] + sensor.max[1]) / 2;
  let angle = m.angle_deg ?? (Math.atan2(sy - cy, sx - cx) * 180) / Math.PI;
  angle = ((angle % 360) + 360) % 360;
  const ux = Math.cos((angle * Math.PI) / 180);
  const uy = Math.sin((angle * Math.PI) / 180);
  // the object's side along that direction: a round object's radius, a box's edge
  const hw = sz.object.w / 2;
  const hh = sz.object.h / 2;
  const edge = sz.round ? hw : Math.min(Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity);
  const rad = m.radial_mm ?? edge + t / 2;
  const dir: 1 | -1 = from === "front" ? 1 : -1;
  const z = from === "front" ? zOutF + m.beyond_mm : zOutB - m.beyond_mm;
  return { at: [cx + ux * rad, cy + uy * rad, z], dir, t, beyond: m.beyond_mm, angle };
}

/** Remanence of N35 NdFeB (T), the grade the held object's magnet is assumed to be. */
const N35_BR = 1.19;
/** Flux density (mT) on the axis of a disc magnet, z mm from its face (same model as the parts' magnet lib). */
function discFieldMt(z: number, d: number, t: number, br: number): number {
  const R = d / 2;
  const zz = Math.max(0, z);
  return (br / 2) * ((zz + t) / Math.hypot(R, zz + t) - zz / Math.hypot(R, zz)) * 1000;
}
/** The distance (mm) at which a disc magnet's field drops to mT (0 when it never reaches it). */
function distanceForFieldMt(mT: number, d: number, t: number, br: number): number {
  if (discFieldMt(0, d, t, br) < mT) return 0;
  let lo = 0;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (discFieldMt(mid, d, t, br) >= mT) lo = mid;
    else hi = mid;
  }
  return lo;
}
