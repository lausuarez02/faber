// Mock APIs, generic: HTTP routes (status / headers / body / streamed chunks / delay), WebSocket
// scripts (frames on open, frames per incoming message) and an MQTT broker with topic rules.
// Nothing here knows what the API is for: a weather API, an AI stream or a webhook are all just
// mocks. Matching is deterministic: the first mock (in file order) that fits answers.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import type { HttpMock, HttpMockResponse, Mock, MqttMock, WsFrame, WsMock } from "./config.ts";
import { hostMatches } from "./config.ts";
import { decodeConnect, decodePublish, decodeSubscribe, enc, readPackets, summarizePacket, topicMatches, type MqttPacket } from "./mqtt.ts";

export type Sleep = (ms: number) => Promise<void>;

export function pathMatches(pattern: string, path: string): boolean {
  const p = path.split("?")[0]!;
  return pattern.endsWith("*") ? p.startsWith(pattern.slice(0, -1)) : p === pattern;
}

/** A deterministic binary payload of n bytes (so streamed test data is identical every run). */
export function patternBytes(n: number, seed = 0): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7 + seed) & 0xff;
  return b;
}

export class MockSet {
  constructor(public list: Mock[] = []) {}

  /** Any mock answers for this host (so DNS resolves it in mock mode). */
  hasHost(host: string): boolean {
    return this.list.some((m) => hostMatches(m.host, host));
  }

  http(host: string, method: string, path: string): HttpMock | undefined {
    return this.list.find((m): m is HttpMock => (m.kind ?? "http") === "http" && hostMatches(m.host, host) && (!(m as HttpMock).method || (m as HttpMock).method!.toUpperCase() === method.toUpperCase()) && pathMatches((m as HttpMock).path, path));
  }

  ws(host: string, path: string): WsMock | undefined {
    return this.list.find((m): m is WsMock => m.kind === "ws" && hostMatches(m.host, host) && pathMatches(m.path, path));
  }

  mqtt(host: string): MqttMock | undefined {
    return this.list.find((m): m is MqttMock => m.kind === "mqtt" && hostMatches(m.host, host));
  }

  /** Add or replace (same kind + host + method + path). Returns "added" | "updated". */
  upsert(m: Mock): "added" | "updated" {
    const key = (x: Mock) => `${x.kind ?? "http"} ${x.host} ${(x as HttpMock).method ?? ""} ${(x as HttpMock).path ?? ""}`;
    const i = this.list.findIndex((x) => key(x) === key(m));
    if (i >= 0) {
      this.list[i] = m;
      return "updated";
    }
    this.list.push(m);
    return "added";
  }
}

function bodyOf(r: HttpMockResponse): { buf: Buffer; type?: string } {
  if (r.body_b64 !== undefined) return { buf: Buffer.from(r.body_b64, "base64"), type: "application/octet-stream" };
  if (r.body === undefined) return { buf: Buffer.alloc(0) };
  if (typeof r.body === "string") return { buf: Buffer.from(r.body), type: "text/plain; charset=utf-8" };
  return { buf: Buffer.from(JSON.stringify(r.body)), type: "application/json" };
}

/** Answer one HTTP request from a mock. Returns bytes sent. */
export async function answerHttp(m: HttpMock, res: ServerResponse, sleep: Sleep, status?: number): Promise<number> {
  const r = m.response;
  if (r.delay_ms) await sleep(r.delay_ms);
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  if (r.chunks?.length) {
    res.writeHead(status ?? r.status ?? 200, { "content-type": "application/octet-stream", ...headers });
    let sent = 0;
    for (const [i, c] of r.chunks.entries()) {
      if (c.delay_ms) await sleep(c.delay_ms);
      const b = c.b64 !== undefined ? Buffer.from(c.b64, "base64") : c.bytes !== undefined ? patternBytes(c.bytes, i) : Buffer.from(c.data ?? "");
      if (res.destroyed) return sent;
      res.write(b);
      sent += b.length;
    }
    res.end();
    return sent;
  }
  const { buf, type } = bodyOf(r);
  res.writeHead(status ?? r.status ?? 200, { ...(type ? { "content-type": type } : {}), "content-length": String(buf.length), ...headers });
  res.end(buf);
  return buf.length;
}

export function frameData(f: WsFrame, i: number): string | Buffer {
  if (f.text !== undefined) return f.text;
  if (f.b64 !== undefined) return Buffer.from(f.b64, "base64");
  return patternBytes(f.bytes ?? 0, i);
}

