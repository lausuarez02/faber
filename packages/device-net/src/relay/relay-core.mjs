// SPDX-License-Identifier: MIT
// Fabwright API relay, the core. Copyright (c) Fabwright Authors. MIT License (see LICENSE next to it).
//
// A device calls  <RELAY_URL>/<api host>[:port]/<path>  with the header  X-Device-Token: <token>.
// The relay checks the token (only SHA-256 hashes of device tokens are stored, in RELAY_DEVICE_TOKENS),
// checks the host against the allow list in relay.config.mjs (made from the project's fabwright.json
// "network"), adds the API keys it holds ({{secret:NAME}} header templates, or {{secret:NAME}} sent by
// the device) and streams the answer back. Keys never live in the firmware; a device token can only
// reach this relay, and only the hosts on its list; removing it from RELAY_DEVICE_TOKENS revokes it.
//
// Plain JavaScript with no dependencies, written against the web Fetch API (Request, Response,
// ReadableStream, crypto.subtle), so the same file runs in Node 20+ (server.mjs) and in a Cloudflare
// Worker (worker.js). Fabwright's simulator uses the same checks (packages/device-net), so a device that
// works in the simulator gets the same answers from the real relay.

export const TOKEN_HEADER = "x-device-token";
/** The host the simulator plays the relay on (the simulation build's RELAY_URL). */
export const SIM_RELAY_HOST = "relay.sandbox.fabwright";
export const SIM_RELAY_URL = `https://${SIM_RELAY_HOST}`;
/** The device token the simulation build uses (the real one never goes into a simulation build). */
export const SIM_DEVICE_TOKEN = "fabwright-sim-device-token";
export const DEFAULT_LIMITS = Object.freeze({
  requests_per_minute: 60,
  max_request_bytes: 1024 * 1024,
  max_response_bytes: 32 * 1024 * 1024,
  max_stream_seconds: 300,
});

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding"]);
// Headers a hosting platform adds about the caller; never forwarded.
const DROP_PREFIX = ["cf-", "x-forwarded-", "x-real-ip", "forwarded", "cdn-loop"];
const SECRET_RE = /\{\{\s*secret:([A-Z][A-Z0-9_]{1,63})\s*\}\}/g;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** An answer the relay gives itself: status + {error, why, fix} (what failed, why, how to fix it). */
export class RelayError extends Error {
  constructor(status, code, why, fix, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.why = why;
    this.fix = fix;
    this.headers = headers;
  }
  body() {
    return { error: this.code, why: this.why, fix: this.fix };
  }
  response() {
    return new Response(JSON.stringify(this.body()), { status: this.status, headers: { "content-type": "application/json", ...this.headers } });
  }
}

