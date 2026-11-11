// What agents and the UI see of the device network. Every output goes through the redactor (the
// log already is redacted; these add a second pass for anything assembled here), and secrets are
// only ever reported by name and set / missing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, validateMock, type Mock, type NetworkConfig } from "./config.ts";
import type { DeviceNet, Fault } from "./gateway.ts";
import type { NetEvent } from "./log.ts";

/** Schemas in the shape of session's ToolDef (name, title, description, inputSchema). */
export const DEVICE_NET_TOOLS = [
  {
    name: "read_network",
    title: "Device network log",
    description:
      "Everything the simulated device did on the network: DNS lookups, HTTP requests (method, host, path, status, bytes, time, who answered: mock / cassette / internet / fault), WebSocket and MQTT sessions with frame counts and samples, and blocked attempts with why and fix. Secrets show as [secret:NAME], never their value. Pass since (a seq) for new entries only, kind or host to filter.",
    inputSchema: { type: "object", properties: { since: { type: "number" }, limit: { type: "number" }, kind: { type: "string", enum: ["dns", "http", "ws", "mqtt", "connect", "udp", "blocked", "fault"] }, host: { type: "string" } } },
    readOnly: true,
  },
  {
    name: "add_mock_api",
    title: "Add or update a mock API",
    description:
      'Add or replace a mock in network/mocks.json, live. HTTP: {"host", "method", "path" (exact or prefix*), "response": {"status", "headers", "body" | "body_b64" | "chunks": [{"data" | "b64" | "bytes", "delay_ms"}], "delay_ms"}}. WebSocket: {"kind": "ws", "host", "path", "on_open": [frames], "on_message": [{"match", "send": [{"text" | "b64" | "bytes", "delay_ms", "repeat"}], "close"}]}. MQTT: {"kind": "mqtt", "host", "on_publish": [{"topic", "reply": [{"topic", "payload"}]}], "retained": [...]}. Any API is just a mock: weather, an AI stream, a webhook.',
    inputSchema: { type: "object", properties: { mock: { type: "object" } }, required: ["mock"] },
  },
  {
    name: "inject_network_fault",
    title: "Network fault",
    description: 'Rehearse bad networks: {"kind": "wifi_drop"}, {"kind": "latency", "ms": 800}, {"kind": "http_error", "status": 500, "host"?, "path"?, "count"?}, {"kind": "timeout", "host"?}, {"kind": "dns_fail", "host"?}, or {"kind": "clear"}.',
    inputSchema: { type: "object", properties: { fault: { type: "object" } }, required: ["fault"] },
  },
] as const;

export function compact(e: NetEvent): Record<string, unknown> {
  const o: Record<string, unknown> = { seq: e.seq, t_ms: Math.round(e.t_ms), kind: e.kind, summary: e.summary };
  for (const k of ["host", "port", "tls", "method", "path", "status", "source", "bytes_out", "bytes_in", "duration_ms", "headers", "secrets_used", "why", "fix"] as const) if (e[k] !== undefined) o[k] = e[k];
  if (e.frames) o.frames = e.frames;
  if (e.open) o.open = true;
  return o;
}

export function readNetwork(net: DeviceNet, args: { since?: number; limit?: number; kind?: string; host?: string } = {}): Record<string, unknown> {
  let entries = net.log.since(args.since ?? 0);
  if (args.kind) entries = entries.filter((e) => e.kind === args.kind);
  if (args.host) entries = entries.filter((e) => e.host === args.host!.toLowerCase());
  const limit = Math.max(1, Math.min(200, args.limit ?? 50));
  const shown = entries.slice(-limit);
  const c = net.config;
  const out = {
    mode: c.mode,
    allow: c.allow.map((a) => ({ host: a.host, tls: a.tls ?? "inspect", ...(a.secrets?.length ? { secrets: a.secrets } : {}), ...(a.headers ? { headers: a.headers } : {}) })),
    mocks: net.mocks.list.map((m) => `${m.kind ?? "http"} ${m.host}${"path" in m ? ` ${(m as { method?: string }).method ?? ""} ${m.path}` : ""}`.replace(/\s+/g, " ").trim()),
    faults: net.faults,
    entries: shown.map(compact),
    last_seq: shown.length ? shown[shown.length - 1]!.seq : (args.since ?? 0),
    ...(entries.length > shown.length ? { truncated: `${entries.length - shown.length} older entries; pass since or a larger limit` } : {}),
    ...(entries.length === 0 ? { hint: "no network activity yet: the firmware has not looked a host up or opened a connection" } : {}),
  };
  return net.redactor.deep(out);
}

/** Which secrets the project declares and whether this machine has them. Names only. */
export function secretStatus(config: NetworkConfig, values: Map<string, string>): Array<{ name: string; set: boolean; hosts: string[] }> {
  return config.secrets.map((name) => ({ name, set: values.has(name), hosts: config.allow.filter((a) => a.secrets?.includes(name)).map((a) => a.host) }));
}

