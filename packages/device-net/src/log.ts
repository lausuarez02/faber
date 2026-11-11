// The network log: one entry per DNS lookup, connection, HTTP exchange, WebSocket and MQTT session
// (frames and packets summarized, with counts and bytes), blocked attempt (with why / fix) and
// fault. Every entry is redacted before it is stored, so neither the agent (read_network) nor the
// UI (Network panel) can ever see a secret value.
import type { Redactor } from "./secrets.ts";

export type Source = "mock" | "cassette" | "internet" | "sandbox" | "fault";

export interface NetEvent {
  seq: number;
  /** ms since the network started (wall clock in this prototype; virtual time once a backend drives it). */
  t_ms: number;
  kind: "dns" | "connect" | "http" | "ws" | "mqtt" | "udp" | "blocked" | "fault" | "wifi" | "dhcp";
  host?: string;
  port?: number;
  tls?: "inspect" | "passthrough" | "none";
  method?: string;
  path?: string;
  status?: number;
  source?: Source;
  bytes_out?: number;
  bytes_in?: number;
  duration_ms?: number;
  /** Request headers as sent upstream, redacted (secret values become [secret:NAME]). */
  headers?: Record<string, string>;
  /** Secrets injected into this request (names only). */
  secrets_used?: string[];
  frames?: { out: number; in: number; bytes_out: number; bytes_in: number; samples: string[] };
  why?: string;
  fix?: string;
  open?: boolean;
  summary: string;
}

export type NetEventDraft = Omit<NetEvent, "seq" | "t_ms"> & { t_ms?: number };

const MAX_SAMPLES = 12;

export class NetLog {
  private entries: NetEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: NetEvent) => void>();
  readonly start = Date.now();

  constructor(
    private redactor: Redactor,
    private limit = 2000,
  ) {}

  push(d: NetEventDraft): NetEvent {
    const e = this.redactor.deep({ ...d, seq: ++this.seq, t_ms: d.t_ms ?? Date.now() - this.start }) as NetEvent;
    this.entries.push(e);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    for (const l of this.listeners) l(e);
    return e;
  }

  /** Change an open entry (status arrived, bytes grew, closed); the patch is redacted too. */
  update(e: NetEvent, patch: Partial<NetEvent>): void {
    Object.assign(e, this.redactor.deep(patch));
    for (const l of this.listeners) l(e);
  }

  sample(e: NetEvent, line: string, dir: "out" | "in", bytes: number): void {
    const f = (e.frames ??= { out: 0, in: 0, bytes_out: 0, bytes_in: 0, samples: [] });
    if (dir === "out") {
      f.out++;
      f.bytes_out += bytes;
    } else {
      f.in++;
      f.bytes_in += bytes;
    }
    // Keep the first samples and the last one, so a 500-frame stream stays readable.
    const red = this.redactor.str(line);
    if (f.samples.length < MAX_SAMPLES) f.samples.push(red);
    else f.samples[MAX_SAMPLES - 1] = `… ${red}`;
  }

  since(seq = 0): NetEvent[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  onEvent(cb: (e: NetEvent) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  clear(): void {
    this.entries = [];
  }
}
