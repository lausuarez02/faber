// A passive WebSocket frame reader, for summarizing frames that Faber forwards to a real host
// (it does not terminate the WebSocket there, it only watches the bytes go by). Masked client
// frames are unmasked for the preview only.

export interface FrameInfo {
  fin: boolean;
  opcode: number;
  length: number;
  preview: Buffer;
}

const OPS: Record<number, string> = { 0: "cont", 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong" };
export const opName = (op: number) => OPS[op] ?? `op${op}`;

export class FrameReader {
  private buf = Buffer.alloc(0);
  /** Bytes of the current frame's payload still to skip. */
  private skip = 0;

  push(chunk: Buffer): FrameInfo[] {
    const out: FrameInfo[] = [];
    if (this.skip > 0) {
      const s = Math.min(this.skip, chunk.length);
      this.skip -= s;
      chunk = chunk.subarray(s);
    }
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let o = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        o = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        len = Number(b.readBigUInt64BE(2));
        o = 10;
      }
      const mask = masked ? b.subarray(o, o + 4) : undefined;
      if (masked) o += 4;
      if (b.length < o) break;
      const avail = Math.min(len, b.length - o, 32);
      const preview = Buffer.from(b.subarray(o, o + avail));
      if (mask) for (let i = 0; i < preview.length; i++) preview[i]! ^= mask[i % 4]!;
      out.push({ fin: (b[0]! & 0x80) !== 0, opcode: b[0]! & 0x0f, length: len, preview });
      const have = b.length - o;
      if (have >= len) this.buf = b.subarray(o + len);
      else {
        this.skip = len - have;
        this.buf = Buffer.alloc(0);
        break;
      }
    }
    return out;
  }
}
