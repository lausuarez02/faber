import { addMockApi, factoryNetworkNotes, injectNetworkFault, readNetwork, type Fault, type Mock } from "@jumper/device-net";
import type { NetworkSettings } from "@jumper/project-format";
import { fail } from "../errors.ts";
import { networkConfigOf } from "../device-network.ts";
import type { ProjectSession } from "../session.ts";
import type { ExtOpContext, ToolModule } from "./types.ts";

/**
 * Round 10 (network): the generic device network. Any API, any protocol over TCP: what the
 * simulated device did on the network, mock APIs, faults, the project's network settings, and a
 * request made from inside the sandbox. Nothing here knows what an API is for.
 */
const FAULT_KINDS = ["wifi_drop", "weak_signal", "latency", "http_error", "timeout", "dns_fail", "clear"] as const;

function netOf(x: ExtOpContext) {
  return x.session.deviceNetwork;
}

type ReadArgs = { since?: number; limit?: number; kind?: string; host?: string };

/** read_network's answer (also GET /api/network, which must not write the action log on every poll). */
export async function networkSnapshot(session: ProjectSession, args: ReadArgs = {}): Promise<Record<string, unknown>> {
  const dn = session.deviceNetwork;
  const host = await dn.ensure();
  host.drain();
  const out = readNetwork(host, args);
  const { status } = dn.secrets();
  return {
    ...out,
    ...(status.length ? { secrets: status, ...(status.some((s) => !s.set) ? { secrets_fix: `put ${status.filter((s) => !s.set).map((s) => `${s.name}=...`).join(", ")} in ${session.dir}/.env (git-ignored) or the environment, then call read_network again` } : {}) } : {}),
    boards: host.devices,
    ...(host.devices.length ? {} : { boards_note: "no emulated board is on the sandbox network yet (boards with a network card join when they run: ESP32-family in Jumper's emulator)" }),
  };
}

