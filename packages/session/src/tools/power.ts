import { buildNets, type Project } from "@jumper/project-format";
import { Simulation, type PartRegistry, type VisualValue } from "@jumper/sim-core";
import { assemblyReason, assemblyStyle } from "../assembly.ts";
import { fail } from "../errors.ts";
import type { ToolModule } from "./types.ts";

/**
 * Track "power" (owner): set_power, set_assembly. Contract: docs/decisions/0004-round6-real-device.md, R2.
 *
 * set_power plugs or unplugs the board's USB cable (jumper.json power.usb): with it unplugged the
 * board runs only from what is wired to its supply pins (a LiPo through a charger, a switch and a
 * Schottky diode), and the firmware is held in reset when nothing powers it. set_assembly says how the
 * device is built (breadboard or soldered), which decides what export writes.
 */

const why = { type: "string", description: 'Short reason shown to the human in the step list, e.g. "check it runs from the battery".' };

export interface PowerReport {
  usb: boolean;
  board_powered: boolean;
  supply: { net: string; volts: number; from: string[] };
  battery?: { part: string; volts: number; ma: number; hours_left: number | null };
}

const num = (v: VisualValue | undefined): number => (typeof v === "number" ? v : Number(v ?? 0));
const r2 = (n: number) => Math.round(n * 100) / 100;

/** What powers the board, from the part states of a solved simulation (the running one, or a fresh one at t = 0). */
export function powerReport(project: Project, registry: PartRegistry, states: Record<string, Record<string, VisualValue>> | undefined): PowerReport {
  const usb = project.power?.usb !== false;
  const boardId = project.firmware?.board ?? project.parts.find((p) => registry.get(p.type)?.spec.category === "board")?.id;
  let st = states;
  let volts: Record<string, number> = {};
  if (!st) {
    // No simulation yet: solve the circuit at t = 0 (no firmware, so only idle currents).
    const sim = new Simulation({ project, registry });
    st = Object.fromEntries(sim.partIds().map((id) => [id, sim.partState(id) ?? {}]));
    const r = sim.lastSolve;
    if (r) volts = Object.fromEntries([...r.voltages.entries()]);
    sim.dispose();
  }
  const board = boardId ? project.parts.find((p) => p.id === boardId) : undefined;
  const bspec = board ? registry.get(board.type)?.spec : undefined;
  const bstate = boardId ? (st[boardId] ?? {}) : {};
  const supplyPin = bspec?.pins.find((p) => p.type === "power" && /^VBUS$/i.test(p.id))?.id ?? bspec?.pins.find((p) => p.type === "power" && /^5V$/i.test(p.id))?.id ?? bspec?.pins.find((p) => p.type === "power")?.id;
  const nets = buildNets(project);
  const net = boardId && supplyPin ? nets.find((n) => n.pins.some((x) => x.part === boardId && x.pin === supplyPin)) : undefined;
  const from: string[] = [];
  if (usb && board) from.push(`USB cable on ${boardId}.${supplyPin}`);
  const batteries = project.parts.filter((p) => p.type === "lipo-battery" || p.type === "battery-pack");
  for (const b of batteries) {
    const ma = num(st[b.id]?.currentmA);
    if (ma > 0.5) from.push(`${b.id} (${ma.toFixed(1)} mA)`);
  }
  const lipo = batteries.find((b) => b.type === "lipo-battery");
  let battery: PowerReport["battery"];
  if (lipo) {
    const s = st[lipo.id] ?? {};
    const ma = num(s.currentmA);
    const cap = Number(lipo.props?.capacity ?? registry.get("lipo-battery")?.spec.props?.find((p) => p.id === "capacity")?.default ?? 500);
    const soc = num(s.soc ?? 100);
    battery = { part: lipo.id, volts: r2(num(s.volts)), ma: r2(ma), hours_left: ma > 0.5 ? r2((cap * soc) / 100 / ma) : null };
  }
  const supplyV = typeof bstate.supplyV === "number" ? bstate.supplyV : net ? (volts[net.id] ?? 0) : 0;
  return {
    usb,
    board_powered: bstate.powered !== false,
    supply: { net: net ? net.pins.map((p) => `${p.part}.${p.pin}`).join(" · ") : `${boardId ?? "board"}.${supplyPin ?? "?"}`, volts: r2(supplyV), from },
    ...(battery ? { battery } : {}),
  };
}

