// The bridge between an emulator's network stack and the gateway when they are different
// processes (QEMU in a container, a netstack sidecar, Renode). Each flow is one local socket that
// starts with a header line, then carries raw bytes both ways:
//
//   FABWRIGHT-FLOW/1 tcp <dst-ip> <dst-port>\n           then the TCP payload, both directions
//   FABWRIGHT-FLOW/1 udp <dst-ip> <dst-port> <len>\n<payload>  answered with  <len>\n<payload> (len 0: none)
//
// The device's own addresses never matter: the gateway identifies hosts by the sandbox DNS answer
// (fake IPs), so the adapter only has to say where the device was trying to go. Listens on
// 127.0.0.1 or a unix socket only.
import net from "node:net";
import type { DeviceNet } from "./gateway.ts";

const HEADER = /^FABWRIGHT-FLOW\/1 (tcp|udp) (\d+\.\d+\.\d+\.\d+) (\d+)(?: (\d+))?$/;

export function serveFlows(dn: DeviceNet, listen: { port?: number; path?: string }): Promise<net.Server> {
  const server = net.createServer((sock) => {
    let buf: Buffer = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > 256) sock.destroy();
        return;
      }
      const m = HEADER.exec(buf.subarray(0, nl).toString("latin1"));
      if (!m) {
        sock.end("ERR expected: FABWRIGHT-FLOW/1 tcp|udp <ip> <port>\n");
        return;
      }
      const rest = buf.subarray(nl + 1);
      if (m[1] === "tcp") {
        sock.off("data", onData);
        sock.pause();
        if (rest.length) sock.unshift(rest);
        void dn.attach(sock, { ip: m[2]!, port: Number(m[3]) });
        return;
      }
      const len = Number(m[4] ?? 0);
      if (rest.length < len) return;
      sock.off("data", onData);
      const reply = dn.udp(m[2]!, Number(m[3]), rest.subarray(0, len));
      sock.end(Buffer.concat([Buffer.from(`${reply?.length ?? 0}\n`), reply ?? Buffer.alloc(0)]));
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (listen.path) server.listen(listen.path, () => resolve(server));
    else server.listen(listen.port ?? 0, "127.0.0.1", () => resolve(server));
  });
}