export const networkTools: ToolModule = {
  name: "network",
  tools: [
    {
      name: "read_network",
      title: "Device network log",
      description:
        'Everything the simulated device did on the network (any board with Wi-Fi or Ethernet in the emulator, e.g. ESP32): Wi-Fi joins and drops, DHCP, DNS lookups, HTTP(S) requests (method, host, path, status, bytes, ms, who answered: mock / cassette / internet / fault), WebSocket and MQTT sessions with frame counts and samples, and blocked attempts with why and fix. Secrets show as [secret:NAME], never their value. Also returns mode, allow list, mocks, active faults, the secrets the project names (set or missing on this machine, never values) and the boards on the sandbox LAN. {"since": seq} for new entries only, {"kind": "http" | "ws" | "mqtt" | "dns" | "wifi" | "dhcp" | "blocked" | "connect" | "fault" | "udp"}, {"host": "api.example.com"}. (read_network_log is the older ESP-01 / pet-AI log.)',
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "number" },
          limit: { type: "number" },
          kind: { type: "string", enum: ["dns", "http", "ws", "mqtt", "connect", "udp", "blocked", "fault", "wifi", "dhcp"] },
          host: { type: "string" },
        },
      },
      readOnly: true,
    },
    {
      name: "add_mock_api",
      title: "Add or update a mock API",
      description:
        'Add or replace a mock in network/mocks.json, live (the running device sees it at once). Any API is just a mock: a weather API, an AI stream, a webhook, a broker. HTTP: {"host", "method"?, "path" (exact, or a prefix ending in *), "response": {"status", "headers", "body" (JSON or text) | "body_b64" | "chunks": [{"data" | "b64" | "bytes", "delay_ms"}], "delay_ms"}}. WebSocket: {"kind": "ws", "host", "path", "on_open": [frames], "on_message": [{"match" (substring or "*"), "send": [{"text" | "b64" | "bytes", "delay_ms", "repeat"}], "close"}]}. MQTT broker: {"kind": "mqtt", "host", "on_publish": [{"topic" (+ and # wildcards), "reply": [{"topic", "payload"}]}], "retained": [{"topic", "payload"}]}. Mocks never contain secrets. Check it with try_request.',
      inputSchema: { type: "object", properties: { mock: { type: "object", description: "One mock (see above)." } }, required: ["mock"] },
      edits: true,
    },
    {
      name: "inject_network_fault",
      title: "Network fault",
      description:
        'Rehearse a bad network while the device runs: {"kind": "wifi_drop"} (the access point disappears: open connections are lost, the firmware sees WL_CONNECTION_LOST and must reconnect once you clear it), {"kind": "weak_signal", "rssi": -85} (WiFi.RSSI() reads it; traffic is not slowed), {"kind": "latency", "ms": 800}, {"kind": "http_error", "status": 503, "host"?, "path"?, "count"?}, {"kind": "timeout", "host"?} (accepted, never answered), {"kind": "dns_fail", "host"?}, {"kind": "clear"}. In a scenario use {"network_fault": {...}}.',
      inputSchema: { type: "object", properties: { fault: { type: "object", description: 'e.g. {"kind": "wifi_drop"}' } }, required: ["fault"] },
    },
    {
      name: "set_network",
      title: "Network settings",
      description:
        'Change jumper.json "network" (undoable) and apply it live. {"mode": "offline" | "mock" | "internet"} (mock is the default and what run_tests uses; internet reaches only hosts in allow), {"allow": [{"host": "api.example.com", "ports"?: [443], "tls"?: "inspect" | "passthrough", "secrets"?: ["API_KEY"], "headers"?: {"Authorization": "Bearer {{secret:API_KEY}}"}}]}, {"secrets": ["API_KEY"]} (names only: the value goes in the project\'s .env or the environment, never in jumper.json), {"wifi": {"ssid": "Home", "password"?: "...", "rssi"?: -60}} (the sandbox access point; leave out to accept any SSID), {"cassette": "name", "record": true}. Only the fields you pass change; null removes one. A literal key in a header is refused with the fix.',
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["offline", "mock", "internet"] },
          allow: { type: ["array", "null"], items: { type: "object" } },
          secrets: { type: ["array", "null"], items: { type: "string" } },
          wifi: { type: ["object", "null"] },
          cassette: { type: ["string", "null"] },
          record: { type: ["boolean", "null"] },
          mocks: { type: ["string", "null"], description: "Mocks file relative to jumper.json (default network/mocks.json)." },
          why: { type: "string" },
        },
      },
      edits: true,
    },
    {
      name: "try_request",
      title: "Try a request in the sandbox",
      description:
        'Make one HTTP(S) request from inside the sandbox, exactly as the device would (sandbox DNS, TLS through the sandbox CA, the mode, allow list, mocks, secrets and faults apply): {"url": "https://api.example.com/v1/now", "method"?: "GET", "headers"?: {}, "body"?: "..."}. Returns {ok, status, headers, body (16 KB max, secrets masked), bytes, ms} or {ok: false, error, why, fix}. Use it to check a mock or an allow entry before writing firmware. It shows in read_network with User-Agent jumper-try-request.',
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, method: { type: "string" }, headers: { type: "object" }, body: { type: "string" } },
        required: ["url"],
      },
    },
  ],
  ops: {
    async read_network(args, x) {
      const out = await networkSnapshot(x.session, args as ReadArgs);
      x.summary(`read the network log (${(out.entries as unknown[]).length} entries)`);
      return out;
    },
    async add_mock_api(args, x) {
      const dn = netOf(x);
      if (!args.mock || typeof args.mock !== "object") fail("bad-arg", "add_mock_api needs a mock", "the mock object is missing", 'pass {"mock": {"host": "api.example.com", "path": "/v1/now", "response": {"body": {"ok": true}}}}');
      const host = await dn.ensure();
      const r = addMockApi(host, args.mock as Mock, dn.mocksFile());
      if (!r.ok) fail("bad-mock", `add_mock_api: ${String(r.error)}`, String(r.why), String(r.fix), r.field ? { field: r.field } : undefined);
      const m = r.mock as Mock;
      x.summary(`mock ${m.kind ?? "http"} ${m.host}${"path" in m ? (m as { path: string }).path : ""} (${String(r.result)})`);
      return { ...r, file: "network/mocks.json", next: m.kind === "ws" || m.kind === "mqtt" ? "run the firmware and read_network" : `try_request {"url": "https://${m.host}${(m as { path?: string }).path?.replace(/\*$/, "") ?? "/"}"} to check it` };
    },
    async inject_network_fault(args, x) {
      const f = args.fault as Fault | { kind: "clear" } | undefined;
      if (!f || typeof f !== "object" || !FAULT_KINDS.includes(f.kind as (typeof FAULT_KINDS)[number])) {
        fail("bad-fault", `inject_network_fault: '${String((f as { kind?: unknown })?.kind)}' is not a network fault`, `network faults are ${FAULT_KINDS.join(", ")}`, 'pass {"fault": {"kind": "wifi_drop"}}');
      }
      if (f.kind === "latency" && !(Number((f as { ms?: number }).ms) > 0)) fail("bad-fault", "latency needs ms", "the delay added to each connection", '{"fault": {"kind": "latency", "ms": 800}}');
      if (f.kind === "http_error" && !(Number((f as { status?: number }).status) >= 400)) fail("bad-fault", "http_error needs a status of 400 or more", "it is the status the device gets instead of the real answer", '{"fault": {"kind": "http_error", "status": 503}}');
      const host = await netOf(x).ensure();
      const msg = injectNetworkFault(host, f);
      x.summary(msg);
      return { ok: true, fault: f, active: host.faults, note: "faults last until {\"kind\": \"clear\"}; a new simulation (run_tests) starts without them" };
    },
    async set_network(args, x) {
      const s = x.session;
      const cur: Record<string, unknown> = { ...(s.project.network ?? {}) };
      for (const k of ["mode", "allow", "secrets", "wifi", "cassette", "record", "mocks"]) {
        if (!(k in args)) continue;
        if (args[k] === null) delete cur[k];
        else cur[k] = args[k];
      }
      const next = { ...s.project, network: cur as NetworkSettings };
      const cfg = networkConfigOf(next); // throws with field / why / fix
      x.commit(`set_network ${Object.keys(args).filter((k) => k !== "why").join(", ")}`, next);
      const dn = netOf(x);
      const host = dn.running;
      if (host) await dn.ensure();
      const { status } = dn.secrets(cfg);
      x.summary(`network: ${cfg.mode}${cfg.allow.length ? `, allow ${cfg.allow.map((a) => a.host).join(", ")}` : ""}`);
      return {
        ok: true,
        network: cur,
        ...(status.length ? { secrets: status } : {}),
        ...(status.some((t) => !t.set) ? { note: `${status.filter((t) => !t.set).map((t) => t.name).join(", ")} has no value on this machine yet: put NAME=value in ${s.dir}/.env (git-ignored) or the environment; requests that need it fail with why and fix until then` } : {}),
        factory_notes: factoryNetworkNotes(cfg),
      };
    },
    async try_request(args, x) {
      if (typeof args.url !== "string") fail("bad-arg", "try_request needs a url", "the URL to request is missing", '{"url": "https://api.example.com/v1/now"}');
      const host = await netOf(x).ensure();
      const r = await host.request({ url: args.url, ...(typeof args.method === "string" ? { method: args.method } : {}), ...(args.headers && typeof args.headers === "object" ? { headers: args.headers as Record<string, string> } : {}), ...(typeof args.body === "string" ? { body: args.body } : {}) });
      host.drain();
      x.summary(`try_request ${String(args.method ?? "GET")} ${args.url} → ${r.ok ? r.status : "failed"}`);
      return r;
    },
  },
};
