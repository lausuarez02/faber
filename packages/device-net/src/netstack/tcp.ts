// The far end of a device's TCP connection. The netstack terminates every TCP flow the device
// opens (whatever the destination), and hands the byte stream to the gateway as a Duplex. Only
// the server side of TCP is needed: the device always connects out.
//
// The link to the emulator is a reliable, ordered byte stream (QEMU -netdev stream), so loss only
// happens when the device itself drops a frame (lwIP out of buffers). A retransmission timer
// (go-back-N from the oldest unacknowledged byte) covers that; the device's window is respected,
// and a zero window is probed.
import type { Duplex } from "node:stream";
import { ACK, FIN, PSH, RST, SYN, seqAdd, seqDiff, type Tcp } from "./packets.ts";

export type TcpState = "syn-rcvd" | "established" | "close-wait" | "last-ack" | "fin-wait-1" | "fin-wait-2" | "closing" | "closed";

export interface TcpSegmentOut {
  seq: number;
  ack: number;
  flags: number;
  window: number;
  mss?: number;
  payload?: Buffer;
}

export interface TcpConnOptions {
  /** Send a segment to the device (the netstack wraps it in IP + Ethernet). */
  emit: (s: TcpSegmentOut) => void;
  /** Initial send sequence number (deterministic per connection). */
  iss: number;
  /** Called once the connection is gone, so the netstack can forget it. */
  onClosed: () => void;
  /** Retransmission timeout, ms (wall clock; the emulator may run slower than real time). */
  rtoMs?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

const OUR_WINDOW = 65535;
const OUR_MSS = 1460;
const MAX_BUFFERED = 256 * 1024;
const MAX_RETRIES = 8;

export class TcpConn {
  state: TcpState = "syn-rcvd";
  private iss: number;
  private sndUna: number;
  private sndNxt: number;
  private sndWnd = 0;
  private rcvNxt = 0;
  private mss = 536;
  /** Bytes from sndUna on: sent-but-unacked first, then not yet sent. */
  private buf: Buffer = Buffer.alloc(0);
  private finQueued = false;
  private finSent = false;
  private timer: unknown;
  private retries = 0;
  private rto: number;
  private duplex?: Duplex;
  private paused = false;
  /** Bytes the device sent / received on this connection. */
  bytesIn = 0;
  bytesOut = 0;

  constructor(private readonly o: TcpConnOptions) {
    this.iss = o.iss >>> 0;
    this.sndUna = this.iss;
    this.sndNxt = this.iss;
    this.rto = o.rtoMs ?? 1000;
  }

  private get timers() {
    return this.o.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };
  }

  /** The device's SYN: answer SYN-ACK. */
  open(syn: Tcp): void {
    this.rcvNxt = seqAdd(syn.seq, 1);
    this.mss = Math.min(syn.mss ?? 536, OUR_MSS);
    this.sndWnd = syn.window;
    this.o.emit({ seq: this.iss, ack: this.rcvNxt, flags: SYN | ACK, window: OUR_WINDOW, mss: OUR_MSS });
    this.sndNxt = seqAdd(this.iss, 1);
    this.arm();
  }

