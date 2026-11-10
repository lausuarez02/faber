// Deterministic PIO clocking. rp2040js 1.4.1 runs PIO state machines from setTimeout, i.e. on the
// wall clock, one instruction per call whatever the clock divider, and keeps a Node process alive
// while a machine is enabled. Jumper turns that off and steps each enabled machine itself, on the
// virtual clock, at clk_sys / clkdiv, honouring instruction delays.
//
// Two shortcuts keep it fast without changing what the pins do:
// - a self-loop `jmp x-- self` / `jmp y-- self` (tone(), delay loops) is skipped in one go: the
//   loop only counts down a scratch register, so the time and the register are set directly;
// - a machine that stalls (wait, blocking pull / push) sleeps until something that could release
//   it happens: a CPU or DMA access to the PIO block, a GPIO input change, or another machine
//   running.
import type { RP2040 } from "rp2040js";

interface Machine {
  enabled: boolean;
  waiting: boolean;
  execValid: boolean;
  x: number;
  y: number;
  pc: number;
  cycles: number;
  clockDivInt: number;
  clockDivFrac: number;
  step(): void;
}

interface Block {
  machines: Machine[];
  instructions: Uint32Array;
  stopped: boolean;
  run(): void;
  stop(): void;
  checkChangedPins(): void;
  readUint32(offset: number): number;
  writeUint32(offset: number, value: number): void;
}

const JMP_X_DEC = 0b010;
const JMP_Y_DEC = 0b100;

export class PioClock {
  private readonly blocks: Block[];
  /** Virtual time (ns) of each machine's next instruction; Infinity while it sleeps. */
  private next: number[][];
  private readonly mcu: RP2040;
  private readonly now: () => number;
  /** Earliest `next` over all enabled machines (Infinity when none can run). */
  nextAt = Infinity;

  constructor(mcu: RP2040, now: () => number) {
    this.mcu = mcu;
    this.now = now;
    this.blocks = mcu.pio as unknown as Block[];
    this.next = this.blocks.map((b) => b.machines.map(() => Infinity));
    for (const b of this.blocks) {
      // Never let rp2040js schedule its own setTimeout loop.
      b.run = () => this.wake();
      const read = b.readUint32.bind(b);
      const write = b.writeUint32.bind(b);
      b.readUint32 = (offset: number) => {
        const v = read(offset);
        this.wake();
        return v;
      };
      b.writeUint32 = (offset: number, value: number) => {
        write(offset, value);
        this.wake();
      };
    }
  }

  /** Something changed that may release a stalled machine (or a machine was enabled): run them now. */
  wake(): void {
    const t = this.now();
    this.blocks.forEach((b, i) =>
      b.machines.forEach((m, j) => {
        if (!m.enabled) this.next[i]![j] = Infinity;
        else if (this.next[i]![j] === Infinity || this.next[i]![j]! < t) this.next[i]![j] = t;
      }),
    );
    this.recompute();
  }

  /** Run every machine whose next instruction is due at or before `t`. */
  runUntil(t: number): void {
    if (this.nextAt > t) return;
    const clkSys = this.mcu.clkSys;
    for (let guard = 0; guard < 1_000_000; guard++) {
      // Earliest due machine first, so machines interleave in time order.
      let bi = -1;
      let mi = -1;
      let at = Infinity;
      this.next.forEach((row, i) =>
        row.forEach((n, j) => {
          if (n < at) {
            at = n;
            bi = i;
            mi = j;
          }
        }),
      );
      if (bi < 0 || at > t) break;
      const b = this.blocks[bi]!;
      const m = b.machines[mi]!;
      if (!m.enabled) {
        this.next[bi]![mi] = Infinity;
        continue;
      }
      const div = (m.clockDivInt || 65536) + m.clockDivFrac / 256;
      const period = (div * 1e9) / clkSys;
      const op = b.instructions[m.pc]! & 0xffff;
      const isJmp = op >> 13 === 0;
      const cond = (op >> 5) & 7;
      if (isJmp && (op & 0x1f) === m.pc && (cond === JMP_X_DEC || cond === JMP_Y_DEC) && !m.waiting && !m.execValid) {
        const reg = cond === JMP_X_DEC ? m.x : m.y;
        if (reg > 1) {
          // reg - 1 taken iterations; the last two (taken with reg = 1, fall-through with reg = 0) run normally.
          const n = reg - 1;
          const per = 1 + delayCycles(op, m);
          if (cond === JMP_X_DEC) m.x = reg - n;
          else m.y = reg - n;
          m.cycles += n * per;
          this.next[bi]![mi] = at + n * per * period;
          continue;
        }
      }
      const before = m.cycles;
      m.step();
      b.checkChangedPins();
      if (m.waiting) {
        this.next[bi]![mi] = Infinity;
      } else {
        this.next[bi]![mi] = at + Math.max(1, m.cycles - before) * period;
      }
      // An instruction may set IRQ flags or move FIFOs another machine waits on.
      this.next.forEach((row, i) =>
        row.forEach((n, j) => {
          if (n === Infinity && this.blocks[i]!.machines[j]!.enabled && (i !== bi || j !== mi)) row[j] = this.next[bi]![mi]!;
        }),
      );
    }
    this.recompute();
  }

  private recompute(): void {
    let at = Infinity;
    for (const row of this.next) for (const n of row) if (n < at) at = n;
    this.nextAt = at;
  }
}

/** Delay cycles of a PIO instruction: bits 12:8 minus the side-set bits at the top. */
function delayCycles(op: number, m: Machine): number {
  const count = (m as unknown as { sidesetCount?: number }).sidesetCount ?? 0;
  return ((op >> 8) & 0x1f) & ((1 << (5 - count)) - 1);
}
