import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Move3d } from "lucide-react";
import type { PropSpec } from "@jumper/sim-core";
import { engine, useJumper } from "../lib/app.ts";
import { getDef } from "../lib/parts.ts";
import { controlOf, isImu, MAX_TILT, MOTION_MS, SHAKE_DURATIONS_MS, sensorProps } from "./controls.ts";
import { playMotion, tilt, type ImuMotion } from "./imu.ts";
import { setArrange, useInteract } from "./store.ts";
import "./projectReset.ts";
import "./interact.css";

/**
 * "Live controls" card while the device runs (round 5; round 6 canvas track). Docked at the bottom
 * of the right column: the panel column ends above it (CSS `:root[data-ix-dock]`), so Serial, Agent
 * steps and the Inspector never cover it. Collapsible (remembered per browser).
 *   - Use / Arrange: what a click on a running part does (press / turn / tilt, or select and move).
 *   - A tilt pad with Shake (click = the set duration, hold = as long as held), Drop and Spin for
 *     each IMU; motions play on the simulation's virtual clock.
 *   - A slider for what each sensor measures.
 * Values go to the running simulation only.
 */

const COLLAPSE_KEY = "jumper.liveControls.collapsed";
const DURATION_KEY = "jumper.liveControls.shakeMs";

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // private window / blocked storage: the default comes back next time
  }
}

export function LiveControls() {
  const active = useInteract((s) => s.active);
  const parts = useJumper((s) => s.project.parts);
  if (!active) return null;
  const imus = parts.filter((p) => isImu(getDef(p.type)));
  const sensors = parts.map((p) => ({ part: p.id, props: sensorProps(getDef(p.type)) })).filter((x) => x.props.length);
  const controls = parts.filter((p) => controlOf(getDef(p.type)));
  if (!imus.length && !sensors.length && !controls.length) return null;
  return <Dock imus={imus.map((p) => p.id)} sensors={sensors} controls={controls.map((p) => ({ id: p.id, kind: controlOf(getDef(p.type))! }))} />;
}

