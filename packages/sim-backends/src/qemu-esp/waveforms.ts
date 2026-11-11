// Pin waveforms the ESP backend draws itself from peripheral events, so part models see real edges
// at exact virtual times (a servo measures its pulse, a buzzer its frequency, a WS2812 chain decodes
// its bits, a DFPlayer reads UART frames) while QEMU only reports what the peripheral was told to
// do. Times are float ns of virtual time. Deterministic: no wall clock.

export interface Edge {
  t: number;
  level: 0 | 1;
}

/** A source of edges in time order. */
export interface Waveform {
  /** Level at the current cursor (after the last edge taken). */
  readonly level: 0 | 1;
  /** Next edge strictly after the cursor, or undefined when the level stays. */
  peek(): Edge | undefined;
  /** Moves the cursor past the edge peek() returned. */
  take(): void;
}

/** LEDC channel: period P, high time H, phase (hpoint) from an epoch. */
export class PwmWave implements Waveform {
  private _level: 0 | 1;
  private cursor: number;
  private epoch = 0;
  private period = 0;
  private high = 0;
  private phase = 0;
  private constant: 0 | 1 | undefined;

  constructor(t: number, idle: 0 | 1) {
    this.cursor = t;
    this._level = idle;
    this.constant = idle;
  }

  get level(): 0 | 1 {
    return this._level;
  }

  /** New channel settings at time t (ns). Returns the level the pin must have at t. */
  update(t: number, o: { enabled: boolean; idle: 0 | 1; periodNs: number; highNs: number; phaseNs: number }): 0 | 1 {
    this.cursor = t;
    if (!o.enabled) this.constant = o.idle;
    else if (o.periodNs <= 0 || o.highNs <= 0) this.constant = 0;
    else if (o.highNs >= o.periodNs) this.constant = 1;
    else this.constant = undefined;
    if (this.constant !== undefined) {
      this._level = this.constant;
      return this._level;
    }
    // A duty change keeps the counter running (it lands at the next period); a new period restarts it.
    const samePeriod = Math.abs(o.periodNs - this.period) < 1e-6 && Math.abs(o.phaseNs - this.phase) < 1e-6 && this.period > 0;
    if (!samePeriod) this.epoch = t;
    this.period = o.periodNs;
    this.high = o.highNs;
    this.phase = o.phaseNs;
    this._level = this.levelAt(t);
    return this._level;
  }

  private levelAt(t: number): 0 | 1 {
    const base = this.epoch + this.phase;
    const k = Math.floor((t - base) / this.period);
    const r = base + k * this.period;
    return t >= r && t < r + this.high ? 1 : 0;
  }

  peek(): Edge | undefined {
    if (this.constant !== undefined) return undefined;
    const base = this.epoch + this.phase;
    const t = this.cursor + 1e-6;
    const k = Math.floor((t - base) / this.period);
    const r = base + k * this.period;
    const f = r + this.high;
    if (t < r) return { t: r, level: 1 };
    if (t < f) return { t: f, level: 0 };
    return { t: r + this.period, level: 1 };
  }

  take(): void {
    const e = this.peek();
    if (!e) return;
    this.cursor = e.t;
    this._level = e.level;
  }

  /** The waveform's settings, for tests and the inspector. */
  get settings() {
    return { periodNs: this.period, highNs: this.high, phaseNs: this.phase, constant: this.constant };
  }
}

/** A queue of absolute edges (RMT symbols, UART frames, hardware chip select). */
export class EdgeQueue implements Waveform {
  private edges: Edge[] = [];
  private _level: 0 | 1;
  /** Time the last queued edge lands (UART frames queue after it). */
  end: number;

  constructor(idle: 0 | 1, t = 0) {
    this._level = idle;
    this.end = t;
  }

  get level(): 0 | 1 {
    return this._level;
  }

  /** Level after every queued edge. */
  get finalLevel(): 0 | 1 {
    return this.edges.length ? this.edges[this.edges.length - 1]!.level : this._level;
  }

  get pending(): number {
    return this.edges.length;
  }

