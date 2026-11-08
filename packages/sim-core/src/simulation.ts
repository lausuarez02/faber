import { buildNets, netIndex, pinKey, type Net, type Project, type PropValue } from "@jumper/project-format";
import { Circuit, GROUND, scopedBuilder, type NodeId, type SolveResult } from "./circuit.ts";
import { Clock } from "./clock.ts";
import { hashString } from "./hash.ts";
import type { BackendFactory, McuBackend, PinState, Unsubscribe } from "./mcu.ts";
import {
  resolveProps,
  type Diagnostic,
  type PartContext,
  type PartDefinition,
  type PartInteraction,
  type PartModel,
  type PartRegistry,
  type VisualState,
} from "./part.ts";

export type TraceEntry =
  | { cycle: number; kind: "pin"; pin: string; mode: PinState["mode"]; value: 0 | 1 }
  | { cycle: number; kind: "serial"; byte: number };

export type SimEvent =
  | { type: "solved"; tMs: number }
  | { type: "pin"; pin: string; state: PinState; cycle: number }
  | { type: "serial"; byte: number; cycle: number }
  | { type: "run"; tMs: number }
  | { type: "stopped" }
  | { type: "reset" };

export interface SimDiagnostic extends Diagnostic {
  partId: string;
}

export interface SimulationOptions {
  project: Project;
  registry: PartRegistry;
  /** Needed when project.firmware is set. */
  backendFactory?: BackendFactory;
  /** Program for the firmware board: Intel HEX text or a raw image. Without it the MCU is created but not loaded. */
  firmware?: Uint8Array | string;
  /** Max virtual time per MCU step inside runFor (ms). Default 1. */
  chunkMs?: number;
  /** Clock frequency when there is no MCU (Hz). Default 1 MHz. */
  frequency?: number;
}

interface PartSlot {
  id: string;
  def: PartDefinition;
  ctx: PartContext;
  props: Record<string, PropValue>;
  model: PartModel;
}

/**
 * Runs a project: builds nets, instantiates part models, drives the MCU backend and
 * re-solves the circuit whenever something changes. Fully deterministic (no Date, no Math.random).
 */
export class Simulation {
  readonly project: Project;
  readonly nets: readonly Net[];
  readonly clock: Clock;
  /** Cycle the last runFor aimed for; the next runFor counts from here. */
  private runTarget = 0;
  /** The MCU backend of the firmware board, if any. */
  readonly mcu: McuBackend | undefined;
  /** Part id of the firmware board, if any. */
  readonly boardId: string | undefined;

  private readonly registry: PartRegistry;
  private readonly firmware: Uint8Array | string | undefined;
  private readonly chunkCycles: number;
  private readonly pinNode = new Map<string, NodeId>();
  private slots: PartSlot[] = [];
  private missing: SimDiagnostic[] = [];
  private circuit = new Circuit();
  private _lastSolve: SolveResult | undefined;
  private _trace: TraceEntry[] = [];
  private serialBytes: number[] = [];
  private listeners = new Set<(e: SimEvent) => void>();
  private solving = false;
  private solveAgain = false;
  private _stopped = false;
  private unsubs: Unsubscribe[] = [];

  constructor(opts: SimulationOptions) {
    this.project = opts.project;
    this.registry = opts.registry;
    this.firmware = opts.firmware;

    // Every pin of every known part gets a net (single-pin nets for unwired pins).
    const extraPins: { part: string; pin: string }[] = [];
    for (const p of this.project.parts) {
      const def = this.registry.get(p.type);
      if (def) for (const pin of def.spec.pins) extraPins.push({ part: p.id, pin: pin.id });
    }
    this.nets = buildNets(this.project, { extraPins });
    const groundNets = new Set<string>();
    const typeOf = new Map(this.project.parts.map((p) => [p.id, p.type]));
    for (const net of this.nets) {
      for (const ref of net.pins) {
        const def = this.registry.get(typeOf.get(ref.part) ?? "");
        if (def?.spec.pins.find((pp) => pp.id === ref.pin)?.type === "ground") groundNets.add(net.id);
      }
    }
    for (const [key, netId] of netIndex(this.nets)) this.pinNode.set(key, groundNets.has(netId) ? GROUND : netId);

    // MCU backend for the firmware board.
    let mcu: McuBackend | undefined;
    const fw = this.project.firmware;
    if (fw) {
      const boardPart = this.project.parts.find((p) => p.id === fw.board);
      const boardDef = boardPart ? this.registry.get(boardPart.type) : undefined;
      if (boardPart && boardDef?.spec.mcu && opts.backendFactory) {
        mcu = opts.backendFactory({ partId: boardPart.id, type: boardPart.type, mcu: boardDef.spec.mcu });
        this.boardId = boardPart.id;
      }
    }
    this.mcu = mcu;
    this.clock = new Clock(mcu?.cyclesPerSecond ?? opts.frequency ?? 1_000_000);
    this.chunkCycles = Math.max(1, this.clock.fromMs(opts.chunkMs ?? 1));

    if (mcu) {
      if (this.firmware !== undefined) mcu.load(this.firmware);
      this.unsubs.push(
        mcu.onPinChange((pin, state, cycle) => this.handlePinChange(pin, state, cycle)),
        mcu.onSerial((byte, cycle) => this.handleSerial(byte, cycle)),
      );
    }
    this.instantiate();
    this.solve();
  }

