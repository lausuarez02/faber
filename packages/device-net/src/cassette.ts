// Cassettes: recorded HTTP exchanges with real hosts, replayed so a test that calls an API runs
// offline and identically. Stored in the project (network/cassettes/<name>.json), so they are
// committed: what goes in is redacted (secret values become [secret:NAME]; request headers are
// kept only as their names; injected headers as their template).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Redactor } from "./secrets.ts";

export interface Interaction {
  request: { method: string; host: string; path: string; body_sha256?: string; header_names: string[] };
  response: { status: number; headers: Record<string, string>; body_b64: string; chunks_ms?: number[] };
  recorded_at: string;
}

export interface CassetteFile {
  version: 1;
  note: string;
  interactions: Interaction[];
}

/** Response headers that are about the hop, not the content, or that leak upstream detail. */
const DROP = new Set(["date", "connection", "keep-alive", "transfer-encoding", "set-cookie", "server", "x-request-id", "cf-ray", "alt-svc", "content-length"]);

export function bodyHash(b: Buffer): string | undefined {
  return b.length ? createHash("sha256").update(b).digest("hex").slice(0, 32) : undefined;
}

export class Cassette {
  private data: CassetteFile;
  /** Replay order per request key, so the n-th identical request gets the n-th recorded answer. */
  private cursor = new Map<string, number>();
  dirty = false;

  constructor(
    readonly file: string,
    private redactor: Redactor,
  ) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as CassetteFile) : { version: 1, note: "Recorded by Faber (network.record). Secrets are redacted.", interactions: [] };
  }

  private key(r: { method: string; host: string; path: string; body_sha256?: string }): string {
    return `${r.method} ${r.host}${r.path} ${r.body_sha256 ?? ""}`;
  }

  find(method: string, host: string, path: string, body: Buffer): Interaction | undefined {
    const k = this.key({ method, host, path, ...(bodyHash(body) ? { body_sha256: bodyHash(body)! } : {}) });
    const all = this.data.interactions.filter((i) => this.key(i.request) === k);
    if (!all.length) return undefined;
    const n = this.cursor.get(k) ?? 0;
    this.cursor.set(k, n + 1);
    return all[Math.min(n, all.length - 1)];
  }

  record(req: { method: string; host: string; path: string; body: Buffer; headerNames: string[] }, res: { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }): void {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined || DROP.has(k.toLowerCase())) continue;
      headers[k.toLowerCase()] = this.redactor.str(Array.isArray(v) ? v.join(", ") : v);
    }
    const bh = bodyHash(req.body);
    this.data.interactions.push({
      request: { method: req.method, host: req.host, path: this.redactor.str(req.path), ...(bh ? { body_sha256: bh } : {}), header_names: req.headerNames.map((h) => h.toLowerCase()).sort() },
      // The body is stored as the device would see it: secret values masked.
      response: { status: res.status, headers, body_b64: this.redactor.maskBytes(res.body).toString("base64") },
      recorded_at: new Date().toISOString(),
    });
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.redactor.deep(this.data), null, 2)}\n`);
    this.dirty = false;
  }

  /** A recorded exchange exists for this host (so DNS resolves it when replaying offline). */
  hasHost(host: string): boolean {
    return this.data.interactions.some((i) => i.request.host === host.toLowerCase());
  }

  get size(): number {
    return this.data.interactions.length;
  }

  rewind(): void {
    this.cursor.clear();
  }
}
