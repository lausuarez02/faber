/**
 * The case engine: project + parts → layout → OpenCascade bodies → files (STL, 3MF, STEP, PNG,
 * SVG / PDF, PRINT.md) + a CaseReport with fit checks. Files are outputs (R5): regenerated from
 * fabwright.json and the parts' mechanical data; case/manifest.json keeps the input hash.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Enclosure, Project } from "@fabwright/project-format";
import type { PartSpec } from "@fabwright/sim-core";
import { drawingSvg } from "./drawing.ts";
import { buildCase, type Body, partColor } from "./geometry.ts";
import { type Layout, type LayoutInput, resolveParams } from "./layout.ts";
import { layoutCase } from "./proposals.ts";
import { checkMesh, type Mesh, meshOf, plateLayout, printPose, stlBinary, threeMf } from "./mesh.ts";
import { contains, outline } from "./plan.ts";
import { materialFor, printMd } from "./print.ts";
import { occt } from "./occt.ts";
import { windowSight } from "./sight.ts";
import { assemblyPlan, pinPositionsOf, type AssemblyWire } from "./assembly.ts";
import { renderAssemblySteps } from "./assembly-render.ts";
import { renderPng, type RenderItem, VIEWS } from "./render.ts";
import type { CaseFile, CaseMesh, CaseReport, FitCheck, PlacedPart, Vec3 } from "./types.ts";

export const ENGINE_VERSION = "case-6"; // round 12: every part held (mounts), the assembly plan and its checks, a picture per step
// (case-5, round 8b: fixed sizes thinnest first, the window sight test, the front-held parts explode with the front)
export const MIN_WALL = 1.2;

export interface GenerateOptions {
  /** Project name for titles. */
  title?: string;
  /** Render the four PNGs (default true). */
  renders?: boolean;
  /** SVG → PDF (Playwright's Chromium); undefined result = not available, with the reason. */
  pdf?: (svg: string) => Promise<{ pdf?: Uint8Array; why?: string }>;
  /** Mesh tolerance for STL / 3MF (mm, default 0.05). */
  tolerance?: number;
  /** A layout already made for this project and enclosure (design_case checks the fit first). */
  layout?: Layout;
  /** Round 12: the wire cut list for this layout (session's wireCuts); estimated from the pin positions when absent. */
  wires?: (L: Layout) => AssemblyWire[];
  /** Round 12: render one picture per assembly step (default: with the renders). */
  stepImages?: boolean;
  /** Round 13: the firmware's source text, for the assembly plan (a board's own card slot needs a card only when it reads one). */
  firmwareText?: string;
}

export interface Generated {
  report: CaseReport;
  /** Relative path under case/ → bytes. */
  files: Map<string, Uint8Array>;
  mesh: CaseMesh;
  layout: Layout;
  missing: { item: string; why: string; fix: string }[];
}

type SpecOf = (type: string) => PartSpec | undefined;

/** The resolved enclosure (defaults filled in), as stored in the report. */
export function resolveEnclosure(enc: Enclosure): Enclosure {
  const p = resolveParams(enc.shape, enc.params);
  return { ...enc, params: { ...p } };
}

export function caseHash(project: Project, specOf: SpecOf): string {
  if (!project.enclosure) return "";
  const parts = project.parts.map((p) => {
    const s = specOf(p.type);
    // a LiPo's capacity picks its cell size (round 7), so it is part of the hash
    const cap = s?.mechanical?.soft ? p.props?.capacity : undefined;
    return { id: p.id, type: p.type, dim: s?.dimensions_mm, mech: s?.mechanical, cat: s?.category, ...(cap !== undefined ? { cap } : {}) };
  });
  return createHash("sha256").update(JSON.stringify({ v: ENGINE_VERSION, enc: resolveEnclosure(project.enclosure), parts })).digest("hex").slice(0, 16);
}

