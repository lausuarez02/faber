import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { engine } from "../lib/app.ts";
import { knobValue, type ControlKind } from "./controls.ts";
import { setHeld, useInteract } from "./store.ts";
import "./interact.css";

/**
 * The hit area over a part while the device runs (round 5): a pushbutton presses on pointer down
 * and releases on pointer up, a slide switch flips on click, a knob turns when dragged. It carries
 * React Flow's `nodrag nopan`, so the part never moves and the canvas never pans from here; with
 * the simulation stopped it is not rendered and the part drags as usual.
 */
export function PartControl({ id, kind }: { id: string; kind: ControlKind }) {
  const active = useInteract((s) => s.active);
  const held = useInteract((s) => !!s.held[id]);
  const value = useInteract((s) => s.values[id]?.position);
  const drag = useRef<{ x: number; y: number; start: number; raf: number; next: number } | undefined>(undefined);
  const [turning, setTurning] = useState(false);
  if (!active) return null;

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const press = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setHeld(id, true);
    engine.interact(id, "press");
  };
  const release = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!useInteract.getState().held[id]) return;
    setHeld(id, false);
    engine.interact(id, "release");
  };

  if (kind === "button") {
    return (
      <div
        className={`part-control nodrag nopan is-button ${held ? "is-held" : ""}`}
        data-testid={`control-${id}`}
        data-control="button"
        data-held={held}
        role="button"
        tabIndex={0}
        aria-pressed={held}
        aria-label={`Press ${id} (hold to keep it pressed)`}
        title={`Hold to press ${id}`}
        onPointerDown={press}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onClick={stop}
        onDoubleClick={stop}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            e.stopPropagation();
            setHeld(id, true);
            engine.interact(id, "press");
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.stopPropagation();
            setHeld(id, false);
            engine.interact(id, "release");
          }
        }}
      />
    );
  }

  const pos = Number(value ?? engine.liveValue(id, "position") ?? 0);
  if (kind === "toggle") {
    return (
      <div
        className="part-control nodrag nopan is-toggle"
        data-testid={`control-${id}`}
        data-control="toggle"
        data-value={pos}
        role="switch"
        tabIndex={0}
        aria-checked={pos >= 0.5}
        aria-label={`Flip ${id}`}
        title={`Click to flip ${id}`}
        onPointerDown={stop}
        onClick={(e) => {
          e.stopPropagation();
          engine.setLiveValue(id, "position", pos >= 0.5 ? 0 : 1);
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            engine.setLiveValue(id, "position", pos >= 0.5 ? 0 : 1);
          }
        }}
      />
    );
  }

  // knob
  const set = (v: number) => engine.setLiveValue(id, "position", Math.round(v * 1000) / 1000);
  return (
    <div
      className={`part-control nodrag nopan is-knob ${turning ? "is-turning" : ""}`}
      data-testid={`control-${id}`}
      data-control="knob"
      data-value={pos}
      role="slider"
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={pos}
      aria-label={`Turn ${id}`}
      title={`Drag to turn ${id} (right or up turns it up)`}
      onPointerDown={(e) => {
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
