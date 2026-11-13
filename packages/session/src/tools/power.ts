import { buildNets, type Project } from "@jumper/project-format";
import { Simulation, type PartRegistry, type VisualValue } from "@jumper/sim-core";
import { assemblyReason, assemblyStyle } from "../assembly.ts";
import { fail } from "../errors.ts";
import { checkDuty, measuredSleep, powerBudget, type Duty, type PowerProfile } from "../power-budget.ts";
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
          target_hours: { type: ["number", "null"], description: "Round 14: hours the device should run on one charge (jumper.json power.target_hours); check_design then warns (battery-life) under it, with the cell size that would make it. null removes it." },
          duty: { type: ["object", "null"], description: 'Round 14: how much of the time each load is on, by role (cpu, wifi, camera, display, audio) or part id: "always", "off" or {"on_s": 2, "every_s": 600}. Merged into power.duty; null clears it.' },
          sleep: { type: ["string", "null"], enum: ["none", "light", "deep", null], description: "Round 14: what the board does between active moments." },
          wakes_per_day: { type: ["number", "null"], description: "Round 15: a sleeping board wakes this many times a day (timer + button / lid). null removes it." },
          awake_s: { type: ["number", "null"], description: "Round 15: seconds awake per wake (boot, read, draw; an e-paper full refresh is 2 s). null removes it." },
          why,
        },
      },
      edits: true,
    },
    {
      name: "estimate_power",
      title: "Battery life from duty cycles",
      description:
        'Round 14: how long the battery lasts, from each load\'s datasheet current and how much of the time it is on: the board CPU (and its sleep), Wi-Fi (connected vs bursts), cameras, screens, audio amplifiers, any part with a current figure. Loads without a duty in jumper.json power.duty are guessed from the firmware (listed in assumptions: correct them). Try other patterns without saving: {"duty": {"camera": {"on_s": 2, "every_s": 600}, "wifi": {"on_s": 10, "every_s": 3600}}, "target_hours": 24}. Returns {summary, battery {part, capacity_mah, usable_mah}, avg_ma, peak_ma, hours, target_hours, loads [{load, part, active_ma, idle_ma, duty, duty_text, avg_ma, share, source}], assumptions, suggestions (the cell that meets the target, and what to duty-cycle)}. Save a pattern with set_power {duty, target_hours}. Estimates, not measurements: measure a real unit.',
      inputSchema: {
        type: "object",
        properties: {
          target_hours: { type: "number", description: "Hours on one charge to compare against (default: power.target_hours)." },
          duty: { type: "object", description: 'What-if duty per role or part id: "always", "off" or {"on_s", "every_s"}.' },
          sleep: { type: "string", enum: ["none", "light", "deep"] },
          wakes_per_day: { type: "number", description: "Round 15: what-if wakes per day of a sleeping board (default: power.wakes_per_day, else measured from the last run's deep sleeps, else the firmware's sleep timer)." },
          awake_s: { type: "number", description: "Round 15: what-if seconds awake per wake." },
        },
      },
      readOnly: true,
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
    estimate_power(args, x) {
      const s = x.session;
      const duty = (args.duty ?? undefined) as Record<string, Duty> | undefined;
      for (const [k, d] of Object.entries(duty ?? {})) {
        const why = checkDuty(k, d);
        if (why) fail("bad-arg", `estimate_power: duty.${k} is not valid`, why, 'pass e.g. {"duty": {"camera": {"on_s": 2, "every_s": 600}}}');
      }
      if (args.target_hours !== undefined && !(Number(args.target_hours) > 0)) fail("bad-arg", "estimate_power: target_hours must be a positive number", `got ${JSON.stringify(args.target_hours)}`, 'pass e.g. {"target_hours": 24}');
      for (const k of ["wakes_per_day", "awake_s"] as const) if (args[k] !== undefined && !(Number(args[k]) >= 0)) fail("bad-arg", `estimate_power: ${k} must be a number of 0 or more`, `got ${JSON.stringify(args[k])}`, `pass e.g. {"${k}": ${k === "awake_s" ? 2 : 30}}`);
      const live = s.liveSleep();
      const measured = live ? measuredSleep(live.log, live.t_ms) : undefined;
      const b = powerBudget(s.project, s.registry, s.firmwareSource(), { ...(duty ? { duty } : {}), ...(typeof args.target_hours === "number" ? { target_hours: args.target_hours } : {}), ...(typeof args.sleep === "string" ? { sleep: args.sleep as PowerProfile["sleep"] } : {}), ...(typeof args.wakes_per_day === "number" ? { wakes_per_day: args.wakes_per_day } : {}), ...(typeof args.awake_s === "number" ? { awake_s: args.awake_s } : {}) }, measured ? { measured } : {});
      x.summary(b.summary);
      return { ...b, next: b.assumptions.length ? "correct the guesses with set_power {duty: {...}} (saved in jumper.json power.duty), then check_design" : "check_design reports battery-life against power.target_hours" };
    },
    set_power(args, x) {
      const s = x.session;
      if (args.usb === undefined && args.target_hours === undefined && args.duty === undefined && args.sleep === undefined && args.wakes_per_day === undefined && args.awake_s === undefined) fail("bad-arg", "set_power needs usb, target_hours, duty or sleep", "nothing to change was given", 'pass {"usb": false} to run from the battery, or {"target_hours": 24, "duty": {"camera": "always"}}');
      if (args.usb === undefined) {
        // Round 14: the battery-life profile (target, duty cycles, sleep), an undoable edit
        const cur = { ...(s.project.power ?? {}) } as Record<string, unknown>;
        if (args.target_hours !== undefined) {
          if (args.target_hours === null) delete cur.target_hours;
          else if (!(Number(args.target_hours) > 0)) fail("bad-arg", "set_power: target_hours must be a positive number", `got ${JSON.stringify(args.target_hours)}`, 'pass e.g. {"target_hours": 24}, or null to remove it');
          else cur.target_hours = Number(args.target_hours);
        }
        if (args.duty !== undefined) {
          if (args.duty === null) delete cur.duty;
          else {
            for (const [k, d] of Object.entries(args.duty as Record<string, unknown>)) {
              const why = checkDuty(k, d);
              if (why) fail("bad-arg", `set_power: duty.${k} is not valid`, why, 'pass e.g. {"duty": {"camera": {"on_s": 2, "every_s": 600}}}');
            }
            cur.duty = { ...((cur.duty as object) ?? {}), ...(args.duty as object) };
          }
        }
        if (args.sleep !== undefined) {
          if (args.sleep === null) delete cur.sleep;
          else if (!["none", "light", "deep"].includes(String(args.sleep))) fail("bad-arg", `set_power: sleep '${String(args.sleep)}' is not a sleep mode`, "the modes are none, light and deep", 'pass {"sleep": "light"}');
          else cur.sleep = args.sleep;
        }
        for (const k of ["wakes_per_day", "awake_s"] as const) {
          if (args[k] === undefined) continue;
          if (args[k] === null) delete cur[k];
          else if (!(Number(args[k]) >= 0) || (k === "awake_s" && !(Number(args[k]) > 0))) fail("bad-arg", `set_power: ${k} must be a ${k === "awake_s" ? "positive number" : "number of 0 or more"}`, `got ${JSON.stringify(args[k])}`, `pass e.g. {"${k}": ${k === "awake_s" ? 2 : 30}}, or null to remove it`);
          else cur[k] = Number(args[k]);
        }
        x.commit("set_power profile", { ...s.project, power: cur as NonNullable<Project["power"]> });
        const b = powerBudget(s.project, s.registry, s.firmwareSource());
        x.summary(b.summary);
        return { power: cur, estimate: b };
      }
      if (typeof args.usb !== "boolean") fail("bad-arg", "set_power needs usb: true or false", `got ${JSON.stringify(args.usb)}`, 'pass {"usb": false} to run from the battery, {"usb": true} for a USB cable');
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
