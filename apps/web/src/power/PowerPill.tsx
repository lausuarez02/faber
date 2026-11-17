import { useEffect, useState } from "react";
import { BatteryMedium, Plug, PlugZap, Unplug } from "lucide-react";
import type { Project } from "@faber/project-format";
import { engine, useFaber } from "../lib/app.ts";
import { registry } from "../lib/parts.ts";
import { useIsPhone } from "../lib/ui.ts";
import "./power.css";

/**
 * Round 6, track "power" (owner): the board's USB cable as a switch (faber.json power.usb, decision
 * 0004 R2). Shown for projects with a battery or with USB already unplugged. Unplugging while it runs
 * is a power cut: the firmware stops unless the battery path powers the board; plugging back in boots
 * it from reset. While it runs it shows what powers the board and the battery's volts, current and
 * time left at that current.
 */

const BATTERIES = new Set(["lipo-battery", "battery-pack"]);

interface Reading {
  powered: boolean;
  volts?: number;
  ma?: number;
  hours?: number;
}

function boardOf(p: Project) {
  return p.parts.find((x) => x.id === p.firmware?.board) ?? p.parts.find((x) => registry.get(x.type)?.spec.category === "board");
}

/** Read the running simulation (no React in the frame loop: polled a few times a second). */
function read(p: Project): Reading | undefined {
  const sim = engine.simulation;
  const board = boardOf(p);
  if (!sim || !board) return undefined;
  const b = sim.partState(board.id) ?? {};
  const bat = p.parts.find((x) => BATTERIES.has(x.type));
  const s = bat ? (sim.partState(bat.id) ?? {}) : {};
  const ma = typeof s.currentmA === "number" ? s.currentmA : undefined;
  const volts = typeof s.volts === "number" ? s.volts : undefined;
  const soc = typeof s.soc === "number" ? s.soc : undefined;
  const cap = Number(bat?.props?.capacity ?? 500);
  const hours = bat?.type === "lipo-battery" && ma !== undefined && ma > 0.5 && soc !== undefined ? (cap * soc) / 100 / ma : undefined;
  return { powered: b.powered !== false, ...(volts !== undefined ? { volts } : {}), ...(ma !== undefined ? { ma } : {}), ...(hours !== undefined ? { hours } : {}) };
}

export function setUsb(usb: boolean): void {
  useFaber.getState().commit((p) => ({ ...p, power: { ...p.power, usb } }));
  // Live in a running simulation; a new run picks it up from the project anyway.
  engine.simulation?.setPower({ usb });
}

export function PowerPill() {
  const project = useFaber((s) => s.project);
  const run = useFaber((s) => s.run);
  const phone = useIsPhone();
  const [reading, setReading] = useState<Reading | undefined>(undefined);
  const hasBattery = project.parts.some((x) => BATTERIES.has(x.type));
  const usb = project.power?.usb !== false;
  const show = !!boardOf(project) && (hasBattery || !usb);

  useEffect(() => {
    if (!show) return;
    const tick = () => setReading(read(useFaber.getState().project));
    tick();
    const t = setInterval(tick, 300);
    return () => clearInterval(t);
  }, [show, run, project]);

  if (!show) return null;
  const following = engine.isExternal && !engine.isLocalRun;
  const title = following
    ? "This is the agent's project: ask it to call set_power, or press Run it here to try it yourself."
    : usb
      ? "A USB cable is plugged into the board. Click to unplug it: the device then runs only from its battery path."
      : "No USB cable: the device runs only from its battery path. Click to plug USB in.";
  const unpowered = reading && !reading.powered;
  return (
    <div className={`power-pill${phone ? " is-phone" : ""}${unpowered ? " is-off" : ""}`} data-testid="power-pill" data-usb={usb ? "plugged" : "unplugged"} data-powered={reading ? String(reading.powered) : "unknown"}>
      <button type="button" className="power-usb" role="switch" aria-checked={usb} aria-label={usb ? "USB plugged in" : "USB unplugged"} title={title} disabled={following} onClick={() => setUsb(!usb)} data-testid="power-usb">
        {usb ? <Plug size={15} strokeWidth={2} aria-hidden /> : <Unplug size={15} strokeWidth={2} aria-hidden />}
        <span>{usb ? "USB" : "No USB"}</span>
      </button>
      <span className="power-div" aria-hidden />
      <span className="power-read mono" data-testid="power-reading">
        {unpowered ? (
          <>
            <PlugZap size={14} strokeWidth={2} aria-hidden /> no power
          </>
        ) : reading && reading.volts !== undefined ? (
          <>
            <BatteryMedium size={14} strokeWidth={2} aria-hidden /> {reading.volts.toFixed(2)} V
            {reading.ma !== undefined && reading.ma > 0.5 ? ` · ${Math.round(reading.ma)} mA` : reading.ma !== undefined && reading.ma < -0.5 ? ` · charging ${Math.round(-reading.ma)} mA` : ""}
            {reading.hours !== undefined ? ` · ~${reading.hours >= 10 ? Math.round(reading.hours) : reading.hours.toFixed(1)} h` : ""}
          </>
        ) : (
          <>{usb ? "on USB" : "battery only"}</>
        )}
      </span>
    </div>
  );
}
