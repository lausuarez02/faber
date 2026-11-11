import type { Enclosure } from "@jumper/project-format";

// The shapes of @jumper/enclosure's CaseReport / CaseMesh (types only: the browser never loads the CAD engine).
export interface FitCheck {
  id: string;
  ok: boolean;
  severity: "error" | "warning" | "info";
  message: string;
  parts?: string[];
}
export interface CaseReport {
  shape: string;
  enclosure: Enclosure;
  size_mm: { w: number; h: number; d: number };
  inner_mm: { w: number; h: number; d: number };
  wall_mm: number;
  mass_g?: number;
  pocket: "fits" | "tight" | "no";
  ok: boolean;
  checks: FitCheck[];
  files: { path: string; kind: string; body: string; bytes: number }[] | string[];
  hash: string;
  notes: string[];
  /** Round 7: a fixed size and whether the parts fit it. */
  fit?: { fits: boolean; needed_mm: { w: number; h: number; d: number }; asked_mm?: { w?: number; h?: number; d?: number }; scale: number };
  /** Round 7: the outer outline seen from the front (case frame, mm). */
  outline_mm?: [number, number][];
  /** Round 8: the distribution the case was built from. */
  layout?: { goal: string; asked: string; label: string; fill_ratio: number; why: string[] };
}

/** Round 7: POST /api/case/fit (check_fit with the front-view preview). */
export interface FitResult {
  fits: boolean;
  shape: string;
  size_mm: { w: number; h: number; d: number };
  needed_mm: { w: number; h: number; d: number };
  asked_mm?: { w?: number; h?: number; d?: number };
  misses: { part: string; type: string; dimension: "outline" | "depth"; short_mm: number; where?: string; message: string }[];
  suggestions: { kind: string; part?: string; from?: string; to?: string; message: string; fits?: boolean; size_mm?: { w: number; h: number; d: number }; tradeoff?: string }[];
  preview: {
    outline: [number, number][];
    cavity: [number, number][];
    parts: { id: string; type: string; collides: boolean; shapes: ({ shape: "rect"; min: [number, number]; max: [number, number] } | { shape: "round"; c: [number, number]; r: number })[] }[];
  };
  notes: string[];
  ms: number;
}
/** Round 8: POST /api/case/layouts (propose_layout with the front and side views). */
export interface LayoutProposal {
  id: "thinnest" | "smallest" | "balanced";
  label: string;
  size_mm: { w: number; h: number; d: number };
  volume_cm3: number;
  pocket: "fits" | "tight" | "no";
  fill_ratio: number;
  layers: { index: number; z_mm: [number, number]; parts: string[] }[];
  placements: Record<string, { x_mm: number; y_mm: number; z_mm: number; rot: number; on_edge: boolean; layer: number; face?: string }>;
  why: string[];
  misses: string[];
  warnings: string[];
  source: string;
  views?: {
    front: { outline: [number, number][]; cavity: [number, number][]; parts: { id: string; label: string; color: string; layer: number; min: [number, number]; max: [number, number] }[] };
    side: { z: [number, number]; y: [number, number]; parts: { id: string; label: string; color: string; layer: number; z: [number, number]; y: [number, number] }[] };
  };
}
export interface LayoutsResult {
  proposals: LayoutProposal[];
  best: string;
  chosen: string;
  parts_volume_cm3: number;
  ms: number;
}
export interface CaseMesh {
  hash: string;
  bodies: { body: string; kind: "shell" | "cap" | "part" | "insert"; color: string; positions: string; indices: string; explode: [number, number, number] }[];
}
import { NO_SERVER, serverConnection } from "../projects/api.ts";

/** Round 6, case track: the Case view's calls to jumper serve (R6). */
export interface CaseState {
  enclosure: Enclosure | null;
  report?: CaseReport;
  stale: boolean;
  /** Shapes made with design_case {save: false} (case/variants/<shape>/), to compare. */
  variants?: { shape: string; size_mm: { w: number; h: number; d: number }; pocket: CaseReport["pocket"]; ok: boolean; files: string[] }[];
}

async function req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const conn = await serverConnection();
  if (!conn) throw new Error(NO_SERVER);
  let r: Response;
  try {
    r = await fetch(path, { method, headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method === "POST" ? { "x-jumper-token": conn.token } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    throw new Error(`Could not reach the Jumper server. Why: ${(e as Error).message}. Fix: check that jumper serve is still running, then try again.`);
  }
  const data = (await r.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
  if (!r.ok) throw new Error(data?.error ?? `${method} ${path} failed with HTTP ${r.status}. Why: the server gave no reason. Fix: look at the jumper serve terminal.`);
  return data as T;
}

export const caseApi = {
  get: () => req<CaseState>("GET", "/api/case"),
  save: (body: Partial<Enclosure>) => req<CaseReport & { error?: string }>("POST", "/api/case", body),
  mesh: () => req<CaseMesh>("GET", "/api/case/mesh"),
  fit: (body: Record<string, unknown>) => req<FitResult>("POST", "/api/case/fit", body),
  layouts: (body: Record<string, unknown>) => req<LayoutsResult>("POST", "/api/case/layouts", body),
  pack: () => req<{ dir: string; zip?: string; url?: string; files: string[]; missing: { item: string; why: string; fix: string; say?: string }[] }>("POST", "/api/manufacturing", {}),
  fileUrl: (path: string) => `/api/case/file?path=${encodeURIComponent(path)}`,
};

export function decodeF32(b64: string): Float32Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

export function decodeU32(b64: string): Uint32Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Uint32Array(u8.buffer);
}