/** add_mock_api: validate, apply live, and persist to network/mocks.json (when a path is given). */
export function addMockApi(net: DeviceNet, mock: Mock, file?: string): Record<string, unknown> {
  let m: Mock;
  try {
    m = validateMock(mock);
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, error: e.message, why: e.why, fix: e.fix, field: e.field };
    throw e;
  }
  const json = JSON.stringify(m);
  if (/\{\{\s*secret:/.test(json)) return { ok: false, error: "mocks cannot contain secrets", why: "mocks are committed project files and answer the device; a mock never needs a real key", fix: "remove the {{secret:...}} reference from the mock" };
  const result = net.mocks.upsert(m);
  if (file) {
    const cur = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { mocks: Mock[] }) : { mocks: [] };
    const key = (x: Mock) => `${x.kind ?? "http"} ${x.host} ${(x as { method?: string }).method ?? ""} ${(x as { path?: string }).path ?? ""}`;
    const i = cur.mocks.findIndex((x) => key(x) === key(m));
    if (i >= 0) cur.mocks[i] = m;
    else cur.mocks.push(m);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(cur, null, 2)}\n`);
  }
  return { ok: true, result, mock: m, note: net.config.mode === "offline" ? "network.mode is offline: the mock will not be reached until the mode is mock or internet" : undefined };
}

export function injectNetworkFault(net: DeviceNet, f: Fault | { kind: "clear" }): string {
  if (f.kind === "clear") {
    net.clearFaults();
    return "network faults cleared";
  }
  net.inject(f);
  return `fault on: ${f.kind}`;
}

/**
 * Scenario step {"request": {"host", "path"?, "method"?, "status"?, "count"?}}: did the device
 * make this request? Fails with what it did instead.
 */
export interface RequestExpectation {
  host: string;
  path?: string;
  method?: string;
  status?: number;
  /** At least this many (default 1). */
  count?: number;
  kind?: "http" | "ws" | "mqtt";
}

export function checkRequest(net: DeviceNet, x: RequestExpectation): { ok: boolean; matched: number; why?: string; fix?: string } {
  const want = x.count ?? 1;
  const kinds = x.kind ? [x.kind] : ["http", "ws"];
  const seen = net.log.since(0).filter((e) => kinds.includes(e.kind));
  const m = seen.filter((e) => e.host === x.host.toLowerCase() && (!x.path || (e.path ?? "").split("?")[0] === x.path || (x.path.endsWith("*") && (e.path ?? "").startsWith(x.path.slice(0, -1)))) && (!x.method || e.method === x.method.toUpperCase()) && (x.status === undefined || e.status === x.status));
  if (m.length >= want) return { ok: true, matched: m.length };
  const blocked = net.log.since(0).filter((e) => e.kind === "blocked" && e.host === x.host.toLowerCase());
  const did = seen.slice(-5).map((e) => e.summary);
  return {
    ok: false,
    matched: m.length,
    why: blocked.length ? `the device tried ${x.host} but it was blocked: ${blocked[0]!.why}` : did.length ? `expected ${want} ${x.method ?? ""} ${x.host}${x.path ?? ""}${x.status ? ` → ${x.status}` : ""}, saw ${m.length}; the device did: ${did.join("; ")}` : `the device made no ${kinds.join("/")} request at all`,
    fix: blocked.length ? blocked[0]!.fix! : "run longer, check the firmware reaches the code that sends it (read_serial), or read_network for what happened",
  };
}

/** The factory pack's network section: what the real device needs. Names of secrets only. */
export function factoryNetworkNotes(config: NetworkConfig): string {
  const lines = ["## Network", ""];
  if (config.mode === "offline" && !config.allow.length) {
    lines.push("The device does not use the network.");
    return lines.join("\n");
  }
  lines.push("The real device needs 2.4 GHz Wi-Fi with internet access to these hosts:", "");
  for (const a of config.allow) lines.push(`- ${a.host} (ports ${(a.ports ?? [443, 80]).join(", ")}${a.secrets?.length ? `; needs ${a.secrets.join(", ")}` : ""})`);
  if (!config.allow.length) lines.push("- (the simulation only used mocks; list the real API hosts here before building)");
  if (config.secrets.length) {
    lines.push(
      "",
      `Secrets (${config.secrets.join(", ")}): the simulation added them at the Jumper sandbox, so the firmware never contained them. On the real device, choose one:`,
      "1. A small relay you run (a serverless function or a home server) that holds the key and adds the header; the device calls the relay. Recommended.",
      "2. Short-lived tokens: the relay (or the provider, where it offers ephemeral client tokens) hands the device a token that expires in minutes.",
      "3. The key compiled into the firmware. Anyone with the device can read it out of flash; only for a private prototype, and rotate the key afterwards.",
    );
  }
  lines.push("", "TLS: the simulation trusted the Jumper sandbox CA; the real firmware must use the real root CAs (the ESP32 certificate bundle, or the provider's root CA).");
  return lines.join("\n");
}
