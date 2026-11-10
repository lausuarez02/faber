import { buildNets, netIndex, pinKey, type Net, type Project, type PropValue } from "@jumper/project-format";
import { Circuit, GROUND, scopedBuilder, type NodeId, type SolveResult } from "./circuit.ts";
import { I2C_FAULTS, I2cBus, SPI_FAULTS, SpiBus, type I2cFault, type SpiFault } from "./bus.ts";
import { Clock } from "./clock.ts";
import { hashString } from "./hash.ts";
import { averageSolves, PwmMeter, type PwmReading } from "./pwm.ts";
import type { BackendFactory, McuBackend, PinState, Unsubscribe } from "./mcu.ts";
import type { ColorFrame } from "./color.ts";
import type { SimServices } from "./network.ts";
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
  /** Host services handed to part models as ctx.services (e.g. `network`: the sandbox Wi-Fi network). */
  services?: SimServices;
}

/** Period of PartModel.tick() and of the stopped-PWM check (virtual ms). */
export const TICK_MS = 1;

interface Ticker {
  periodCycles: number;
  cb: (tMs: number) => void;
  armed: boolean;
  live: boolean;
}

/** The backend as the board model sees it: readPin reports forced levels for averaged PWM pins during variant solves. */
function overlayMcu(mcu: McuBackend, override: ReadonlyMap<string, 0 | 1>): McuBackend {
  return new Proxy(mcu, {
    get(target, key) {
      if (key === "readPin") {
        return (pin: string): PinState => {
          const s = target.readPin(pin);
          const o = override.get(pin);
          return o === undefined || s.mode !== "output" ? s : { mode: "output", value: o };
        };
      }
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
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
  /** The project being simulated. Replaced only by adoptProps (same parts and wires, new saved props). */
  project: Project;
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
  private busUnsubs: Unsubscribe[] = [];
  private busDiag: SimDiagnostic[] = [];
  /** SPI devices: part id → CS state after the last solve. */
  private spiSelected = new Map<string, { selected: () => boolean; last: boolean }>();
  /** The firmware board's I2C bus (exists even without an MCU, so parts can be inspected). */
  readonly i2c: I2cBus;
  /** The firmware board's SPI bus. */
  readonly spi: SpiBus;

  // ---- PWM measurement, periodic ticks and part-scheduled events (packages/sim-core/PWM.md)
  /** One meter per MCU GPIO that has changed at least once, fed from onPinChange. */
  private meters = new Map<string, PwmMeter>();
  /** Circuit node → the firmware board's GPIO pin on it. */
  private mcuPinOfNode = new Map<NodeId, string>();
  /** PWM declared by driver parts (setPwm) on their output nets. */
  private declaredPwm = new Map<NodeId, PwmReading>();
  /** Levels forced onto averaged PWM pins during the per-pin variant solves. */
  private pinOverride = new Map<string, 0 | 1>();
  /** What the firmware board's model gets as ctx.mcu: the backend, with readPin honouring pinOverride. */
  private boardMcu: McuBackend | undefined;
  private tickCycles = 1;
  private tickArmed = false;
  private tickers: Ticker[] = [];
  private stepping = false;
  /** Host services for part models (ctx.services). */
  readonly services: SimServices | undefined;
  /** Part watchers of MCU GPIO edges (ctx.watch), by MCU pin id. Dropped on reset. */
  private pinWatchers = new Map<string, Set<(level: 0 | 1, tMs: number) => void>>();
  /** Node → the firmware board GPIO that drives it directly or through resistors (cached; nets never change). */
  private driverCache = new Map<NodeId, string | null>();
  // round 6 power
  /** jumper.json power.usb (live: adoptProps / setPower change it). */
  private powerState = { usb: true };
  /** The firmware board had power after the last solve (its model's powered()). */
  private _boardPowered = true;
  /** Power changed while the MCU was stepping: apply the reset after the step. */
  private powerPending = false;
  /** Global cycle at which the MCU last came out of reset (its own cycle counter restarts at 0 then). */
  private mcuOffset = 0;

  constructor(opts: SimulationOptions) {
    this.project = opts.project;
    this.registry = opts.registry;
    this.firmware = opts.firmware;
    this.services = opts.services;
    this.powerState.usb = opts.project.power?.usb !== false;

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
    this.i2c = new I2cBus("i2c0", () => this.cycles);
    this.spi = new SpiBus("spi0");
    mcu?.attachI2c?.(this.i2c);
    mcu?.attachSpi?.(this.spi);
    this.chunkCycles = Math.max(1, this.clock.fromMs(opts.chunkMs ?? 1));
    this.tickCycles = Math.max(1, this.clock.fromMs(TICK_MS));
    if (mcu && this.boardId) {
      this.boardMcu = overlayMcu(mcu, this.pinOverride);
      for (const pin of mcu.pinIds) {
        const n = this.pinNode.get(pinKey({ part: this.boardId, pin }));
        if (n !== undefined && n !== GROUND) this.mcuPinOfNode.set(n, pin);
      }
    }

    if (mcu) {
      if (this.firmware !== undefined) mcu.load(this.firmware);
      this.unsubs.push(
        mcu.onPinChange((pin, state, cycle) => this.handlePinChange(pin, state, cycle + this.mcuOffset)),
        mcu.onSerial((byte, cycle) => this.handleSerial(byte, cycle + this.mcuOffset)),
      );
    }
    this.instantiate();
    this.solve();
  }

  // ------------------------------------------------------------------ time

  /** Current cycle (inside an MCU step this is the MCU's live cycle). */
  get cycles(): number {
    return this.mcu ? Math.max(this.mcu.cycles + this.mcuOffset, this.clock.cycles) : this.clock.cycles;
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
      if (this.powerPending) this.applyPower();
      if (this.mcu && this._boardPowered) {
        this.stepping = true;
        try {
          this.mcu.step(next - cur);
        } finally {
          this.stepping = false;
        }
        // Normally mcu.cycles >= next; it is less only when a part event stopped the step early (stopAt).
        this.clock.advanceTo(Math.max(this.clock.cycles, this.mcu.cycles + this.mcuOffset));
        if (this.powerPending) this.applyPower();
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
    this.i2c.clearLog();
    this.clock.reset();
    this.runTarget = 0;
    this._trace = [];
    this.serialBytes = [];
    this.circuit = new Circuit();
    this.mcu?.reset();
    this.mcuOffset = 0;
    this._boardPowered = true;
    this.powerPending = false;
    this._stopped = false;
    this.meters.clear();
    this.declaredPwm.clear();
    this.pinOverride.clear();
    this.tickArmed = false;
    for (const t of this.tickers) t.armed = false;
    this.pinWatchers.clear();
    this.instantiate();
    this.solve();
    this.emit({ type: "reset" });
  }

  /** Drop listeners and backend subscriptions. */
  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.detachBuses();
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
        const r = this.solveCircuit();
        this._lastSolve = r;
        const t = this.timeMs;
        for (const s of this.slots) s.model.onSolved?.(r, t);
      } while (this.solveAgain && ++guard < 8);
    } finally {
      this.solving = false;
    }
    this.updateSpiSelects();
    this.checkBoardPower();
    this.emit({ type: "solved", tMs: this.timeMs });
    return this._lastSolve!;
  }

  // round 6 power
  /** Whether the firmware board has power (USB, or a battery path to its supply pins). */
  get boardPowered(): boolean {
    return this._boardPowered;
  }

  /** jumper.json power.usb as the simulation sees it. */
  get usb(): boolean {
    return this.powerState.usb;
  }

  /** Plug (true) or unplug (false) the board's USB cable while it runs; re-solves. Returns true when it changed. */
  setPower(p: { usb: boolean }): boolean {
    if (p.usb === this.powerState.usb) return false;
    this.powerState.usb = p.usb;
    this.solve();
    return true;
  }

  /** After a solve: a firmware board that lost or regained power is held in reset / restarts from reset (power-on). */
  private checkBoardPower(): void {
    if (!this.boardId || !this.mcu) return;
    const model = this.slot(this.boardId)?.model;
    const powered = model?.powered ? model.powered() : true;
    if (powered === this._boardPowered) return;
    this._boardPowered = powered;
    if (this.stepping) {
      this.powerPending = true;
      this.mcu.stopAt?.(this.cycles - this.mcuOffset);
    } else this.applyPower();
  }

  /** Reset the MCU at the current cycle: on power loss its pins let go; on power-on it boots from the start. */
  private applyPower(): void {
    this.powerPending = false;
    if (!this.mcu) return;
    this.mcuOffset = this.clock.cycles;
    this.mcu.reset();
    this.solve();
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

  /** A colour display part's frame (see PartModel.framebuffer), or undefined for other parts. */
  framebuffer(partId: string): ColorFrame | undefined {
    return this.slot(partId)?.model.framebuffer?.();
  }

  /**
   * Digital level of a part pin's net right now (see PartContext.digital): the live GPIO output
   * level when the firmware board drives the net (directly or through resistors), else the last
   * solve against `threshold` volts.
   */
  digitalLevel(partId: string, pinId: string, threshold?: number): 0 | 1 {
    return this.levelOfNode(this.nodeOf(partId, pinId), threshold);
  }

  setProp(partId: string, propId: string, value: PropValue): void {
    const s = this.slot(partId);
    if (!s) throw new Error(`unknown part '${partId}'`);
    s.props[propId] = value;
    s.model.setProp(propId, value);
    this.solve();
  }

  /**
   * Live edit of saved props: take a project with the same parts and wires but new prop values,
   * push every changed prop into the running models (one re-solve), and keep the new project so
   * reset() starts from these values too. Throws when parts or wires differ (build a new Simulation).
   */
  adoptProps(project: Project): string[] {
    const shape = (p: Project) => JSON.stringify([p.parts.map((x) => [x.id, x.type]), p.wires.map((w) => [w.from.part, w.from.pin, w.to.part, w.to.pin])]);
    if (shape(project) !== shape(this.project)) throw new Error("adoptProps: the parts or wires changed; create a new Simulation instead");
    const changed: string[] = [];
    for (const p of project.parts) {
      const s = this.slot(p.id);
      if (!s) continue;
      const next = resolveProps(s.def.spec, p.props);
      const before = resolveProps(s.def.spec, this.project.parts.find((x) => x.id === p.id)?.props);
      for (const [k, v] of Object.entries(next)) {
        if (before[k] === v) continue;
        s.props[k] = v;
        s.model.setProp(k, v);
        changed.push(`${p.id}.${k}`);
      }
    }
    // round 6 power: plugging / unplugging USB applies live.
    const usb = project.power?.usb !== false;
    if (usb !== this.powerState.usb) {
      this.powerState.usb = usb;
      changed.push("power.usb");
    }
    this.project = project;
    if (changed.length) this.solve();
    return changed;
  }

  /** Set several props of one part with a single re-solve (e.g. a physics engine feeding an IMU every step). */
  setProps(partId: string, values: Record<string, PropValue>): void {
    const s = this.slot(partId);
    if (!s) throw new Error(`unknown part '${partId}': the project has ${this.partIds().join(", ") || "no parts"}`);
    for (const [k, v] of Object.entries(values)) {
      s.props[k] = v;
      s.model.setProp(k, v);
    }
    this.solve();
  }

  /**
   * Inject a bus fault on a part (or clear it with null). I2C parts: "nack", "nack-data",
   * "disconnect", "garbage". SPI parts: "disconnect", "garbage". Faults survive reset().
   * Throws a readable error when the part is not on a bus or the fault does not apply.
   */
  setBusFault(partId: string, fault: I2cFault | SpiFault | null): void {
    const s = this.slot(partId);
    if (!s) throw new Error(`setBusFault: unknown part '${partId}'. Parts in this project: ${this.partIds().join(", ") || "none"}.`);
    if (s.model.i2c) {
      if (fault !== null && !I2C_FAULTS.includes(fault as I2cFault)) {
        throw new Error(`setBusFault: '${String(fault)}' is not an I2C fault. '${partId}' is an I2C part; use one of ${I2C_FAULTS.join(", ")} (or null to clear).`);
      }
      this.i2c.setFault(partId, fault as I2cFault | null);
      return;
    }
    if (s.model.spi) {
      if (fault !== null && !SPI_FAULTS.includes(fault as SpiFault)) {
        throw new Error(`setBusFault: '${String(fault)}' is not an SPI fault. '${partId}' is an SPI part; use one of ${SPI_FAULTS.join(", ")} (or null to clear).`);
      }
      this.spi.setFault(partId, fault as SpiFault | null);
      return;
    }
    throw new Error(`setBusFault: part '${partId}' (${s.def.spec.id}) is not an I2C or SPI device, so it has no bus to fault. Use a pin-level fault or change a prop instead.`);
  }

  /**
   * Press / release / set a part. `opts.solve: false` skips the re-solve, for values only the
   * part's own logic reads (a physics engine feeding an HC-SR04 its distance every step).
   */
  interact(partId: string, event: PartInteraction, opts?: { solve?: boolean }): void {
    const s = this.slot(partId);
    if (!s) throw new Error(`unknown part '${partId}': the project has ${this.partIds().join(", ") || "no parts"}`);
    s.model.interact?.(event);
    if (opts?.solve !== false) this.solve();
  }

  // ------------------------------------------------------------------ PWM and time hooks

  /**
   * PWM / pulse measurement of the net a part pin is on: an MCU pin driving that net, or a driver
   * part's declared output (setPwm). undefined when nothing on that net is an MCU output or a
   * declared PWM. Example: sim.pwm("servo1", "SIG") → { highUs: 1500, periodUs: 20000, … }.
   */
  pwm(partId: string, pinId: string): PwmReading | undefined {
    return this.pwmOfNode(this.nodeOf(partId, pinId));
  }

  /**
   * Call `cb` every `periodMs` of virtual time, at fixed cycle numbers (k · period), so a physics
   * engine stepped from here is deterministic whatever the runFor slicing. Survives reset().
   */
  every(periodMs: number, cb: (tMs: number) => void): Unsubscribe {
    if (!(periodMs > 0)) throw new Error(`every(): periodMs must be > 0, got ${periodMs}. Pass the step length in ms, e.g. every(4, step) for 250 Hz.`);
    const t: Ticker = { periodCycles: Math.max(1, this.clock.fromMs(periodMs)), cb, armed: false, live: true };
    this.tickers.push(t);
    this.armTicker(t);
    return () => {
      t.live = false;
      this.tickers = this.tickers.filter((x) => x !== t);
    };
  }

  /** Diagnostics of every part, plus errors for parts whose type is not in the registry. */
  diagnostics(): SimDiagnostic[] {
    const out = [...this.missing, ...this.busDiag, ...this.i2cAddressConflicts()];
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
      const mcu = p.id === this.boardId ? this.boardMcu : undefined;
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
        pwm: (pin) => this.pwmOfNode(this.nodeOf(p.id, pin)),
        setPwm: (pin, r) => this.declarePwm(p.id, this.nodeOf(p.id, pin), r),
        schedule: (delayMs, cb) => this.scheduleIn(delayMs, cb),
        digital: (pin, threshold) => this.levelOfNode(this.nodeOf(p.id, pin), threshold),
        watch: (pin, cb) => this.watchNode(this.nodeOf(p.id, pin), cb),
        ...(this.services ? { services: this.services } : {}),
        power: this.powerState, // round 6 power
      };
      this.slots.push({ id: p.id, def, ctx, props, model: def.create(ctx) });
    }
    this.attachBuses();
    if (this.slots.some((sl) => sl.model.tick)) this.armTicks();
    for (const t of this.tickers) this.armTicker(t);
  }

  // ------------------------------------------------------------------ buses

  private detachBuses(): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
    this.busDiag = [];
    this.spiSelected.clear();
  }

  /** Nodes of the firmware board's pins that carry `protocol`, plus the backend's own bus pin. */
  private boardBusNodes(protocol: string, backendPin: string | undefined): Map<NodeId, string> {
    const out = new Map<NodeId, string>();
    if (!this.boardId) return out;
    const board = this.slot(this.boardId);
    if (!board) return out;
    for (const pin of board.def.spec.pins) {
      if (pin.protocols?.includes(protocol)) out.set(this.nodeOf(board.id, pin.id), pin.id);
    }
    if (backendPin && board.def.spec.pins.some((p) => p.id === backendPin)) out.set(this.nodeOf(board.id, backendPin), backendPin);
    return out;
  }

  private attachBuses(): void {
    this.detachBuses();
    const board = this.boardId;
    const sda = this.boardBusNodes("i2c-sda", this.mcu?.busPins?.i2c?.sda);
    const scl = this.boardBusNodes("i2c-scl", this.mcu?.busPins?.i2c?.scl);
    const mosi = this.boardBusNodes("spi-mosi", this.mcu?.busPins?.spi?.mosi);
    const miso = this.boardBusNodes("spi-miso", this.mcu?.busPins?.spi?.miso);
    const sck = this.boardBusNodes("spi-sck", this.mcu?.busPins?.spi?.sck);
    const names = (m: Map<NodeId, string>) => [...new Set(m.values())].join("/") || "?";
    const sdaName = names(sda);
    const sclName = names(scl);
    const pinsWith = (s: PartSlot, protocol: string) => s.def.spec.pins.filter((p) => p.protocols?.includes(protocol)).map((p) => p.id);
    const isWired = (s: PartSlot, pin: string) => this.nets.some((n) => n.pins.length > 1 && n.pins.some((r) => r.part === s.id && r.pin === pin));
    let i2cDevices = 0;
    let i2cPullups = false;

    for (const s of this.slots) {
      const diag = (severity: SimDiagnostic["severity"], code: string, message: string, pin?: string) =>
        this.busDiag.push({ partId: s.id, severity, code, message, ...(pin ? { pin } : {}) });

      if (s.model.i2c) {
        const [dSda] = pinsWith(s, "i2c-sda");
        const [dScl] = pinsWith(s, "i2c-scl");
        if (!dSda || !dScl) {
          diag("error", "i2c-pins-missing", `${s.id} (${s.def.spec.id}) is an I2C device but its part.json marks no pin with protocol "i2c-sda" and "i2c-scl", so the simulator cannot attach it. This is a bug in the part definition: add the protocols to its SDA and SCL pins.`);
          continue;
        }
        if (!board || !this.mcu) {
          diag("warning", "i2c-no-mcu", `${s.id} is an I2C device but the project has no firmware board running, so nothing talks to it. Set project.firmware.board to the board part and load firmware.`);
          continue;
        }
        if (!this.mcu.attachI2c || sda.size === 0) {
          diag("error", "i2c-unsupported", `${s.id} needs I2C, but the board '${board}' has no I2C support in its simulator backend. Use a board with I2C (Arduino Uno: SDA = A4, SCL = A5).`);
          continue;
        }
        const nSda = this.nodeOf(s.id, dSda);
        const nScl = this.nodeOf(s.id, dScl);
        if (sda.has(nSda) && scl.has(nScl)) {
          this.busUnsubs.push(this.i2c.attach(s.id, s.model.i2c));
          i2cDevices++;
          if (s.def.spec.bus?.i2c?.pullUpOhms) i2cPullups = true;
        } else if (sda.has(nScl) && scl.has(nSda)) {
          diag("error", "i2c-swapped", `${s.id}: SDA and SCL are swapped. ${s.id}:${dSda} goes to the board's SCL and ${s.id}:${dScl} to its SDA, so the device never answers (Wire.endTransmission() returns 2). Wire ${s.id}:${dSda} → ${board}:${sdaName} and ${s.id}:${dScl} → ${board}:${sclName}.`, dSda);
        } else {
          const missing: string[] = [];
          if (!sda.has(nSda)) missing.push(`${s.id}:${dSda} → ${board}:${sdaName}${isWired(s, dSda) ? ` (it is wired, but not to the board's SDA)` : " (not wired)"}`);
          if (!scl.has(nScl)) missing.push(`${s.id}:${dScl} → ${board}:${sclName}${isWired(s, dScl) ? ` (it is wired, but not to the board's SCL)` : " (not wired)"}`);
          diag("error", "i2c-not-connected", `${s.id} is not on the I2C bus, so it never answers (Wire.endTransmission() returns 2, the I2C scanner does not find it). Missing wires: ${missing.join("; ")}.`, !sda.has(nSda) ? dSda : dScl);
        }
      }

      if (s.model.spi) {
        const [dMosi] = pinsWith(s, "spi-mosi");
        const [dMiso] = pinsWith(s, "spi-miso");
        const [dSck] = pinsWith(s, "spi-sck");
        const [dCs] = pinsWith(s, "spi-cs");
        if (!this.mcu || !board) {
          diag("warning", "spi-no-mcu", `${s.id} is an SPI device but the project has no firmware board running, so nothing talks to it. Set project.firmware.board and load firmware.`);
          continue;
        }
        if (!this.mcu.attachSpi || mosi.size === 0 || sck.size === 0) {
          diag("error", "spi-unsupported", `${s.id} needs SPI, but the board '${board}' has no SPI support in its simulator backend. Use a board with SPI (Arduino Uno: MOSI = D11, MISO = D12, SCK = D13).`);
          continue;
        }
        const problems: string[] = [];
        if (dMosi && !mosi.has(this.nodeOf(s.id, dMosi))) problems.push(`${s.id}:${dMosi} → ${board}:${names(mosi)}`);
        if (dSck && !sck.has(this.nodeOf(s.id, dSck))) problems.push(`${s.id}:${dSck} → ${board}:${names(sck)}`);
        if (dMiso && miso.size > 0 && isWired(s, dMiso) && !miso.has(this.nodeOf(s.id, dMiso))) problems.push(`${s.id}:${dMiso} → ${board}:${names(miso)}`);
        if (problems.length > 0) {
          diag("error", "spi-not-connected", `${s.id} is not on the SPI bus, so it receives nothing. Missing wires: ${problems.join("; ")}.`, dMosi);
          continue;
        }
        let selected: () => boolean;
        if (!dCs) {
          selected = () => true;
        } else {
          const csNode = this.nodeOf(s.id, dCs);
          if (!isWired(s, dCs)) {
            diag("error", "spi-cs-unwired", `${s.id}:${dCs} (chip select) is not wired, so the device is never selected. Wire it to a free digital pin (e.g. ${board}:D10) and pass that pin to the library, or to GND if it is the only SPI device.`, dCs);
          }
          const vcc = this.mcu.vcc;
          // A CS line nothing drives (not in the circuit, or floating) does not select the device.
          // A GPIO on the CS net is read live: libraries toggle CS per transaction, fast enough that
          // the circuit is solved on duty-averaged values (PWM.md), which would blur the level.
          const driver = this.driverPinOf(csNode);
          selected = () => {
            if (csNode === GROUND) return true;
            if (driver !== undefined && this.mcu) {
              const st = this.mcu.readPin(driver);
              if (st.mode === "output") return st.value === 0;
            }
            const r = this._lastSolve;
            return r !== undefined && r.voltages.has(csNode) && !r.isFloating(csNode) && r.voltage(csNode) < 0.3 * vcc;
          };
        }
        this.busUnsubs.push(this.spi.attach(s.id, s.model.spi, selected));
        this.spiSelected.set(s.id, { selected, last: false });
      }
    }

    if (i2cDevices > 0 && !i2cPullups) {
      const sdaNet = this.nets.find((n) => n.pins.some((r) => r.part === board && sda.get(this.nodeOf(r.part, r.pin)) !== undefined));
      const typeOf = new Map(this.project.parts.map((p) => [p.id, p.type]));
      const hasResistor = sdaNet?.pins.some((r) => typeOf.get(r.part) === "resistor") ?? false;
      if (!hasResistor) {
        const first = this.i2c.list()[0];
        if (first) {
          this.busDiag.push({
            partId: first.partId,
            severity: "info",
            code: "i2c-weak-pullups",
            message: `No module on the I2C bus has pull-up resistors and none are wired, so the bus relies on the ATmega's internal ~35 kΩ pull-ups (Wire turns them on). The simulator works; real hardware usually does at 100 kHz on short wires, but is unreliable at 400 kHz or with long wires. Add 4.7 kΩ from SDA and SCL to 5V.`,
          });
        }
      }
    }
  }

  private i2cAddressConflicts(): SimDiagnostic[] {
    const byAddr = new Map<number, string[]>();
    for (const d of this.i2c.list()) {
      const list = byAddr.get(d.address) ?? [];
      list.push(d.partId);
      byAddr.set(d.address, list);
    }
    const out: SimDiagnostic[] = [];
    for (const [addr, ids] of byAddr) {
      if (ids.length < 2) continue;
      const hex = `0x${addr.toString(16).toUpperCase().padStart(2, "0")}`;
      for (const id of ids) {
        out.push({
          partId: id,
          severity: "error",
          code: "i2c-address-conflict",
          message: `${ids.join(" and ")} share I2C address ${hex}, so they answer at the same time and corrupt each other's replies. Change one address (the module's address prop / solder jumper) or move one to another bus.`,
        });
      }
    }
    return out;
  }

  /** After each solve: tell SPI devices about CS edges. */
  private updateSpiSelects(): void {
    for (const [id, st] of this.spiSelected) {
      const now = st.selected();
      if (now === st.last) continue;
      st.last = now;
      this.spi.select(id, now);
    }
  }

  private handlePinChange(pin: string, state: PinState, cycle: number): void {
    this._trace.push({ cycle, kind: "pin", pin, mode: state.mode, value: state.value });
    this.emit({ type: "pin", pin, state, cycle });
    const watchers = this.pinWatchers.get(pin);
    if (watchers && state.mode === "output") {
      const tMs = this.clock.toMs(cycle);
      for (const w of [...watchers]) w(state.value, tMs);
    }
    let meter = this.meters.get(pin);
    if (!meter) {
      meter = new PwmMeter(pin, this.clock.frequency);
      this.meters.set(pin, meter);
    }
    // Slow signals (servo pulses, digitalWrite) re-solve on every edge as before. Fast PWM
    // (period < 5 ms) re-solves only when its measured duty changes; see packages/sim-core/PWM.md.
    const needSolve = meter.change(state.mode, state.value, cycle);
    if (meter.averaged) this.armTicks();
    if (needSolve) this.solve();
  }

  /** Stamp every part and solve; while pins are averaged PWM, one solve per such pin plus a base, combined by duty. */
  private solveCircuit(): SolveResult {
    const once = (): SolveResult => {
      this.circuit.clear();
      for (const s of this.slots) s.model.stamp(scopedBuilder(this.circuit, s.id));
      return this.circuit.solve();
    };
    const fast: PwmMeter[] = [];
    for (const m of this.meters.values()) if (m.averaged) fast.push(m);
    if (fast.length === 0 || !this.boardMcu) return once();
    try {
      for (const m of fast) this.pinOverride.set(m.pin, 0);
      const base = once();
      const variants: { r: SolveResult; w: number }[] = [];
      for (const m of fast) {
        this.pinOverride.set(m.pin, 1);
        variants.push({ r: once(), w: m.duty });
        this.pinOverride.set(m.pin, 0);
        m.markSolved();
      }
      return averageSolves(base, variants);
    } finally {
      this.pinOverride.clear();
    }
  }

  private pwmOfNode(node: NodeId): PwmReading | undefined {
    if (node === GROUND) return undefined;
    const pin = this.mcuPinOfNode.get(node);
    if (pin !== undefined && this.mcu?.readPin(pin).mode === "output") {
      const m = this.meters.get(pin);
      if (m) return m.reading(this.cycles);
      const level = this.mcu.readPin(pin).value;
      return { duty: level, highUs: 0, periodUs: 0, freqHz: 0, averaged: false, level, sinceEdgeUs: this.clock.toMs(this.cycles) * 1000, source: `mcu:${pin}` };
    }
    return this.declaredPwm.get(node);
  }

  private declarePwm(partId: string, node: NodeId, r: { duty: number; freqHz?: number } | undefined): void {
    if (node === GROUND) return;
    if (!r) {
      if (this.declaredPwm.get(node)?.source === partId) this.declaredPwm.delete(node);
      return;
    }
    const duty = Math.min(1, Math.max(0, Number.isFinite(r.duty) ? r.duty : 0));
    const freqHz = r.freqHz ?? 0;
    const periodUs = freqHz > 0 ? 1e6 / freqHz : 0;
    this.declaredPwm.set(node, {
      duty,
      highUs: periodUs * duty,
      periodUs,
      freqHz,
      averaged: duty > 0 && duty < 1,
      level: duty > 0 ? 1 : 0,
      sinceEdgeUs: 0,
      source: partId,
    });
  }

  /**
   * The firmware board GPIO driving `node`: on the net itself, or reached through resistor parts
   * (up to two, e.g. a 1k/2k level-shifting divider; a divider keeps the logic level). undefined if none.
   */
  private driverPinOf(node: NodeId): string | undefined {
    if (node === GROUND) return undefined;
    const cached = this.driverCache.get(node);
    if (cached !== undefined) return cached ?? undefined;
    let found: string | undefined = this.mcuPinOfNode.get(node);
    if (found === undefined) {
      const typeOf = new Map(this.project.parts.map((p) => [p.id, p.type]));
      let frontier = [node];
      const seen = new Set<NodeId>([node]);
      for (let hop = 0; hop < 2 && found === undefined; hop++) {
        const next: NodeId[] = [];
        for (const n of frontier) {
          const net = this.nets.find((nt) => nt.pins.some((r) => this.pinNode.get(pinKey(r)) === n));
          for (const ref of net?.pins ?? []) {
            if (typeOf.get(ref.part) !== "resistor") continue;
            const other = this.pinNode.get(pinKey({ part: ref.part, pin: ref.pin === "1" ? "2" : "1" }));
            if (other === undefined || other === GROUND || seen.has(other)) continue;
            seen.add(other);
            const pin = this.mcuPinOfNode.get(other);
            if (pin !== undefined) {
              found = pin;
              break;
            }
            next.push(other);
          }
          if (found !== undefined) break;
        }
        frontier = next;
      }
    }
    this.driverCache.set(node, found ?? null);
    return found;
  }

  private levelOfNode(node: NodeId, threshold?: number): 0 | 1 {
    if (node === GROUND) return 0;
    const driver = this.driverPinOf(node);
    if (driver !== undefined && this.mcu) {
      const st = this.mcu.readPin(driver);
      if (st.mode === "output") return st.value;
    }
    const v = this._lastSolve?.voltage(node) ?? 0;
    return v >= (threshold ?? (this.mcu?.vcc ?? 5) / 2) ? 1 : 0;
  }

  private watchNode(node: NodeId, cb: (level: 0 | 1, tMs: number) => void): () => void {
    const pin = this.driverPinOf(node);
    if (pin === undefined) return () => {};
    let set = this.pinWatchers.get(pin);
    if (!set) {
      set = new Set();
      this.pinWatchers.set(pin, set);
    }
    set.add(cb);
    return () => void this.pinWatchers.get(pin)?.delete(cb);
  }

  /** A part event `delayMs` from now. Inside an MCU step it also shortens the step so the event lands on its cycle. */
  private scheduleIn(delayMs: number, cb: () => void): () => void {
    const at = this.cycles + Math.max(0, this.clock.fromMs(delayMs));
    const id = this.clock.schedule(at, () => cb());
    if (this.stepping) this.mcu?.stopAt?.(at - this.mcuOffset);
    return () => void this.clock.cancel(id);
  }

  /** Start the TICK_MS tick when a model has tick() or a pin is averaged PWM (it checks for stopped PWM). */
  private armTicks(): void {
    if (this.tickArmed) return;
    this.tickArmed = true;
    const period = this.tickCycles;
    const first = (Math.floor(this.cycles / period) + 1) * period;
    const run = (cycle: number): void => {
      const tMs = this.clock.toMs(cycle);
      let changed = false;
      for (const m of this.meters.values()) if (m.checkStale(cycle)) changed = true;
      for (const s of this.slots) s.model.tick?.(tMs, TICK_MS);
      if (changed) this.solve();
      this.clock.schedule(cycle + period, run);
    };
    this.clock.schedule(first, run);
  }

  private armTicker(t: Ticker): void {
    if (t.armed || !t.live) return;
    t.armed = true;
    const first = (Math.floor(this.cycles / t.periodCycles) + 1) * t.periodCycles;
    const run = (cycle: number): void => {
      if (!t.live || !t.armed) return;
      t.cb(this.clock.toMs(cycle));
      this.clock.schedule(cycle + t.periodCycles, run);
    };
    this.clock.schedule(first, run);
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
