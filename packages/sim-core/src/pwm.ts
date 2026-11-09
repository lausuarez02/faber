// PWM measurement from pin-change events. Deterministic: everything is computed from the cycle
// stamps the MCU backend reports, never from wall-clock time.
//
// Why: analogWrite() toggles a pin 490 or 976 times a second. Solving the circuit on every edge is
// correct but slow, and parts such as a servo or a motor care about the pulse width or the duty
// cycle, not the individual edges. The meter turns edges into { duty, highUs, periodUs } and tells
// the Simulation when an edge actually changes something worth a re-solve.
import type { ElementId, NodeId, SolveResult } from "./circuit.ts";

/** What a part (or an agent) sees on a PWM-driven net. */
export interface PwmReading {
  /** Fraction of time HIGH over the last complete period, 0..1. When the pin is not toggling, its steady level (0 or 1). */
  duty: number;
  /** Last complete HIGH pulse (rising → falling edge) in µs; 0 until one has been seen. */
  highUs: number;
  /** Last complete period (rising → rising edge) in µs; 0 until one has been seen. */
  periodUs: number;
  /** 1e6 / periodUs, or 0. */
  freqHz: number;
  /**
   * true when the edges come faster than PWM_FAST_PERIOD_US apart: the Simulation then stops
   * solving the circuit on every edge and solves on duty-averaged values instead (see
   * packages/sim-core/PWM.md). false for slow signals such as 50 Hz servo pulses, which are solved per edge.
   */
  averaged: boolean;
  /** Level the pin (or the driver output) has right now. */
  level: 0 | 1;
  /** µs since the last edge. */
  sinceEdgeUs: number;
  /** Who produces it: "mcu:D9" for a microcontroller pin, or the part id of a driver that declared it (e.g. "drv"). */
  source: string;
}

/** Signals with a period below this are solved on duty-averaged values (200 Hz and up). Servo pulses (50 Hz) stay per-edge. */
export const PWM_FAST_PERIOD_US = 5000;
/** A duty change smaller than this (absolute) does not trigger a re-solve while averaged. */
export const PWM_DUTY_EPSILON = 0.004;
/** An averaged signal with no edge for this many periods is treated as stopped (analogWrite(0) / (255) or digitalWrite). */
export const PWM_STALE_PERIODS = 3;

/** Per-pin edge tracker. One per MCU GPIO; driven by the Simulation from onPinChange. */
export class PwmMeter {
  private level: 0 | 1 = 0;
  private output = false;
  private lastRise = -1;
  private prevRise = -1;
  private lastFall = -1;
  private lastEdge = 0;
  private highCycles = 0;
  private periodCycles = 0;
  private rises = 0;
  private _averaged = false;
  /** Duty the circuit was last solved with (while averaged). */
  private solvedDuty = -1;

  constructor(
    readonly pin: string,
    private readonly cyclesPerSecond: number,
  ) {}

  get averaged(): boolean {
    return this._averaged;
  }

  /** Duty over the last complete period (or the level when not toggling). */
  get duty(): number {
    if (!this._averaged) return this.level;
    return this.periodCycles > 0 ? Math.min(1, Math.max(0, this.highCycles / this.periodCycles)) : this.level;
  }

  private us(cycles: number): number {
    return (cycles * 1e6) / this.cyclesPerSecond;
  }

  /**
   * Record a pin change. Returns true when the circuit needs a re-solve: always for slow signals
   * (one solve per edge, as before), and for averaged signals only when the measured duty moved by
   * more than PWM_DUTY_EPSILON or the signal just became averaged.
   */
  change(mode: string, value: 0 | 1, cycle: number): boolean {
    const isOutput = mode === "output";
    if (!isOutput) {
      this.resetEdges();
      this.output = false;
      this.level = value;
      return true;
    }
    if (!this.output) {
      // Became an output: start measuring from scratch.
      this.resetEdges();
      this.output = true;
      this.level = value;
      this.lastEdge = cycle;
      if (value === 1) {
        // Starts HIGH: count it as a rising edge so the first pulse is measured too.
        this.lastRise = cycle;
        this.rises = 1;
      }
      return true;
    }
    if (value === this.level) return !this._averaged;
    this.level = value;
    this.lastEdge = cycle;
    if (value === 1) {
      this.prevRise = this.lastRise;
      this.lastRise = cycle;
      this.rises++;
      if (this.prevRise >= 0) {
        this.periodCycles = this.lastRise - this.prevRise;
        if (this.lastFall > this.prevRise) this.highCycles = this.lastFall - this.prevRise;
      }
      const fast = this.rises >= 3 && this.periodCycles > 0 && this.us(this.periodCycles) < PWM_FAST_PERIOD_US;
      if (fast !== this._averaged) {
        this._averaged = fast;
        this.solvedDuty = -1;
        return true;
      }
      if (!fast) return true;
      const d = this.duty;
      if (Math.abs(d - this.solvedDuty) > PWM_DUTY_EPSILON) return true;
      return false;
    }
    // falling edge
    this.lastFall = cycle;
    if (this.lastRise >= 0) this.highCycles = this.lastFall - this.lastRise;
    return !this._averaged;
  }