export const powerTools: ToolModule = {
  name: "power",
  tools: [
    {
      name: "set_power",
      title: "Plug or unplug the board's USB cable",
      description:
        'Say whether a USB cable is plugged into the board (jumper.json power.usb; default true, as before). {"usb": false} runs the device only from what is wired to the board\'s supply pins: check that a pocket device really runs from its battery (cell → charger BAT, charger OUT → switch → schottky-diode → the board\'s 5V / VBUS, or a Pico\'s VSYS). Without a battery path the firmware is held in reset (no serial, nothing on the screen) and check_design reports no-power-path. Applies live to a running simulation (unplugging mid-run is a power cut; plugging in boots it from reset). The TP4056 module\'s own USB socket is separate: set_part_property <charger> usb true plugs a charger into it. Returns {usb, board_powered, supply: {net, volts, from}, battery?: {part, volts, ma, hours_left}} (from the running simulation, or the circuit at 0 ms when nothing ran yet).',
      inputSchema: {
        type: "object",
        properties: {
          usb: { type: "boolean", description: "true = a USB cable is plugged into the board; false = it runs from its battery path only." },
          why,
        },
        required: ["usb"],
      },
      edits: true,
    },
    {
      name: "set_assembly",
      title: "Say how the device is built (breadboard or soldered)",
      description:
        'How the real device is put together; export follows it. "soldered" = hand-wired point to point (or perfboard) inside a case: export writes WIRE-CUTS.csv (every wire with its length, colour and gauge), ASSEMBLY.md (numbered soldering steps, power path first) and a BOM with hook-up wire and heat-shrink, never breadboards or dupont wires. "breadboard" = a desk prototype with dupont wires. Default: soldered for a project with a case or a pocket board (XIAO, RP2040-Zero), breadboard otherwise. Example: {"style": "soldered", "why": "it goes in a pocket case"}. Returns {style, note}.',
      inputSchema: {
        type: "object",
        properties: {
          style: { type: "string", enum: ["breadboard", "soldered"], description: "breadboard | soldered" },
          why,
        },
        required: ["style"],
      },
      edits: true,
    },
  ],
  ops: {
    set_power(args, x) {
      if (typeof args.usb !== "boolean") fail("bad-arg", "set_power needs usb: true or false", `got ${JSON.stringify(args.usb)}`, 'pass {"usb": false} to run from the battery, {"usb": true} for a USB cable');
      const s = x.session;
      const usb = args.usb as boolean;
      const was = s.project.power?.usb !== false;
      if (was !== usb || s.project.power?.usb === undefined) x.commit(`set_power usb=${usb}`, { ...s.project, power: { ...s.project.power, usb } });
      const report = powerReport(s.project, s.registry, s.liveStates());
      x.summary(`USB ${usb ? "plugged in" : "unplugged"}: ${report.board_powered ? `board powered (${report.supply.from.join(", ") || "its supply pins"})` : "the board has no power"}`);
      return {
        ...report,
        ...(report.board_powered
          ? {}
          : { fix: `nothing powers the board without USB. Wire the battery path (check_design no-power-path says how), or set_power {"usb": true}.` }),
        next: usb ? 'run or run_tests as usual; set_power {"usb": false} checks the battery path' : "run / run_tests now run from the battery; check_design shows the power-path checks (usb-backfeed, ldo-dropout)",
      };
    },
    set_assembly(args, x) {
      const style = args.style;
      if (style !== "breadboard" && style !== "soldered") fail("bad-arg", `set_assembly: unknown style ${JSON.stringify(style)}`, "the styles are breadboard (dupont wires on a breadboard) and soldered (hand-wired in a case)", 'pass {"style": "soldered"} or {"style": "breadboard"}');
      const s = x.session;
      if (s.project.assembly !== style) x.commit(`set_assembly ${style}`, { ...s.project, assembly: style });
      x.summary(`assembly: ${style}`);
      const note =
        style === "soldered"
          ? "export now writes WIRE-CUTS.csv (length, colour and gauge per wire), ASSEMBLY.md (soldering steps, power path first) and a BOM with hook-up wire and heat-shrink instead of a breadboard and dupont wires"
          : "export writes a breadboard BOM (breadboard + dupont wires) and the wiring table";
      return { style: assemblyStyle(s.project, s.registry), note, why_default: assemblyReason({ ...s.project, assembly: undefined }, s.registry) };
    },
  },
};
