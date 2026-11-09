import type { PartInstance, Project, Rotation } from "@jumper/project-format";
import type { PartRegistry, PartSpec } from "@jumper/sim-core";

const GRID = 20;
const MARGIN = 40;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function sizeOf(spec: PartSpec | undefined, rotation: Rotation = 0): { w: number; h: number } {
  const w = spec?.size.w ?? 80;
  const h = spec?.size.h ?? 80;
  return rotation === 90 || rotation === 270 ? { w: h, h: w } : { w, h };
}

export function boxOf(part: PartInstance, registry: PartRegistry): Box {
  const s = sizeOf(registry.get(part.type)?.spec, part.rotation);
  return { x: part.x, y: part.y, w: s.w, h: s.h };
}

function overlaps(a: Box, b: Box, margin = MARGIN): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;

/**
 * A readable, non-overlapping spot for a new part. Boards go to the right of everything; other parts
 * line up in a row above the board (where the Uno's digital header is), left to right, wrapping upward.
 */
export function autoPlace(project: Project, registry: PartRegistry, spec: PartSpec | undefined, rotation: Rotation = 0): { x: number; y: number } {
  const { w, h } = sizeOf(spec, rotation);
  const boxes = project.parts.map((p) => boxOf(p, registry));
  if (boxes.length === 0) return { x: 0, y: 0 };
  const isBoard = spec?.category === "board";
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  if (isBoard) {
    let x = snap(maxX + 120);
    const y = 0;
    while (boxes.some((b) => overlaps(b, { x, y, w, h }))) x += GRID * 5;
    return { x, y };
  }
  const boardPart = project.parts.find((p) => registry.get(p.type)?.spec.category === "board");
  const board = boardPart ? boxOf(boardPart, registry) : boxes[0]!;
  const others = project.parts.filter((p) => p !== boardPart && registry.get(p.type)?.spec.category !== "board");
  const last = others[others.length - 1];
  let pref: { x: number; y: number };
  if (last) {
    const lb = boxOf(last, registry);
    pref = { x: lb.x + lb.w + 60, y: lb.y + lb.h - h };
    if (pref.x + w > board.x + board.w + 400) pref = { x: board.x, y: Math.min(...others.map((o) => boxOf(o, registry).y)) - h - 80 };
  } else {
    pref = { x: board.x + Math.max(0, board.w * 0.35), y: board.y - h - 100 };
  }
  let best: { x: number; y: number } | undefined;
  let bestScore = Infinity;
  const x0 = snap(Math.min(board.x, pref.x) - 600);
  const x1 = snap(Math.max(maxX, pref.x) + 600);
  const y0 = snap(Math.min(minY, pref.y) - 800);
  const y1 = snap(board.y + board.h + 600);
  for (let y = y0; y <= y1; y += GRID) {
    for (let x = x0; x <= x1; x += GRID) {
      const cand = { x, y, w, h };
      if (boxes.some((b) => overlaps(b, cand))) continue;
      // Prefer the row above the board; below costs a bit more, far away costs a lot.
      const dx = x - pref.x;
      const dy = y - pref.y;
      const below = y > board.y ? 2 : 1;
      const score = Math.hypot(dx, dy * 1.5) * below;
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best ?? { x: snap(maxX + 80), y: 0 };
}

/** Parts overlapping each other (for get_project / check_design hints). */
export function overlappingParts(project: Project, registry: PartRegistry): [string, string][] {
  const out: [string, string][] = [];
  const boxes = project.parts.map((p) => ({ id: p.id, b: boxOf(p, registry) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i]!.b, boxes[j]!.b, 0)) out.push([boxes[i]!.id, boxes[j]!.id]);
  }
  return out;
}