export function hostMatches(pattern, host) {
  const h = String(host).toLowerCase();
  const p = String(pattern).toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/** The limits in force: the spec's, with the defaults filled in. */
export function limitsOf(spec) {
  return { ...DEFAULT_LIMITS, ...(spec && spec.limits ? spec.limits : {}) };
}

/**
 * Where a relay path points: "/api.example.com/v1/x?y=1" → {host, port, path: "/v1/x?y=1"}.
 * Throws RelayError (400) when the path does not start with a host.
 */
export function parseTarget(pathAndQuery) {
  const raw = String(pathAndQuery || "/");
  const m = /^\/+([^/?#]+)(.*)$/.exec(raw);
  const example = "/api.example.com/v1/forecast";
  if (!m) throw new RelayError(400, "no-host-in-path", `the request path '${raw.slice(0, 80)}' does not start with the API host the relay should call`, `put the API's host first: <RELAY_URL>${example} (fabwrightRelayUrl("api.example.com", "/v1/forecast") in the firmware builds it)`);
  let [hostPart, rest] = [m[1], m[2] || "/"];
  if (!rest.startsWith("/")) rest = `/${rest}`;
  let decoded;
  try {
    decoded = decodeURIComponent(hostPart).toLowerCase();
  } catch {
    decoded = "";
  }
  const hp = /^([^:]+)(?::(\d{1,5}))?$/.exec(decoded);
  if (!hp || !HOST_RE.test(hp[1]) || !hp[1].includes(".")) {
    throw new RelayError(400, "bad-host", `'${hostPart.slice(0, 80)}' is not a host name`, `the first part of the path is the API host, e.g. ${example}`);
  }
  const port = hp[2] ? Number(hp[2]) : 443;
  if (!(port >= 1 && port <= 65535)) throw new RelayError(400, "bad-port", `port ${hp[2]} is out of range`, "use a port between 1 and 65535, or leave it out for 443");
  return { host: hp[1], port, path: rest };
}

/** The allow entry for host:port, or a RelayError (403) that says how to allow it. */
export function findAllow(spec, host, port) {
  const entry = (spec.allow || []).find((a) => hostMatches(a.host, host));
  if (!entry) {
    const direct = (spec.direct || []).find((a) => hostMatches(a.host, host));
    if (direct) throw new RelayError(403, "host-not-relayed", `${host} is set to TLS passthrough in the project, so the device talks to it directly, not through the relay`, `call https://${host} directly from the firmware, or change its network.allow entry to "tls": "inspect" and regenerate the relay`);
    throw new RelayError(403, "host-not-allowed", `${host} is not on this relay's allow list (it only calls the hosts in the project's network.allow)`, `add {"host": "${host}"} to network.allow in fabwright.json, regenerate the relay (fabwright relay init) and deploy it again`);
  }
  const ports = entry.ports && entry.ports.length ? entry.ports : [443, 80];
  if (!ports.includes(port)) throw new RelayError(403, "port-not-allowed", `${host} is allowed only on port(s) ${ports.join(", ")}, the device asked for ${port}`, `add ${port} to "ports" of the ${entry.host} entry in network.allow and regenerate the relay`);
  return entry;
}

/** Which device sent this: the token's name, or a RelayError (401). Tokens are compared by SHA-256. */
export async function identifyDevice(token, tokensVar) {
  if (!token) throw new RelayError(401, "no-device-token", `the request has no ${TOKEN_HEADER} header, so the relay does not know which device sent it`, `send the header ${TOKEN_HEADER}: <your device token> (the firmware sends FABWRIGHT_DEVICE_TOKEN; make one with: fabwright relay token add <device name>)`);
  const known = parseDeviceTokens(tokensVar);
  if (!known.length) throw new RelayError(401, "no-devices", "this relay has no device tokens yet (RELAY_DEVICE_TOKENS is empty), so it refuses every device", "fabwright relay token add <device name>, then set RELAY_DEVICE_TOKENS on the relay (wrangler secret put RELAY_DEVICE_TOKENS, or the relay's .env)");
  const hash = await sha256Hex(token);
  let found;
  for (const k of known) if (timingSafeEqual(k.hash, hash)) found = k.name;
  if (!found) throw new RelayError(401, "unknown-device-token", "the device token is not one this relay knows (mistyped, from another project, or revoked)", "flash the device with a current token (fabwright relay token add <device name>, then fabwright relay device-header and build), and make sure the relay has the same RELAY_DEVICE_TOKENS");
  return found;
}

/** "star-1:<sha256 hex>,star-2:<sha256 hex>" → [{name, hash}]. Bad items are skipped. */
export function parseDeviceTokens(v) {
  return String(v || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf(":");
      return i > 0 ? { name: s.slice(0, i), hash: s.slice(i + 1).toLowerCase() } : undefined;
    })
    .filter((x) => x && /^[0-9a-f]{64}$/.test(x.hash));
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** Requests per minute per device: a token bucket that refills continuously. */
export class RateLimiter {
  constructor(perMinute, now = () => Date.now()) {
    this.perMinute = perMinute;
    this.now = now;
    this.buckets = new Map();
  }
  take(key) {
    const t = this.now();
    const cap = Math.max(1, this.perMinute);
    const b = this.buckets.get(key) || { tokens: cap, t };
    // a clock that went back (the simulator starts a new test or run at 0 ms; a wall clock set back)
    // starts the bucket full instead of draining it by the negative gap
    if (t < b.t) b.tokens = cap;
    else b.tokens = Math.min(cap, b.tokens + ((t - b.t) / 60000) * cap);
    b.t = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retry_after_s: Math.max(1, Math.ceil(((1 - b.tokens) * 60000) / cap / 1000)) };
  }
}

/** Throws a RelayError (429) when the device used up its requests for now. */
export function checkRate(limiter, device, perMinute) {
  const r = limiter.take(device);
  if (!r.ok) throw new RelayError(429, "rate-limited", `device ${device} sent more than ${perMinute} requests in a minute`, `wait ${r.retry_after_s} s (Retry-After), or raise network.relay.requests_per_minute in fabwright.json and regenerate the relay`, { "retry-after": String(r.retry_after_s) });
}

/** Throws a RelayError (413) when a body announced by Content-Length is over the limit. */
export function checkRequestSize(contentLength, maxBytes) {
  const n = Number(contentLength);
  if (contentLength != null && contentLength !== "" && Number.isFinite(n) && n > maxBytes) {
    throw new RelayError(413, "request-too-large", `the request body is ${n} bytes, over this relay's limit of ${maxBytes}`, "send less (or stream it in parts), or raise network.relay.max_request_kb in fabwright.json and regenerate the relay");
  }
}

/** Replace {{secret:NAME}} with the value from env; only names the host's entry lists. */
export function expandSecrets(template, env, entry, host) {
  const allowed = entry.secrets || [];
  const used = [];
  const value = String(template).replace(SECRET_RE, (_m, name) => {
    if (!allowed.includes(name)) throw new RelayError(403, "secret-not-for-host", `${host} may not receive the secret ${name} (only hosts that list it under "secrets" in network.allow get it)`, `add "${name}" to the secrets of the ${entry.host} entry in network.allow, then regenerate the relay`);
    const v = env[name];
    if (typeof v !== "string" || !v) throw new RelayError(500, "secret-missing", `the relay has no value for ${name}`, `set it on the relay: wrangler secret put ${name} (Cloudflare), or ${name}=... in the relay's .env (fabwright relay serve reads the project's .env)`);
    used.push(name);
    return v;
  });
  return { value, used };
}

/**
 * The headers sent upstream: the device's (without hop-by-hop, the device token and platform headers;
 * {{secret:NAME}} expanded) plus the allow entry's templates. Returns [headers object, secret names used].
 */
export function upstreamHeaders(deviceHeaders, entry, env, target) {
  const out = {};
  const used = new Set();
  const add = (k, v) => {
    const r = expandSecrets(v, env, entry, target.host);
    r.used.forEach((n) => used.add(n));
    out[k.toLowerCase()] = r.value;
  };
  for (const [k0, v] of deviceHeaders) {
    const k = k0.toLowerCase();
    if (HOP.has(k) || k === TOKEN_HEADER || DROP_PREFIX.some((p) => k.startsWith(p))) continue;
    if (k.startsWith("sec-websocket-")) {
      out[k] = v;
      continue;
    }
    add(k, v);
  }
  for (const [k, v] of Object.entries(entry.headers || {})) add(k, v);
  if ([...used].length && target.scheme !== "https") {
    throw new RelayError(403, "secret-over-http", `${target.host}:${target.port} is plain HTTP, and the relay never sends a key unencrypted`, `call ${target.host} on port 443 (HTTPS)`);
  }
  // microcontrollers rarely decompress: ask for the plain body
  out["accept-encoding"] = "identity";
  return { headers: out, used: [...used] };
}

/** A function that replaces every secret value (and device token) in a string with [secret:NAME]. */
export function makeRedactor(spec, env) {
  const pairs = (spec.secrets || [])
    .map((n) => [n, env[n]])
    .filter(([, v]) => typeof v === "string" && v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  const fn = (s) => {
    let out = String(s);
    for (const [n, v] of pairs) if (out.includes(v)) out = out.split(v).join(`[secret:${n}]`);
    return out;
  };
  fn.values = pairs.map(([, v]) => new TextEncoder().encode(v));
  return fn;
}

function pendingPrefix(buf, needles) {
  let keep = 0;
  for (const nd of needles) {
    for (let n = Math.min(nd.length - 1, buf.length); n > keep; n--) {
      let eq = true;
      for (let i = 0; i < n; i++) if (buf[buf.length - n + i] !== nd[i]) { eq = false; break; }
      if (eq) { keep = n; break; }
    }
  }
  return keep;
}

function maskBytes(buf, needles) {
  for (const nd of needles) {
    outer: for (let i = 0; i + nd.length <= buf.length; i++) {
      for (let j = 0; j < nd.length; j++) if (buf[i + j] !== nd[j]) continue outer;
      buf.fill(0x2a, i, i + nd.length);
      i += nd.length - 1;
    }
  }
  return buf;
}

/**
 * The body stream back to the device: counts bytes, stops at maxBytes or maxSeconds, masks any secret
 * value an API echoes back (same length, '*'; a secret split across chunks too: only bytes that could
 * start one wait, at most 30 ms). `done(info)` is called once at the end with {bytes, error?}.
 */
export function responseStream({ maxBytes, maxSeconds, needles = [], done = () => {}, now = () => Date.now() }) {
  let bytes = 0;
  let tail = new Uint8Array(0);
  let timer;
  let ended = false;
  const t0 = now();
  const finish = (info) => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    done({ bytes, ...info });
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (timer) clearTimeout(timer);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        finish({ error: `the answer passed the relay's limit of ${maxBytes} bytes` });
        controller.error(new Error("response too large"));
        return;
      }
      if (maxSeconds && now() - t0 > maxSeconds * 1000) {
        finish({ error: `the answer streamed longer than the relay's limit of ${maxSeconds} s` });
        controller.error(new Error("stream too long"));
        return;
      }
      if (!needles.length) {
        controller.enqueue(chunk);
        return;
      }
      const all = new Uint8Array(tail.length + chunk.byteLength);
      all.set(tail);
      all.set(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk), tail.length);
      maskBytes(all, needles);
      const keep = pendingPrefix(all, needles);
      tail = all.slice(all.length - keep);
      if (all.length - keep) controller.enqueue(all.slice(0, all.length - keep));
      if (keep) {
        timer = setTimeout(() => {
          try {
            if (tail.length) controller.enqueue(tail);
          } catch {
            // stream already closed
          }
          tail = new Uint8Array(0);
        }, 30);
      }
    },
    flush(controller) {
      if (tail.length) controller.enqueue(maskBytes(tail, needles));
      finish({});
    },
  });
}

