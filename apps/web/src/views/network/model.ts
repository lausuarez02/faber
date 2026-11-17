// Pure view model of the network panel: log entries → rows (tested without a DOM).
import type { NetLogEntry } from "@fabwright/ai-gateway";

export interface RequestRow {
  key: string;
  t: string;
  method: string;
  target: string;
  status: string;
  tone: "ok" | "warn" | "err" | "pending";
  latency: string;
  provider: string;
  body: string;
  note?: string;
}

export interface EventRow {
  key: string;
  t: string;
  kind: "wifi" | "dns" | "tcp";
  tone: "ok" | "warn" | "err" | "muted";
  text: string;
}

export type Row = ({ type: "request" } & RequestRow) | ({ type: "event" } & EventRow);

export function fmtTime(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(2)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function toRows(log: readonly NetLogEntry[], opts: { showEvents?: boolean; limit?: number } = {}): Row[] {
  const rows: Row[] = [];
  for (const e of log) {
    if (e.kind === "http") {
      const status = e.pending ? "…" : String(e.status ?? "–");
      const tone: RequestRow["tone"] = e.pending ? "pending" : !e.status || e.status >= 500 ? "err" : e.status >= 400 ? "warn" : "ok";
      rows.push({
        type: "request",
        key: `h${e.id}-${e.seq}`,
        t: fmtTime(e.t),
        method: e.method,
        target: `${e.host}${e.path}${e.query ? `?${e.query}` : ""}`,
        status,
        tone,
        latency: e.latencyMs !== undefined ? `${e.latencyMs} ms` : e.pending ? "waiting" : "",
        provider: e.providerLabel ?? "",
        body: e.responseBody ?? (e.pending ? "" : e.requestPreview),
        ...(e.note ? { note: e.note } : {}),
      });
    } else if (opts.showEvents !== false) {
      const tone: EventRow["tone"] =
        e.kind === "wifi" ? (e.event === "join" || e.event === "restore" ? "ok" : e.event === "leave" ? "muted" : "err") : e.kind === "dns" ? (e.ip ? "muted" : "err") : e.event === "refused" ? "err" : "muted";
      rows.push({ type: "event", key: `e${e.seq}`, t: fmtTime(e.t), kind: e.kind, tone, text: e.message });
    }
  }
  const limit = opts.limit ?? 80;
  return rows.slice(-limit).reverse();
}