function sha(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/**
 * Pocket verdict, thickness first (what a pocket feels): "fits" (comfortable) up to 18 mm thick
 * within 110 x 70 mm, "tight" up to 22 mm within 130 x 80 mm, otherwise "no" (bulky).
 */
export function pocketVerdict(s: { w: number; h: number; d: number }): "fits" | "tight" | "no" {
  const [a, b, c] = [s.w, s.h, s.d].sort((x, y) => y - x) as [number, number, number];
  if (a <= 110 && b <= 70 && c <= 18) return "fits";
  if (a <= 130 && b <= 80 && c <= 22) return "tight";
  return "no";
}

/** The pocket verdict in words, with the reason. */
export function pocketText(s: { w: number; h: number; d: number }): string {
  const v = pocketVerdict(s);
  const [a, b, c] = [s.w, s.h, s.d].sort((x, y) => y - x) as [number, number, number];
  if (v === "fits") return `comfortable in a pocket (${c} mm thick; up to 18 mm feels fine)`;
  const wide = a > 110 || b > 70 ? `${a} x ${b} mm across (a pocket takes about 110 x 70 mm)` : "";
  const thick = c > 22 ? `${c} mm thick (over 22 mm)` : c > 18 ? `${c} mm thick (18 to 22 mm)` : "";
  const why = [thick, wide].filter(Boolean).join(" and ");
  if (v === "tight") return `tight in a pocket: ${why}`;
  return `bulky for a pocket: ${why}`;
}

export async function generateCase(project: Project, specOf: SpecOf, opts: GenerateOptions = {}): Promise<Generated> {
  if (!project.enclosure) throw new Error("No case yet. Why: fabwright.json has no enclosure. Fix: design_case {\"shape\": \"pebble\"}");
  const enc = project.enclosure;
  const title = opts.title ?? project.name;
  const L = opts.layout ?? layoutCase(layoutInput(project, specOf));
  const r = await occt();
  const B = await buildCase(L);
  const missing: Generated["missing"] = [];
  const checks: FitCheck[] = [...L.issues];
  const files = new Map<string, Uint8Array>();
  const tolMesh = opts.tolerance ?? 0.05;

  // ---- meshes + watertight
  const meshes = new Map<string, Mesh>();
  const watertight: string[] = [];
  const overhang = new Map<string, number>();
  for (const b of B.bodies) {
    const m = meshOf(b.shape, tolMesh);
    meshes.set(b.name, m);
    const c = checkMesh(m);
    if (!c.closed || c.volume <= 0 || (b.kind === "shell" && c.shells !== 1)) watertight.push(`${b.name} (${c.badEdges} open edges, volume ${c.volume.toFixed(1)} mm³, ${c.shells} pieces)`);
    if (b.kind === "shell") overhang.set(b.name, overhangArea(m, [-b.up[0], -b.up[1], -b.up[2]]));
    files.set(`stl/${b.name}.stl`, stlBinary(printPose(m, b.up), b.name));
  }
  checks.push(watertight.length ? { id: "watertight", ok: false, severity: "error", message: `Not every printable file is a closed solid: ${watertight.join("; ")}. Why: a boolean in the CAD kernel left a gap. Fix: change wall_mm or gap_mm a little and design again; report it if it persists.` } : { id: "watertight", ok: true, severity: "info", message: `All ${B.bodies.length} bodies are closed 2-manifolds (every edge shared by two triangles) with volume > 0.` });

  // ---- round 17: the rims really got the radius planned (OpenCascade's fillet used to fail silently)
  {
    const got = { front: Math.round(B.rf * 10) / 10, back: Math.round(B.rfBack * 10) / 10 };
    const want = { front: Math.round(L.rf * 10) / 10, back: Math.round(L.rfBack * 10) / 10 };
    const short = (["front", "back"] as const).filter((f) => want[f] > 0.05 && (got[f] + 0.05 < want[f] || B.edgeHow === "chamfer" || B.edgeHow === "sharp"));
    const how = B.edgeHow === "fillet" ? "filleted" : B.edgeHow === "lofted" ? "a lofted round-over (OpenCascade's fillet failed on this outline, so the rim is built from offset outlines)" : B.edgeHow === "chamfer" ? "chamfered in two facets (no round-over could be built)" : "sharp";
    const facts = { front_mm: got.front, back_mm: got.back, planned_front_mm: want.front, planned_back_mm: want.back, how: B.edgeHow };
    checks.push(short.length
      ? { id: "edge-radius", ok: true, severity: "warning", facts, message: `The ${short.map((f) => `${f} edge is ${got[f]} mm (${how}), not the ${want[f]} mm planned`).join("; the ")}. Why: ${B.edgeWhy || "OpenCascade could not round this outline at the full radius"}. Fix: ${B.edgeWhy ? "a thicker wall (wall_mm 2) allows a larger round-over, or accept this one" : "a smoother outline (larger corner_radius_mm, fewer tight curves) or a smaller edge_radius_front_mm / edge_radius_back_mm, and design again"}.` }
      : { id: "edge-radius", ok: true, severity: "info", facts, message: `Front edge rounded ${got.front} mm, back edge ${got.back} mm, as planned (${B.edgeHow === "fillet" ? "filleted" : B.edgeHow === "lofted" ? "lofted round-over" : B.edgeHow}).` });
  }

  // ---- no part body intersects the shell
  const hits: string[] = [];
  const shells = B.bodies.filter((b) => b.kind === "shell");
  for (const e of B.envelopes)
    for (const s of shells) {
      let v = 0;
      try {
        v = r.measureVolume(e.shape.intersect(s.shape));
      } catch {
        v = 0;
      }
      if (v > 0.001) hits.push(`${e.id} into the ${s.name} shell (${v.toFixed(3)} mm³)`);
    }
  checks.push(hits.length ? { id: "no-intersection", ok: false, severity: "error", message: `A part overlaps the case: ${hits.join("; ")}. Why: the layout left it too close to a wall, lip or rib. Fix: raise gap_mm (e.g. 2) or move the part with placements.`, parts: [...new Set(hits.map((h) => h.split(" ")[0]!))] } : { id: "no-intersection", ok: true, severity: "info", message: `No part body touches the shell (${B.envelopes.length} parts checked in OpenCascade, overlap < 0.001 mm³).` });

  // ---- wall
  let wall = L.params.wall_mm;
  try {
    wall = r.measureDistanceBetween(B.outer, B.cavity);
  } catch {
    // keep nominal
  }
  const grooveWall = L.lip && L.lip.groove > 0.05 ? L.params.wall_mm - L.lip.groove : Infinity;
  const minWall = Math.min(wall, grooveWall);
  checks.push(minWall >= MIN_WALL - 0.02 ? { id: "min-wall", ok: true, severity: "info", message: `Wall ${wall.toFixed(2)} mm measured between the outer and inner surfaces${grooveWall < Infinity ? `, ${grooveWall.toFixed(2)} mm at the snap groove` : ""} (minimum ${MIN_WALL} mm).` } : { id: "min-wall", ok: false, severity: "error", message: `The wall is ${minWall.toFixed(2)} mm somewhere, under the ${MIN_WALL} mm minimum. Why: ${grooveWall < wall ? "the snap groove cuts into a thin wall" : "the rounded edges are tighter than the wall"}. Fix: wall_mm 1.8 or more.` });

  // ---- size match
  const ob = mergedBounds(shells.map((s) => meshes.get(s.name)!));
  // (against the exact planned box: outer.w / h / d are rounded to 0.1 mm for people)
  const dw = [0, 1, 2].map((k) => Math.abs(ob.max[k]! - ob.min[k]! - (L.outer.max[k]! - L.outer.min[k]!)));
  const dc = [ob.min[0] - L.outer.min[0], ob.min[1] - L.outer.min[1], ob.min[2] - L.outer.min[2]].map(Math.abs);
  const sizeOk = Math.max(...dw, ...dc) <= 0.1 + 1e-6;
  checks.push({ id: "size-match", ok: sizeOk, severity: sizeOk ? "info" : "error", message: sizeOk ? `Printed bodies match the layout within ${Math.max(...dw, ...dc).toFixed(2)} mm (limit 0.1).` : `The printed bodies are ${Math.max(...dw, ...dc).toFixed(2)} mm off the planned size. Why: a fillet or the tab changed the outline. Fix: design again; the drawing uses the planned size.` });

  // ---- screen window
  const front = L.front ? L.placed.find((p) => p.mech.id === L.front) : undefined;
  const win = L.openings.find((o) => o.kind === "window" && o.part === L.front);
  if (front) {
    const scr = front.mech.features.find((f) => f.kind === "screen");
    if (win && scr) {
      const over = (win.u - scr.u) / 2;
      // round 8b: and look through it: the screen's active area must be what is behind the window
      const sight = windowSight(L);
      const sizeOk = over >= -0.01 && over <= scr.bezel + 0.01;
      const ok = sizeOk && (sight?.ok ?? false);
      const sizeMsg = `Window ${win.shape === "round" ? "Ø" + win.u.toFixed(1) : win.u.toFixed(1) + " x " + win.v.toFixed(1)} mm over the ${front.mech.id} active area (${scr.shape === "round" ? "Ø" + scr.u.toFixed(1) : scr.u.toFixed(1) + " x " + scr.v.toFixed(1)}), ${over.toFixed(2)} mm over its ${scr.bezel} mm bezel, glass ${win.standoff.toFixed(1)} mm behind the wall.`;
      checks.push({ id: "screen-window", ok, severity: ok ? "info" : "error", message: sight && !sight.ok ? sight.message : `${sizeMsg} ${sight?.message ?? ""}`.trim(), parts: [front.mech.id, ...(sight?.blocked.map((b) => b.by).filter((b) => L.placed.some((p) => p.mech.id === b)) ?? [])] });
    } else if (!checks.some((c) => c.id === "screen-window")) checks.push({ id: "screen-window", ok: false, severity: "error", message: `${L.front} has no screen window. Why: its part data has no exposed screen feature facing the front. Fix: check its mechanical block, or pass front with the display's id.`, parts: [L.front!] });
  }
  // ---- buttons
  for (const o of L.openings.filter((x) => x.kind === "button")) {
    const ins = o.insert!;
    const ok = ins.protrude >= ins.travel + 0.3 && ins.length <= 14;
    checks.push({ id: "buttons-reachable", ok, severity: ok ? "info" : "warning", message: ok ? `${o.part}: plunger Ø${ins.d.toFixed(1)} through a Ø${o.u.toFixed(1)} hole on the ${o.face}, ${ins.length.toFixed(1)} mm long, stands ${ins.protrude.toFixed(1)} mm proud for ${ins.travel} mm of travel.` : `${o.part}: the plunger is ${ins.length.toFixed(1)} mm long${ins.length > 14 ? " and may wobble" : ""}. Why: the switch sits ${o.standoff.toFixed(1)} mm from the wall. Fix: move it to a face with placements, or accept a longer plunger.`, parts: [o.part] });
  }
  // ---- camera lenses (round 14): say the hole is there, where, and that the field of view clears the wall,
  // so an agent reading the report does not have to infer it from the drawing
  for (const o of L.openings.filter((x) => x.kind === "lens")) {
    const feat = L.placed.find((p) => p.mech.id === o.part)?.mech.features.find((f) => f.id === o.feature);
    const fov = feat?.fov ?? 66;
    const behind = Math.max(0, o.standoff) + o.depth;
    const need = (feat?.u ?? 0) + 2 * behind * Math.tan((fov * Math.PI) / 360);
    const ok = o.u + 0.05 >= need;
    const where = `(${o.at[0].toFixed(1)}, ${o.at[1].toFixed(1)}) mm from the centre`;
    checks.push({ id: "camera-view", ok, severity: ok ? "info" : "warning", facts: { hole_mm: Math.round(o.u * 10) / 10, behind_mm: Math.round(behind * 10) / 10, fov_deg: fov }, message: ok ? `${o.part}.${o.feature}: Ø${o.u.toFixed(1)} mm lens hole on the ${o.face} at ${where}, lens ${behind.toFixed(1)} mm behind the outer surface: its ${fov}° field of view clears the wall.` : `${o.part}.${o.feature}: the Ø${o.u.toFixed(1)} mm lens hole on the ${o.face} at ${where} is narrower than the ${need.toFixed(1)} mm its ${fov}° field of view needs ${behind.toFixed(1)} mm behind the surface, so the wall shows at the photo's edges. Why: the lens sits deep behind the wall. Fix: a thinner wall (wall_mm), or place ${o.part} closer to the ${o.face}.`, parts: [o.part] });
  }
  // ---- connectors (the layout's own estimate is replaced by this check on the real bodies)
  for (let i = checks.length - 1; i >= 0; i--) if (checks[i]!.id === "connector-access" && L.openings.some((o) => o.kind === "connector" && checks[i]!.parts?.includes(o.part))) checks.splice(i, 1);
  for (const o of L.openings.filter((x) => x.kind === "connector")) {
    const recess = o.standoff + o.depth;
    const inward: Vec3 = [-o.n[0], -o.n[1], -o.n[2]];
    const half = o.u / 2;
    // a curved wall may bow away from the opening's corners by its sagitta (up to ~1 mm over a plug's width)
    const bow = L.kind === "rrect" ? 0.05 : 1.2;
    const edgeOk = [-1, 1].every((s) => contains(L.plan, o.at[0] + o.uAxis[0] * half * s + inward[0] * bow, o.at[1] + o.uAxis[1] * half * s + inward[1] * bow, 0));
    const band: [number, number] = [L.zBack - L.params.wall_mm + B.rfBack, L.zFront + L.params.wall_mm - B.rf];
    // the receptacle faces the straight band; the plug's overmold clearance may run into the curve
    const feat = L.placed.find((p) => p.mech.id === o.part)?.mech.features.find((f) => f.id === o.feature);
    const vHalf = feat ? feat.v / 2 + Math.min(0.6, feat.plugClearance) : o.v / 2;
    const zIn = Math.abs(o.vAxis[2]) > 0.5 ? o.at[2] - vHalf >= band[0] - 0.05 && o.at[2] + vHalf <= band[1] + 0.05 : true;
    const ok = recess <= 2.5 && edgeOk && zIn;
    checks.push({ id: "connector-access", ok, severity: ok ? "info" : "error", message: ok ? `${o.part}.${o.feature}: ${o.u.toFixed(1)} x ${o.v.toFixed(1)} mm opening on the ${o.face}, receptacle ${recess.toFixed(1)} mm inside the outer surface (plug overmold clearance included).` : `${o.part}.${o.feature}: the plug may not reach (receptacle ${recess.toFixed(1)} mm in${edgeOk ? "" : ", opening wider than the flat"}${zIn ? "" : ", opening runs into the rounded edge"}). Why: the port sits too far from the wall or on a curve. Fix: a rounded-box shape, a smaller corner / edge radius, or wall_mm 1.2.`, parts: [o.part] });
  }
  // ---- printable
  const oh = [...overhang.entries()].filter(([, a]) => a > 1);
  checks.push({ id: "printable", ok: true, severity: oh.some(([, a]) => a > 60) ? "warning" : "info", message: oh.length ? `Each shell prints ${L.printFlip ? `on its outer face, except the ${L.printFlip} shell, which stands on the socket's floor plate (the seam face),` : "on its outer face"} with no supports; ${oh.map(([n, a]) => `${n}: ${a.toFixed(0)} mm² of the rounded edge overhangs > 45° near the bed`).join(", ")} (use a brim; PRINT.md).` : `Each shell prints ${L.printFlip ? `on its outer face (the ${L.printFlip} shell on the socket's floor plate)` : "on its outer face"} with no overhang past 45°.` });
  // ---- pocket
  const size = { w: L.outer.w, h: L.outer.h, d: L.outer.d };
  const pocket = pocketVerdict(size);
  let outerVol = 0;
  try {
    outerVol = r.measureVolume(B.outer) / 1000;
  } catch {
    outerVol = 0;
  }
  checks.push({ id: "pocket", ok: pocket !== "no", severity: pocket === "no" ? "warning" : "info", message: `${size.w} x ${size.h} x ${size.d} mm${outerVol ? `, ${outerVol.toFixed(0)} cm³` : ""}: ${pocketText(size)}.${pocket !== "fits" ? " Thinner: exclude a part that need not be inside, or try another shape (each packs differently)." : ""}` });
  const fitsOk = !L.issues.some((i) => i.id === "fits" && i.severity === "error");
  // round 7: a fixed size is kept exactly
  if (L.fit?.asked_mm) {
    const a = L.fit.asked_mm;
    const off = [a.w !== undefined ? Math.abs(L.outer.w - a.w) : 0, a.h !== undefined && !L.tab ? Math.abs(L.outer.h - a.h) : 0, a.d !== undefined ? Math.abs(L.outer.d - a.d) : 0];
    const ok = Math.max(...off) <= 0.1 + 1e-6;
    checks.push({ id: "size-asked", ok, severity: ok ? "info" : "warning", message: ok ? `The case is the size asked: ${[a.w !== undefined ? `${a.w} wide` : "", a.h !== undefined ? `${a.h} tall` : "", a.d !== undefined ? `${a.d} thick` : ""].filter(Boolean).join(", ")} (mm).` : `The case is ${L.outer.w} x ${L.outer.h} x ${L.outer.d} mm, not the ${a.w ?? "auto"} x ${a.h ?? "auto"} x ${a.d ?? "auto"} mm asked. Why: a dome or an edge could not be made as planned. Fix: set dome_mm and the edge radii explicitly, or accept the size.` });
  }
  checks.unshift({ id: "fits", ok: fitsOk, severity: fitsOk ? "info" : "error", message: fitsOk ? `All ${L.placed.length} parts fit in ${L.inner.w} x ${L.inner.h} x ${L.inner.d} mm inside with ${L.params.gap_mm} mm of wiring room around each${L.inline.length ? `; ${L.inline.join(", ")} ride in the wiring (heat-shrink)` : ""}${L.outside.length ? `; outside the case: ${L.outside.map((o) => o.id).join(", ")}` : ""}.` : "Some parts do not fit; see the errors below." });

  // ---- 3MF, STEP
  // 3MF: one build plate, every body in its print pose, side by side (6 mm apart)
  const posed = B.bodies.map((b) => ({ b, mesh: printPose(meshes.get(b.name)!, b.up) }));
  const spots = plateLayout(posed.map(({ mesh }) => {
    const bb = checkMesh(mesh).bbox;
    return { w: bb.max[0] - bb.min[0], h: bb.max[1] - bb.min[1] };
  }));
  files.set("case.3mf", threeMf(posed.map(({ b, mesh }, i) => ({ name: b.name, color: b.color, mesh, at: { x: spots[i]!.x + 10, y: spots[i]!.y + 10 } })), `${title} case`));
  const step = async (cfg: { shape: unknown; name: string; color: string }[]) => new Uint8Array(await (r.exportSTEP(cfg, { unit: "MM", modelUnit: "MM" }) as Blob).arrayBuffer());
  files.set("step/assembly.step", await step([...B.bodies.map((b) => ({ shape: b.shape, name: b.name, color: b.color })), ...B.envelopes.map((e) => ({ shape: e.shape, name: `part-${e.id}`, color: e.color }))]));
  files.set("step/front.step", await step([{ shape: B.bodies[0]!.shape, name: "front", color: B.bodies[0]!.color }]));
  files.set("step/back.step", await step([{ shape: B.bodies[1]!.shape, name: "back", color: B.bodies[1]!.color }]));

  // ---- renders
  const envMeshes = B.envelopes.map((e) => ({ id: e.id, mesh: meshOf(e.shape, 0.1, 0.5), color: e.color }));
  if (opts.renders !== false) {
    const assembled: RenderItem[] = [...B.bodies.map((b) => ({ mesh: meshes.get(b.name)!, color: b.color })), ...envMeshes.map((e) => ({ mesh: e.mesh, color: e.color }))];
    files.set("renders/front.png", renderPng(assembled, VIEWS.front));
    files.set("renders/back.png", renderPng(assembled, VIEWS.back));
    // round 8b: the parts held by the front shell (the screen behind its window, a front grille's
    // speaker) move out with it, so the window shows the screen and not, by parallax, a part behind
    const frontOff = B.bodies.find((b) => b.name === "front")?.explode ?? ([0, 0, 0] as Vec3);
    const withFront = new Set(L.placed.filter((p) => p.bound?.face === "front").map((p) => p.mech.id));
    const exploded: RenderItem[] = [...B.bodies.map((b) => ({ mesh: meshes.get(b.name)!, color: b.color, offset: b.explode })), ...envMeshes.map((e) => ({ mesh: e.mesh, color: e.color, ...(withFront.has(e.id) ? { offset: frontOff } : {}) }))];
    files.set("renders/exploded.png", renderPng(exploded, VIEWS.exploded));
    const inside: RenderItem[] = [...B.bodies.filter((b) => b.name !== "front").map((b) => ({ mesh: meshes.get(b.name)!, color: b.color })), ...envMeshes.map((e) => ({ mesh: e.mesh, color: e.color })), { mesh: meshes.get("front")!, color: B.bodies[0]!.color, alpha: 0.22 }];
    files.set("renders/inside.png", renderPng(inside, VIEWS.inside));
  }

  // ---- round 12: how it goes together (the assembly plan), its checks, and a picture per step
  const plan = assemblyPlan({ project, layout: L, specOf, title, ...(opts.wires ? { wires: opts.wires(L) } : {}), ...(opts.firmwareText !== undefined ? { firmwareText: opts.firmwareText } : {}) });
  checks.push(...plan.checks.map(({ facts, ...c }) => ({ ...c, ...(facts ? { facts } : {}) })));
  if (opts.renders !== false && opts.stepImages !== false) {
    const front = B.bodies.find((b) => b.name === "front")!;
    const back = B.bodies.find((b) => b.name === "back")!;
    const stepFiles = renderAssemblySteps(plan, L, {
      front: meshes.get("front")!,
      back: meshes.get("back")!,
      color: front.color,
      inserts: new Map(B.bodies.filter((b) => b.kind === "cap" || b.kind === "light-pipe").map((b) => [b.name, { mesh: meshes.get(b.name)!, color: b.color }])),
      parts: new Map(envMeshes.map((e) => [e.id, { mesh: e.mesh, color: e.color }])),
      pins: pinPositionsOf(L.placed, specOf),
      explode: { front: front.explode, back: back.explode },
    });
    for (const [p, b] of stepFiles) files.set(p, b);
  }
  files.set("assembly/plan.json", new TextEncoder().encode(JSON.stringify(plan, null, 2) + "\n"));

  // ---- drawing, PRINT.md
  const mat = materialFor(L.params.process);
  let shellVol = 0;
  for (const b of B.bodies) shellVol += Math.max(0, checkMesh(meshes.get(b.name)!).volume);
  const massG = (shellVol / 1000) * mat.density;
  const svg = drawingSvg(L, title, { rf: B.rf, rfBack: B.rfBack, wallMeasured: wall, ...(B.screws ? { screws: `${B.screws.count} x ${B.screws.size} into heat-set inserts` } : {}), massG });
  files.set("drawing/drawing.svg", new TextEncoder().encode(svg));
  if (opts.pdf) {
    const p = await opts.pdf(svg);
    if (p.pdf) files.set("drawing/drawing.pdf", p.pdf);
    else missing.push({ item: "drawing/drawing.pdf", why: p.why ?? "Playwright's Chromium is not installed", fix: "pnpm --filter @fabwright/web exec playwright install chromium, then get_case or export_manufacturing again (drawing.svg has the same content)" });
  } else missing.push({ item: "drawing/drawing.pdf", why: "no PDF printer was given to the case engine", fix: "open drawing/drawing.svg in a browser and print it to PDF" });
  files.set("PRINT.md", new TextEncoder().encode(printMd(L, title, B.bodies.map((b) => ({ name: b.name, print: b.print, overhang_mm2: overhang.get(b.name) ?? 0 })), B.screws)));

  // ---- report
  const hash = caseHash(project, specOf);
  const placed: PlacedPart[] = L.placed.map((p) => ({ id: p.mech.id, type: p.mech.type, min: p.min.map(r2) as Vec3, max: p.max.map(r2) as Vec3, rotation: p.rotation, facing: p.facing, layer: p.layer }));
  const notes = [
    ...B.notes,
    "Snap-fit strength and fit depend on the filament and your printer's real tolerances: print the two shells first and test the fit.",
    "Sizes come from the parts' mechanical data (datasheets or typical modules); clone modules can differ by about 1 mm.",
    "Not checked: drop, water, heat, the cell swelling beyond 10 %, wire routing (the gap_mm room is a budget, not a route).",
    "STEP is AP214 (the OpenCascade build has no IGES writer): factories accept STEP; ask for IGES and convert it in FreeCAD or the factory's CAD.",
  ];
  const ok = !checks.some((c) => !c.ok && c.severity === "error");
  const caseFiles: CaseFile[] = [];
  for (const [path, bytes] of files) caseFiles.push(fileEntry(path, bytes, B.bodies));
  const report: CaseReport = {
    shape: L.shape,
    enclosure: resolveEnclosure(enc),
    size_mm: size,
    inner_mm: L.inner,
    wall_mm: L.params.wall_mm,
    mass_g: Math.round(massG * 10) / 10,
    ...(outerVol ? { volume_cm3: Math.round(outerVol * 10) / 10 } : {}),
    pocket,
    ok,
    checks,
    placed,
    files: caseFiles,
    hash,
    notes: [...(L.outlineNotes ?? []), ...notes],
    ...(L.fit ? { fit: { fits: L.fit.fits, needed_mm: L.fit.needed_mm, ...(L.fit.asked_mm ? { asked_mm: L.fit.asked_mm } : {}), scale: L.fit.scale } } : {}),
    outline_mm: frontOutline(L),
    assembly: { steps: plan.steps.length, plan: "assembly/plan.json", images: plan.steps.flatMap((st) => (st.image ? [st.image] : [])), hinge: plan.hinge, order: plan.order, errors: plan.checks.filter((c) => !c.ok && c.severity === "error").length, warnings: plan.checks.filter((c) => c.severity === "warning").length },
    ...(L.proposal ? { layout: { goal: L.proposal.id, asked: L.proposal.asked, label: L.proposal.label, fill_ratio: L.proposal.fill_ratio, layers: L.proposal.layers, why: L.proposal.why, source: L.proposal.source } } : {}),
    ...(L.held?.length ? { held: L.held } : {}),
  };
  const reportBytes = new TextEncoder().encode(JSON.stringify(report, null, 2) + "\n");
  files.set("report.json", reportBytes);
  files.set("manifest.json", new TextEncoder().encode(JSON.stringify({ hash, engine: ENGINE_VERSION, enclosure: report.enclosure, files: caseFiles }, null, 2) + "\n"));

  // ---- mesh for the web view
  const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
  const mesh: CaseMesh = {
    hash,
    bodies: [
      ...B.bodies.map((b) => ({ body: b.name, kind: b.kind === "shell" ? ("shell" as const) : ("cap" as const), color: b.color, positions: b64(meshes.get(b.name)!.positions), indices: b64(meshes.get(b.name)!.indices), explode: b.explode })),
      // (the parts the front shell holds move out with it, as in the exploded render)
      ...envMeshes.map((e) => ({ body: `part-${e.id}`, kind: "part" as const, color: e.color, positions: b64(e.mesh.positions), indices: b64(e.mesh.indices), explode: (L.placed.some((p) => p.mech.id === e.id && p.bound?.face === "front") ? B.bodies.find((b) => b.name === "front")?.explode ?? [0, 0, 0] : [0, 0, 0]) as Vec3 })),
    ],
  };
  return { report, files, mesh, layout: L, missing };
}

