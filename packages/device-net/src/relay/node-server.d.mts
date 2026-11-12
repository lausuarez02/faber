import type { Server } from "node:http";
import type { RelayLog, RelaySpec } from "./relay-core.mjs";

export function parseDotEnv(text: string): Record<string, string>;

export interface RelayServer {
  port: number;
  url: string;
  server: Server;
  close(): Promise<void>;
}

export function startRelay(opts: {
  spec: RelaySpec;
  env?: Record<string, string | undefined>;
  port?: number;
  host?: string;
  log?: RelayLog;
  /** Where a target is really reached, as an origin ("http://127.0.0.1:1234"). Tests use it. */
  upstream?: (host: string, port: number, scheme: string) => string;
  /** Extra CA for the upstream (WebSocket over TLS to a test server). */
  upstreamCa?: string;
  fetch?: typeof fetch;
}): Promise<RelayServer>;
