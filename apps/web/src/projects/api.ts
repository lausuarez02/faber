/**
 * The local server's projects API (apps/cli/src/routes/projects.ts, decision 0003 C3), as the web
 * app uses it. Only pages served by `jumper serve` itself can change things (the token comes from
 * GET /api/connect, which answers same-origin pages only); anywhere else (pnpm dev, a static build)
 * the app runs without a server and says what needs one.
 */

export interface ProjectCard {
  id: string;
  name: string;
  dir: string;
  kind: "project" | "example" | "agent-built" | "registered";
  description?: string;
  board?: string;
  boardName?: string;
  parts: number;
  scenarios?: number;
  updatedAt: string;
  tests?: { passed: number; total: number; at?: string };
  thumbnail: string;
  readOnly: boolean;
  versions?: number;
  /** Agent-made part types on its canvas (create_part). */
  agentMade?: number;
}

export interface ProjectsListing {
  active: string;
  projects: ProjectCard[];
  examples: ProjectCard[];
}

export interface VersionChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface VersionSummary {
  version: number;
  seq: number;
  t: string;
  actor: string;
  client?: string;
  op: string;
  why?: string;
  summary?: string;
  step?: number;
  changes: VersionChanges;
  firmwareHash?: string;
  firmwareBuilt?: boolean;
  hasFrame: boolean;
}

export interface VersionDetail {
  version: number;
  summary: VersionSummary;
  project: import("@jumper/project-format").Project;
  files: Record<string, string>;
  approxFiles?: string[];
  firmware?: { hash: string; hex: string };
  frame?: { t_ms: number; parts: Record<string, Record<string, unknown>> };
  changes: VersionChanges;
}

export interface CompileDiagnostic {
  severity: "error" | "warning" | "note";
  file?: string;
  line?: number;
  column?: number;
  message: string;
  hint?: string;
}

export interface BuildResponse {
  ok: boolean;
  diagnostics: CompileDiagnostic[];
  hash?: string;
  hex?: string;
  size?: string;
  cached?: boolean;
  log?: string;
  error?: string;
  run?: { t_ms?: number; serial?: string; error?: string };
}

/** An error from the server, already in "what. Why: … Fix: …" form. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let connection: Promise<{ token: string } | null> | undefined;

/** The token when this page is served by `jumper serve`, else null. Cached. */
export function serverConnection(fetchFn: typeof fetch = fetch): Promise<{ token: string } | null> {
  connection ??= (async () => {
    try {
      const r = await fetchFn("/api/connect", { headers: { accept: "application/json" } });
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
      const body = (await r.json()) as { token?: string };
      return typeof body.token === "string" ? { token: body.token } : null;
    } catch {
      return null;
    }
  })();
  return connection;
}

/** Forget the cached answer (tests). */
export function resetServerConnection(): void {
  connection = undefined;
}

export const NO_SERVER =
  "This needs the local Jumper server. Why: the page was not opened from `jumper serve`, so there is no project folder to read or write. Fix: run `pnpm start` (or `jumper serve --project <folder>`) and open the URL it prints.";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const conn = await serverConnection();
  if (!conn) throw new ApiError(NO_SERVER, 0);
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method === "GET" ? {} : { "x-jumper-token": conn.token }) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new ApiError(`Could not reach the Jumper server. Why: ${(e as Error).message}. Fix: check that jumper serve is still running, then try again.`, 0);
  }
  const data = (await r.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
  if (!r.ok) throw new ApiError(data?.error ?? `${method} ${path} failed with HTTP ${r.status}. Why: the server gave no reason. Fix: look at the jumper serve terminal for details.`, r.status);
  return data as T;
}

export const api = {
  projects: () => request<ProjectsListing>("GET", "/api/projects"),
  create: (body: { name?: string; template?: string; from?: string }) => request<{ id: string; dir: string }>("POST", "/api/projects", body),
  open: (id: string) => request<{ id: string; dir: string }>("POST", `/api/projects/${id}/open`, {}),
  history: () => request<{ id: string; dir: string; versions: VersionSummary[] }>("GET", "/api/history"),
  version: (n: number) => request<VersionDetail>("GET", `/api/history/${n}`),
  restore: (n: number, why?: string) => request<{ version: number; step: number | null; changes: VersionChanges; note?: string }>("POST", `/api/history/${n}/restore`, why ? { why } : {}),
  files: () => request<{ files: { path: string; size: number }[]; main: string | null }>("GET", "/api/files"),
  file: (path: string) => request<{ path: string; content: string }>("GET", `/api/file?path=${encodeURIComponent(path)}`),
  saveFile: (path: string, content: string) => request<{ path: string; notes?: string[] }>("PUT", "/api/file", { path, content }),
  build: (run: boolean) => request<BuildResponse>("POST", "/api/build", { run }),
};

/** "3 min ago", "yesterday", "12 Mar". */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Who made a change, for people: "Claude Code", "Codex", "You (canvas)", "CLI". */
export function actorLabel(actor: string, client?: string): string {
  if (client) {
    const c = client.toLowerCase();
    if (c.includes("claude-code") || c.includes("claude code")) return "Claude Code";
    if (c.includes("codex")) return "Codex";
    if (c.includes("cursor")) return "Cursor";
    if (c.includes("claude")) return "Claude";
    return client.split(" ")[0]!;
  }
  if (actor === "web") return "You";
  if (actor === "mcp") return "Agent";
  if (actor === "cli") return "CLI";
  return actor;
}

/** "part:led1" → { kind: "part", id: "led1" }. */
export function entityLabel(key: string): { kind: string; id: string } {
  const i = key.indexOf(":");
  if (i < 0) return { kind: key, id: key === "firmware" ? "firmware block" : key === "meta" ? "name" : key };
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
}