  // ------------------------------------------------------------------ time

  /** Current cycle (inside an MCU step this is the MCU's live cycle). */
  get cycles(): number {
    return this.mcu ? Math.max(this.mcu.cycles, this.clock.cycles) : this.clock.cycles;
  }

  get timeMs(): number {
    return this.clock.toMs(this.cycles);
  }

  get stopped(): boolean {
    return this._stopped;
  }

  /** Advance virtual time by `ms`. Re-solves on every pin change. No-op while stopped. */
  runFor(ms: number): void {
    if (this._stopped) return;
    // Targets accumulate from the previous target, not from where the MCU stopped: an instruction that
    // overshoots one call's end is absorbed by the next, so N calls of `ms` land exactly where one call
    // of N*ms does (no drift in timeMs under per-frame slicing).
    // If a run was aborted (stop) the clock is behind the old target; then count from the clock.
    const base = this.clock.cycles >= this.runTarget ? this.runTarget : this.clock.cycles;
    const target = base + this.clock.fromMs(ms);
    this.runTarget = target;
    while (this.clock.cycles < target && !this._stopped) {
      const cur = this.clock.cycles;
      this.clock.advanceTo(cur); // run events due now
      const nextEvent = this.clock.nextEventCycle();
      let next = Math.min(target, cur + this.chunkCycles);
      if (nextEvent !== undefined && nextEvent > cur && nextEvent < next) next = nextEvent;
      if (this.mcu) {
        this.mcu.step(next - cur);
        this.clock.advanceTo(Math.max(next, this.mcu.cycles));
      } else {
        this.clock.advanceTo(next);
      }
    }
    this.emit({ type: "run", tMs: this.timeMs });
  }