  /** The Simulation calls this when it solved with the current duty. */
  markSolved(): void {
    this.solvedDuty = this.duty;
  }

  /** Called on the periodic tick: an averaged signal that stopped toggling falls back to per-edge. Returns true if that happened. */
  checkStale(cycle: number): boolean {
    if (!this._averaged) return false;
    if (cycle - this.lastEdge > PWM_STALE_PERIODS * this.periodCycles) {
      this._averaged = false;
      this.rises = 0;
      this.solvedDuty = -1;
      return true;
    }
    return false;
  }

  reading(cycle: number): PwmReading {
    const periodUs = this.us(this.periodCycles);
    return {
      duty: this.duty,
      highUs: this.us(this.highCycles),
      periodUs,
      freqHz: periodUs > 0 ? 1e6 / periodUs : 0,
      averaged: this._averaged,
      level: this.level,
      sinceEdgeUs: this.us(Math.max(0, cycle - this.lastEdge)),
      source: `mcu:${this.pin}`,
    };
  }

  private resetEdges(): void {
    this.lastRise = -1;
    this.prevRise = -1;
    this.lastFall = -1;
    this.highCycles = 0;
    this.periodCycles = 0;
    this.rises = 0;
    this._averaged = false;
    this.solvedDuty = -1;
  }
}

// ---------------------------------------------------------------------------
// Duty-averaged solve
// ---------------------------------------------------------------------------

/**
 * Combine the solves the Simulation runs while some pins are averaged PWM:
 *   base  = every averaged pin LOW,
 *   ri    = only pin i HIGH (weight di = its duty).
 * Result = base + Σ di · (ri − base) for every voltage and current. For a linear network this is
 * exactly the time average (superposition). For a nonlinear element driven by ONE PWM pin (an LED
 * behind a resistor) it is also exact, because the element is either in the HIGH or the LOW
 * configuration. Only nonlinear elements fed by SEVERAL PWM pins at once are approximate.
 */
export function averageSolves(base: SolveResult, variants: readonly { r: SolveResult; w: number }[]): SolveResult {
  const voltages = new Map<NodeId, number>();
  for (const [n, v0] of base.voltages) {
    let v = v0;
    for (const { r, w } of variants) v += w * ((r.voltages.get(n) ?? 0) - v0);
    voltages.set(n, v);
  }
  const currents = new Map<ElementId, number>();
  const ids = new Set<ElementId>(base.currents.keys());
  for (const { r } of variants) for (const id of r.currents.keys()) ids.add(id);
  for (const id of ids) {
    const i0 = base.currents.get(id) ?? 0;
    let i = i0;
    for (const { r, w } of variants) i += w * ((r.currents.get(id) ?? 0) - i0);
    currents.set(id, i);
  }
  const floating = new Set<NodeId>();
  for (const n of base.floating) if (variants.every(({ r }) => r.floating.has(n))) floating.add(n);
  const all = [base, ...variants.map((v) => v.r)];
  return {
    voltages,
    currents,
    floating,
    iterations: Math.max(...all.map((r) => r.iterations)),
    converged: all.every((r) => r.converged),
    voltage: (n) => voltages.get(n) ?? 0,
    current: (id) => currents.get(id) ?? 0,
    isFloating: (n) => floating.has(n),
    isOn: (id) => all.some((r, k) => r.isOn(id) && (k === 0 ? 1 - variants.reduce((s, v) => s + v.w, 0) > 0 : variants[k - 1]!.w > 0)),
  };
}