export interface FrameSink {
  frame(dir: "in" | "out", data: string | Buffer): void;
}

/** Run a WebSocket mock on an accepted connection. */
export function runWsMock(m: WsMock, ws: WebSocket, sleep: Sleep, sink: FrameSink): void {
  let closed = false;
  ws.on("close", () => (closed = true));
  // Frames go out in order even when several scripts overlap.
  let queue = Promise.resolve();
  const send = (frames: WsFrame[], close?: boolean) => {
    queue = queue.then(async () => {
      let n = 0;
      for (const f of frames) {
        for (let k = 0; k < (f.repeat ?? 1); k++) {
          if (f.delay_ms) await sleep(f.delay_ms);
          if (closed) return;
          const d = frameData(f, n++);
          ws.send(d, { binary: typeof d !== "string" });
          sink.frame("in", d);
        }
      }
      if (close && !closed) ws.close(1000, "done");
    });
  };
  if (m.on_open?.length) send(m.on_open);
  ws.on("message", (data, isBinary) => {
    const d = isBinary ? Buffer.from(data as Buffer) : data.toString();
    sink.frame("out", d);
    const text = typeof d === "string" ? d : "";
    const rule = m.on_message?.find((r) => r.match === "*" || (text && text.includes(r.match)));
    if (rule) send(rule.send, rule.close);
  });
}

/**
 * A sandbox MQTT 3.1.1 broker for one mock host. Shared by every device connection to that host,
 * so two simulated boards can talk through it. QoS 0 and 1 (QoS 2 is answered as 1).
 */
export class MockBroker {
  private subs = new Map<(b: Buffer) => void, string[]>();
  private retained = new Map<string, Buffer>();

  constructor(private mock: MqttMock) {
    for (const r of mock.retained ?? []) this.retained.set(r.topic, Buffer.from(r.payload));
  }

  /** Serve one connection. `send` writes to the device; `log` gets one line per packet. */
  attach(write: (b: Buffer) => void, log: (line: string, dir: "in" | "out", bytes: number) => void): { feed: (chunk: Buffer) => void; close: () => void } {
    let buf: Buffer = Buffer.alloc(0);
    const out = (b: Buffer) => {
      write(b);
      const { packets } = readPackets(b);
      for (const p of packets) log(summarizePacket(p, "in"), "in", b.length);
    };
    const deliver = (topic: string, payload: Buffer) => {
      for (const [w, filters] of this.subs) if (filters.some((f) => topicMatches(f, topic))) w(enc.publish(topic, payload));
    };
    const me = (b: Buffer) => out(b);
    const feed = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets, rest } = readPackets(buf);
      buf = rest;
      for (const p of packets) {
        log(summarizePacket(p, "out"), "out", p.body.length + 2);
        this.handle(p, out, me, deliver);
      }
    };
    return { feed, close: () => void this.subs.delete(me) };
  }

  private handle(p: MqttPacket, out: (b: Buffer) => void, me: (b: Buffer) => void, deliver: (t: string, p: Buffer) => void): void {
    switch (p.type) {
      case 1:
        decodeConnect(p);
        out(enc.connack(0));
        break;
      case 3: {
        const pub = decodePublish(p);
        if (pub.qos > 0 && pub.id !== undefined) out(enc.puback(pub.id));
        if (pub.retain) this.retained.set(pub.topic, Buffer.from(pub.payload));
        deliver(pub.topic, pub.payload);
        for (const rule of this.mock.on_publish ?? []) {
          if (!topicMatches(rule.topic, pub.topic)) continue;
          for (const r of rule.reply ?? []) deliver(r.topic, Buffer.from(r.payload));
        }
        break;
      }
      case 8: {
        const s = decodeSubscribe(p);
        const list = this.subs.get(me) ?? [];
        list.push(...s.topics.map((t) => t.topic));
        this.subs.set(me, list);
        out(enc.suback(s.id, s.topics.map((t) => Math.min(t.qos, 1))));
        for (const [topic, payload] of this.retained) if (s.topics.some((t) => topicMatches(t.topic, topic))) out(enc.publish(topic, payload, 0, 1, true));
        break;
      }
      case 12:
        out(enc.pingresp());
        break;
      case 14:
        this.subs.delete(me);
        break;
      default:
        break;
    }
  }
}

/** Read a request body fully (requests from devices are small). */
export function readBody(req: IncomingMessage, max = 4 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) req.destroy(new Error("request body too large"));
      else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
