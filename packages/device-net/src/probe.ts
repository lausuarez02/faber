// try_request: one HTTP(S) request made from inside the sandbox, the way a device would make it
// (sandbox DNS, a TCP flow to the fake IP, TLS that trusts the sandbox CA), so an agent or a person
// can check a mock, an allow-list entry, a secret header or a fault before any firmware exists.
// It shows in the network log like a device request (User-Agent: fabwright-try-request).
import http from "node:http";
import tls from "node:tls";
import type { DeviceNet } from "./gateway.ts";

export interface ProbeRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  bytes?: number;
  ms?: number;
  error?: string;
  why?: string;
  fix?: string;
}

const MAX_BODY = 16 * 1024;

export async function probeRequest(dn: DeviceNet, req: ProbeRequest): Promise<ProbeResult> {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return { ok: false, error: `'${req.url}' is not a URL`, why: "try_request needs a full URL", fix: 'pass e.g. "https://api.example.com/v1/now"' };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: `${u.protocol} is not supported`, why: "try_request speaks HTTP and HTTPS", fix: "use an http:// or https:// URL; WebSocket and MQTT mocks are tested from firmware" };
  const host = u.hostname.toLowerCase();
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const t0 = Date.now();
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : dn.resolve(host);
  if (!ip) {
    const b = dn.log.since(0).filter((e) => e.kind === "blocked" && e.host === host).at(-1);
    return { ok: false, error: `DNS for ${host} failed in the sandbox`, why: b?.why ?? "the sandbox refused the name", fix: b?.fix ?? "add a mock for it, or allow it in internet mode" };
  }
  const raw = dn.connect({ ip, port });
  const sock = u.protocol === "https:" ? tls.connect({ socket: raw as never, servername: host, ca: dn.ca.certPem }) : raw;
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(dn.redactor.deep(r) as ProbeResult);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer from ${host} within ${req.timeoutMs ?? 10000} ms`, why: "the request was accepted but nothing answered (a timeout fault, a slow mock, or a slow real API)", fix: "read_network for what happened; clear faults with inject_network_fault {\"kind\": \"clear\"}" }), req.timeoutMs ?? 10000);
    const r = http.request(
      {
        createConnection: () => sock as never,
        method: (req.method ?? "GET").toUpperCase(),
        path: `${u.pathname}${u.search}`,
        headers: { host: u.port ? `${host}:${u.port}` : host, "user-agent": "fabwright-try-request", ...(req.headers ?? {}), ...(req.body ? { "content-length": String(Buffer.byteLength(req.body)) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => {
          n += c.length;
          if (Buffer.concat(chunks).length < MAX_BODY) chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8");
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          finish({ ok: true, status: res.statusCode, headers, body: n > MAX_BODY ? `${body}… (${n} bytes in all)` : body, bytes: n, ms: Date.now() - t0 });
        });
        res.on("error", (e) => finish({ ok: false, error: e.message }));
      },
    );
    r.on("error", (e) => {
      const b = dn.log.since(0).filter((x) => (x.kind === "blocked" || x.kind === "connect") && x.host === host && x.why).at(-1);
      finish({ ok: false, error: `the connection to ${host}:${port} failed: ${e.message}`, why: b?.why ?? "the sandbox closed the connection", fix: b?.fix ?? "read_network for what happened" });
    });
    if (req.body) r.write(req.body);
    r.end();
  });
}
