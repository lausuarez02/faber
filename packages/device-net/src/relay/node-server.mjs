// SPDX-License-Identifier: MIT
// Jumper API relay for Node 20+ (a computer at home, a small server, a Raspberry Pi). Copyright (c)
// Jumper Authors. MIT License. No dependencies.
//
//   node server.mjs                 (reads relay.config.mjs next to it and .env from this folder)
//   PORT=8787 node server.mjs
//
// HTTP requests (plain or chunked, streamed both ways) go through handleRelay in relay-core.mjs;
// WebSocket upgrades are checked the same way, then piped byte for byte to the API with the keys added.
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorize, handleRelay, limitsOf, logEntry, makeRedactor, originOf, RateLimiter, RelayError, upstreamHeaders } from "./relay-core.mjs";

/** KEY=value lines, optional quotes, # comments. No expansion. */
export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function errorHead(e) {
  const body = JSON.stringify(e.body());
  const extra = Object.entries(e.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  return `HTTP/1.1 ${e.status} ${http.STATUS_CODES[e.status] || "Error"}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${extra}connection: close\r\n\r\n${body}`;
}

/**
 * Start the relay. opts = {spec, env, port?, host?, log?, upstream?(host, port, scheme) → origin,
 * upstreamCa?, fetch?}. Resolves to {url, port, server, close()}.
 */
export function startRelay(opts) {
  const spec = opts.spec;
  const env = opts.env || {};
  const limits = limitsOf(spec);
  const ctx = {
    spec,
    env,
    limiter: new RateLimiter(limits.requests_per_minute),
    log: opts.log || ((e) => process.stdout.write(`${JSON.stringify(e)}\n`)),
    ...(opts.upstream ? { upstream: opts.upstream } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
  const redact = makeRedactor(spec, env);

  const server = http.createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(`http://relay.local${req.url}`, { method: req.method, headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}) });
      const resp = await handleRelay(request, ctx);
      const out = {};
      resp.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(resp.status, out);
      if (!resp.body) return void res.end();
      const body = Readable.fromWeb(resp.body);
      body.on("error", () => res.destroy());
      body.pipe(res);
    } catch (err) {
      const e = err instanceof RelayError ? err : new RelayError(500, "relay-error", redact(String(err && err.message ? err.message : err)), "see the relay's log; report it if it repeats");
      if (!res.headersSent) {
        res.writeHead(e.status, { "content-type": "application/json", ...e.headers });
        res.end(JSON.stringify(e.body()));
      } else res.destroy();
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => {});
    const t0 = Date.now();
    const header = (n) => {
      const v = req.headers[n];
      return v === undefined ? null : Array.isArray(v) ? v.join(", ") : v;
    };
    let a;
    let sent;
    try {
      if (String(req.headers.upgrade || "").toLowerCase() !== "websocket") throw new RelayError(400, "not-websocket", `the relay only upgrades to WebSocket, not '${req.headers.upgrade}'`, "use a WebSocket client, or a plain HTTP request");
      a = await authorize({ method: req.method, url: req.url, header }, ctx);
      sent = upstreamHeaders(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]), a.entry, env, a.target);
    } catch (err) {
      const e = err instanceof RelayError ? err : new RelayError(500, "relay-error", redact(String(err)), "see the relay's log");
      ctx.log(logEntry(redact, { kind: "refused", ...(a ? { device: a.device, host: a.target.host } : e.device ? { device: e.device } : {}), method: "WS", path: req.url, status: e.status, error: e.code, why: e.why }));
      socket.end(errorHead(e));
      return;
    }
    const { device, target } = a;
    const origin = new URL(originOf(ctx, target, a.entry));
    const port = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
    const up = origin.protocol === "https:" ? tls.connect({ host: origin.hostname, port, servername: net.isIP(origin.hostname) ? undefined : origin.hostname, ...(opts.upstreamCa ? { ca: opts.upstreamCa } : {}) }) : net.connect({ host: origin.hostname, port });
    const hostHeader = (target.scheme === "https" && target.port === 443) || (target.scheme === "http" && target.port === 80) ? target.host : `${target.host}:${target.port}`;
    const lines = [`GET ${target.path} HTTP/1.1`, `host: ${hostHeader}`, "connection: Upgrade", "upgrade: websocket"];
    for (const [k, v] of Object.entries(sent.headers)) if (k !== "accept-encoding") lines.push(`${k}: ${v}`);
    let bytesIn = 0;
    let bytesOut = head.length;
    let status = 0;
    let closed = false;
    let error;
    const timer = setTimeout(() => {
      error = `the stream passed the relay's limit of ${a.limits.max_stream_seconds} s`;
      end();
    }, a.limits.max_stream_seconds * 1000);
    const end = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      socket.destroy();
      up.destroy();
      ctx.log(logEntry(redact, { kind: "ws", device, host: target.host, path: target.path, status: status || 502, bytes_out: bytesOut, bytes_in: bytesIn, ms: Date.now() - t0, secrets_used: sent.used, ...(error ? { error } : {}) }));
    };
    up.on("error", (err) => {
      if (!status && !closed) {
        error = `could not reach ${target.host}: ${redact(err.message)}`;
        socket.write(errorHead(new RelayError(502, "upstream-unreachable", error, "check the host and that the API is up")));
      }
      end();
    });
    up.on("connect", () => {});
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) up.write(head);
    up.on("data", (c) => {
      if (!status) {
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(c.subarray(0, 16).toString("latin1"));
        status = m ? Number(m[1]) : 502;
      }
      bytesIn += c.length;
      if (bytesIn > a.limits.max_response_bytes) {
        error = `the stream passed the relay's limit of ${a.limits.max_response_bytes} bytes`;
        return end();
      }
      socket.write(c);
    });
    socket.on("data", (c) => {
      bytesOut += c.length;
      up.write(c);
    });
    socket.on("close", end);
    up.on("close", end);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, opts.host ?? "0.0.0.0", () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://localhost:${port}`,
        server,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = (await import(pathToFileURL(join(here, "relay.config.mjs")).href)).default;
  const envFile = process.env.RELAY_ENV_FILE || join(here, ".env");
  const env = { ...(existsSync(envFile) ? parseDotEnv(readFileSync(envFile, "utf8")) : {}), ...process.env };
  const missing = (spec.secrets || []).filter((n) => !env[n]);
  const r = await startRelay({ spec, env, port: Number(process.env.PORT || 8787) });
  process.stderr.write(`Jumper relay for ${spec.project} on ${r.url} (hosts: ${(spec.allow || []).map((a) => a.host).join(", ") || "none"})\n`);
  if (!env.RELAY_DEVICE_TOKENS) process.stderr.write("No device tokens yet: every device is refused. Make one: jumper relay token add <device name> (it writes RELAY_DEVICE_TOKENS to .env)\n");
  if (missing.length) process.stderr.write(`Missing secrets: ${missing.join(", ")}. Requests that need them get 500 with the fix. Put NAME=value in ${envFile}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`jumper relay: ${e.message}\n`);
    process.exit(1);
  });
}
