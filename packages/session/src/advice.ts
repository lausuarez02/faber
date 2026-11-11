/**
 * Round 8 (parts-advice): "parts you may not need" and "a smaller part does the same job". Static,
 * from the wiring and the parts' own physical data (dimensions_mm, mass_g), so a device comes out
 * small without the person having to know which module is redundant. Every finding is an `info`
 * issue in check_design (it works as wired; it is only bigger than it needs to be) that says what,
 * why (with the mm it saves) and the fix. The same rules feed plan_device's reasoning
 * (`savingFor`, `smallerBoardFor`).
 */
import { buildNets, type PinRef, type Project } from "@jumper/project-format";
import type { PartRegistry, PartSpec, PinSpec } from "@jumper/sim-core";
import type { DesignIssue } from "./drc.ts";

/** A 1S LiPo after the power switch: about 3.3 V under load near empty, 4.2 V full. */
export const CELL_MIN_V = 3.3;
export const CELL_MAX_V = 4.2;
/** Cells smaller than this are charged too hard by an IP5306 (about 2 A, 1C). */
const CHARGE_BOOST_MIN_MAH = 2000;

const r1 = (n: number) => Math.round(n * 10) / 10;

/** "36 x 17 x 6 mm (612 mm² of board area, 3 g)" for a part, from its own data. */
export function savingFor(spec: PartSpec | undefined, qty = 1): { text: string; area: number; mass: number } {
  const d = spec?.dimensions_mm;
  if (!d) return { text: "its size (no dimensions_mm)", area: 0, mass: 0 };
  const area = Math.round(d.w * d.h * qty);
  const mass = (spec?.mass_g ?? 0) * qty;
  return { text: `${d.w} x ${d.h} x ${d.d} mm (${area} mm² of footprint${mass ? `, ${r1(mass)} g` : ""})`, area, mass };
}

type Ref = { ref: PinRef; spec: PartSpec; pin: PinSpec };

/** A board pin the cell may feed (through a Schottky diode on a USB pin), and the range it takes. */
function boardTakesCell(spec: PartSpec, pin: PinSpec): { ok: boolean; why: string } {
  const lim = (spec.limits ?? {}) as Record<string, number | undefined>;
  if (/^VSYS$/i.test(pin.id) && (pin.voltage?.min ?? 99) <= 3.0) return { ok: true, why: `${pin.id} takes ${pin.voltage!.min} to ${pin.voltage!.max} V` };
  if (/^(VBUS|5V)$/i.test(pin.id) && (lim.vbusInMinV ?? 99) <= 3.6) return { ok: true, why: `${pin.id} takes ${lim.vbusInMinV} to ${lim.vbusInMaxV ?? 5.5} V into the board's own 3.3 V regulator` };
  return { ok: false, why: `${pin.id} needs ${pin.voltage?.min ?? 4.75} V or more` };
}

/** A module's supply pin that runs straight from a 1S cell (3.3 to 4.2 V). */
function moduleTakesCell(pin: PinSpec): boolean {
  const v = pin.voltage;
  return !!v && v.min <= CELL_MIN_V && v.max >= CELL_MAX_V;
}