  push(t: number, level: 0 | 1): void {
    if (level === this.finalLevel) {
      this.end = Math.max(this.end, t);
      return;
    }
    const last = this.edges[this.edges.length - 1];
    if (last && t < last.t) t = last.t;
    this.edges.push({ t, level });
    this.end = Math.max(this.end, t);
  }

  peek(): Edge | undefined {
    return this.edges[0];
  }

  take(): void {
    const e = this.edges.shift();
    if (e) this._level = e.level;
  }

  clear(level: 0 | 1): void {
    this.edges = [];
    this._level = level;
  }
}

/** RMT words (dur0 15 bits, level0, dur1 15 bits, level1) from t0 at tickNs per tick, into a queue. Returns the end time. */
export function queueRmt(q: EdgeQueue, t0: number, tickNs: number, words: Uint32Array, idle: 0 | 1): number {
  let t = Math.max(t0, q.end);
  let ended = false;
  for (const w of words) {
    const d0 = w & 0x7fff;
    const l0 = ((w >>> 15) & 1) as 0 | 1;
    const d1 = (w >>> 16) & 0x7fff;
    const l1 = ((w >>> 31) & 1) as 0 | 1;
    if (d0 === 0) {
      ended = true;
      break;
    }
    q.push(t, l0);
    t += d0 * tickNs;
    if (d1 === 0) {
      ended = true;
      break;
    }
    q.push(t, l1);
    t += d1 * tickNs;
  }
  q.end = t;
  if (ended) q.push(t, idle);
  return t;
}

/** One 8N1 UART frame per byte, LSB first, from max(t0, the end of what is queued). */
export function queueUart(q: EdgeQueue, t0: number, baud: number, bytes: Iterable<number>): number {
  const bit = 1e9 / baud;
  let t = Math.max(t0, q.end);
  for (const b of bytes) {
    q.push(t, 0);
    for (let i = 0; i < 8; i++) q.push(t + (1 + i) * bit, ((b >> i) & 1) as 0 | 1);
    q.push(t + 9 * bit, 1);
    t += 10 * bit;
    q.end = t;
  }
  return t;
}

/** Decodes 8N1 bytes from input level changes (a part driving the MCU's RX pin). */
export class UartDecoder {
  private start = -1;
  private edges: Edge[] = [];
  private level: 0 | 1 = 1;
  framingErrors = 0;

  constructor(public baud: number) {}

  /** Level change at t. Returns the time the frame in progress completes (decode then), if a frame just started. */
  edge(t: number, level: 0 | 1): number | undefined {
    if (level === this.level) return undefined;
    this.level = level;
    if (this.start < 0) {
      if (level !== 0) return undefined;
      this.start = t;
      this.edges = [];
      return t + 9.5 * (1e9 / this.baud);
    }
    this.edges.push({ t, level });
    return undefined;
  }

  /** At the frame's completion time: the byte, or undefined (framing error). May start the next frame. */
  complete(): { byte?: number; nextAt?: number } {
    const bit = 1e9 / this.baud;
    const s = this.start;
    if (s < 0) return {};
    const at = (t: number): 0 | 1 => {
      let l: 0 | 1 = 0;
      for (const e of this.edges) {
        if (e.t > t) break;
        l = e.level;
      }
      return l;
    };
    let b = 0;
    for (let i = 0; i < 8; i++) if (at(s + (1.5 + i) * bit)) b |= 1 << i;
    const stop = at(s + 9.5 * bit);
    const end = s + 9.5 * bit;
    const later = this.edges.filter((e) => e.t > end);
    this.start = -1;
    this.edges = [];
    let nextAt: number | undefined;
    // The line went low again after the stop bit sample: that is the next start bit.
    const nextStart = later.find((e) => e.level === 0);
    if (nextStart) {
      this.start = nextStart.t;
      this.edges = later.filter((e) => e.t > nextStart.t);
      nextAt = nextStart.t + 9.5 * bit;
    }
    if (!stop) {
      this.framingErrors++;
      return { nextAt };
    }
    return { byte: b, nextAt };
  }
}
