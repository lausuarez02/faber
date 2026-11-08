/**
 * Deterministic virtual clock. Time is a count of MCU cycles; nothing here reads the wall clock.
 * Cycles are a JS number: exact up to 2^53 (≈ 17.8 years at 16 MHz).
 */

export type ClockCallback = (cycle: number) => void;
export type EventId = number;

interface ScheduledEvent {
  at: number;
  seq: number;
  cb: ClockCallback;
  cancelled: boolean;
}

export class Clock {
  readonly frequency: number;
  private _cycles = 0;
  private seq = 0;
  private heap: ScheduledEvent[] = [];
  private byId = new Map<EventId, ScheduledEvent>();

  /** @param frequency cycles per second (Hz), e.g. 16_000_000. */
  constructor(frequency: number) {
    if (!(frequency > 0) || !Number.isFinite(frequency)) throw new Error(`clock frequency must be > 0, got ${frequency}`);
    this.frequency = frequency;
  }

  /** Current cycle count. */
  get cycles(): number {
    return this._cycles;
  }

  /** Current virtual time in ms. */
  get ms(): number {
    return this.toMs(this._cycles);
  }

  toMs(cycles: number): number {
    return (cycles * 1000) / this.frequency;
  }

  /** ms → cycles, rounded to the nearest whole cycle. */
  fromMs(ms: number): number {
    return Math.round((ms * this.frequency) / 1000);
  }

  /**
   * Run `cb` when the clock reaches `atCycle` (absolute). Events at the same cycle run in the
   * order they were scheduled. Scheduling in the past runs it on the next advance.
   */
  schedule(atCycle: number, cb: ClockCallback): EventId {
    const ev: ScheduledEvent = { at: atCycle, seq: this.seq++, cb, cancelled: false };
    this.push(ev);
    this.byId.set(ev.seq, ev);
    return ev.seq;
  }

  /** schedule(cycles + delayCycles, cb). */
  scheduleIn(delayCycles: number, cb: ClockCallback): EventId {
    return this.schedule(this._cycles + delayCycles, cb);
  }

  cancel(id: EventId): boolean {
    const ev = this.byId.get(id);
    if (!ev) return false;
    ev.cancelled = true;
    this.byId.delete(id);
    return true;
  }

  /** Cycle of the next pending event, or undefined. */
  nextEventCycle(): number | undefined {
    this.dropCancelled();
    return this.heap[0]?.at;
  }

  get pendingEvents(): number {
    return this.byId.size;
  }

  /**
   * Move time forward to `cycle`, running due events in order. Each callback sees `cycles` equal
   * to its own scheduled cycle (or the current cycle if it was scheduled in the past).
   * Events scheduled by callbacks for ≤ `cycle` also run. Moving backwards throws.
   */
  advanceTo(cycle: number): void {
    if (cycle < this._cycles) throw new Error(`clock cannot go backwards (${this._cycles} → ${cycle})`);
    for (;;) {
      this.dropCancelled();
      const top = this.heap[0];
      if (!top || top.at > cycle) break;
      this.pop();
      this.byId.delete(top.seq);
      if (top.at > this._cycles) this._cycles = top.at;
      top.cb(this._cycles);
    }
    this._cycles = cycle;
  }

  advance(cycles: number): void {
    this.advanceTo(this._cycles + cycles);
  }

  /** Back to cycle 0 and drop every pending event. */
  reset(): void {
    this._cycles = 0;
    this.heap = [];
    this.byId.clear();
  }

  // --- binary heap ordered by (at, seq) ---
  private less(a: ScheduledEvent, b: ScheduledEvent) {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
  private push(ev: ScheduledEvent) {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  private pop(): ScheduledEvent | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < h.length && this.less(h[l]!, h[s]!)) s = l;
        if (r < h.length && this.less(h[r]!, h[s]!)) s = r;
        if (s === i) break;
        [h[i], h[s]] = [h[s]!, h[i]!];
        i = s;
      }
    }
    return top;
  }
  private dropCancelled() {
    while (this.heap[0]?.cancelled) this.pop();
  }
}
