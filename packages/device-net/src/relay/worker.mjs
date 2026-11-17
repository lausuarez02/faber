// SPDX-License-Identifier: MIT
// Fabwright API relay as a Cloudflare Worker. Copyright (c) Fabwright Authors. MIT License.
//
//   wrangler secret put RELAY_DEVICE_TOKENS     (from: fabwright relay token add <device name>)
//   wrangler secret put <EACH API KEY NAME>      (the names in relay.config.mjs "secrets")
//   wrangler deploy
//
// HTTP requests (streamed both ways) go through handleRelay in relay-core.mjs. WebSocket upgrades are
// checked the same way, then bridged: the Worker opens the API's WebSocket with the keys added and
// passes frames both ways, counting bytes and time. The rate limit is per Worker instance (Cloudflare
// runs several), so treat it as a guard against a runaway device, not an exact quota.
import spec from "./relay.config.mjs";
import { authorize, handleRelay, limitsOf, logEntry, makeRedactor, originOf, RateLimiter, RelayError, upstreamHeaders } from "./relay-core.mjs";

let limiter;

export default {
  async fetch(request, env) {
    limiter ??= new RateLimiter(limitsOf(spec).requests_per_minute);
    const ctx = { spec, env, limiter, log: (e) => console.log(JSON.stringify(e)) };
    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") return websocket(request, ctx);
    return handleRelay(request, ctx);
  },
};

const size = (d) => (typeof d === "string" ? new TextEncoder().encode(d).length : d.byteLength ?? d.size ?? 0);

async function websocket(request, ctx) {
  const url = new URL(request.url);
  const redact = makeRedactor(ctx.spec, ctx.env);
  const t0 = Date.now();
  let a;
  let sent;
  try {
    a = await authorize({ method: request.method, url: url.pathname + url.search, header: (n) => request.headers.get(n) }, ctx);
    sent = upstreamHeaders(request.headers.entries(), a.entry, ctx.env, a.target);
  } catch (e) {
    if (!(e instanceof RelayError)) throw e;
    ctx.log(logEntry(redact, { kind: "refused", ...(a ? { device: a.device, host: a.target.host } : e.device ? { device: e.device } : {}), method: "WS", path: url.pathname, status: e.status, error: e.code, why: e.why }));
    return e.response();
  }
  const { device, target, limits } = a;
  const headers = { ...sent.headers, upgrade: "websocket" };
  // the runtime makes its own handshake with the API
  for (const k of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "accept-encoding"]) delete headers[k];
  const origin = originOf(ctx, target, a.entry).replace(/^ws/, "http");
  let resp;
  try {
    resp = await (ctx.fetch || fetch)(origin + target.path, { headers });
  } catch (err) {
    const e = new RelayError(502, "upstream-unreachable", `${target.host} could not be reached (${redact(String(err && err.message ? err.message : err))})`, "check the host and that the API is up");
    ctx.log(logEntry(redact, { kind: "ws", device, host: target.host, path: target.path, status: 502, error: e.why, secrets_used: sent.used }));
    return e.response();
  }
  const api = resp.webSocket;
  if (!api) {
    ctx.log(logEntry(redact, { kind: "ws", device, host: target.host, path: target.path, status: resp.status, error: "the API did not accept the WebSocket", secrets_used: sent.used }));
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  api.accept();
  server.accept();
  let bytesIn = 0;
  let bytesOut = 0;
  let closed = false;
  let error;
  const end = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { server.close(code, reason); } catch {}
    try { api.close(code, reason); } catch {}
    ctx.log(logEntry(redact, { kind: "ws", device, host: target.host, path: target.path, status: 101, bytes_out: bytesOut, bytes_in: bytesIn, ms: Date.now() - t0, secrets_used: sent.used, ...(error ? { error } : {}) }));
  };
  const timer = setTimeout(() => {
    error = `the stream passed the relay's limit of ${limits.max_stream_seconds} s`;
    end(1008, "relay time limit");
  }, limits.max_stream_seconds * 1000);
  server.addEventListener("message", (ev) => {
    bytesOut += size(ev.data);
    api.send(ev.data);
  });
  api.addEventListener("message", (ev) => {
    bytesIn += size(ev.data);
    if (bytesIn > limits.max_response_bytes) {
      error = `the stream passed the relay's limit of ${limits.max_response_bytes} bytes`;
      return end(1009, "relay size limit");
    }
    server.send(ev.data);
  });
  server.addEventListener("close", (ev) => end(ev.code === 1005 ? 1000 : ev.code, ev.reason));
  api.addEventListener("close", (ev) => end(ev.code === 1005 ? 1000 : ev.code, ev.reason));
  server.addEventListener("error", () => end(1011, "device error"));
  api.addEventListener("error", () => end(1011, "api error"));
  return new Response(null, { status: 101, webSocket: client });
}
