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
  pack: () => req<{ dir: string; zip?: string; url?: string; files: string[]; missing: { item: string; why: string; fix: string }[] }>("POST", "/api/manufacturing", {}),
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
