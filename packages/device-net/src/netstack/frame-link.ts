// Where emulators plug their network card into the netstack: a local TCP server that speaks QEMU's
// stream netdev framing (each Ethernet frame preceded by its length, 4 bytes big-endian; the same
// as -netdev socket). QEMU connects as the client:
//
//   -netdev stream,id=jn,server=off,addr.type=inet,addr.host=<host>,addr.port=<port>
//   -net nic,netdev=jn,model=open_eth
//
// Each connection is one network card (one board). Listens on 127.0.0.1 only; Docker Desktop
// forwards host.docker.internal to it.
import net from "node:net";
import type { Netstack } from "./stack.ts";

export interface FrameServer {
  port: number;
  server: net.Server;
  /** Cards plugged in right now. */
  connections(): number;
  close(): Promise<void>;
}

export function serveFrames(stack: Netstack, listen: { host?: string; port?: number } = {}): Promise<FrameServer> {
  const socks = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    socks.add(sock);
    const port = stack.attach({
      send: (frame) => {
        if (sock.destroyed) return;
        const h = Buffer.alloc(4);
        h.writeUInt32BE(frame.length, 0);
        sock.write(Buffer.concat([h, frame]));
      },
    });
    let buf: Buffer = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, c]) : c;
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len > 65536) {
          // Not QEMU stream framing: drop the connection rather than misread it.
          sock.destroy();
          return;
        }
        if (buf.length < 4 + len) break;
        port.input(Buffer.from(buf.subarray(4, 4 + len)));
        buf = buf.subarray(4 + len);
      }
    });
    const done = () => {
      socks.delete(sock);
      port.close();
    };
    sock.on("close", done);
    sock.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port ?? 0, listen.host ?? "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        server,
        connections: () => socks.size,
        close: () =>
          new Promise<void>((r) => {
            for (const s of socks) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

/** The QEMU arguments that plug an OpenCores Ethernet card into a frame server. */
export function qemuNetArgs(host: string, port: number, id = "jn"): string[] {
  return ["-netdev", `stream,id=${id},server=off,addr.type=inet,addr.host=${host},addr.port=${port}`, "-net", `nic,netdev=${id},model=open_eth`];
}