export function partsAdvice(project: Project, registry: PartRegistry): DesignIssue[] {
  const out: DesignIssue[] = [];
  const specOf = new Map<string, PartSpec>();
  for (const p of project.parts) {
    const d = registry.get(p.type);
    if (d) specOf.set(p.id, d.spec);
  }
  const nets = buildNets(project).map((n) => ({
    id: n.id,
    pins: n.pins.flatMap((ref): Ref[] => {
      const spec = specOf.get(ref.part);
      const pin = spec?.pins.find((x) => x.id === ref.pin);
      return spec && pin ? [{ ref, spec, pin }] : [];
    }),
  }));
  const netOf = (part: string, pin: string) => nets.find((n) => n.pins.some((x) => x.ref.part === part && x.ref.pin === pin));
  const boardId = project.firmware?.board ?? project.parts.find((p) => specOf.get(p.id)?.category === "board")?.id;
  const board = boardId ? specOf.get(boardId) : undefined;
  const lipos = project.parts.filter((p) => p.type === "lipo-battery");
  const handheld = !!project.enclosure || lipos.length > 0 || project.parts.some((p) => p.type === "battery-pack");

  /** Everything a supply net feeds, following Schottky / signal diodes forward (A → C) and switches. */
  const consumersOf = (start: ReturnType<typeof netOf>, self: string): { refs: Ref[]; viaDiode: Set<string> } => {
    const refs: Ref[] = [];
    const viaDiode = new Set<string>();
    const seen = new Set<string>();
    const queue: { net: NonNullable<typeof start>; diode: boolean }[] = start ? [{ net: start, diode: false }] : [];
    while (queue.length) {
      const { net, diode } = queue.shift()!;
      if (seen.has(net.id)) continue;
      seen.add(net.id);
      for (const x of net.pins) {
        if (x.ref.part === self) continue;
        const t = x.spec.id;
        if (/diode/.test(t) && x.ref.pin === "A") {
          const n = netOf(x.ref.part, "C");
          if (n) queue.push({ net: n, diode: true });
        } else if (t === "slide-switch") {
          for (const o of x.spec.pins) if (o.id !== x.ref.pin) {
            const n = netOf(x.ref.part, o.id);
            if (n) queue.push({ net: n, diode });
          }
        } else if (x.pin.type === "power" && x.spec.category !== "passive") {
          refs.push(x);
          if (diode) viaDiode.add(`${x.ref.part}.${x.ref.pin}`);
        }
      }
    }
    return { refs, viaDiode };
  };

  // 1. A boost converter feeding only parts that run from the cell itself.
  for (const p of project.parts.filter((q) => q.type === "boost-converter")) {
    const spec = specOf.get(p.id)!;
    const { refs } = consumersOf(netOf(p.id, "VOUT+"), p.id);
    if (!refs.length) continue;
    const verdicts = refs.map((x) => {
      if (x.spec.category === "board") return { x, ...boardTakesCell(x.spec, x.pin) };
      if (x.spec.category === "power") return { x, ok: (x.pin.voltage?.min ?? 99) <= CELL_MIN_V && /VIN/i.test(x.pin.id), why: `${x.pin.id} takes ${x.pin.voltage?.min ?? "?"} V and up` };
      return { x, ok: moduleTakesCell(x.pin), why: `${x.pin.id} takes ${x.pin.voltage?.min ?? "?"} to ${x.pin.voltage?.max ?? "?"} V` };
    });
    if (!verdicts.every((v) => v.ok)) continue;
    const save = savingFor(spec);
    const onlyBoard = verdicts.every((v) => v.x.spec.category === "board") && (board?.mcu?.vcc ?? 5) < 4;
    const boardRef = verdicts.find((v) => v.x.spec.category === "board");
    const modules = verdicts.filter((v) => v.x.spec.category !== "board");
    const feeders = netOf(p.id, "VIN+")?.pins.filter((x) => x.ref.part !== p.id && x.spec.id !== "resistor") ?? [];
    const f = feeders.find((x) => x.spec.id === "slide-switch") ?? feeders.find((x) => x.spec.category === "power") ?? feeders[0];
    const feeder = f ? `${f.ref.part}.${f.ref.pin}` : undefined;
    out.push({
      severity: "info",
      code: "boost-not-needed",
      message:
        `${p.id} (5 V boost) may not be needed: everything it feeds runs straight from the 1S LiPo. ` +
        `Why: ${verdicts.map((v) => `${v.x.spec.name.replace(/ \(.*\)$/, "")} ${v.why}`).join("; ")}, and the cell gives ${CELL_MIN_V} to ${CELL_MAX_V} V${onlyBoard ? `; the ${board!.name} only turns the 5 V back into 3.3 V` : ""}. ` +
        `The boost adds ${save.text} and wastes about 12 % of the battery in heat. ` +
        `Fix: remove ${p.id} and wire ${feeder ?? "the switched battery"} straight to where ${p.id}.VOUT+ went` +
        `${boardRef ? ` (keep the Schottky diode before ${boardRef.x.ref.part}.${boardRef.x.ref.pin}, stripe towards the board)` : ""}` +
        `${modules.length ? `; ${modules.map((v) => `${v.x.ref.part}.${v.x.ref.pin}`).join(", ")} on the switched battery${modules.some((v) => v.x.spec.id === "dfplayer-mini") ? " (the DFPlayer is a bit quieter at 3.7 V than at 5 V)" : ""}` : ""}` +
        `. Then check_design: ldo-dropout says how low the cell can go before the board browns out.`,
      parts: [p.id, ...new Set(verdicts.map((v) => v.x.ref.part))],
    });
  }

  // 2. A separate charger when the board charges a LiPo itself.
  const boardCharges = !!board && ((board.limits as Record<string, unknown> | undefined)?.chargerBuiltIn === 1 || (board.tags ?? []).includes("lipo charger"));
  for (const p of project.parts.filter((q) => q.type === "tp4056-charger" || q.type === "charge-boost-5v")) {
    if (!boardCharges || !boardId) break;
    const save = savingFor(specOf.get(p.id));
    out.push({
      severity: "info",
      code: "charger-not-needed",
      message: `${p.id} (LiPo charger) may not be needed: ${boardId} (${board!.name}) charges a LiPo on its own BAT pads. Why: two chargers on one cell fight over it, and ${p.id} adds ${save.text}. Fix: remove ${p.id}; wire the cell's + / − to ${boardId}'s battery pads and charge through the board's USB.`,
      parts: [p.id, boardId],
    });
  }

  // 3. TP4056 + boost when a real 5 V is needed: one charge-boost module, if the cell can take its 2 A.
  const tp = project.parts.find((q) => q.type === "tp4056-charger");
  const cb = registry.get("charge-boost-5v")?.spec;
  if (tp && cb && !out.some((i) => i.code === "boost-not-needed")) {
    const boost = project.parts.find((q) => q.type === "boost-converter" && consumersOf(netOf(tp.id, "OUT"), tp.id).refs.some((x) => x.ref.part === q.id));
    const cell = lipos.find((l) => netOf(l.id, "POS")?.pins.some((x) => x.ref.part === tp.id && x.ref.pin === "BAT"));
    const cap = Number(cell?.props?.capacity ?? registry.get("lipo-battery")?.spec.props?.find((x) => x.id === "capacity")?.default ?? 0);
    if (boost && cap >= CHARGE_BOOST_MIN_MAH) {
      const before = savingFor(specOf.get(tp.id)).area + savingFor(specOf.get(boost.id)).area;
      const after = savingFor(cb).area;
      out.push({
        severity: "info",
        code: "combine-charge-boost",
        message: `${tp.id} + ${boost.id} could be one module. Why: charge-boost-5v (IP5306 class, ${cb.dimensions_mm!.w} x ${cb.dimensions_mm!.h} x ${cb.dimensions_mm!.d} mm) charges the ${cap} mAh cell and gives 5 V, ${before - after} mm² less footprint than both (${before} → ${after} mm²). Its catch: OUT switches off after 32 s under about 45 mA, so it suits loads that draw more (motors, LED strips, a 5 V board with a screen). Fix: remove ${tp.id} and ${boost.id}, place_part charge-boost-5v, then cell + → BAT, cell − → GND.2, OUT → where ${boost.id}.VOUT+ went, GND.3 → GND.`,
        parts: [tp.id, boost.id],
      });
    }
  }

  // 4. A big board in a hand-held device when a smaller one has enough pins.
  if (board && boardId && handheld) {
    const alt = smallerBoardFor(board, usedGpio(project, boardId, specOf), registry);
    if (alt.length) {
      const save = savingFor(board);
      const [same, other] = [alt.find((a) => a.sameChip), alt.find((a) => !a.sameChip)];
      const pick = [same, other].filter((a): a is NonNullable<typeof a> => !!a);
      out.push({
        severity: "info",
        code: "board-bigger-than-needed",
        message: `${boardId} (${board.name}, ${save.text}) is bigger than this device needs. Why: it uses ${usedGpio(project, boardId, specOf)} GPIO pins; ${pick.map((a) => `the ${a.spec.name} (${a.spec.id}, ${a.spec.dimensions_mm!.w} x ${a.spec.dimensions_mm!.h} x ${a.spec.dimensions_mm!.d} mm, ${a.gpio} GPIO) ${a.sameChip ? "has the same chip, so the sketch stays the same" : "is smaller still, with 3.3 V logic: the sketch's pin numbers change"}`).join("; ")}. Fix: swap ${boardId} for ${pick[0]!.spec.id} (remove ${boardId}, place_part ${pick[0]!.spec.id}, connect the same signals; get_part ${pick[0]!.spec.id} lists its pins).`,
        parts: [boardId],
      });
    }
  }

  // 5. The 28 mm speaker in a hand-held device: a 20 mm one is clear enough for speech.
  const small = registry.get("speaker-20mm")?.spec;
  if (small && handheld) {
    for (const p of project.parts.filter((q) => q.type === "speaker")) {
      const big = savingFor(specOf.get(p.id));
      const s = savingFor(small);
      out.push({
        severity: "info",
        code: "smaller-speaker",
        message: `${p.id} (28 mm speaker) could be a 20 mm one. Why: speech from a DFPlayer is clear on a 20 mm speaker (${small.dimensions_mm!.w} x ${small.dimensions_mm!.h} x ${small.dimensions_mm!.d} mm) and it saves ${big.area - s.area} mm² of footprint and ${r1(specOf.get(p.id)!.dimensions_mm!.d - small.dimensions_mm!.d)} mm of depth; it is a bit quieter, with less bass. Fix: remove ${p.id}, place_part speaker-20mm with id ${p.id}, wire + → SPK_1 and - → SPK_2 again (speaker-15mm is smaller still and quieter).`,
        parts: [p.id],
      });
    }
  }
  return out;
}

