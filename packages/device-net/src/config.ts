// The project's network section (jumper.json "network") and its mock file (network/mocks.json).
// Plain data, git-friendly, no secret values anywhere: secrets are referenced by name only.

/**
 * offline  : Wi-Fi is up but no host answers (DNS fails for everything): tests the "no internet" path.
 * mock     : nothing leaves this machine; mocks and recorded cassettes answer, anything else is
 *            blocked with Why/Fix. The default, and what run_tests always uses.
 * internet : hosts in `allow` also reach the real internet (mocks and cassettes still win).
 */
export type NetMode = "offline" | "mock" | "internet";

export interface AllowEntry {
  /** "api.openai.com" or "*.example.com". */
  host: string;
  /** Default [443, 80]. */
  ports?: number[];
  /**
   * inspect (default): Jumper terminates TLS with the sandbox CA, so it can log paths, inject
   * secrets, record cassettes. passthrough: the bytes go end to end; only host, port, bytes and
   * timing are logged, no secret injection.
   */
  tls?: "inspect" | "passthrough";
  /** Secrets this host may receive. */
  secrets?: string[];
  /** Headers added to every request to this host, e.g. {"Authorization": "Bearer {{secret:OPENAI_API_KEY}}"}. */
  headers?: Record<string, string>;
}

export interface NetworkConfig {
  mode: NetMode;
  allow: AllowEntry[];
  /** Secret names the project needs (values come from the environment / .env). */
  secrets: string[];
  /** Cassette to replay (and record into, in internet mode with record: true). */
  cassette?: string;
  record?: boolean;
  wifi?: { ssid: string; password?: string };
}

// ------------------------------------------------------------------ mocks

export interface HttpMockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** A string, or JSON (sent as application/json). */
  body?: unknown;
  /** Base64 body (binary). */
  body_b64?: string;
  /** A streamed body: each chunk after delay_ms (chunked transfer encoding). */
  chunks?: Array<{ data?: string; b64?: string; bytes?: number; delay_ms?: number }>;
  delay_ms?: number;
}

export interface HttpMock {
  kind?: "http";
  host: string;
  method?: string;
  /** Exact path, or a prefix ending in "*". */
  path: string;
  response: HttpMockResponse;
}

export interface WsFrame {
  text?: string;
  b64?: string;
  /** A binary frame of this many bytes (deterministic pattern). */
  bytes?: number;
  delay_ms?: number;
  /** Repeat this frame n times. */
  repeat?: number;
}

export interface WsMock {
  kind: "ws";
  host: string;
  path: string;
  on_open?: WsFrame[];
  /** First rule whose `match` (substring of a text frame, or "*" for anything) fits answers. */
  on_message?: Array<{ match: string; send: WsFrame[]; close?: boolean }>;
}

export interface MqttMock {
  kind: "mqtt";
  host: string;
  /** When the device publishes to `topic` (MQTT wildcards + and #), publish these back. */
  on_publish?: Array<{ topic: string; reply?: Array<{ topic: string; payload: string }> }>;
  /** Retained messages delivered on subscribe. */
  retained?: Array<{ topic: string; payload: string }>;
}

export type Mock = HttpMock | WsMock | MqttMock;

export interface MocksFile {
  mocks: Mock[];
}

