// Just enough MQTT 3.1.1 for a sandbox broker and for summarizing packets in the log: CONNECT /
// CONNACK, PUBLISH (QoS 0 and 1) / PUBACK, SUBSCRIBE / SUBACK, UNSUBSCRIBE, PINGREQ / PINGRESP,
// DISCONNECT. Own code (no broker dependency).

export const MQTT_TYPES = ["?", "CONNECT", "CONNACK", "PUBLISH", "PUBACK", "PUBREC", "PUBREL", "PUBCOMP", "SUBSCRIBE", "SUBACK", "UNSUBSCRIBE", "UNSUBACK", "PINGREQ", "PINGRESP", "DISCONNECT", "AUTH"];

export interface MqttPacket {
  type: number;
  flags: number;
  body: Buffer;
}

/** Split complete packets off the front of buf. */
export function readPackets(buf: Buffer): { packets: MqttPacket[]; rest: Buffer } {
  const packets: MqttPacket[] = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    let mult = 1;
    let len = 0;
    let i = o + 1;
    let ok = false;
    for (let n = 0; n < 4 && i < buf.length; n++, i++) {
      const b = buf[i]!;
      len += (b & 0x7f) * mult;
      mult *= 128;
      if ((b & 0x80) === 0) {
        ok = true;
        i++;
        break;
      }
    }
    if (!ok || i + len > buf.length) break;
    packets.push({ type: buf[o]! >> 4, flags: buf[o]! & 0xf, body: buf.subarray(i, i + len) });
    o = i + len;
  }
  return { packets, rest: buf.subarray(o) };
}

function remLen(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

export function packet(type: number, flags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), remLen(body.length), body]);
}

function str(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
}

function readStr(b: Buffer, o: number): [string, number] {
  const n = b.readUInt16BE(o);
  return [b.subarray(o + 2, o + 2 + n).toString("utf8"), o + 2 + n];
}

export const enc = {
  connect(clientId: string, opts: { username?: string; password?: string; keepalive?: number } = {}): Buffer {
    let flags = 0x02;
    if (opts.username !== undefined) flags |= 0x80;
    if (opts.password !== undefined) flags |= 0x40;
    const ka = Buffer.alloc(2);
    ka.writeUInt16BE(opts.keepalive ?? 60);
    const parts = [str("MQTT"), Buffer.from([4, flags]), ka, str(clientId)];
    if (opts.username !== undefined) parts.push(str(opts.username));
    if (opts.password !== undefined) parts.push(str(opts.password));
    return packet(1, 0, Buffer.concat(parts));
  },
  connack(code = 0): Buffer {
    return packet(2, 0, Buffer.from([0, code]));
  },
  publish(topic: string, payload: Buffer | string, qos: 0 | 1 = 0, id = 1, retain = false): Buffer {
    const pid = Buffer.alloc(qos ? 2 : 0);
    if (qos) pid.writeUInt16BE(id);
    return packet(3, (qos << 1) | (retain ? 1 : 0), Buffer.concat([str(topic), pid, Buffer.from(payload)]));
  },
  puback(id: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(id);
    return packet(4, 0, b);
  },
  subscribe(id: number, topic: string, qos = 0): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(id);
    return packet(8, 2, Buffer.concat([b, str(topic), Buffer.from([qos])]));
  },
  suback(id: number, codes: number[]): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(id);
    return packet(9, 0, Buffer.concat([b, Buffer.from(codes)]));
  },
  pingresp(): Buffer {
    return packet(13, 0, Buffer.alloc(0));
  },
};

export interface Publish {
  topic: string;
  payload: Buffer;
  qos: number;
  id?: number;
  retain: boolean;
}

export function decodePublish(p: MqttPacket): Publish {
  const [topic, o] = readStr(p.body, 0);
  const qos = (p.flags >> 1) & 3;
  let off = o;
  let id: number | undefined;
  if (qos > 0) {
    id = p.body.readUInt16BE(off);
    off += 2;
  }
  return { topic, payload: p.body.subarray(off), qos, ...(id !== undefined ? { id } : {}), retain: (p.flags & 1) === 1 };
}

export function decodeConnect(p: MqttPacket): { clientId: string; username?: string; hasPassword: boolean } {
  let [, o] = readStr(p.body, 0); // "MQTT"
  o += 1; // level
  const flags = p.body[o]!;
  o += 3; // flags + keepalive
  const [clientId, o2] = readStr(p.body, o);
  o = o2;
  if (flags & 0x04) {
    o = readStr(p.body, o)[1];
    o = readStr(p.body, o)[1];
  }
  let username: string | undefined;
  if (flags & 0x80) [username, o] = readStr(p.body, o);
  return { clientId, ...(username !== undefined ? { username } : {}), hasPassword: (flags & 0x40) !== 0 };
}

export function decodeSubscribe(p: MqttPacket): { id: number; topics: Array<{ topic: string; qos: number }> } {
  const id = p.body.readUInt16BE(0);
  const topics: Array<{ topic: string; qos: number }> = [];
  let o = 2;
  while (o < p.body.length) {
    const [t, o2] = readStr(p.body, o);
    topics.push({ topic: t, qos: p.body[o2]! });
    o = o2 + 1;
  }
  return { id, topics };
}

/** MQTT topic filter match (+ one level, # the rest). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** One line per packet for the log (payloads previewed, never more than 64 chars). */
export function summarizePacket(p: MqttPacket, dir: "out" | "in"): string {
  const name = MQTT_TYPES[p.type] ?? `type${p.type}`;
  const arrow = dir === "out" ? "device →" : "→ device";
  try {
    if (p.type === 3) {
      const pub = decodePublish(p);
      return `${arrow} PUBLISH ${pub.topic} qos${pub.qos} ${pub.payload.length} B ${previewBytes(pub.payload)}`;
    }
    if (p.type === 1) {
      const c = decodeConnect(p);
      return `${arrow} CONNECT client=${c.clientId}${c.username ? ` user=${c.username}` : ""}${c.hasPassword ? " password=(set)" : ""}`;
    }
    if (p.type === 8) return `${arrow} SUBSCRIBE ${decodeSubscribe(p).topics.map((t) => t.topic).join(", ")}`;
  } catch {
    /* fall through */
  }
  return `${arrow} ${name}`;
}

export function previewBytes(b: Buffer, n = 64): string {
  const printable = b.every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127));
  if (printable) {
    const s = b.toString("latin1");
    return JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);
  }
  return `<binary ${b.subarray(0, 8).toString("hex")}${b.length > 8 ? "…" : ""}>`;
}
