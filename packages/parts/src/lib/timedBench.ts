// Time-aware test bench for parts with tick(), schedule() or pwm() (motors, servos, sonar).
// Like bench.ts, but with a virtual clock (1 µs resolution), ideal voltage sources the test sets
// per node, a PWM table the test fills, and advance(ms) that runs scheduled events and 1 ms ticks
// exactly the way the Simulation does.
import type { PropValue } from "@fabwright/project-format";
import {
  Circuit,
  Clock,
  GROUND,
  resolveProps,
  scopedBuilder,
  type CircuitBuilder,
  type NodeId,
  type PartContext,
  type PartDefinition,
  type PartModel,
  type PwmReading,
  type SolveResult,
} from "@fabwright/sim-core";

export interface TimedBench {
  ctx: PartContext;
  model: PartModel;
  clock: Clock;
  readonly result: SolveResult | undefined;
  /** Drive `node` with an ideal-ish source (0.01 Ω). undefined removes it. Re-solves. */
  set(node: NodeId, volts: number | undefined): SolveResult;
  /** Extra elements stamped on every solve. */
  extra(fn: (c: CircuitBuilder) => void): void;
  solve(): SolveResult;
  /** Advance virtual time by `ms`, running due events and tick() every 1 ms. */
  advance(ms: number): void;
  /** What this part's pins see from pwm(); the test fills it. */
  pwm: Map<string, PwmReading>;
  /** What the part declared with setPwm(), per pin. */
  declared: Map<string, { duty: number; freqHz?: number } | undefined>;
  now(): number;
}

export function pwmReading(duty: number, freqHz = 490, source = "mcu:D5"): PwmReading {
  const periodUs = 1e6 / freqHz;
  return { duty, highUs: periodUs * duty, periodUs, freqHz, averaged: duty > 0 && duty < 1, level: duty > 0.5 ? 1 : 0, sinceEdgeUs: 0, source };
}

export function timedMount(def: PartDefinition, opts: { id?: string; props?: Record<string, PropValue>; wiring?: Record<string, NodeId> } = {}): TimedBench {
  const id = opts.id ?? def.spec.id;
  const props = resolveProps(def.spec, opts.props);
  const clock = new Clock(1_000_000);
  const circuit = new Circuit();
  const sources = new Map<NodeId, number>();
  const extras: ((c: CircuitBuilder) => void)[] = [];
  const pwm = new Map<string, PwmReading>();
  const declared = new Map<string, { duty: number; freqHz?: number } | undefined>();
  const pins = new Map(def.spec.pins.map((p) => [p.id, p]));
  let result: SolveResult | undefined;
  let solving = false;
  let again = false;

  const ctx: PartContext = {
    id,
    spec: def.spec,
    props,
    node(pin) {
      const p = pins.get(pin);
      if (!p) throw new Error(`${id}: unknown pin '${pin}'`);
      return opts.wiring?.[pin] ?? (p.type === "ground" ? GROUND : `${id}:${pin}`);
    },
    internalNode: (name) => `${id}#${name}`,
    requestSolve: () => void bench.solve(),
    now: () => clock.ms,
    pwm: (pin) => pwm.get(pin),
    setPwm: (pin, r) => void declared.set(pin, r),
    schedule: (delayMs, cb) => {
      const ev = clock.schedule(clock.cycles + clock.fromMs(delayMs), () => cb());
      return () => void clock.cancel(ev);
    },
  };
  const model = def.create(ctx);

  const bench: TimedBench = {
    ctx,
    model,
    clock,
    pwm,
    declared,
    get result() {
      return result;
    },
    now: () => clock.ms,
    set(node, volts) {
      if (volts === undefined) sources.delete(node);
      else sources.set(node, volts);
      return bench.solve();
    },
    extra(fn) {
      extras.push(fn);
    },
    solve() {
      if (solving) {
        again = true;
        return result!;
      }
      solving = true;
      try {
        let guard = 0;
        do {
          again = false;
          circuit.clear();
          model.stamp(scopedBuilder(circuit, id));
          for (const [n, v] of sources) circuit.voltageSource(n, GROUND, v, 0.01, { id: `src:${n}` });
          for (const fn of extras) fn(circuit);
          result = circuit.solve();
          model.onSolved?.(result, clock.ms);
        } while (again && ++guard < 8);
      } finally {
        solving = false;
      }
      return result!;
    },
    advance(ms) {
      const target = clock.cycles + clock.fromMs(ms);
      const tick = clock.fromMs(1);
      while (clock.cycles < target) {
        const nextTick = (Math.floor(clock.cycles / tick) + 1) * tick;
        const to = Math.min(target, nextTick);
        clock.advanceTo(to);
        if (to === nextTick) model.tick?.(clock.ms, 1);
      }
    },
  };
  return bench;
}