/** A request body stream that errors past maxBytes (for chunked uploads with no Content-Length). */
export function requestLimitStream(maxBytes) {
  let n = 0;
  return new TransformStream({
    transform(chunk, controller) {
      n += chunk.byteLength;
      if (n > maxBytes) controller.error(new RelayError(413, "request-too-large", `the request body passed this relay's limit of ${maxBytes} bytes`, "send less, or raise network.relay.max_request_kb and regenerate the relay"));
      else controller.enqueue(chunk);
    },
  });
}

/** One log line: no secret values, no device token, no query values (only their names). */
export function logEntry(redact, fields) {
  const path = fields.path ? String(fields.path) : undefined;
  const [p, q] = path ? path.split("?") : [];
  const query = q ? q.split("&").map((kv) => kv.split("=")[0]).filter(Boolean) : undefined;
  const out = { t: new Date().toISOString(), ...fields, ...(path ? { path: p } : {}), ...(query && query.length ? { query_keys: query } : {}) };
  return JSON.parse(redact(JSON.stringify(out)));
}

/**
 * Everything checked before a request goes upstream, shared by HTTP and WebSocket and by every host
 * (Node, Workers, Fabwright's simulator): device token, rate, target host / port, size.
 * `req` = {method, url (path + query), header(name) → string | null}.
 */
