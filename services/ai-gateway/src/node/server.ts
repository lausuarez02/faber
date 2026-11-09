// A real HTTP server for the pet AI: real boards on your Wi-Fi (point the sketch's AI_HOST at
// this computer's LAN address, port 8787) and the web app's live mode call it.
import { createServer, type Server } from "node:http";
import { parsePetQuery, PetRequestError } from "../protocol.ts";
import { PetAi, type LiveProvider } from "../petAi.ts";

export interface GatewayServerOptions {
  port?: number;
  host?: string;
  live?: LiveProvider;
  /** Log one line per request (never headers or keys). */
  log?: (line: string) => void;
}

export function startGatewayServer(opts: GatewayServerOptions = {}): Promise<{ server: Server; url: string; ai: PetAi }> {
  const ai = new PetAi({ mode: opts.live ? "live" : "mock", ...(opts.live ? { live: opts.live } : {}) });
  const log = opts.log ?? (() => {});
  const server = createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://gateway");
    const send = (status: number, body: string, provider = "-", note?: string) => {
      // Few, short headers: a board reads the whole response through a 64-byte SoftwareSerial buffer.
      res.sendDate = false;
      res.writeHead(status, { "content-length": Buffer.byteLength(body), connection: "close", "access-control-allow-origin": "*", "x-jumper-provider": provider });
      res.end(body);
      log(`${req.method} ${url.pathname}${url.search} → ${status} ${Date.now() - started} ms ${provider}${note ? ` (${note})` : ""} ${JSON.stringify(body)}`);
    };
    if (url.pathname === "/" || url.pathname === "/health") return send(200, `ok|pet gateway, provider ${ai.provider()}`);
    if (url.pathname !== "/v1/pet") return send(404, "error|use GET /v1/pet?a=talk&f=50&j=50&e=50");
    let pet;
    try {
      pet = parsePetQuery(url.search.slice(1));
    } catch (e) {
      const err = e as PetRequestError;
      return send(400, `error|${err.message}; ${err.fix}`);
    }
    const r = ai.answer(pet);
    if (r.kind === "now") return send(r.answer.status, r.answer.body, r.answer.provider, r.answer.note);
    void r.promise.then((a) => send(a.status, a.body, a.provider, a.note));
  });
  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === "EADDRINUSE" ? `port ${opts.port ?? 8787} is already in use. Pass --port <n>, or stop the other gateway` : e.message)),
    );
    server.listen(opts.port ?? 8787, opts.host ?? "0.0.0.0", () => {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : (opts.port ?? 8787);
      resolve({ server, url: `http://127.0.0.1:${port}`, ai });
    });
  });
}