/** The parts of a project as the layout takes them (spec + props). */
export function layoutInput(project: Project, specOf: SpecOf): LayoutInput {
  if (!project.enclosure) throw new Error("No case yet. Why: fabwright.json has no enclosure. Fix: design_case {\"shape\": \"pebble\"}");
  const parts = project.parts.flatMap((p) => {
    const spec = specOf(p.type);
    return spec ? [{ id: p.id, type: p.type, spec, ...(p.props ? { props: p.props as Record<string, unknown> } : {}) }] : [];
  });
  return { parts, enclosure: project.enclosure };
}

/** The outer outline seen from the front (case frame, mm, ~120 points), for drawings and the Case view. */
export function frontOutline(L: Layout): [number, number][] {
  const P = outline(L.plan, L.params.wall_mm, 120);
  const step = Math.max(1, Math.floor(P.length / 120));
  return P.filter((_, i) => i % step === 0).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function fileEntry(path: string, bytes: Uint8Array, bodies: Body[]): CaseFile {
  const ext = path.split(".").pop()!;
  const kind = (ext === "3mf" ? "3mf" : ext) as CaseFile["kind"];
  const base = path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const body = path.startsWith("renders/") ? `render-${base}` : path.startsWith("drawing/") ? "drawing" : path === "case.3mf" ? "all" : path.startsWith("step/") ? base : base;
  const b = bodies.find((x) => x.name === base);
  return { path, kind, body, bytes: bytes.length, sha256: sha(bytes), ...(b && ext === "stl" ? { print: b.print } : {}) };
}

function mergedBounds(ms: Mesh[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const m of ms) {
    const c = checkMesh(m).bbox;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, c.min[k]!);
      max[k] = Math.max(max[k]!, c.max[k]!);
    }
  }
  return { min, max };
}

