/**
 * A small modified-nodal-analysis DC solver.
 *
 * Every element is stamped as a conductance (plus a Norton current source where needed),
 * so the system matrix is a weighted Laplacian plus a tiny leak (GMIN) from every node to
 * ground: always non-singular. Diodes are piecewise linear and iterated until their on/off
 * states stop changing. Fidelity: DC operating point only, no transients, no capacitance.
 */

/** Circuit node id. "0" is ground. */
export type NodeId = string;
export type ElementId = string;

export const GROUND: NodeId = "0";
/** Leak from every node to ground (S, = 1 GΩ). Keeps floating nodes near 0 V and the matrix non-singular. */
export const GMIN = 1e-9;
/** Smallest output resistance a voltage source may have (Ω). */
export const MIN_R_OUT = 1e-3;
export const SWITCH_R_CLOSED = 0.01;
/** An open switch is not stamped at all (truly open); this is just the nominal value for docs/UI. */
export const SWITCH_R_OPEN = Infinity;
export const DIODE_R_OFF = 1e12;

export interface DiodeParams {
  /** Forward voltage (V), e.g. 2.0 for a red LED, 0.7 for a silicon diode. */
  vf: number;
  /** On resistance (Ω), e.g. 15 for a 5 mm LED. */
  rOn: number;
  /** Off resistance (Ω). Default DIODE_R_OFF. */
  rOff?: number;
}

export interface ElementOptions {
  /** Explicit element id. Default: auto "e<n>" (scoped builders prefix it with the part id). */
  id?: ElementId;
}

/** What part models use to add elements. Node "0" is ground; any other string creates a node. */
export interface CircuitBuilder {
  /** Resistor between a and b. current(id) > 0 means current flows a → b. */
  resistor(a: NodeId, b: NodeId, ohms: number, opts?: ElementOptions): ElementId;
  /**
   * Voltage source: V(plus) − V(minus) = volts when unloaded, with series output resistance rOut (Ω, default 0 → MIN_R_OUT).
   * current(id) > 0 means the source delivers current out of `plus` into the circuit.
   * A GPIO output is voltageSource(pin, "0", high ? vcc : 0, 25); a pull-up is voltageSource(pin, "0", vcc, 35_000).
   */
  voltageSource(plus: NodeId, minus: NodeId, volts: number, rOut?: number, opts?: ElementOptions): ElementId;
  /** Ideal current source pushing `amps` from a through the source into b. current(id) = amps. */
  currentSource(a: NodeId, b: NodeId, amps: number, opts?: ElementOptions): ElementId;
  /** Piecewise-linear diode, anode → cathode. current(id) > 0 = forward current. */
  diode(anode: NodeId, cathode: NodeId, params: DiodeParams, opts?: ElementOptions): ElementId;
  /** Same as diode(); separate name for readability. */
  led(anode: NodeId, cathode: NodeId, params: DiodeParams, opts?: ElementOptions): ElementId;
  /** Switch: SWITCH_R_CLOSED when closed, fully open (nothing stamped) when open. current(id) > 0 = a → b. */
  switch(a: NodeId, b: NodeId, closed: boolean, opts?: ElementOptions): ElementId;
}

/** What part models read after a solve. */
export interface SolveResultView {
  /** Node voltage relative to ground (V). Unknown nodes read 0. */
  voltage(node: NodeId): number;
  /** Element current (A), sign per element kind (see CircuitBuilder docs). Unknown ids read 0. */
  current(id: ElementId): number;
  /** True when the node has no conducting path to ground (open switches and off diodes do not conduct). */
  isFloating(node: NodeId): boolean;
  /** For diodes/LEDs: whether it ended up conducting. */
  isOn(id: ElementId): boolean;
}