/** Board GPIO pins with a wire on them. */
function usedGpio(project: Project, boardId: string, specOf: Map<string, PartSpec>): number {
  const spec = specOf.get(boardId);
  const used = new Set<string>();
  for (const w of project.wires) for (const e of [w.from, w.to]) {
    if (e.part !== boardId) continue;
    const pin = spec?.pins.find((x) => x.id === e.pin);
    if (pin && (pin.type === "digital" || pin.type === "analog")) used.add(pin.id);
  }
  return used.size;
}

const gpioCount = (s: PartSpec) => s.pins.filter((p) => p.type === "digital" || p.type === "analog").length;
const areaOf = (s: PartSpec) => (s.dimensions_mm ? s.dimensions_mm.w * s.dimensions_mm.h : Number.POSITIVE_INFINITY);

/** Simulated boards at most 70 % of this one's footprint with enough GPIO, same chip first, then smallest. */
export function smallerBoardFor(board: PartSpec, gpioNeeded: number, registry: PartRegistry): { spec: PartSpec; gpio: number; sameChip: boolean }[] {
  return registry
    .list()
    .map((d) => d.spec)
    .filter((s) => s.category === "board" && s.mcu && s.id !== board.id && s.dimensions_mm && areaOf(s) < areaOf(board) * 0.7 && gpioCount(s) >= Math.max(1, gpioNeeded))
    .map((s) => ({ spec: s, gpio: gpioCount(s), sameChip: s.mcu!.chip === board.mcu?.chip }))
    .sort((a, b) => Number(b.sameChip) - Number(a.sameChip) || areaOf(a.spec) - areaOf(b.spec));
}