  /** Connect the byte stream (the gateway's flow) once the handshake is done. */
  attach(d: Duplex): void {
    this.duplex = d;
    d.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      if (this.buf.length > MAX_BUFFERED && !this.paused) {
        this.paused = true;
        d.pause();
      }
      this.flush();
    });
    d.on("end", () => {
      this.finQueued = true;
      this.flush();
    });
    d.on("close", () => {
      // Closed without a clean end (the gateway refused the flow, Wi-Fi dropped): reset.
      if (!this.finQueued && this.state !== "closed") this.reset();
    });
    d.on("error", () => {});
  }

  /** A segment from the device on this connection. */
  input(t: Tcp): void {
    if (this.state === "closed") return;
    if (t.flags & RST) {
      this.close(true);
      return;
    }
    if (t.flags & SYN) {
      // A retransmitted SYN: answer the SYN-ACK again.
      if (this.state === "syn-rcvd") this.o.emit({ seq: this.iss, ack: this.rcvNxt, flags: SYN | ACK, window: OUR_WINDOW, mss: OUR_MSS });
      return;
    }
    if (t.flags & ACK) this.onAck(t);
    let needAck = false;
    let data = t.payload;
    let seq = t.seq;
    if (data.length) {
      const d = seqDiff(this.rcvNxt, seq);
      if (d > 0) {
        // Partly or fully a retransmission of what we already have.
        data = d >= data.length ? Buffer.alloc(0) : data.subarray(d);
        seq = this.rcvNxt;
      }
      if (seq === this.rcvNxt && data.length && (this.state === "established" || this.state === "fin-wait-1" || this.state === "fin-wait-2")) {
        this.rcvNxt = seqAdd(this.rcvNxt, data.length);
        this.bytesOut += data.length;
        this.duplex?.write(data);
      }
      needAck = true;
    }
    if (t.flags & FIN && seqAdd(t.seq, t.payload.length) === this.rcvNxt) {
      this.rcvNxt = seqAdd(this.rcvNxt, 1);
      needAck = true;
      if (this.state === "established") {
        this.state = "close-wait";
        this.duplex?.end();
      } else if (this.state === "fin-wait-1") {
        this.state = "closing";
        this.duplex?.end();
      } else if (this.state === "fin-wait-2") {
        this.ack();
        this.duplex?.end();
        this.close(false);
        return;
      }
    }
    if (needAck && !this.flush()) this.ack();
  }

  private onAck(t: Tcp): void {
    this.sndWnd = t.window;
    const acked = seqDiff(t.ack, this.sndUna);
    if (acked <= 0 || seqDiff(t.ack, this.sndNxt) > 0) {
      if (acked === 0) this.flush();
      return;
    }
    if (this.state === "syn-rcvd") {
      this.state = "established";
      this.sndUna = t.ack;
      this.retries = 0;
      this.disarm();
      this.flush();
      return;
    }
    let dataAcked = acked;
    const finAcked = this.finSent && t.ack === this.sndNxt;
    if (finAcked) dataAcked -= 1;
    if (dataAcked > 0) {
      this.buf = this.buf.subarray(Math.min(dataAcked, this.buf.length));
      this.bytesIn += dataAcked;
      if (this.paused && this.buf.length < MAX_BUFFERED / 2) {
        this.paused = false;
        this.duplex?.resume();
      }
    }
    this.sndUna = t.ack;
    this.retries = 0;
    this.rto = this.o.rtoMs ?? 1000;
    this.disarm();
    if (finAcked) {
      if (this.state === "fin-wait-1") this.state = "fin-wait-2";
      else if (this.state === "closing" || this.state === "last-ack") {
        this.close(false);
        return;
      }
    }
    if (this.sndUna !== this.sndNxt) this.arm();
    this.flush();
  }

  /** Send what the window allows. Returns true if at least one segment went out. */
  private flush(): boolean {
    if (this.state === "syn-rcvd" || this.state === "closed") return false;
    let sent = false;
    for (;;) {
      const inflight = seqDiff(this.sndNxt, this.sndUna) - (this.finSent ? 1 : 0);
      const unsent = this.buf.length - inflight;
      if (unsent <= 0) break;
      const room = this.sndWnd - inflight;
      if (room <= 0) {
        // Zero window: the retransmission timer doubles as the persist timer.
        this.arm();
        break;
      }
      const n = Math.min(unsent, room, this.mss);
      const payload = this.buf.subarray(inflight, inflight + n);
      this.o.emit({ seq: this.sndNxt, ack: this.rcvNxt, flags: ACK | PSH, window: OUR_WINDOW, payload });
      this.sndNxt = seqAdd(this.sndNxt, n);
      sent = true;
      this.arm();
    }
    const allSent = seqDiff(this.sndNxt, this.sndUna) - (this.finSent ? 1 : 0) >= this.buf.length;
    if (this.finQueued && !this.finSent && allSent && (this.state === "established" || this.state === "close-wait")) {
      this.o.emit({ seq: this.sndNxt, ack: this.rcvNxt, flags: FIN | ACK, window: OUR_WINDOW });
      this.sndNxt = seqAdd(this.sndNxt, 1);
      this.finSent = true;
      this.state = this.state === "established" ? "fin-wait-1" : "last-ack";
      sent = true;
      this.arm();
    }
    return sent;
  }

  private ack(): void {
    this.o.emit({ seq: this.sndNxt, ack: this.rcvNxt, flags: ACK, window: OUR_WINDOW });
  }

  private arm(): void {
    if (this.timer !== undefined) return;
    this.timer = this.timers.set(() => this.onTimeout(), this.rto);
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private onTimeout(): void {
    this.timer = undefined;
    if (this.state === "closed") return;
    if (++this.retries > MAX_RETRIES) {
      this.reset();
      return;
    }
    this.rto = Math.min(this.rto * 2, 8000);
    if (this.state === "syn-rcvd") {
      this.o.emit({ seq: this.iss, ack: this.rcvNxt, flags: SYN | ACK, window: OUR_WINDOW, mss: OUR_MSS });
      this.arm();
      return;
    }
    if (this.sndWnd === 0 && this.buf.length > seqDiff(this.sndNxt, this.sndUna)) {
      // Zero-window probe: one byte past the window.
      const inflight = seqDiff(this.sndNxt, this.sndUna);
      this.o.emit({ seq: this.sndNxt, ack: this.rcvNxt, flags: ACK, window: OUR_WINDOW, payload: this.buf.subarray(inflight, inflight + 1) });
      this.arm();
      return;
    }
    // Go back N: resend from the oldest unacknowledged byte.
    if (this.sndUna !== this.sndNxt) {
      this.sndNxt = this.sndUna;
      if (this.finSent) {
        this.finSent = false;
        this.state = this.state === "fin-wait-1" || this.state === "closing" ? "established" : this.state === "last-ack" ? "close-wait" : this.state;
      }
      this.flush();
    }
  }

  /** Abort: RST to the device, destroy the flow. */
  reset(): void {
    if (this.state === "closed") return;
    this.o.emit({ seq: this.sndNxt, ack: this.rcvNxt, flags: RST | ACK, window: 0 });
    this.close(true);
  }

  private close(abort: boolean): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.disarm();
    if (abort) this.duplex?.destroy();
    this.o.onClosed();
  }
}
