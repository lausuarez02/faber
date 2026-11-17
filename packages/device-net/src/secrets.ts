// Secrets, generic: a project names the secrets it needs (OPENAI_API_KEY, WEATHER_KEY, ...);
// their values come from the person's environment or a .env file on their machine, never from
// fabwright.json, the firmware or an export. The sandbox proxy puts them into outbound requests at
// the edge ({{secret:NAME}} in a header template or in a header the device sends), and every
// string that leaves this package (log, tool output, cassette, factory pack) goes through the
// Redactor first.
import { readFileSync, existsSync } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";

export const SECRET_RE = /\{\{\s*secret:([A-Z][A-Z0-9_]{1,63})\s*\}\}/g;

export interface SecretSource {
  /** process.env by default. */
  env?: Record<string, string | undefined>;
  /** A .env file (KEY=value lines). The environment wins over the file. */
  envFile?: string;
}

export interface LoadedSecrets {
  values: Map<string, string>;
  /** Declared names with no value: requests that need them fail with Why/Fix. */
  missing: string[];
}

/** Minimal .env parser: KEY=value, optional quotes, # comments. No expansion. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

export function loadSecrets(names: string[], src: SecretSource = {}): LoadedSecrets {
  const env = src.env ?? process.env;
  const file = src.envFile && existsSync(src.envFile) ? parseDotEnv(readFileSync(src.envFile, "utf8")) : {};
  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const n of names) {
    const v = env[n] ?? file[n];
    if (v && v.length > 0) values.set(n, v);
    else missing.push(n);
  }
  return { values, missing };
}

export class MissingSecretError extends Error {
  constructor(
    readonly secret: string,
    readonly why: string,
    readonly fix: string,
  ) {
    super(`secret ${secret} has no value`);
  }
}

/**
 * Replace {{secret:NAME}} in a template. `allowed` is the list of secrets this host may receive
 * (so a device cannot send OPENAI_API_KEY to a host that was not given it).
 */
export function expandSecrets(template: string, secrets: Map<string, string>, allowed: readonly string[], host: string): { value: string; used: string[] } {
  const used: string[] = [];
  const value = template.replace(SECRET_RE, (_m, name: string) => {
    if (!allowed.includes(name)) {
      throw new MissingSecretError(
        name,
        `${host} is not allowed to receive the secret ${name} (only the hosts that list it under "secrets" in fabwright.json network.allow get it)`,
        `add "${name}" to the "secrets" list of the ${host} entry in network.allow, or send the request to a host that has it`,
      );
    }
    const v = secrets.get(name);
    if (v === undefined) {
      throw new MissingSecretError(
        name,
        `the project declares ${name} but it is not set on this machine (looked in the environment and the project's .env)`,
        `add ${name}=... to the project's .env file (it is git-ignored) or export ${name} before starting Fabwright; never put it in fabwright.json or the firmware`,
      );
    }
    used.push(name);
    return v;
  });
  return { value, used };
}

/** Replaces every known secret value with [secret:NAME] in strings and nested JSON. */
export class Redactor {
  private pairs: Array<[string, string]> = [];

  constructor(secrets: Map<string, string> = new Map()) {
    this.set(secrets);
  }

  set(secrets: Map<string, string>): void {
    // Longest first, so a secret that contains another is masked whole. Values under 4 chars
    // would mask ordinary text; the loader rejects nothing, but they are not worth a key anyway.
    this.pairs = [...secrets.entries()].filter(([, v]) => v.length >= 4).sort((a, b) => b[1].length - a[1].length);
  }

  get longest(): number {
    return this.pairs.reduce((m, [, v]) => Math.max(m, v.length), 0);
  }

  str(s: string): string {
    let out = s;
    for (const [name, v] of this.pairs) if (out.includes(v)) out = out.split(v).join(`[secret:${name}]`);
    return out;
  }

  deep<T>(x: T): T {
    if (typeof x === "string") return this.str(x) as T;
    if (Array.isArray(x)) return x.map((v) => this.deep(v)) as T;
    if (x && typeof x === "object" && !(x instanceof Uint8Array)) {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x)) o[k] = this.deep(v);
      return o as T;
    }
    return x;
  }

  /** Same-length mask for bytes going back to the device (keeps Content-Length valid). */
  maskBytes(buf: Buffer): Buffer {
    let out = buf;
    for (const [, v] of this.pairs) {
      const needle = Buffer.from(v);
      let i = out.indexOf(needle);
      if (i < 0) continue;
      out = Buffer.from(out);
      while (i >= 0) {
        out.fill(0x2a, i, i + needle.length); // '*'
        i = out.indexOf(needle, i + needle.length);
      }
    }
    return out;
  }

  /**
   * How many trailing bytes of buf could be the start of a secret (so they must wait for the next
   * chunk before they can be shown or forwarded). Usually 0, so streams are not delayed.
   */
  private pendingPrefix(buf: Buffer): number {
    let keep = 0;
    for (const [, v] of this.pairs) {
      const needle = Buffer.from(v);
      for (let n = Math.min(needle.length - 1, buf.length); n > keep; n--) {
        if (buf.subarray(buf.length - n).equals(needle.subarray(0, n))) {
          keep = n;
          break;
        }
      }
    }
    return keep;
  }

  /**
   * A stream that masks secrets even when one is split across chunks. It holds back only the
   * trailing bytes that could begin a secret, and lets them go after `flushMs` if nothing follows,
   * so a live stream (SSE, chunked audio, ...) is never stalled waiting for the next chunk.
   */
  maskStream(flushMs = 30): Transform {
    let tail: Buffer = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;
    const self = this;
    const t: Transform = new Transform({
      transform(chunk: Buffer, _enc, cb: TransformCallback) {
        if (timer) clearTimeout(timer);
        const all = self.maskBytes(Buffer.concat([tail, chunk]));
        const keep = self.pendingPrefix(all);
        tail = all.subarray(all.length - keep);
        if (keep) {
          timer = setTimeout(() => {
            if (tail.length) t.push(tail);
            tail = Buffer.alloc(0);
          }, flushMs);
        }
        cb(null, all.subarray(0, all.length - keep));
      },
      flush(cb: TransformCallback) {
        if (timer) clearTimeout(timer);
        cb(null, self.maskBytes(tail));
      },
    });
    return t;
  }
}
