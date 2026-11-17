import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { engine, useFaber } from "../lib/app.ts";
import { CONTROL_SELECTORS, controlHitRect, knobValue, tiltFromDrag, type ControlKind, type Rect } from "./controls.ts";
import { tilt } from "./imu.ts";
import { pressPart, releasePart } from "./press.ts";
import { useInteract } from "./store.ts";
import "./interact.css";

/**
 * The hit area over a running part's control (round 5; round 6 canvas track). It covers only the
 * cap / lever / knob / touch pad, found in the part's drawing (controlHitRect), so:
 *   - a click on a pushbutton cap presses it (pointer down) and releases it (pointer up, after at
 *     least MIN_PRESS_MS: see press.ts); the cap is drawn pressed meanwhile;
 *   - a slide switch flips on click, a knob turns when dragged;
 *   - the rest of the part (and its label) selects and drags the part as usual, past React Flow's
 *     drag threshold.
 * It carries React Flow's `nodrag nopan`. Not rendered when the simulation is stopped or the person
 * picked "Arrange" in the Live controls card.
 */
export function PartControl({ id, kind, box, name }: { id: string; kind: ControlKind; box: { w: number; h: number }; name: string }) {
  const active = useInteract((s) => s.active);
  const arrange = useInteract((s) => s.arrange);
  if (!active || arrange) return null;
  return <ControlArea id={id} kind={kind} box={box} name={name} />;
}

function useHitRect(kind: ControlKind, box: { w: number; h: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect>(() => controlHitRect(undefined, box));
  useLayoutEffect(() => {
    const host = ref.current?.closest<HTMLElement>(".part");
    const svg = host?.querySelector(".part-svg");
    if (!host || !svg) return;
    const hr = host.getBoundingClientRect();
    const zoom = hr.width / box.w || 1;
    let found: Rect | undefined;
    for (const el of svg.querySelectorAll(CONTROL_SELECTORS[kind])) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue; // hidden (e.g. a "pressed" ring that is display:none)
      found = { x: (r.left - hr.left) / zoom, y: (r.top - hr.top) / zoom, w: r.width / zoom, h: r.height / zoom };
      break;
    }
    setRect(controlHitRect(found, box));
  }, [kind, box.w, box.h]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ref, rect };
}

function ControlArea({ id, kind, box, name }: { id: string; kind: ControlKind; box: { w: number; h: number }; name: string }) {
  const held = useInteract((s) => !!s.held[id]);
  const value = useInteract((s) => s.values[id]?.position);
  const drag = useRef<{ x: number; y: number; start: number; raf: number; next: number } | undefined>(undefined);
  const [turning, setTurning] = useState(false);
  const { ref, rect } = useHitRect(kind, box);
  const style: CSSProperties = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  if (kind === "button") {
    const down = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      pressPart(id);
    };
    const up = (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (useInteract.getState().held[id]) releasePart(id);
    };
    return (
      <div
        ref={ref}
        className={`part-control nodrag nopan is-button ${held ? "is-held" : ""}`}
        style={style}
        data-testid={`control-${id}`}
        data-control="button"
        data-held={held}
        role="button"
        tabIndex={0}
        aria-pressed={held}
        aria-label={`Press ${id} (${name})`}
        title={`${id} · ${name}\nClick to press, hold to keep it pressed. Drag the part's body or label to move it.`}
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
        onClick={stop}
        onDoubleClick={stop}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            e.stopPropagation();
            pressPart(id);
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.stopPropagation();
            releasePart(id);
          }
        }}
      />
    );
  }

  const pos = Number(value ?? engine.liveValue(id, "position") ?? 0);
  if (kind === "toggle") {
    const flip = () => engine.setLiveValue(id, "position", pos >= 0.5 ? 0 : 1);
    return (
      <div
        ref={ref}
        className="part-control nodrag nopan is-toggle"
        style={style}
        data-testid={`control-${id}`}
        data-control="toggle"
        data-value={pos}
        role="switch"
        tabIndex={0}
        aria-checked={pos >= 0.5}
        aria-label={`Flip ${id} (${name})`}
        title={`${id} · ${name}\nClick to flip. Drag the part's body or label to move it.`}
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          flip();
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            flip();
          }
        }}
      />
    );
  }

  // knob
  const set = (v: number) => engine.setLiveValue(id, "position", Math.round(v * 1000) / 1000);
  return (
    <div
      ref={ref}
      className={`part-control nodrag nopan is-knob ${turning ? "is-turning" : ""}`}
      style={style}
      data-testid={`control-${id}`}
      data-control="knob"
      data-value={pos}
      role="slider"
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={pos}
      aria-label={`Turn ${id} (${name})`}
      title={`${id} · ${name}\nDrag to turn (right or up turns it up). Drag the part's body or label to move it.`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, start: pos, raf: 0, next: pos };
        setTurning(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        e.stopPropagation();
        d.next = knobValue(d.start, e.clientX - d.x, e.clientY - d.y);
        if (!d.raf)
          d.raf = requestAnimationFrame(() => {
            d.raf = 0;
            set(d.next);
          });
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        const d = drag.current;
        if (d) {
          cancelAnimationFrame(d.raf);
          set(d.next);
        }
        drag.current = undefined;
        setTurning(false);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setTurning(false);
      }}
      onClick={stop}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") set(Math.min(1, pos + step));
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(Math.max(0, pos - step));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {turning ? <span className="part-control-badge mono">{Math.round(pos * 100)}%</span> : null}
    </div>
  );
}

/**
 * Round 6: an IMU part while the device runs. Dragging its body tilts it (right rolls right, up
 * pitches the nose up; the Live controls pad follows); a click without a drag selects it. Its label
 * stays a drag handle, and "Arrange" in the Live controls card moves it like any part.
 */
export function ImuSurface({ id, name }: { id: string; name: string }) {
  const active = useInteract((s) => s.active);
  const arrange = useInteract((s) => s.arrange);
  const t = useInteract((s) => s.tilt[id]);
  const drag = useRef<{ x: number; y: number; start: { pitch: number; roll: number }; moved: boolean } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  if (!active || arrange) return null;
  return (
    <div
      className={`part-control nodrag nopan is-imu ${dragging ? "is-turning" : ""}`}
      style={{ inset: 0 }}
      data-testid={`control-${id}`}
      data-control="imu"
      role="slider"
      aria-label={`Tilt ${id} (${name}): pitch ${t?.pitch ?? 0}°, roll ${t?.roll ?? 0}°`}
      aria-valuetext={`pitch ${t?.pitch ?? 0}°, roll ${t?.roll ?? 0}°`}
      tabIndex={-1}
      title={`${id} · ${name}\nDrag to tilt it. Drag its label (or pick Arrange in Live controls) to move it.`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, start: useInteract.getState().tilt[id] ?? { pitch: 0, roll: 0 }, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        e.stopPropagation();
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        if (!d.moved) setDragging(true);
        d.moved = true;
        const next = tiltFromDrag(d.start, dx, dy);
        tilt(id, next.pitch, next.roll);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        const d = drag.current;
        drag.current = undefined;
        setDragging(false);
        if (d && !d.moved) useFaber.getState().select([id], []);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setDragging(false);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {dragging ? (
        <span className="part-control-badge mono">
          pitch {t?.pitch ?? 0}° · roll {t?.roll ?? 0}°
        </span>
      ) : null}
    </div>
  );
}
