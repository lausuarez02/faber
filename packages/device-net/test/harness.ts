// A fake device: plays what firmware on an emulated board does at the transport level (DNS over
// UDP, TCP flows through the gateway, TLS with the sandbox CA as its trusted root), using the same
// entry points a QEMU / Renode backend will call (net.udp, net.connect).
import http from "node:http";
import tls from "node:tls";
import { WebSocket } from "ws";
import { buildDnsQuery, parseDnsAnswerIp } from "../src/dns.ts";
import type { DeviceNet } from "../src/gateway.ts";

let qid = 1;
export function lookup(net: DeviceNet, name: string): { rcode: number; ip?: string } {
  const reply = net.udp("10.0.2.3", 53, buildDnsQuery(qid++, name))!;
  return parseDnsAnswerIp(reply);
}

export function tlsTo(net: DeviceNet, host: string, ca: string, port = 443): tls.TLSSocket {
  const r = lookup(net, host);
  if (!r.ip) throw new Error(`DNS failed for ${host} (rcode ${r.rcode})`);
  return tls.connect({ socket: net.connect({ ip: r.ip, port }) as never, servername: host, ca });
}

export interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** ms from request to each body chunk. */
  chunkTimes: number[];
}

export function request(net: DeviceNet, o: { host: string; path: string; method?: string; headers?: Record<string, string>; body?: string; ca?: string; port?: number }): Promise<Got> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const secure = o.ca !== undefined;
    const port = o.port ?? (secure ? 443 : 80);
    const req = http.request(
      {
        host: o.host,
        path: o.path,
        method: o.method ?? "GET",
        headers: { ...(o.headers ?? {}), connection: "close" },
        createConnection: () => {
          if (secure) return tlsTo(net, o.host, o.ca!, port) as never;
          const r = lookup(net, o.host);
          if (!r.ip) throw new Error(`DNS failed for ${o.host}`);
          return net.connect({ ip: r.ip, port }) as never;
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        const chunkTimes: number[] = [];
        res.on("data", (c: Buffer) => {
          parts.push(c);
          chunkTimes.push(performance.now() - t0);
        });
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts), chunkTimes }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

export function wsTo(net: DeviceNet, host: string, path: string, ca: string, headers: Record<string, string> = {}): WebSocket {
  return new WebSocket(`wss://${host}${path}`, { headers, createConnection: () => tlsTo(net, host, ca) as never });
}
