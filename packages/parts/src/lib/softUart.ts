// UART on plain GPIO nets, for parts that talk serial to a board pin (an ESP-01 on the Uno's
// SoftwareSerial pins). 8N1, LSB first, idle high. Cycle-exact: the receiver gets the MCU pin's
// edges through ctx.watch and samples each bit in its middle; the transmitter changes its output
// level at scheduled virtual times through ctx.schedule, so the firmware's pin-change interrupt
// sees every edge on the right cycle. Deterministic: virtual time only.
import type { PartContext } from "@fabwright/sim-core";

/** Decodes bytes the MCU sends on `pin` (the part's RX). */
export class UartReceiver {
  private start = -1;
  private edges: [number, 0 | 1][] = [];
  private unwatch: () => void = () => {};
  /** Bytes with a bad stop bit (wrong baud rate, noise), since creation. */
  framingErrors = 0;
  bytes = 0;

  constructor(
    private readonly ctx: PartContext,
    private readonly pin: string,
    private readonly baud: () => number,
    private readonly onByte: (byte: number, tMs: number) => void,
  ) {
    if (ctx.watch) this.unwatch = ctx.watch(pin, (level, t) => this.edge(level, t));
  }

  /** True when the MCU drives the pin (a GPIO on the net, directly or through resistors). */
  get attached(): boolean {
    return this.ctx.watch !== undefined;
  }

  dispose(): void {
    this.unwatch();
  }

  private edge(level: 0 | 1, t: number): void {
    if (this.start < 0) {
      if (level !== 0) return;
      this.start = t;
      this.edges = [];
      const bit = 1000 / this.baud();
      this.ctx.schedule?.(9.5 * bit - (this.ctx.now() - t), () => this.decode());
      return;
    }
    this.edges.push([t, level]);
  }

  private levelAt(t: number): 0 | 1 {
    let level: 0 | 1 = 0;
    for (const [et, l] of this.edges) {
      if (et > t) break;
      level = l;
    }
    return level;
  }

  private decode(): void {
    const bit = 1000 / this.baud();
    const s = this.start;
    let b = 0;
    for (let i = 0; i < 8; i++) if (this.levelAt(s + (1.5 + i) * bit)) b |= 1 << i;
    const stop = this.levelAt(s + 9.5 * bit);
    const t = s + 9.5 * bit;
    this.start = -1;
    // The line went low again during the frame's stop bit: that is the next start bit.
    const last = this.edges[this.edges.length - 1];
    this.edges = [];
    if (!stop) {
      this.framingErrors++;
      if (last && last[1] === 0) this.edge(0, last[0]);
      return;
    }
    this.bytes++;
    this.onByte(b, t);
  }
}

/** Sends bytes on the part's TX pin. The part stamps its pin with `level` (and calls requestSolve on change). */
export class UartTransmitter {
  level: 0 | 1 = 1;
  private queue: number[] = [];
  private busy = false;
  private cancel: (() => void) | undefined;
  /** Virtual time the last byte finished, for activity LEDs. */
  lastActivity = -1;
  bytes = 0;

  constructor(
    private readonly ctx: PartContext,
    private readonly baud: () => number,
    private readonly onLevel: (level: 0 | 1) => void,
  ) {}

  get pending(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  /** Queue a byte string (latin1, one char per byte). `atBaud` overrides the baud for these bytes (boot ROM at 74880). */
  send(text: string, atBaud?: number): void {
    for (let i = 0; i < text.length; i++) this.queue.push((text.charCodeAt(i) & 0xff) | (atBaud ? atBaud << 8 : 0));
    if (!this.busy) this.next();
  }

  /** Drop everything (power off, reset). */
  clear(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.queue = [];
    this.busy = false;
    this.set(1);
  }

  private set(level: 0 | 1): void {
    if (level === this.level) return;
    this.level = level;
    this.onLevel(level);
  }

  private next(): void {
    const item = this.queue.shift();
    if (item === undefined) {
      this.busy = false;
      return;
    }
    if (!this.ctx.schedule) {
      // No scheduler (simple bench): nothing can be timed; drop.
      this.busy = false;
      this.queue = [];
      return;
    }
    this.busy = true;
    const byte = item & 0xff;
    const baud = item >> 8 || this.baud();
    const bit = 1000 / baud;
    const t0 = this.ctx.now();
    // Levels of start, 8 data bits, stop.
    const levels: (0 | 1)[] = [0];
    for (let i = 0; i < 8; i++) levels.push(((byte >> i) & 1) as 0 | 1);
    levels.push(1);
    let i = 0;
    const step = (): void => {
      this.set(levels[i]!);
      i++;
      // Next change: skip bits at the same level.
      while (i < levels.length && levels[i] === this.level) i++;
      const at = i < levels.length ? t0 + i * bit : t0 + 10 * bit;
      this.cancel = this.ctx.schedule!(Math.max(0, at - this.ctx.now()), () => {
        if (i < levels.length) step();
        else {
          this.bytes++;
          this.lastActivity = this.ctx.now();
          this.next();
        }
      });
    };
    step();
  }
}