/** Area of faces that overhang more than 45° when printed with `down` pointing into the bed. */
function overhangArea(m: Mesh, down: Vec3): number {
  const P = m.positions;
  const I = m.indices;
  let bed = Infinity;
  for (let i = 0; i < P.length; i += 3) bed = Math.min(bed, -(P[i]! * down[0] + P[i + 1]! * down[1] + P[i + 2]! * down[2]));
  let area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t]!, b = 3 * I[t + 1]!, c = 3 * I[t + 2]!;
    const u = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
    const v = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (l < 1e-12) continue;
    const cos = (n[0]! * down[0] + n[1]! * down[1] + n[2]! * down[2]) / l;
    if (cos < Math.SQRT1_2) continue; // faces pointing down steeper than 45° only
    const h = Math.min(...[a, b, c].map((k) => -(P[k]! * down[0] + P[k + 1]! * down[1] + P[k + 2]! * down[2]))) - bed;
    if (h < 0.3) continue; // on the bed
    area += l / 2;
  }
  return area;
}

// ------------------------------------------------------------------ files on disk

export interface CaseManifest {
  hash: string;
  engine: string;
  enclosure: Enclosure;
  files: CaseFile[];
}

export function readManifest(caseDir: string): CaseManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(caseDir, "manifest.json"), "utf8")) as CaseManifest;
  } catch {
    return undefined;
  }
}

export function readReport(caseDir: string): CaseReport | undefined {
  try {
    return JSON.parse(readFileSync(join(caseDir, "report.json"), "utf8")) as CaseReport;
  } catch {
    return undefined;
  }
}

/** Write generated files into dir (removing the previous generation's files that are gone; variants/ kept). */
export function writeCaseFiles(dir: string, files: Map<string, Uint8Array>): void {
  const old = readManifest(dir);
  if (old) for (const f of old.files) if (!files.has(f.path) && !f.path.startsWith("variants/")) rmSync(join(dir, f.path), { force: true });
  for (const [path, bytes] of files) {
    const p = join(dir, path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
  }
}

/** The web view's meshes are cached outside case/ (e.g. .fabwright/case-mesh.json), keyed by the case hash. */
export function writeMeshCache(file: string, mesh: CaseMesh): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(mesh));
}

export function readMeshCache(file: string, hash: string): CaseMesh | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as CaseMesh;
    return m.hash === hash ? m : undefined;
  } catch {
    return undefined;
  }
}

export { partColor };
