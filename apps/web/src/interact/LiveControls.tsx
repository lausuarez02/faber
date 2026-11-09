import { useRef, useState } from "react";
import { ChevronDown, Move3d } from "lucide-react";
import type { PropSpec } from "@jumper/sim-core";
import { engine, useJumper } from "../lib/app.ts";
import { getDef } from "../lib/parts.ts";
import { isImu, sensorProps } from "./controls.ts";
import { playMotion, tilt, type ImuMotion } from "./imu.ts";
import { useInteract } from "./store.ts";
import "./interact.css";

/**
 * "Live controls" card while the device runs (round 5): a tilt pad with Shake / Drop / Spin for each
 * IMU, and a slider for what each sensor measures. Values go to the running simulation only.
 * Buttons and knobs are pressed and turned on the parts themselves (PartControl).
 */
export function LiveControls() {
  const active = useInteract((s) => s.active);
  const parts = useJumper((s) => s.project.parts);
  const [open, setOpen] = useState(true);
  if (!active) return null;
  const imus = parts.filter((p) => isImu(getDef(p.type)));
  const sensors = parts.map((p) => ({ part: p.id, props: sensorProps(getDef(p.type)) })).filter((x) => x.props.length);
  if (!imus.length && !sensors.length) return null;
  return (
    <section className={`ix-card ${open ? "" : "is-closed"}`} data-testid="live-controls" aria-label="Live controls">
      <header>
        <button type="button" className="ix-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span>Live controls</span>
          <span className="ix-dim">sets values in the running sim only</span>
          <ChevronDown size={14} strokeWidth={1.8} aria-hidden className="ix-chev" />
        </button>
      </header>
      {open ? (
        <div className="ix-body">
          {imus.map((p) => (
            <ImuPad key={p.id} part={p.id} />
          ))}
          {sensors.map((s) => (
            <div className="ix-group" key={s.part} data-testid={`sensor-${s.part}`}>
              <div className="ix-group-title mono">{s.part}</div>
              {s.props.map((prop) => (
                <SensorSlider key={prop.id} part={s.part} prop={prop} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SensorSlider({ part, prop }: { part: string; prop: PropSpec }) {
  const set = useInteract((s) => s.values[part]?.[prop.id]);
  const value = Number(set ?? engine.liveValue(part, prop.id) ?? prop.default);
  return (
    <label className="ix-slider">
      <span className="ix-label">{prop.label}</span>
      <input
        type="range"
        min={prop.min}
        max={prop.max}
        step={prop.step ?? (prop.max! - prop.min! > 50 ? 1 : 0.1)}
        value={value}
        data-testid={`sensor-${part}-${prop.id}`}
        onChange={(e) => engine.setLiveValue(part, prop.id, Number(e.target.value))}
      />
      <span className="ix-value mono">
        {+value.toFixed(2)}
        {prop.unit ? ` ${prop.unit}` : ""}
      </span>
    </label>
  );
}

const MAX_TILT = 60;

function ImuPad({ part }: { part: string }) {
  const [rest, setRest] = useState({ pitch: 0, roll: 0 });
  const pad = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const fromPointer = (x: number, y: number) => {
    const r = pad.current!.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, ((x - r.left) / r.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((y - r.top) / r.height) * 2 - 1));
    const next = { pitch: Math.round(-ny * MAX_TILT), roll: Math.round(nx * MAX_TILT) };
    setRest(next);
    tilt(part, next.pitch, next.roll);
  };
  const motion = (m: ImuMotion) => playMotion(part, m, rest);
  return (
    <div className="ix-group ix-imu" data-testid={`imu-${part}`}>
      <div className="ix-group-title">
        <Move3d size={13} strokeWidth={1.8} aria-hidden /> <span className="mono">{part}</span> <span className="ix-dim">drag to tilt</span>
      </div>
      <div className="ix-imu-row">
        <div
          ref={pad}
          className="ix-pad"
          data-testid={`imu-pad-${part}`}
          role="slider"
          aria-label={`Tilt ${part}: pitch ${rest.pitch}°, roll ${rest.roll}°`}
          aria-valuetext={`pitch ${rest.pitch}°, roll ${rest.roll}°`}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            dragging.current = true;
            fromPointer(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => dragging.current && fromPointer(e.clientX, e.clientY)}
          onPointerUp={() => (dragging.current = false)}
          onPointerCancel={() => (dragging.current = false)}
          onDoubleClick={() => {
            setRest({ pitch: 0, roll: 0 });
            tilt(part, 0, 0);
          }}
          onKeyDown={(e) => {
            const d = e.shiftKey ? 10 : 5;
            const next = { ...rest };
            if (e.key === "ArrowUp") next.pitch = Math.min(MAX_TILT, rest.pitch + d);
            else if (e.key === "ArrowDown") next.pitch = Math.max(-MAX_TILT, rest.pitch - d);
            else if (e.key === "ArrowRight") next.roll = Math.min(MAX_TILT, rest.roll + d);
            else if (e.key === "ArrowLeft") next.roll = Math.max(-MAX_TILT, rest.roll - d);
            else return;
            e.preventDefault();
            setRest(next);
            tilt(part, next.pitch, next.roll);
          }}
        >
          <span className="ix-pad-dot" style={{ left: `${50 + (rest.roll / MAX_TILT) * 50}%`, top: `${50 - (rest.pitch / MAX_TILT) * 50}%` }} />
        </div>
        <div className="ix-imu-side">
          <div className="ix-imu-read mono" data-testid={`imu-read-${part}`}>
            pitch {rest.pitch}° · roll {rest.roll}°
          </div>
          <div className="ix-imu-btns">
            <button type="button" className="ix-btn" data-testid={`imu-shake-${part}`} title="Approximate: 0.8 s of a 7 Hz, ±2.2 g side-to-side shake" onClick={() => motion("shake")}>
              Shake
            </button>
            <button type="button" className="ix-btn" data-testid={`imu-drop-${part}`} title="Approximate: 0.4 s of free fall (0 g), then a 6 g bump" onClick={() => motion("drop")}>
              Drop
            </button>
            <button type="button" className="ix-btn" data-testid={`imu-spin-${part}`} title="Approximate: 1 s at 360 °/s around Z" onClick={() => motion("spin")}>
              Spin
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
