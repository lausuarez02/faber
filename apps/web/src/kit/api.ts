import { NO_SERVER, serverConnection } from "../projects/api.ts";

/**
 * Round 12, track kit: the Build it panel's calls to fabwright serve. The types are a structural copy
 * of packages/session/src/kit/types.ts (the browser never loads @fabwright/session).
 */
export interface KitLink {
  store: string;
  region: string;
  url: string;
  kind: "product" | "search";
}
export interface ShopLine {
  id: string;
  section: "electronics" | "build" | "case";
  qty: number;
  name: string;
  variant: string;
  ask_for: string;
  refs: string;
  unit_usd: number | null;
  ext_usd: number | null;
  price_note: string;
  links: KitLink[];
  no_link?: string;
  alternatives: string[];
  why?: string;
  may_have: boolean;
  source: string;
}
export interface PrintItem {
  file: string;
  body: string;
  label: string;
  material: string;
  color: string;
  color_hex?: string;
  orientation: string;
  supports: boolean;
  layer_mm: number;
  infill_pct: number;
  walls: number;
  grams: number;
  minutes: number;
  /** Measured from the STL as it lies on the bed: width, depth, print height (mm). */
  size_mm?: [number, number, number];
  source: string;
  note?: string;
}
export interface KitWire {
  wire: string;
  from: string;
  to: string;
  from_label: string;
  to_label: string;
  color: string;
  length_mm: number;
  gauge_awg: number;
}
export interface KitStep {
  n: number;
  title: string;
  do: string[];
  image?: string;
  image_alt?: string;
  parts: string[];
  wires: KitWire[];
  cautions: string[];
  check?: string;
  minutes?: number;
}
export interface ConnectPlan {
  /** Said first when the board cannot reach the network at all (no Wi-Fi). */
  warning?: string;
  summary: string;
  needs_relay: boolean;
  hosts: { host: string; secrets: string[]; relayed: boolean }[];
  secrets: { name: string; hosts: string[]; set: boolean }[];
  devices: string[];
  steps: { title: string; do: string[]; commands?: { label: string; cmd: string }[] }[];
  cost: string[];
  notes: string[];
}
export interface BuildKit {
  project: string;
  style: "soldered" | "breadboard";
  summary: string;
  size_mm?: { w: number; h: number; d: number };
  shopping: { lines: ShopLine[]; stores: { store: string; lines: number; total_usd: number }[]; grand_total_usd: number; to_buy_usd: number; unpriced: string[]; notes: string[] };
  print: {
    process: string;
    items: PrintItem[];
    plate?: string;
    total_grams: number;
    total_minutes: number;
    method: string;
    slicer: { found: boolean; name?: string; used: boolean; why?: string };
    service: { files: string[]; material: string; say: string[] };
    settings: string[];
    stale?: string;
  };
  tools: { items: { name: string; why: string; need: "required" | "recommended" | "optional" }[]; skill: string; skill_why: string; time: { print_h: number; build_h: number; total_h: number; note: string } };
  steps: KitStep[];
  steps_source: string;
  flash: { board: string; language: string; method: string; file?: string; kit_file?: string; built: string; steps: string[]; commands: { label: string; cmd: string }[]; needs: string[]; cable?: string; why_missing?: string };
  /** Round 13: how the device reaches its APIs (only for projects on the network). */
  connect?: ConnectPlan;
  troubleshooting: { problem: string; why: string; fix: string; source: string }[];
  missing: { item: string; why: string; fix: string; say: string }[];
  /** The design check's errors and warnings about the circuit (older servers leave it out). */
  check_first?: { severity: "error" | "warning"; code: string; problem: string; why: string; fix: string }[];
  region: string;
}
export interface KitFiles {
  missing: BuildKit["missing"];
  zip_url?: string;
  html_url: string;
  pdf_url?: string;
}

async function req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const conn = await serverConnection();
  if (!conn) throw new Error(NO_SERVER);
  let r: Response;
  try {
    r = await fetch(path, { method, headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method === "POST" ? { "x-fabwright-token": conn.token } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    throw new Error(`Could not reach the Fabwright server. Why: ${(e as Error).message}. Fix: check that fabwright serve is still running, then try again.`);
  }
  const data = (await r.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
  if (!r.ok) throw new Error(data?.error ?? `${method} ${path} failed with HTTP ${r.status}. Why: the server gave no reason. Fix: look at the fabwright serve terminal.`);
  return data as T;
}

export const kitApi = {
  get: (region: string) => req<BuildKit>("GET", `/api/kit?region=${encodeURIComponent(region)}`),
  files: (region: string) => req<KitFiles>("POST", "/api/kit/files", { region }),
  /** A kit picture ("case/renders/inside.png") as a URL the page can show. */
  imageUrl: (p: string) => (p.startsWith("case/") ? `/api/case/file?path=${encodeURIComponent(p.slice(5))}&inline=1` : undefined),
};

/** The person's ticks for one project, kept in this browser only (wrapped: storage can be blocked). */
export function loadTicks(project: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(`fabwright:kit:${project}`);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
export function saveTicks(project: string, ticks: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(`fabwright:kit:${project}`, JSON.stringify(ticks));
  } catch {
    // private mode / blocked storage: the ticks last until the page closes
  }
}
export function loadRegion(): string {
  try {
    return window.localStorage.getItem("fabwright:kit:region") ?? "global";
  } catch {
    return "global";
  }
}
export function saveRegion(r: string): void {
  try {
    window.localStorage.setItem("fabwright:kit:region", r);
  } catch {
    // not remembered
  }
}
