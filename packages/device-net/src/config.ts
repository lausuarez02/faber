// The project's network section (faber.json "network") and its mock file (network/mocks.json).
// Plain data, git-friendly, no secret values anywhere: secrets are referenced by name only.
import { parseLocalTarget, type LocalTarget } from "./local.ts";
import type { OpenApiMock } from "./openapi.ts";

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
   * inspect (default): Faber terminates TLS with the sandbox CA, so it can log paths, inject
   * secrets, record cassettes. passthrough: the bytes go end to end; only host, port, bytes and
   * timing are logged, no secret injection.
   */
  tls?: "inspect" | "passthrough";
  /** Secrets this host may receive. */
  secrets?: string[];
  /** Headers added to every request to this host, e.g. {"Authorization": "Bearer {{secret:OPENAI_API_KEY}}"}. */
  headers?: Record<string, string>;
  /**
   * Round 14: this host may reach this computer or the local network (a dev server, a service the
   * person runs). Without it, a host that resolves to a loopback / private / link-local address is
   * refused. Per host only (no wildcards).
   */
  local?: boolean;
  /**
   * Round 14: send this host's traffic to a service here instead, e.g. "http://127.0.0.1:7821" (needs
   * "local": true). Works in mock mode too (nothing leaves this computer); mocks still answer first.
   * The device keeps calling its own name (http://api.mystar.test/...), as it will on the real network.
   */
  to?: string;
}

export interface NetworkConfig {
  mode: NetMode;
  allow: AllowEntry[];
  /** Secret names the project needs (values come from the environment / .env). */
  secrets: string[];
  /** Cassette to replay (and record into, in internet mode with record: true). */
  cassette?: string;
  record?: boolean;
  /** The sandbox Wi-Fi network (none: any SSID joins). */
  wifi?: { ssid: string; password?: string; rssi?: number };
  /** Mocks file relative to the project (default network/mocks.json). */
  mocks?: string;
  /** Round 13: limits of the API relay (the real device's relay and the simulator's, the same). */
  relay?: RelayOptions;
}

/** The API relay's limits, per device (faber.json network.relay). Defaults in relay-core.mjs DEFAULT_LIMITS. */
export interface RelayOptions {
  requests_per_minute?: number;
  max_request_kb?: number;
  max_response_kb?: number;
  max_stream_seconds?: number;
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
  /** Exact path, or a prefix ending in "*"; with "?k=v&..." the request also needs those query parameters (any order, value may end in "*"). */
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

export type Mock = HttpMock | WsMock | MqttMock | OpenApiMock;

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

/** Validate faber.json "network". Throws ConfigError with why / fix / field. */
export function parseNetworkConfig(raw: unknown): NetworkConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const mode = (r.mode ?? "mock") as NetMode;
  if (!["offline", "mock", "internet"].includes(mode)) {
    throw new ConfigError(`network.mode '${String(mode)}' is not a mode`, "modes are offline, mock and internet", 'set "mode": "mock" (nothing leaves this machine) or "internet" with an allow list', "network.mode");
  }
  const secrets = (r.secrets ?? []) as string[];
  for (const s of secrets) {
    if (typeof s !== "string" || !NAME_RE.test(s)) {
      throw new ConfigError(`network.secrets: '${String(s)}' is not a secret name`, "secret names are UPPER_SNAKE_CASE (like OPENAI_API_KEY); faber.json holds names only, never values", 'list the name only, e.g. "secrets": ["OPENAI_API_KEY"], and put the value in .env', "network.secrets");
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
        throw new ConfigError(`${field}.headers.${h} looks like a literal API key`, "faber.json is committed and exported; a key in it leaks", `use a template: "Bearer {{secret:NAME}}" and put NAME=... in .env`, `${field}.headers.${h}`);
      }
    }
    if (a.tls === "passthrough" && (a.headers || a.secrets?.length)) {
      throw new ConfigError(`${field}: ${a.host} is passthrough but asks for headers / secrets`, "with tls passthrough the request is encrypted end to end, so Faber cannot add a header", 'use "tls": "inspect" (the default) for hosts that need a secret', `${field}.tls`);
    }
    if (a.local !== undefined && typeof a.local !== "boolean") throw new ConfigError(`${field}.local must be true or false`, "it opts one host in to reaching this computer or the local network", '"local": true', `${field}.local`);
    if ((a.local || a.to !== undefined) && a.host.startsWith("*.")) {
      throw new ConfigError(`${field}: ${a.host} is a wildcard, so it cannot use "local" or "to"`, "reaching this computer or the local network is opted in per host name, never for a whole domain", `name the one host, e.g. {"host": "${a.host.slice(2)}", "local": true${a.to ? `, "to": "${a.to}"` : ""}}`, `${field}.host`);
    }
    if (a.to !== undefined) {
      if (typeof a.to !== "string") throw new ConfigError(`${field}.to must be a URL string`, '"to" says where this host\'s traffic goes', '"to": "http://127.0.0.1:7821"', `${field}.to`);
      let t: LocalTarget;
      try {
        t = parseLocalTarget(a.to, `${field}.to`);
      } catch (err) {
        throw new ConfigError((err as Error).message.split(". Why:")[0]!, (err as Error).message.split("Why: ")[1]?.split(" Fix:")[0] ?? "it is not a usable URL", (err as Error).message.split("Fix: ")[1] ?? '"to": "http://127.0.0.1:7821"', `${field}.to`);
      }
      if (a.local !== true) {
        throw new ConfigError(`${field}: ${a.host} sends its traffic to ${a.to} but does not say "local": true`, `"to" points the device at a service on this computer or the local network (${t.host}), which the sandbox only does for a host that opts in`, `add "local": true to this entry: {"host": "${a.host}", "local": true, "to": "${a.to}"}`, `${field}.local`);
      }
      if (a.tls === "passthrough") throw new ConfigError(`${field}: ${a.host} uses "to" with tls passthrough`, "passthrough sends the device's encrypted bytes unchanged, so they cannot be re-sent to another address and certificate", 'remove "tls": "passthrough" (inspect, the default, works with "to")', `${field}.tls`);
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
    ...(r.wifi ? { wifi: parseWifi(r.wifi) } : {}),
    ...(typeof r.mocks === "string" ? { mocks: r.mocks } : {}),
    ...(r.relay !== undefined ? { relay: parseRelayOptions(r.relay) } : {}),
  };
}

