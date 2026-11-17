// Test bench for part models: mounts one model on a sim-core Circuit with a fake PartContext,
// lets the test add its own sources/loads, and solves. Used by every parts/<id>/model.test.ts.
import type { PropValue } from "@faber/project-format";
import {
  Circuit,
  GROUND,
  resolveProps,
  scopedBuilder,
  type CircuitBuilder,
  type McuBackend,
  type NodeId,
  type PartContext,
  type PartDefinition,
  type PartModel,
  type PinState,
  type SolveResult,
} from "@faber/sim-core";

export interface BenchOptions {
  /** Instance id (element ids are scoped with it). Default: the part type id. */
  id?: string;
  props?: Record<string, PropValue>;
  /** pin id → circuit node. Pins not listed get "<id>:<pin>"; ground pins default to "0". */
  wiring?: Record<string, NodeId>;
  mcu?: McuBackend;
  /** Round 6: the project's power situation (faber.json power). Default: USB plugged. */
  power?: { usb: boolean };
}

export interface Bench {
  ctx: PartContext;
  model: PartModel;
  circuit: Circuit;
  /** Stamp the part (plus `extra`, kept for later re-solves) and solve. */
  solve(extra?: (c: CircuitBuilder) => void): SolveResult;
  /** Last result. */
  readonly result: SolveResult | undefined;
  setProp(id: string, v: PropValue): SolveResult;
  interact(e: Parameters<NonNullable<PartModel["interact"]>>[0]): SolveResult;
}

export function mount(def: PartDefinition, opts: BenchOptions = {}): Bench {
  const id = opts.id ?? def.spec.id;
  const props = resolveProps(def.spec, opts.props);
  const circuit = new Circuit();
  let extra: ((c: CircuitBuilder) => void) | undefined;
  let result: SolveResult | undefined;
  const pins = new Map(def.spec.pins.map((p) => [p.id, p]));
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
    ...(opts.mcu ? { mcu: opts.mcu } : {}),
    power: opts.power ?? { usb: true },
    requestSolve: () => void bench.solve(),
    now: () => 0,
  };
  const model = def.create(ctx);
  const bench: Bench = {
    ctx,
    model,
    circuit,
    get result() {
      return result;
    },
    solve(e) {
      if (e) extra = e;
      circuit.clear();
      model.stamp(scopedBuilder(circuit, id));
      extra?.(circuit);
      result = circuit.solve();
      model.onSolved?.(result, 0);
      return result;
    },
    setProp(k, v) {
      props[k] = v;
      model.setProp(k, v);
      return bench.solve();
    },
    interact(e) {
      model.interact?.(e);
      return bench.solve();
    },
  };
  return bench;
}

/** Ideal-ish supply: `volts` on `node` with 0.01 Ω source resistance. */
export const supply =
  (node: NodeId, volts: number) =>
  (c: CircuitBuilder): void =>
    void c.voltageSource(node, GROUND, volts, 0.01, { id: `supply:${node}` });

/** A scriptable MCU for board tests: the test sets pin modes/levels directly. */
export class ScriptedMcu implements McuBackend {
  readonly cyclesPerSecond = 16_000_000;
  readonly vcc = 5;
  readonly pinIds: readonly string[] = [
    ...Array.from({ length: 14 }, (_, i) => `D${i}`),
    ...Array.from({ length: 6 }, (_, i) => `A${i}`),
  ];
  cycles = 0;
  readonly inputs = new Map<string, number>();
  private pins = new Map<string, PinState>(this.pinIds.map((p) => [p, { mode: "input", value: 0 }]));
  load(): void {
    this.reset();
  }
  reset(): void {
    this.cycles = 0;
  }
  step(n: number): void {
    this.cycles += n;
  }
  readPin(id: string): PinState {
    return { ...(this.pins.get(id) ?? { mode: "input", value: 0 }) };
  }
  setPinInput(id: string, volts: number): void {
    this.inputs.set(id, volts);
    const p = this.pins.get(id);
    if (p && p.mode !== "output") p.value = volts > this.vcc / 2 ? 1 : 0;
  }
  /** Test hook: what firmware would do with pinMode/digitalWrite. */
  drive(id: string, mode: PinState["mode"], value: 0 | 1 = 0): void {
    this.pins.set(id, { mode, value });
  }
  onPinChange(): () => void {
    return () => {};
  }
  onSerial(): () => void {
    return () => {};
  }
}

/** Look up a part in the generated registry or fail loudly (run `pnpm gen`). */
export function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} is not in the generated registry; run \`pnpm gen\``);
  return v;
}
