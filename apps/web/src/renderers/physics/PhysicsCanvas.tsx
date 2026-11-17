// One <canvas> that repaints from a snapshot getter on every animation frame. Sized to its
// container (ResizeObserver) at device-pixel resolution; colours from the brand tokens.
import { useEffect, useRef } from "react";
import type { WorldSnapshot } from "@fabwright/physics";
import { readPalette, type Ctx2D, type View } from "./paint.ts";

export interface PhysicsCanvasProps {
  /** Latest world state (binding.snapshot), or undefined while nothing is attached. */
  getSnapshot: () => WorldSnapshot | undefined;
  paint: (ctx: Ctx2D, snap: WorldSnapshot, view: View, pal: ReturnType<typeof readPalette>) => void;
  /** Accessible name of the drawing, e.g. "Robot world, top view". */
  label: string;
  className?: string;
}

export function PhysicsCanvas({ getSnapshot, paint, label, className }: PhysicsCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let view: View = { width: canvas.clientWidth || 480, height: canvas.clientHeight || 320 };
    let pal = readPalette(canvas);
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      view = { width: canvas.clientWidth || 480, height: canvas.clientHeight || 320 };
      canvas.width = Math.round(view.width * dpr);
      canvas.height = Math.round(view.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pal = readPalette(canvas); // theme may have changed
    };
    resize();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : undefined;
    ro?.observe(canvas);
    let raf = 0;
    let lastT = -1;
    const frame = () => {
      const snap = getSnapshot();
      // Repaint only when virtual time moved (or on the first frame): idle sims cost nothing.
      if (snap && snap.tMs !== lastT) {
        lastT = snap.tMs;
        paint(ctx, snap, view, pal);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [getSnapshot, paint]);
  return <canvas ref={ref} className={className} role="img" aria-label={label} data-testid="physics-canvas" style={{ width: "100%", height: "100%", display: "block", background: "var(--bg)", borderRadius: "var(--radius)" }} />;
}
