// Types for relay-core.mjs (plain JavaScript so the same file runs in Node and Cloudflare Workers).

export interface RelayAllow {
  host: string;
  ports?: number[];
  secrets?: string[];
  headers?: Record<string, string>;
  /** Round 14: where this host is really reached (an origin, e.g. "http://127.0.0.1:7821"); the device keeps calling the host's name. */
  to?: string;
}

export interface RelayLimits {
  requests_per_minute: number;
  max_request_bytes: number;
  max_response_bytes: number;
  max_stream_seconds: number;
}

export interface RelaySpec {
  version: 1;
  project: string;
  allow: RelayAllow[];
  /** Secret NAMES (values live on the relay: .env or wrangler secrets). */
  secrets: string[];
  limits: RelayLimits;
  /** TLS passthrough hosts: the device reaches them directly, never through the relay. */
  direct?: Array<{ host: string; ports?: number[] }>;
}

export interface RelayTarget {
  host: string;
  port: number;
  path: string;
  scheme: "http" | "https";
}

export type RelayEnv = Record<string, string | undefined>;
export type RelayLog = (entry: Record<string, unknown>) => void;

export interface RelayCtx {
  spec: RelaySpec;
  env: RelayEnv;
  limiter: RateLimiter;
  log?: RelayLog;
  fetch?: typeof fetch;
  upstream?: (host: string, port: number, scheme: string) => string;
}

export const TOKEN_HEADER: "x-device-token";
export const SIM_RELAY_HOST: "relay.sandbox.faber";
export const SIM_RELAY_URL: string;
export const SIM_DEVICE_TOKEN: string;
export const DEFAULT_LIMITS: Readonly<RelayLimits>;

export class RelayError extends Error {
  constructor(status: number, code: string, why: string, fix: string, headers?: Record<string, string>);
  status: number;
  code: string;
  why: string;
  fix: string;
  headers: Record<string, string>;
  /** The device, when it was known before the refusal. */
  device?: string;
  body(): { error: string; why: string; fix: string };
  response(): Response;
}

export function hostMatches(pattern: string, host: string): boolean;
export function limitsOf(spec: Pick<RelaySpec, "limits"> | undefined): RelayLimits;
export function parseTarget(pathAndQuery: string): { host: string; port: number; path: string };
export function findAllow(spec: Pick<RelaySpec, "allow" | "direct">, host: string, port: number): RelayAllow;
export function identifyDevice(token: string | null | undefined, tokensVar: string | undefined): Promise<string>;
export function parseDeviceTokens(v: string | undefined): Array<{ name: string; hash: string }>;
export function sha256Hex(text: string): Promise<string>;
export class RateLimiter {
  constructor(perMinute: number, now?: () => number);
  take(key: string): { ok: true } | { ok: false; retry_after_s: number };
}
export function checkRate(limiter: RateLimiter, device: string, perMinute: number): void;
export function checkRequestSize(contentLength: string | null | undefined, maxBytes: number): void;
export function expandSecrets(template: string, env: RelayEnv, entry: RelayAllow, host: string): { value: string; used: string[] };
export function upstreamHeaders(deviceHeaders: Iterable<[string, string]>, entry: RelayAllow, env: RelayEnv, target: RelayTarget): { headers: Record<string, string>; used: string[] };
export function makeRedactor(spec: Pick<RelaySpec, "secrets">, env: RelayEnv): ((s: string) => string) & { values: Uint8Array[] };
export function responseStream(o: { maxBytes: number; maxSeconds?: number; needles?: Uint8Array[]; done?: (info: { bytes: number; error?: string }) => void; now?: () => number }): TransformStream<Uint8Array, Uint8Array>;
export function requestLimitStream(maxBytes: number): TransformStream<Uint8Array, Uint8Array>;
export function logEntry(redact: (s: string) => string, fields: Record<string, unknown>): Record<string, unknown>;
export function authorize(
  req: { method: string; url: string; header(name: string): string | null },
  ctx: Pick<RelayCtx, "spec" | "env" | "limiter">,
): Promise<{ device: string; limits: RelayLimits; entry: RelayAllow; target: RelayTarget }>;
export function originOf(ctx: Pick<RelayCtx, "upstream">, target: RelayTarget, entry?: RelayAllow): string;
export function handleRelay(request: Request, ctx: RelayCtx): Promise<Response>;