export interface SolveResult extends SolveResultView {
  voltages: ReadonlyMap<NodeId, number>;
  currents: ReadonlyMap<ElementId, number>;
  floating: ReadonlySet<NodeId>;
  /** Diode-state iterations used. */
  iterations: number;
  /** False when diode states did not settle within the iteration limit (result is the last iterate). */
  converged: boolean;
}

type Element =
  | { kind: "resistor"; id: ElementId; a: NodeId; b: NodeId; g: number }
  | { kind: "vsource"; id: ElementId; a: NodeId; b: NodeId; v: number; g: number }
  | { kind: "isource"; id: ElementId; a: NodeId; b: NodeId; i: number }
  | { kind: "diode"; id: ElementId; a: NodeId; b: NodeId; vf: number; gOn: number; gOff: number }
  | { kind: "switch"; id: ElementId; a: NodeId; b: NodeId; closed: boolean };

function assertFinite(name: string, v: number) {
  if (!Number.isFinite(v)) throw new Error(`${name} must be a finite number, got ${v}`);
}

export class Circuit implements CircuitBuilder {
  private elements: Element[] = [];
  private ids = new Set<ElementId>();
  private auto = 0;
  private nodes = new Set<NodeId>();
  /** Diode states carried between solves (warm start). */
  private diodeState = new Map<ElementId, boolean>();
  /** Max diode-state iterations per solve. */
  maxIterations = 64;

  /** Remove all elements (diode warm-start states are kept). */
  clear(): void {
    this.elements = [];
    this.ids.clear();
    this.nodes.clear();
    this.auto = 0;
  }

  get elementCount(): number {
    return this.elements.length;
  }

  private addId(opts?: ElementOptions): ElementId {
    const id = opts?.id ?? `e${this.auto++}`;
    if (this.ids.has(id)) throw new Error(`duplicate circuit element id '${id}'`);
    this.ids.add(id);
    return id;
  }

  private touch(...ns: NodeId[]) {
    for (const n of ns) if (n !== GROUND) this.nodes.add(n);
  }

  resistor(a: NodeId, b: NodeId, ohms: number, opts?: ElementOptions): ElementId {
    assertFinite("ohms", ohms);
    if (ohms <= 0) throw new Error(`resistor must be > 0 Ω, got ${ohms}`);
    const id = this.addId(opts);
    this.touch(a, b);
    this.elements.push({ kind: "resistor", id, a, b, g: 1 / ohms });
    return id;
  }

  voltageSource(plus: NodeId, minus: NodeId, volts: number, rOut = 0, opts?: ElementOptions): ElementId {
    assertFinite("volts", volts);
    assertFinite("rOut", rOut);
    const id = this.addId(opts);
    this.touch(plus, minus);
    this.elements.push({ kind: "vsource", id, a: plus, b: minus, v: volts, g: 1 / Math.max(rOut, MIN_R_OUT) });
    return id;
  }

  currentSource(a: NodeId, b: NodeId, amps: number, opts?: ElementOptions): ElementId {
    assertFinite("amps", amps);
    const id = this.addId(opts);
    this.touch(a, b);
    this.elements.push({ kind: "isource", id, a, b, i: amps });
    return id;
  }

  diode(anode: NodeId, cathode: NodeId, params: DiodeParams, opts?: ElementOptions): ElementId {
    assertFinite("vf", params.vf);
    if (!(params.rOn > 0)) throw new Error(`diode rOn must be > 0 Ω, got ${params.rOn}`);
    const id = this.addId(opts);
    this.touch(anode, cathode);
    this.elements.push({
      kind: "diode",
      id,
      a: anode,
      b: cathode,
      vf: params.vf,
      gOn: 1 / params.rOn,
      gOff: 1 / (params.rOff ?? DIODE_R_OFF),
    });
    return id;
  }

  led(anode: NodeId, cathode: NodeId, params: DiodeParams, opts?: ElementOptions): ElementId {
    return this.diode(anode, cathode, params, opts);
  }

