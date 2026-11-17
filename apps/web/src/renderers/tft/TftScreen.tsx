// A standalone, enlarged view of a TFT part's screen (for a device panel or the network view's
// preview), redrawn on animation frames from the live frame, only where it changed.
import { useEffect, useRef } from "react";
import type { ColorFrame } from "@faber/sim-core";
import { TftPainter } from "./index.ts";

export interface TftScreenProps {
  /** Reads the current frame, e.g. () => sim.framebuffer("tft"). */
  frame: () => ColorFrame | undefined;
  /** Backlight 0..1 (the part's visualState.backlight). */
  backlight?: () => number;
  /** CSS width; height follows the aspect ratio. Default 100%. */
  width?: number | string;
  className?: string;
  label?: string;
  /** Round glass (GC9A01): clip the canvas to a circle. */
  round?: boolean;
}

export function TftScreen({ frame, backlight, width = "100%", className, label, round = false }: TftScreenProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    let painter: TftPainter | undefined;
    let image: ImageData | undefined;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const canvas = ref.current;
      const f = frame();
      if (!canvas || !f) return;
      if (!painter || painter.width !== f.width || painter.height !== f.height) {
        painter = new TftPainter(f.width, f.height);
        canvas.width = f.width;
        canvas.height = f.height;
        image = undefined;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      image ??= ctx.createImageData(f.width, f.height);
      const rect = painter.update(f);
      const bl = backlight?.() ?? 1;
      canvas.style.filter = bl >= 0.999 ? "" : `brightness(${Math.max(0.04, bl).toFixed(3)})`;
      if (!rect) return;
      image.data.set(painter.rgba);
      ctx.putImageData(image, 0, 0, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frame, backlight]);
  // Height follows the canvas's own width / height (the frame size), so 4:3, 4:5 and 1:1 panels all fit.
  return (
    <canvas
      ref={ref}
      className={className}
      aria-label={label ?? "Simulated colour screen"}
      role="img"
      style={{ width, height: "auto", imageRendering: "pixelated", display: "block", background: "#05070a", borderRadius: round ? "50%" : 6 }}
    />
  );
}
