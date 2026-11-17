// Round 10 (network): the device network as the web app sees it, from faber serve
// (GET /api/network, the same answer as the read_network tool: secrets are names, never values).
// Pure view model (tested without a DOM) and the small API client.
import { NO_SERVER, serverConnection } from "../../projects/api.ts";

export interface DevNetEntry {
  seq: number;
  t_ms: number;
  kind: "dns" | "connect" | "http" | "ws" | "mqtt" | "udp" | "blocked" | "fault" | "wifi" | "dhcp";
  summary: string;
  host?: string;
  port?: number;
  tls?: string;
  method?: string;
  path?: string;
  status?: number;
  source?: string;
  bytes_out?: number;
  bytes_in?: number;
  duration_ms?: number;
  headers?: Record<string, string>;
  secrets_used?: string[];
  frames?: { out: number; in: number; bytes_out: number; bytes_in: number; samples: string[] };
  why?: string;
  fix?: string;
  open?: boolean;
}

export interface DevNetBoard {
  mac: string;
  ip?: string;
  ssid?: string;
  chip?: string;
  shim: boolean;
  joined: boolean;
}

export interface DevNetSnapshot {
  enabled: boolean;
  hint?: string;
  mode?: "offline" | "mock" | "internet";
  allow?: Array<{ host: string; tls: string; secrets?: string[] }>;
  mocks?: string[];
  faults?: Array<{ kind: string; [k: string]: unknown }>;
  entries?: DevNetEntry[];
  last_seq?: number;
  secrets?: Array<{ name: string; set: boolean; hosts: string[] }>;
  secrets_fix?: string;
  boards?: DevNetBoard[];
  boards_note?: string;
}

export interface TryResult {
  ok: boolean;
  status?: number;
  body?: string;
  bytes?: number;
  ms?: number;
  error?: string;
  why?: string;
  fix?: string;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const conn = await serverConnection();
  if (!conn) throw new Error(NO_SERVER);
  let r: Response;
  try {
    r = await fetch(path, { method, headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method === "POST" ? { "x-faber-token": conn.token } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    throw new Error(`Could not reach the Faber server. Why: ${(e as Error).message}. Fix: check that faber serve is still running, then try again.`);
  }
  const data = (await r.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
  if (!r.ok) throw new Error(data?.error ?? `${method} ${path} failed with HTTP ${r.status}. Why: the server gave no reason. Fix: look at the faber serve terminal.`);
  return data as T;
}

export const devnetApi = {
  read: () => call<DevNetSnapshot>("GET", "/api/network"),
  fault: (fault: Record<string, unknown>) => call<{ ok: boolean }>("POST", "/api/network/fault", { fault }),
  tryRequest: (url: string, method = "GET") => call<TryResult>("POST", "/api/network/try", { url, method }),
};

export type Tone = "ok" | "warn" | "err" | "muted" | "pending";

export interface DevNetRow {
  key: string;
  t: string;
  /** "GET", "WS", "MQTT", "Wi-Fi", "DNS", "DHCP", "BLOCKED", "FAULT", "TCP", "UDP". */
  label: string;
  target: string;
  status: string;
  tone: Tone;
  meta: string[];
  /** Frames / packets summarized: "12 out · 50 in · 160 KB". */
  frames?: string;
  samples?: string[];
  why?: string;
  fix?: string;
  secrets?: string[];
  event: boolean;
}

export function fmtT(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(2)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const EVENT_KINDS = new Set(["dns", "wifi", "dhcp", "udp", "fault"]);

/** Log entries → newest-first rows. `events: false` hides Wi-Fi / DHCP / DNS / fault lines. */
export function devnetRows(entries: readonly DevNetEntry[], opts: { events?: boolean; limit?: number } = {}): DevNetRow[] {
  const rows: DevNetRow[] = [];
  for (const e of entries) {
    const event = EVENT_KINDS.has(e.kind);
    if (event && opts.events === false) continue;
    const meta: string[] = [];
    if (e.source) meta.push(e.source);
    if (e.duration_ms !== undefined) meta.push(`${e.duration_ms} ms`);
    if (e.bytes_in) meta.push(fmtBytes(e.bytes_in));
    if (e.tls && e.tls !== "none") meta.push(e.tls === "inspect" ? "TLS (sandbox CA)" : `TLS ${e.tls}`);
    const base = { key: `${e.kind}-${e.seq}`, t: fmtT(e.t_ms), meta, event, ...(e.why ? { why: e.why } : {}), ...(e.fix ? { fix: e.fix } : {}), ...(e.secrets_used?.length ? { secrets: e.secrets_used } : {}) };
    if (e.kind === "http") {
      const s = e.status;
      rows.push({ ...base, label: e.method ?? "HTTP", target: `${e.host ?? ""}${e.path ?? ""}`, status: s ? String(s) : e.open ? "…" : "–", tone: e.open && !s ? "pending" : !s || s >= 500 ? "err" : s >= 400 ? "warn" : "ok" });
    } else if (e.kind === "ws" || e.kind === "mqtt") {
      const f = e.frames;
      rows.push({
        ...base,
        label: e.kind === "ws" ? "WS" : "MQTT",
        target: `${e.host ?? ""}${e.path ?? ""}`,
        status: e.open ? "open" : "closed",
        tone: e.open ? "pending" : "ok",
        ...(f ? { frames: `${f.out} out · ${f.in} in · ${fmtBytes(f.bytes_out + f.bytes_in)}`, samples: f.samples.slice(0, 6) } : {}),
      });
    } else if (e.kind === "blocked") {
      rows.push({ ...base, label: "BLOCKED", target: e.host ?? "", status: "refused", tone: "err" });
    } else if (e.kind === "connect") {
      rows.push({ ...base, label: "TCP", target: `${e.host ?? ""}${e.port ? `:${e.port}` : ""}`, status: e.why ? "failed" : "", tone: e.why ? "err" : "muted" });
    } else {
      const label = e.kind === "wifi" ? "Wi-Fi" : e.kind === "dhcp" ? "DHCP" : e.kind === "dns" ? "DNS" : e.kind === "fault" ? "FAULT" : "UDP";
      const tone: Tone = e.kind === "fault" ? "warn" : e.why ? "err" : /dropped|could not/.test(e.summary) ? "err" : "muted";
      rows.push({ ...base, label, target: e.summary, status: "", tone });
    }
  }
  return rows.slice(-(opts.limit ?? 120)).reverse();
}

/** "joined FaberNet · 10.0.2.15 · -55 dBm" for the header, from the boards on the LAN and the log. */
export function wifiSummary(snap: DevNetSnapshot): { text: string; tone: Tone } {
  const dropped = snap.faults?.some((f) => f.kind === "wifi_drop");
  if (dropped) return { text: "Wi-Fi dropped (fault)", tone: "err" };
  const b = snap.boards ?? [];
  if (!b.length) return { text: "no board on the network yet", tone: "muted" };
  const j = b.filter((x) => x.joined || !x.shim);
  if (!j.length) return { text: `${b.length} board${b.length > 1 ? "s" : ""}, not joined`, tone: "warn" };
  const weak = snap.faults?.find((f) => f.kind === "weak_signal");
  const first = j[0]!;
  return { text: `${first.ssid ? `"${first.ssid}" · ` : ""}${first.ip ?? "no lease yet"}${weak ? ` · weak ${String(weak.rssi ?? -85)} dBm` : ""}${j.length > 1 ? ` · +${j.length - 1}` : ""}`, tone: weak ? "warn" : "ok" };
}