  switch(a: NodeId, b: NodeId, closed: boolean, opts?: ElementOptions): ElementId {
    const id = this.addId(opts);
    this.touch(a, b);
    this.elements.push({ kind: "switch", id, a, b, closed });
    return id;
  }

  /** Solve the DC operating point. */
  solve(): SolveResult {
    const nodeList = [...this.nodes].sort();
    const index = new Map<NodeId, number>();
    nodeList.forEach((n, i) => index.set(n, i));
    const n = nodeList.length;

    const diodes = this.elements.filter((e) => e.kind === "diode");
    const state = new Map<ElementId, boolean>();
    for (const d of diodes) state.set(d.id, this.diodeState.get(d.id) ?? false);

    let x: Float64Array = new Float64Array(n);
    let iterations = 0;
    let converged = false;
    while (iterations < this.maxIterations) {
      iterations++;
      x = this.solveLinear(n, index, state);
      const v = (node: NodeId) => (node === GROUND ? 0 : x[index.get(node)!]!);
      let changed = false;
      for (const d of diodes) {
        if (d.kind !== "diode") continue;
        const on = state.get(d.id)!;
        const vd = v(d.a) - v(d.b);
        if (!on && vd > d.vf + 1e-9) {
          state.set(d.id, true);
          changed = true;
        } else if (on && (vd - d.vf) * d.gOn < -1e-12) {
          state.set(d.id, false);
          changed = true;
        }
      }
      if (!changed) {
        converged = true;
        break;
      }
    }
    for (const [k, s] of state) this.diodeState.set(k, s);

    const voltages = new Map<NodeId, number>();
    voltages.set(GROUND, 0);
    nodeList.forEach((node, i) => voltages.set(node, x[i]!));
    const v = (node: NodeId) => voltages.get(node) ?? 0;

    const currents = new Map<ElementId, number>();
    for (const e of this.elements) {
      const vab = v(e.a) - v(e.b);
      switch (e.kind) {
        case "resistor":
          currents.set(e.id, vab * e.g);
          break;
        case "vsource":
          currents.set(e.id, (e.v - vab) * e.g);
          break;
        case "isource":
          currents.set(e.id, e.i);
          break;
        case "diode":
          currents.set(e.id, state.get(e.id) ? (vab - e.vf) * e.gOn : vab * e.gOff);
          break;
        case "switch":
          currents.set(e.id, e.closed ? vab / SWITCH_R_CLOSED : 0);
          break;
      }
    }

    const floating = this.findFloating(nodeList, state);
    return {
      voltages,
      currents,
      floating,
      iterations,
      converged,
      voltage: (node) => v(node),
      current: (id) => currents.get(id) ?? 0,
      isFloating: (node) => floating.has(node),
      isOn: (id) => state.get(id) ?? false,
    };
  }

  private solveLinear(n: number, index: Map<NodeId, number>, diodeOn: Map<ElementId, boolean>): Float64Array {
    // Dense augmented matrix [G | I]. Kit-sized circuits have tens of nodes.
    const w = n + 1;
    const m = new Float64Array(n * w);
    const at = (r: number, c: number) => r * w + c;
    const idx = (node: NodeId) => (node === GROUND ? -1 : index.get(node)!);
    const stampG = (a: NodeId, b: NodeId, g: number) => {
      const i = idx(a);
      const j = idx(b);
      if (i >= 0) m[at(i, i)]! += g;
      if (j >= 0) m[at(j, j)]! += g;
      if (i >= 0 && j >= 0) {
        m[at(i, j)]! -= g;
        m[at(j, i)]! -= g;
      }
    };
    /** Current `amps` injected into node a and drawn from node b. */
    const stampI = (a: NodeId, b: NodeId, amps: number) => {
      const i = idx(a);
      const j = idx(b);
      if (i >= 0) m[at(i, n)]! += amps;
      if (j >= 0) m[at(j, n)]! -= amps;
    };

    for (let i = 0; i < n; i++) m[at(i, i)]! += GMIN;
    for (const e of this.elements) {
      switch (e.kind) {
        case "resistor":
          stampG(e.a, e.b, e.g);
          break;
        case "vsource":
          // Norton equivalent: conductance g in parallel with current v*g pushed into `plus`.
          stampG(e.a, e.b, e.g);
          stampI(e.a, e.b, e.v * e.g);
          break;
        case "isource":
          stampI(e.b, e.a, e.i);
          break;
        case "diode":
          if (diodeOn.get(e.id)) {
            // i = gOn * (vab - vf)  →  conductance gOn plus a source of gOn*vf from k into a.
            stampG(e.a, e.b, e.gOn);
            stampI(e.a, e.b, e.gOn * e.vf);
          } else {
            stampG(e.a, e.b, e.gOff);
          }
          break;
        case "switch":
          if (e.closed) stampG(e.a, e.b, 1 / SWITCH_R_CLOSED);
          break;
      }
    }
    return gaussianSolve(m, n);
  }