export async function authorize(req, ctx) {
  const limits = limitsOf(ctx.spec);
  const device = await identifyDevice(req.header(TOKEN_HEADER), ctx.env.RELAY_DEVICE_TOKENS);
  try {
    checkRate(ctx.limiter, device, limits.requests_per_minute);
    const t = parseTarget(req.url);
    const entry = findAllow(ctx.spec, t.host, t.port);
    checkRequestSize(req.header("content-length"), limits.max_request_bytes);
    const scheme = t.port === 80 ? "http" : "https";
    return { device, limits, entry, target: { ...t, scheme } };
  } catch (e) {
    // the log says which device was refused
    if (e instanceof RelayError) e.device = device;
    throw e;
  }
}

/**
 * Where the target is really reached: the allow entry's "to" (a service the person runs, e.g. a dev
 * server or their own backend at another address; the device keeps calling its own name), else the
 * host itself (tests point it at a local server with ctx.upstream).
 */
export function originOf(ctx, target, entry) {
  if (ctx.upstream) return ctx.upstream(target.host, target.port, target.scheme);
  if (entry && entry.to) return String(entry.to).replace(/\/+$/, "");
  const def = (target.scheme === "https" && target.port === 443) || (target.scheme === "http" && target.port === 80);
  return `${target.scheme}://${target.host}${def ? "" : `:${target.port}`}`;
}

