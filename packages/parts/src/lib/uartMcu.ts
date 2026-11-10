// A fake MCU for UART part tests (round 7, voice): it bit-bangs bytes onto a pin at a baud rate,
// cycle-exact, the way firmware with SoftwareSerial / a hardware UART on its pins would, and records
// the edges a part drives on another pin so the test can decode the replies. No firmware needed.
import type { McuBackend, PinState } from "@jumper/sim-core";

type Listener = (pin: string, state: PinState, cycle: number) => void;

export class UartScriptMcu implements McuBackend {
  readonly cyclesPerSecond = 16_000_000;
  readonly vcc = 5;
  readonly pinIds: readonly string[] = [...Array.from({ length: 14 }, (_, i) => `D${i}`), ...Array.from({ length: 6 }, (_, i) => `A${i}`)];
  cycles = 0;
  private stepEnd = 0;
  private events: { cycle: number; pin: string; value: 0 | 1 }[] = [];
  private pins = new Map<string, PinState>(this.pinIds.map((p) => [p, { mode: "input", value: 0 }]));
  private listeners = new Set<Listener>();
  /** Input edges per pin: [cycle, level]. */
  readonly edges = new Map<string, [number, 0 | 1][]>();
  private lastEnd = new Map<string, number>();

  load(): void {
    this.reset();
  }
  reset(): void {
    this.cycles = 0;
    this.events = [];
  }
  /** Make `pin` an output idling HIGH (a UART TX after begin()). */
  idle(pin: string): void {
    this.set(pin, 1);
  }
  /** Queue bytes on `pin` (8N1, LSB first) starting now or after the previous bytes on that pin. */
  send(pin: string, bytes: number[], baud = 9600): void {
    const bit = this.cyclesPerSecond / baud;
    let t = Math.max(this.cycles + 1, this.lastEnd.get(pin) ?? 0);
    for (const b of bytes) {
      const levels: (0 | 1)[] = [0, ...Array.from({ length: 8 }, (_, i) => ((b >> i) & 1) as 0 | 1), 1];
      levels.forEach((l, i) => this.events.push({ cycle: Math.round(t + i * bit), pin, value: l }));
      t += 10 * bit;
    }
    this.lastEnd.set(pin, Math.round(t));
    this.events.sort((a, b) => a.cycle - b.cycle);
  }
  step(n: number): void {
    this.stepEnd = this.cycles + n;
    while (this.events.length && this.events[0]!.cycle <= this.stepEnd) {
      const e = this.events.shift()!;
      this.cycles = Math.max(this.cycles, e.cycle);
      this.set(e.pin, e.value);
    }
    this.cycles = Math.max(this.cycles, this.stepEnd);
  }
  stopAt(cycle: number): void {
    if (cycle < this.stepEnd) this.stepEnd = Math.max(this.cycles, Math.floor(cycle));
  }
  readPin(id: string): PinState {
    return { ...(this.pins.get(id) ?? { mode: "input", value: 0 }) };
  }
  setPinInput(id: string, volts: number): void {
    const p = this.pins.get(id);
    if (!p || p.mode === "output") return;
    const v: 0 | 1 = volts > 2 ? 1 : 0;
    if (v !== p.value) {
      p.value = v;
      const list = this.edges.get(id) ?? [];
      list.push([this.cycles, v]);
      this.edges.set(id, list);
    }
  }
  onPinChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
  onSerial(): () => void {
    return () => {};
  }
  /** Decode the bytes a part sent on `pin` (8N1 at `baud`) from the recorded edges. */
  received(pin: string, baud = 9600): number[] {
    const edges = this.edges.get(pin) ?? [];
    const bit = this.cyclesPerSecond / baud;
    const levelAt = (t: number): 0 | 1 => {
      let l: 0 | 1 = 1;
      for (const [c, v] of edges) {
        if (c > t) break;
        l = v;
      }
      return l;
    };
    const out: number[] = [];
    let i = 0;
    while (i < edges.length) {
      const [start, v] = edges[i]!;
      if (v !== 0) {
        i++;
        continue;
      }
      let b = 0;
      for (let k = 0; k < 8; k++) if (levelAt(start + (1.5 + k) * bit)) b |= 1 << k;
      out.push(b);
      const end = start + 9.6 * bit;
      while (i < edges.length && edges[i]![0] < end) i++;
    }
    return out;
  }
  private set(pin: string, value: 0 | 1): void {
    const state: PinState = { mode: "output", value };
    this.pins.set(pin, state);
    for (const l of this.listeners) l(pin, state, this.cycles);
  }
}