  private findFloating(nodeList: NodeId[], diodeOn: Map<ElementId, boolean>): Set<NodeId> {
    const adj = new Map<NodeId, NodeId[]>();
    const link = (a: NodeId, b: NodeId) => {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    };
    for (const e of this.elements) {
      const conducts =
        e.kind === "resistor" ||
        e.kind === "vsource" ||
        (e.kind === "switch" && e.closed) ||
        (e.kind === "diode" && diodeOn.get(e.id));
      if (conducts) link(e.a, e.b);
    }
    const seen = new Set<NodeId>([GROUND]);
    const stack: NodeId[] = [GROUND];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    return new Set(nodeList.filter((node) => !seen.has(node)));
  }
}

/** Solve the n×(n+1) augmented system in place with partial pivoting. */
export function gaussianSolve(m: Float64Array, n: number): Float64Array {
  const w = n + 1;
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(m[col * w + col]!);
    for (let r = col + 1; r < n; r++) {
      const a = Math.abs(m[r * w + col]!);
      if (a > best) {
        best = a;
        piv = r;
      }
    }
    if (best === 0) throw new Error("singular circuit matrix");
    if (piv !== col) {
      for (let c = col; c < w; c++) {
        const t = m[col * w + c]!;
        m[col * w + c] = m[piv * w + c]!;
        m[piv * w + c] = t;
      }
    }
    const p = m[col * w + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = m[r * w + col]! / p;
      if (f === 0) continue;
      for (let c = col; c < w; c++) m[r * w + c]! -= f * m[col * w + c]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r * w + n]!;
    for (let c = r + 1; c < n; c++) s -= m[r * w + c]! * x[c]!;
    x[r] = s / m[r * w + r]!;
  }
  return x;
}

/**
 * A builder that prefixes element ids with a scope (used by the simulation so each part's
 * auto ids are "<partId>/e0", "<partId>/e1", … and explicit ids become "<partId>/<id>").
 * Returned ids are the full ids, so pass them straight to SolveResultView.current().
 */
export function scopedBuilder(target: CircuitBuilder, scope: string): CircuitBuilder {
  let n = 0;
  const id = (opts?: ElementOptions): ElementOptions => ({ id: `${scope}/${opts?.id ?? `e${n++}`}` });
  return {
    resistor: (a, b, ohms, opts) => target.resistor(a, b, ohms, id(opts)),
    voltageSource: (p, m, v, r, opts) => target.voltageSource(p, m, v, r, id(opts)),
    currentSource: (a, b, i, opts) => target.currentSource(a, b, i, id(opts)),
    diode: (a, k, p, opts) => target.diode(a, k, p, id(opts)),
    led: (a, k, p, opts) => target.led(a, k, p, id(opts)),
    switch: (a, b, c, opts) => target.switch(a, b, c, id(opts)),
  };
}