export class ConfigError extends Error {
  constructor(
    msg: string,
    readonly why: string,
    readonly fix: string,
    readonly field?: string,
  ) {
    super(msg);
  }
}

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Validate jumper.json "network". Throws ConfigError with why / fix / field. */
export function parseNetworkConfig(raw: unknown): NetworkConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const mode = (r.mode ?? "mock") as NetMode;
  if (!["offline", "mock", "internet"].includes(mode)) {
    throw new ConfigError(`network.mode '${String(mode)}' is not a mode`, "modes are offline, mock and internet", 'set "mode": "mock" (nothing leaves this machine) or "internet" with an allow list', "network.mode");
  }
  const secrets = (r.secrets ?? []) as string[];
  for (const s of secrets) {
    if (typeof s !== "string" || !NAME_RE.test(s)) {
      throw new ConfigError(`network.secrets: '${String(s)}' is not a secret name`, "secret names are UPPER_SNAKE_CASE (like OPENAI_API_KEY); jumper.json holds names only, never values", 'list the name only, e.g. "secrets": ["OPENAI_API_KEY"], and put the value in .env', "network.secrets");
    }
  }
  const allow = ((r.allow ?? []) as AllowEntry[]).map((a, i) => {
    const field = `network.allow[${i}]`;
    if (!a || typeof a.host !== "string" || !HOST_RE.test(a.host.toLowerCase())) {
      throw new ConfigError(`${field}.host '${String(a?.host)}' is not a host name`, "allow entries name a host (api.example.com) or a wildcard (*.example.com), no scheme or path", '{"host": "api.example.com"}', `${field}.host`);
    }
    for (const s of a.secrets ?? []) {
      if (!secrets.includes(s)) throw new ConfigError(`${field} gives ${a.host} the secret ${s}, which the project does not declare`, `every secret must be listed in network.secrets first`, `add "${s}" to network.secrets`, `${field}.secrets`);
    }
    for (const [h, v] of Object.entries(a.headers ?? {})) {
      for (const m of v.matchAll(/\{\{\s*secret:([A-Z0-9_]+)\s*\}\}/g)) {
        if (!(a.secrets ?? []).includes(m[1]!)) {
          throw new ConfigError(`${field}.headers.${h} uses {{secret:${m[1]}}} but ${a.host} is not given it`, "a host only receives the secrets listed in its own secrets field", `add "secrets": ["${m[1]}"] to this allow entry`, `${field}.headers.${h}`);
        }
      }
      if (!/\{\{\s*secret:/.test(v) && /(sk-|Bearer\s+[A-Za-z0-9_-]{16,})/.test(v)) {
        throw new ConfigError(`${field}.headers.${h} looks like a literal API key`, "jumper.json is committed and exported; a key in it leaks", `use a template: "Bearer {{secret:NAME}}" and put NAME=... in .env`, `${field}.headers.${h}`);
      }
    }
    if (a.tls === "passthrough" && (a.headers || a.secrets?.length)) {
      throw new ConfigError(`${field}: ${a.host} is passthrough but asks for headers / secrets`, "with tls passthrough the request is encrypted end to end, so Jumper cannot add a header", 'use "tls": "inspect" (the default) for hosts that need a secret', `${field}.tls`);
    }
    return { ...a, host: a.host.toLowerCase() };
  });
  if (mode === "internet" && allow.length === 0) {
    throw new ConfigError("network.mode is internet but network.allow is empty", "internet mode only reaches hosts on the allow list", '"allow": [{"host": "api.example.com"}]', "network.allow");
  }
  return {
    mode,
    allow,
    secrets,
    ...(typeof r.cassette === "string" ? { cassette: r.cassette } : {}),
    ...(r.record === true ? { record: true } : {}),
    ...(r.wifi ? { wifi: r.wifi as { ssid: string; password?: string } } : {}),
  };
}

export function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

export function parseMocks(raw: unknown): Mock[] {
  const r = raw as MocksFile | Mock[] | undefined;
  const list = Array.isArray(r) ? r : (r?.mocks ?? []);
  return list.map((m, i) => validateMock(m, `mocks[${i}]`));
}

export function validateMock(m: Mock, field = "mock"): Mock {
  if (!m || typeof m.host !== "string" || !HOST_RE.test(m.host.toLowerCase())) {
    throw new ConfigError(`${field}.host is missing or not a host`, "a mock answers for one host name the device resolves", '{"host": "api.example.com", "path": "/v1/x", "response": {"body": {}}}', `${field}.host`);
  }
  const kind = m.kind ?? "http";
  if (kind === "http") {
    const h = m as HttpMock;
    if (typeof h.path !== "string" || !h.path.startsWith("/")) throw new ConfigError(`${field}.path must start with /`, "HTTP mocks match a path (exact, or a prefix ending in *)", '"path": "/v1/weather"', `${field}.path`);
    if (!h.response) throw new ConfigError(`${field}.response is missing`, "an HTTP mock says what to answer", '"response": {"status": 200, "body": {"ok": true}}', `${field}.response`);
  } else if (kind === "ws") {
    if (typeof (m as WsMock).path !== "string") throw new ConfigError(`${field}.path is missing`, "a WebSocket mock answers one path", '"path": "/v1/stream"', `${field}.path`);
  } else if (kind !== "mqtt") {
    throw new ConfigError(`${field}.kind '${String(kind)}' is not a mock kind`, "mock kinds are http, ws and mqtt", '"kind": "http"', `${field}.kind`);
  }
  return { ...m, host: m.host.toLowerCase() } as Mock;
}
