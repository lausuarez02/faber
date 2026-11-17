import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { expect, it } from "vitest";
import { SandboxCA } from "../src/ca.ts";
import { parseMocks, parseNetworkConfig } from "../src/config.ts";
import { buildDnsQuery, parseDnsAnswerIp } from "../src/dns.ts";
import { serveFlows } from "../src/flow-server.ts";
import { DeviceNet } from "../src/gateway.ts";

// The cross-process path a QEMU / Renode adapter uses: flows over real local sockets.
it("flow server: DNS over a UDP flow, then HTTPS over a TCP flow, across a real socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fabwright-flow-"));
  const ca = await SandboxCA.open(dir);
  const dn = new DeviceNet({ config: parseNetworkConfig({ mode: "mock" }), mocks: parseMocks([{ host: "api.weather.test", path: "/v1/now", response: { body: { ok: 1 } } }]), ca });
  const server = await serveFlows(dn, { port: 0 });
  const port = (server.address() as net.AddressInfo).port;

  const q = buildDnsQuery(7, "api.weather.test");
  const dnsReply = await new Promise<Buffer>((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(Buffer.concat([Buffer.from(`FABWRIGHT-FLOW/1 udp 10.0.2.3 53 ${q.length}\n`), q])));
    const parts: Buffer[] = [];
    s.on("data", (c: Buffer) => parts.push(c));
    s.on("end", () => resolve(Buffer.concat(parts)));
  });
  const nl = dnsReply.indexOf(10);
  const ip = parseDnsAnswerIp(dnsReply.subarray(nl + 1)).ip!;
  expect(ip).toBe("198.18.0.1");

  const t0 = performance.now();
  const body = await new Promise<string>((resolve, reject) => {
    const raw = net.connect(port, "127.0.0.1");
    raw.write(`FABWRIGHT-FLOW/1 tcp ${ip} 443\n`);
    const t = tls.connect({ socket: raw, servername: "api.weather.test", ca: ca.certPem });
    const req = http.request({ host: "api.weather.test", path: "/v1/now", createConnection: () => t as never, headers: { connection: "close" } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.end();
  });
  console.log(`[timing] HTTPS GET over the flow server (real local TCP socket): ${(performance.now() - t0).toFixed(1)} ms`);
  expect(JSON.parse(body)).toEqual({ ok: 1 });
  server.close();
  dn.close();
  rmSync(dir, { recursive: true, force: true });
});