  /** Halt: aborts a runFor in progress and makes later runFor calls no-ops until resume() or reset(). */
  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    this.emit({ type: "stopped" });
  }

  resume(): void {
    this._stopped = false;
  }

  /** Back to t = 0: resets the MCU (program stays loaded), clock, trace, serial and every part model. */
  reset(): void {
    for (const s of this.slots) s.model.dispose?.();
    this.clock.reset();
    this.runTarget = 0;
    this._trace = [];
    this.serialBytes = [];
    this.circuit = new Circuit();
    this.mcu?.reset();
    this._stopped = false;
    this.instantiate();
    this.solve();
    this.emit({ type: "reset" });
  }

  /** Drop listeners and backend subscriptions. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const s of this.slots) s.model.dispose?.();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ circuit

  /** Re-stamp every part and solve now. Re-entrant calls are coalesced. */
  solve(): SolveResult {
    if (this.solving) {
      this.solveAgain = true;
      return this._lastSolve!;
    }
    this.solving = true;
    try {
      let guard = 0;
      do {
        this.solveAgain = false;
        this.circuit.clear();
        for (const s of this.slots) s.model.stamp(scopedBuilder(this.circuit, s.id));
        const r = this.circuit.solve();
        this._lastSolve = r;
        const t = this.timeMs;
        for (const s of this.slots) s.model.onSolved?.(r, t);
      } while (this.solveAgain && ++guard < 8);
    } finally {
      this.solving = false;
    }
    this.emit({ type: "solved", tMs: this.timeMs });
    return this._lastSolve!;
  }

  get lastSolve(): SolveResult | undefined {
    return this._lastSolve;
  }

  /** Circuit node of a part pin ("0" for ground). Throws for unknown pins. */
  nodeOf(partId: string, pinId: string): NodeId {
    const n = this.pinNode.get(pinKey({ part: partId, pin: pinId }));
    if (n === undefined) throw new Error(`unknown pin '${partId}:${pinId}'`);
    return n;
  }

  pinVoltage(partId: string, pinId: string): number {
    return this._lastSolve?.voltage(this.nodeOf(partId, pinId)) ?? 0;
  }

  netVoltage(netId: string): number {
    const net = this.nets.find((n) => n.id === netId);
    const first = net?.pins[0];
    return first ? this.pinVoltage(first.part, first.pin) : 0;
  }

  // ------------------------------------------------------------------ parts

  partIds(): string[] {
    return this.slots.map((s) => s.id);
  }

  partState(partId: string): VisualState | undefined {
    return this.slot(partId)?.model.visualState();
  }

  setProp(partId: string, propId: string, value: PropValue): void {
    const s = this.slot(partId);
    if (!s) throw new Error(`unknown part '${partId}'`);
    s.props[propId] = value;
    s.model.setProp(propId, value);
    this.solve();
  }

  interact(partId: string, event: PartInteraction): void {
    const s = this.slot(partId);
    if (!s) throw new Error(`unknown part '${partId}'`);
    s.model.interact?.(event);
    this.solve();
  }

  /** Diagnostics of every part, plus errors for parts whose type is not in the registry. */
  diagnostics(): SimDiagnostic[] {
    const out = [...this.missing];
    for (const s of this.slots) for (const d of s.model.diagnostics?.() ?? []) out.push({ ...d, partId: s.id });
    return out;
  }

  // ------------------------------------------------------------------ trace

  get trace(): readonly TraceEntry[] {
    return this._trace;
  }

  /** Hash of the pin/serial trace. Same project + inputs → same hash. */
  traceHash(): string {
    return hashString(JSON.stringify(this._trace));
  }

  /** Everything the firmware printed on the default UART, as latin-1 text. */
  serialText(): string {
    let out = "";
    for (let i = 0; i < this.serialBytes.length; i += 4096) {
      out += String.fromCharCode(...this.serialBytes.slice(i, i + 4096));
    }
    return out;
  }

  /** Send a byte to the firmware's UART RX (if the backend supports it). */
  writeSerial(byte: number): void {
    this.mcu?.writeSerial?.(byte);
  }

  subscribe(listener: (e: SimEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------ internals

  private slot(partId: string): PartSlot | undefined {
    return this.slots.find((s) => s.id === partId);
  }

  private instantiate(): void {
    this.slots = [];
    this.missing = [];
    for (const p of this.project.parts) {
      const def = this.registry.get(p.type);
      if (!def) {
        this.missing.push({
          partId: p.id,
          severity: "error",
          code: "unknown-part-type",
          message: `part '${p.id}' has type '${p.type}', which is not in the parts registry; it is left out of the simulation`,
        });
        continue;
      }
      const props = resolveProps(def.spec, p.props);
      const mcu = p.id === this.boardId ? this.mcu : undefined;
      const ctx: PartContext = {
        id: p.id,
        spec: def.spec,
        props,
        node: (pin) => this.nodeOf(p.id, pin),
        internalNode: (name) => `${p.id}#${name}`,
        ...(mcu ? { mcu } : {}),
        requestSolve: () => {
          this.solve();
        },
        now: () => this.timeMs,
      };
      this.slots.push({ id: p.id, def, ctx, props, model: def.create(ctx) });
    }
  }

  private handlePinChange(pin: string, state: PinState, cycle: number): void {
    this._trace.push({ cycle, kind: "pin", pin, mode: state.mode, value: state.value });
    this.emit({ type: "pin", pin, state, cycle });
    this.solve();
  }

  private handleSerial(byte: number, cycle: number): void {
    this._trace.push({ cycle, kind: "serial", byte });
    this.serialBytes.push(byte);
    this.emit({ type: "serial", byte, cycle });
  }

  private emit(e: SimEvent): void {
    for (const l of this.listeners) l(e);
  }
}