/**
 * The relay for one HTTP request (Fetch API). ctx = {spec, env, limiter, fetch?, log?, upstream?, now?}.
 * WebSocket upgrades are handled by the host (server.mjs pipes them, worker.js bridges them) after
 * authorize().
 */
export async function handleRelay(request, ctx) {
  const url = new URL(request.url);
  const t0 = Date.now();
  const redact = makeRedactor(ctx.spec, ctx.env);
  const log = ctx.log || ((e) => console.log(JSON.stringify(e)));
  if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET" && !request.headers.get(TOKEN_HEADER)) {
    return new Response(JSON.stringify({ ok: true, relay: "fabwright", project: ctx.spec.project || "" }), { headers: { "content-type": "application/json" } });
  }
  const pathAndQuery = url.pathname + url.search;
  let a;
  try {
    a = await authorize({ method: request.method, url: pathAndQuery, header: (n) => request.headers.get(n) }, ctx);
  } catch (e) {
    if (!(e instanceof RelayError)) throw e;
    log(logEntry(redact, { kind: "refused", ...(e.device ? { device: e.device } : {}), method: request.method, path: pathAndQuery, status: e.status, error: e.code, why: e.why }));
    return e.response();
  }
  const { device, limits, entry, target } = a;
  let sent;
  try {
    sent = upstreamHeaders(request.headers.entries(), entry, ctx.env, target);
  } catch (e) {
    if (!(e instanceof RelayError)) throw e;
    log(logEntry(redact, { kind: "refused", device, method: request.method, host: target.host, path: target.path, status: e.status, error: e.code, why: e.why }));
    return e.response();
  }
  const upstreamUrl = originOf(ctx, target, entry) + target.path;
  const method = request.method;
  let body;
  let bytesOut = 0;
  if (method !== "GET" && method !== "HEAD" && request.body) {
    if (request.headers.get("content-length") != null) {
      // a known size: send it whole with its length (some APIs refuse chunked uploads)
      const buf = new Uint8Array(await request.arrayBuffer());
      bytesOut = buf.length;
      body = buf;
    } else body = request.body.pipeThrough(requestLimitStream(limits.max_request_bytes));
  }
  const init = { method, headers: sent.headers, redirect: "manual", ...(body !== undefined ? { body } : {}) };
  if (body instanceof ReadableStream && !(globalThis.navigator && globalThis.navigator.userAgent === "Cloudflare-Workers")) init.duplex = "half";
  const doFetch = ctx.fetch || fetch;
  let up;
  try {
    up = await doFetch(upstreamUrl, init);
  } catch (err) {
    const e = err instanceof RelayError ? err : new RelayError(502, "upstream-unreachable", entry.to ? `${target.host} (sent to ${entry.to}) could not be reached from the relay (${redact(String(err && err.message ? err.message : err))})` : `${target.host} could not be reached from the relay (${redact(String(err && err.message ? err.message : err))})`, entry.to ? `start the service at ${entry.to}, or set "to" in relay.config.mjs to an address this relay can reach (a relay in the cloud cannot reach 127.0.0.1 or your home network: use the service's public https URL)` : "check the host name and that the API is up; try again later");
    log(logEntry(redact, { kind: "http", device, method, host: target.host, path: target.path, status: e.status, error: e.code, why: e.why, secrets_used: sent.used, ms: Date.now() - t0 }));
    return e.response();
  }
  const headers = new Headers();
  up.headers.forEach((v, k) => {
    if (!HOP.has(k) || k === "content-length") headers.set(k, redact(v));
  });
  if (up.headers.get("content-encoding")) headers.delete("content-length");
  const done = (info) =>
    log(logEntry(redact, { kind: "http", device, method, host: target.host, path: target.path, status: up.status, bytes_out: bytesOut, bytes_in: info.bytes, ms: Date.now() - t0, secrets_used: sent.used, ...(info.error ? { error: info.error } : {}) }));
  if (!up.body) {
    done({ bytes: 0 });
    return new Response(null, { status: up.status, headers });
  }
  const stream = up.body.pipeThrough(responseStream({ maxBytes: limits.max_response_bytes, maxSeconds: limits.max_stream_seconds, needles: redact.values, done }));
  return new Response(stream, { status: up.status, statusText: up.statusText, headers });
}