function Dock({ imus, sensors, controls }: { imus: string[]; sensors: { part: string; props: PropSpec[] }[]; controls: { id: string; kind: string }[] }) {
  const [open, setOpen] = useState(() => readPref(COLLAPSE_KEY) !== "1");
  const arrange = useInteract((s) => s.arrange);
  const paused = useJumper((s) => s.run !== "running");
  const card = useRef<HTMLElement>(null);

  // Reserve the card's height at the bottom of the right column (the panel column ends above it).
  useLayoutEffect(() => {
    const el = card.current;
    const root = document.documentElement;
    if (!el) return;
    const apply = () => root.style.setProperty("--ix-dock-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    apply();
    root.dataset.ixDock = "";
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : undefined;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      delete root.dataset.ixDock;
      root.style.removeProperty("--ix-dock-h");
    };
  }, []);

  const toggle = () => {
    setOpen((o) => {
      writePref(COLLAPSE_KEY, o ? "1" : "0");
      return !o;
    });
  };
  const how = [
    controls.some((c) => c.kind === "button") ? "click a button's cap to press it" : "",
    controls.some((c) => c.kind === "toggle") ? "click a switch to flip it" : "",
    controls.some((c) => c.kind === "knob") ? "drag a knob to turn it" : "",
    imus.length ? `drag ${imus.length === 1 ? imus[0] : "an IMU"} to tilt it` : "",
  ].filter(Boolean);

  return (
    <section ref={card} className={`ix-card ${open ? "" : "is-closed"}`} data-testid="live-controls" data-open={open} aria-label="Live controls">
      <header className="ix-headrow">
        <button type="button" className="ix-head" onClick={toggle} aria-expanded={open} data-testid="live-controls-toggle">
          <ChevronDown size={14} strokeWidth={1.8} aria-hidden className="ix-chev" />
          <span>Live controls</span>
          {paused ? <span className="ix-dim ix-paused">paused</span> : null}
        </button>
        <span className="ix-mode" role="group" aria-label="What a click on a part does while it runs">
          <button type="button" aria-pressed={!arrange} data-testid="live-mode-use" title="Clicks press buttons, turn knobs and tilt IMUs" onClick={() => setArrange(false)}>
            Use
          </button>
          <button type="button" aria-pressed={arrange} data-testid="live-mode-arrange" title="Clicks select parts and drags move them, as when stopped" onClick={() => setArrange(true)}>
            Arrange
          </button>
        </span>
      </header>
      {open ? (
        <>
          <div className="ix-hint" data-testid="live-controls-hint">
            {arrange ? "Arrange: click selects a part, drag moves it. Use goes back to pressing and turning." : how.length ? `${cap(how.join(", "))}. Drag a part's label to move it.` : "Values here go to the running simulation only."}
          </div>
          {imus.length || sensors.length ? (
            <div className="ix-body">
              {imus.map((p) => (
                <ImuPad key={p} part={p} paused={paused} />
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
        </>
      ) : null}
    </section>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

function ImuPad({ part, paused }: { part: string; paused: boolean }) {
  const rest = useInteract((s) => s.tilt[part]) ?? { pitch: 0, roll: 0 };
  const playing = useInteract((s) => s.motion[part]);
  const [shakeMs, setShakeMs] = useState(() => {
    const v = Number(readPref(DURATION_KEY));
    return (SHAKE_DURATIONS_MS as readonly number[]).includes(v) ? v : MOTION_MS.shake;
  });
  const pad = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const shake = useRef<ReturnType<typeof playMotion> | undefined>(undefined);
  useEffect(() => () => shake.current?.release(), []);
  const fromPointer = (x: number, y: number) => {
    const r = pad.current!.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, ((x - r.left) / r.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((y - r.top) / r.height) * 2 - 1));
    tilt(part, Math.round(-ny * MAX_TILT), Math.round(nx * MAX_TILT));
  };
  const motion = (m: ImuMotion) => playMotion(part, m);
  const shakeDown = () => {
    shake.current = playMotion(part, "shake", { hold: true, durationMs: shakeMs });
  };
  const shakeUp = () => {
    shake.current?.release();
    shake.current = undefined;
  };
  return (
    <div className="ix-group ix-imu" data-testid={`imu-${part}`}>
      <div className="ix-group-title">
        <Move3d size={13} strokeWidth={1.8} aria-hidden /> <span className="mono">{part}</span> <span className="ix-dim">drag the pad or the part to tilt; hold Shake to keep shaking</span>
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
          onDoubleClick={() => tilt(part, 0, 0)}
          onKeyDown={(e) => {
            const d = e.shiftKey ? 10 : 5;
            const next = { ...rest };
            if (e.key === "ArrowUp") next.pitch = Math.min(MAX_TILT, rest.pitch + d);
            else if (e.key === "ArrowDown") next.pitch = Math.max(-MAX_TILT, rest.pitch - d);
            else if (e.key === "ArrowRight") next.roll = Math.min(MAX_TILT, rest.roll + d);
            else if (e.key === "ArrowLeft") next.roll = Math.max(-MAX_TILT, rest.roll - d);
            else return;
            e.preventDefault();
            tilt(part, next.pitch, next.roll);
          }}
        >
          <span className="ix-pad-dot" style={{ left: `${50 + (rest.roll / MAX_TILT) * 50}%`, top: `${50 - (rest.pitch / MAX_TILT) * 50}%` }} />
        </div>
        <div className="ix-imu-side">
          <div className="ix-imu-read mono" data-testid={`imu-read-${part}`}>
            pitch {rest.pitch}° · roll {rest.roll}°{playing ? ` · ${playing}` : ""}
          </div>
          <div className="ix-imu-btns">
            <button
              type="button"
              className={`ix-btn ${playing === "shake" ? "is-playing" : ""}`}
              data-testid={`imu-shake-${part}`}
              title={`Click: shake for ${shakeMs / 1000} s. Hold: shake for as long as you hold. Approximate: a 7 Hz, ±2.2 g looping shake with the wrist turning, on simulation time.`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                shakeDown();
              }}
              onPointerUp={shakeUp}
              onPointerCancel={shakeUp}
              onLostPointerCapture={shakeUp}
              onKeyDown={(e) => {
                if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                  e.preventDefault();
                  shakeDown();
                }
              }}
              onKeyUp={(e) => {
                if (e.key === " " || e.key === "Enter") shakeUp();
              }}
            >
              Shake
            </button>
            <DurationPicker
              part={part}
              value={shakeMs}
              onChange={(v) => {
                setShakeMs(v);
                writePref(DURATION_KEY, String(v));
              }}
            />
            <button type="button" className={`ix-btn ${playing === "drop" ? "is-playing" : ""}`} data-testid={`imu-drop-${part}`} title="Approximate: 0.4 s of free fall (0 g), then a 6 g bump, on simulation time" onClick={() => motion("drop")}>
              Drop
            </button>
            <button type="button" className={`ix-btn ${playing === "spin" ? "is-playing" : ""}`} data-testid={`imu-spin-${part}`} title="Approximate: 1 s at 360 °/s around Z, on simulation time" onClick={() => motion("spin")}>
              Spin
            </button>
          </div>
          {paused && playing ? <div className="ix-dim ix-paused">plays when the simulation runs</div> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Round 6b: how long a click on Shake shakes. A button that opens a small list (click, Enter, Space
 * or Alt+ArrowDown), and ArrowUp / ArrowDown on the closed button step through the lengths, like a
 * select whose list always shows in the page (the native one did not open for everyone).
 */
function DurationPicker({ part, value, onChange }: { part: string; value: number; onChange(v: number): void }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [at0, setAt0] = useState<{ left: number; bottom: number } | undefined>();
  const root = useRef<HTMLSpanElement>(null);
  const list = SHAKE_DURATIONS_MS as readonly number[];
  const at = Math.max(0, list.indexOf(value));
  const label = (ms: number) => `${ms / 1000} s`;
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  const show = () => {
    // Fixed to the window, above the button: the card's body scrolls and would clip the list.
    const r = root.current?.getBoundingClientRect();
    if (r) setAt0({ left: r.left, bottom: window.innerHeight - r.top + 4 });
    setHi(at);
    setOpen(true);
  };
  const pick = (i: number) => {
    onChange(list[i]!);
    setOpen(false);
  };
  const listId = `ix-dur-list-${part}`;
  return (
    <span className="ix-dur-wrap" ref={root}>
      <button
        type="button"
        className="ix-dur mono"
        aria-label={`Shake length for a click: ${label(value)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-testid={`imu-shake-ms-${part}`}
        data-value={value}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === "ArrowDown" && e.altKey) show();
            else if (e.key === "ArrowDown" || e.key === "ArrowRight") onChange(list[Math.min(list.length - 1, at + 1)]!);
            else if (e.key === "ArrowUp" || e.key === "ArrowLeft") onChange(list[Math.max(0, at - 1)]!);
            else if (e.key === "Home") onChange(list[0]!);
            else if (e.key === "End") onChange(list[list.length - 1]!);
            else return;
            e.preventDefault();
            return;
          }
          if (e.key === "ArrowDown") setHi((h) => Math.min(list.length - 1, h + 1));
          else if (e.key === "ArrowUp") setHi((h) => Math.max(0, h - 1));
          else if (e.key === "Home") setHi(0);
          else if (e.key === "End") setHi(list.length - 1);
          else if (e.key === "Enter" || e.key === " ") pick(hi);
          else if (e.key === "Escape" || e.key === "Tab") {
            setOpen(false);
            if (e.key === "Tab") return;
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {label(value)}
        <ChevronDown size={12} strokeWidth={1.8} aria-hidden />
      </button>
      {open ? (
        <ul className="ix-dur-list" style={at0} role="listbox" id={listId} aria-label="Shake length for a click" data-testid={`imu-shake-ms-list-${part}`}>
          {list.map((ms, i) => (
            <li
              key={ms}
              role="option"
              aria-selected={ms === value}
              className={i === hi ? "is-hi" : undefined}
              data-testid={`imu-shake-ms-${part}-${ms}`}
              onPointerMove={() => i !== hi && setHi(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <Check size={12} strokeWidth={2} aria-hidden style={{ visibility: ms === value ? "visible" : "hidden" }} />
              {label(ms)}
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