const RELAY_LIMITS: Record<keyof RelayOptions, [number, number, string]> = {
  requests_per_minute: [1, 6000, "requests a device may send per minute"],
  max_request_kb: [1, 100 * 1024, "the largest request body, in KiB"],
  max_response_kb: [1, 1024 * 1024, "the largest answer (or WebSocket stream), in KiB"],
  max_stream_seconds: [1, 3600, "how long one answer or WebSocket may stream, in seconds"],
};

function parseRelayOptions(raw: unknown): RelayOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("network.relay must be an object", "it holds the relay's limits per device", '"relay": {"requests_per_minute": 30}', "network.relay");
  }
  const out: RelayOptions = {};
  for (const [k, v] of Object.entries(raw)) {
    const lim = RELAY_LIMITS[k as keyof RelayOptions];
    if (!lim) throw new ConfigError(`network.relay.${k} is not a relay setting`, `the relay settings are ${Object.keys(RELAY_LIMITS).join(", ")}`, `remove ${k}`, `network.relay.${k}`);
    if (typeof v !== "number" || !Number.isInteger(v) || v < lim[0] || v > lim[1]) {
      throw new ConfigError(`network.relay.${k} must be a whole number from ${lim[0]} to ${lim[1]}`, `it is ${lim[2]}`, `"${k}": ${Math.min(lim[1], Math.max(lim[0], 60))}`, `network.relay.${k}`);
    }
    out[k as keyof RelayOptions] = v;
  }
  return out;
}

function parseWifi(raw: unknown): { ssid: string; password?: string; rssi?: number } {
  const w = raw as { ssid?: unknown; password?: unknown; rssi?: unknown };
  if (typeof w?.ssid !== "string" || !w.ssid || w.ssid.length > 32) {
    throw new ConfigError("network.wifi.ssid is missing or longer than 32 characters", "the sandbox plays one Wi-Fi network, named by ssid (what the sketch passes to WiFi.begin)", '"wifi": {"ssid": "FaberNet"}, or remove network.wifi to accept any SSID', "network.wifi.ssid");
  }
  if (w.password !== undefined && (typeof w.password !== "string" || w.password.length > 64)) {
    throw new ConfigError("network.wifi.password must be a string of at most 64 characters", "it is only compared with what the sketch sends, to rehearse a wrong password", "remove it to accept any password", "network.wifi.password");
  }
  if (w.rssi !== undefined && (typeof w.rssi !== "number" || w.rssi > 0 || w.rssi < -100)) {
    throw new ConfigError("network.wifi.rssi must be between -100 and 0 dBm", "it is the signal strength WiFi.RSSI() reads", '"rssi": -60', "network.wifi.rssi");
  }
  return { ssid: w.ssid, ...(typeof w.password === "string" ? { password: w.password } : {}), ...(typeof w.rssi === "number" ? { rssi: w.rssi } : {}) };
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

/** Mocks with the same key replace each other (kind + host + method + path). */
export function mockKey(x: Mock): string {
  return `${x.kind ?? "http"} ${x.host} ${(x as { method?: string }).method ?? ""} ${(x as { path?: string }).path ?? ""}`;
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
  } else if (kind === "openapi") {
    const o = m as OpenApiMock;
    if (!(typeof o.spec === "string" && o.spec) && !(o.spec && typeof o.spec === "object")) {
      throw new ConfigError(`${field}.spec is missing`, "an openapi mock answers from the API's OpenAPI 3 description", '{"kind": "openapi", "host": "api.example.com", "spec": "network/api.openapi.yaml"}', `${field}.spec`);
    }
  } else if (kind !== "mqtt") {
    throw new ConfigError(`${field}.kind '${String(kind)}' is not a mock kind`, "mock kinds are http, ws, mqtt and openapi", '"kind": "http"', `${field}.kind`);
  }
  return { ...m, host: m.host.toLowerCase() } as Mock;
}
