// Filmstrip thumbnails: the device at one moment of a test, drawn from the captured snapshot.
//   screen  → the display's pixels (same painter as the canvas)
//   robot   → the arena from above with the robot, its sonar ray and the path so far
//   arm     → side view of the links
//   else    → LEDs / buzzer / buttons as dots
import { useEffect, useMemo, useRef } from "react";
import type { Project } from "@fabwright/project-format";
import { armPose, parseWorld, type WorldSpec } from "@fabwright/physics";
import { base64ToBytes, rgb565ToRgb } from "@fabwright/sim-core";
import { painterFor } from "../../renderers/displays/paint.ts";
import { screenTypeOf } from "../device/classify.ts";
import type { DeviceSnapshot } from "./types.ts";

export const THUMB_W = 128;
export const THUMB_H = 64;

export function useWorldSpec(project: Project): WorldSpec | undefined {
  return useMemo(() => {
    if (!project.world) return undefined;
    try {
      return parseWorld(project.world, project);
    } catch {
      return undefined;
    }
  }, [project]);
}

export function thumbKind(s: DeviceSnapshot): "robot" | "arm" | "screen" | "io" {
  if (s.robot) return "robot";
  if (s.arm) return "arm";
  if (s.displays && Object.keys(s.displays).length) return "screen";
  return "io";
}

/** The page theme (data-theme on <html>, else the OS preference). */
export function isDarkTheme(): boolean {
  if (typeof document === "undefined") return true;
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light") return false;
  if (t === "dark") return true;
  return !(typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches);
}

export function FrameThumb({ snap, world, path, dark = isDarkTheme(), width = THUMB_W, height = THUMB_H }: { snap: DeviceSnapshot; world?: WorldSpec | undefined; path?: { x: number; y: number }[]; dark?: boolean; width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const kind = thumbKind(snap);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    if (kind === "screen") drawScreen(g, snap, width, height);
    else if (kind === "robot" && world) drawRobot(g, snap, world, path ?? [], width, height, dark);
    else if (kind === "arm" && world?.arm) drawArm(g, snap, world, width, height, dark);
    else drawIo(g, snap, width, height, dark);
  }, [snap, world, path, kind, width, height, dark]);
  return <canvas ref={ref} className={`vt-thumb vt-thumb-${kind}`} style={{ width, height }} aria-hidden />;
}

function drawScreen(g: CanvasRenderingContext2D, snap: DeviceSnapshot, w: number, h: number): void {
  const [, d] = Object.entries(snap.displays ?? {})[0]!;
  let img: { width: number; height: number; data: Uint8ClampedArray };
  if (typeof d.state.thumb === "string") {
    // Colour panel: a small RGB565 thumbnail captured by the session.
    const tw = Number(d.state.thumbW);
    const th = Number(d.state.thumbH);
    const src = base64ToBytes(d.state.thumb);
    const data = new Uint8ClampedArray(tw * th * 4);
    for (let i = 0; i < tw * th; i++) {
      const [r, gg, b] = rgb565ToRgb(src[i * 2]! | (src[i * 2 + 1]! << 8));
      data[i * 4] = r;
      data[i * 4 + 1] = gg;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }
    img = { width: tw, height: th, data };
  } else {
    const screen = screenTypeOf(d.type)?.screen ?? "128x64";
    const paint = painterFor(screen)!;
    img = paint(d.state);
  }
  const off = document.createElement("canvas");
  off.width = img.width;
  off.height = img.height;
  const og = off.getContext("2d")!;
  const id = og.createImageData(img.width, img.height);
  id.data.set(img.data);
  og.putImageData(id, 0, 0);
  g.fillStyle = "#050709";
  g.fillRect(0, 0, w, h);
  const s = Math.min(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  g.imageSmoothingEnabled = false;
  g.drawImage(off, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function drawRobot(g: CanvasRenderingContext2D, snap: DeviceSnapshot, world: WorldSpec, path: { x: number; y: number }[], w: number, h: number, dark: boolean): void {
  const pad = 6;
  const A = world.arena;
  const s = Math.min((w - pad * 2) / A.width, (h - pad * 2) / A.height);
  const ox = (w - A.width * s) / 2;
  const oy = (h - A.height * s) / 2;
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy + y * s;
  g.fillStyle = dark ? "#1b1b1b" : "#ececea";
  g.fillRect(X(0), Y(0), A.width * s, A.height * s);
  g.strokeStyle = dark ? "#3a3a3a" : "#c9c9c6";
  g.lineWidth = 1;
  g.strokeRect(X(0) + 0.5, Y(0) + 0.5, A.width * s - 1, A.height * s - 1);
  g.fillStyle = dark ? "#4a4a4a" : "#bdbdb9";
  for (const o of world.obstacles) {
    if (o.shape === "circle") {
      g.beginPath();
      g.arc(X(o.x), Y(o.y), o.r * s, 0, Math.PI * 2);
      g.fill();
    } else {
      g.save();
      g.translate(X(o.x), Y(o.y));
      g.rotate(((o.angle ?? 0) * Math.PI) / 180);
      g.fillRect((-o.w / 2) * s, (-o.h / 2) * s, o.w * s, o.h * s);
      g.restore();
    }
  }
  g.strokeStyle = dark ? "#4a4a4a" : "#bdbdb9";
  g.lineWidth = 2;
  for (const wl of world.walls) {
    g.beginPath();
    g.moveTo(X(wl.x1), Y(wl.y1));
    g.lineTo(X(wl.x2), Y(wl.y2));
    g.stroke();
  }
  const r = snap.robot!;
  if (path.length > 1) {
    g.strokeStyle = "rgba(61, 220, 151, 0.75)";
    g.lineWidth = 1.25;
    g.beginPath();
    path.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))));
    g.lineTo(X(r.x), Y(r.y));
    g.stroke();
  }
  const a = (r.heading * Math.PI) / 180;
  if (r.sonar_cm !== undefined && r.sonar_cm > 0) {
    g.strokeStyle = r.sonar_cm < 25 ? "rgba(245,165,36,0.9)" : "rgba(180,240,210,0.55)";
    g.setLineDash([2, 2]);
    g.beginPath();
    g.moveTo(X(r.x), Y(r.y));
    g.lineTo(X(r.x + Math.cos(a) * r.sonar_cm), Y(r.y + Math.sin(a) * r.sonar_cm));
    g.stroke();
    g.setLineDash([]);
  }
  g.save();
  g.translate(X(r.x), Y(r.y));
  g.rotate(a);
  const L = Math.max(7, 20 * s);
  const Wd = Math.max(5, 15 * s);
  g.fillStyle = dark ? "#f5f5f5" : "#0a0a0a";
  g.beginPath();
  g.moveTo(L / 2, 0);
  g.lineTo(-L / 2, -Wd / 2);
  g.lineTo(-L / 3, 0);
  g.lineTo(-L / 2, Wd / 2);
  g.closePath();
  g.fill();
  g.restore();
}

function drawArm(g: CanvasRenderingContext2D, snap: DeviceSnapshot, world: WorldSpec, w: number, h: number, dark: boolean): void {
  const spec = world.arm!;
  const pose = armPose(spec, snap.arm!.angles);
  const reach = spec.links.reduce((a, b) => a + b, 0);
  const s = Math.min(w / (reach * 2.1), (h - 8) / (reach + spec.base.y + 2));
  const ox = w / 2 - spec.base.x * s - reach * 0.15 * s;
  const oy = h - 6;
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy - y * s;
  g.strokeStyle = dark ? "#3a3a3a" : "#c9c9c6";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, oy + 0.5);
  g.lineTo(w, oy + 0.5);
  g.stroke();
  for (const t of spec.targets) {
    const hit = snap.arm!.reached.includes(t.id);
    g.fillStyle = hit ? "rgba(61,220,151,0.9)" : dark ? "#5a5a5a" : "#bdbdb9";
    g.beginPath();
    g.arc(X(t.x), Y(t.y), Math.max(2.5, t.r * s), 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = dark ? "#f0f0f0" : "#111";
  g.lineWidth = 3;
  g.lineCap = "round";
  g.beginPath();
  pose.points.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))));
  g.stroke();
  g.fillStyle = "#2a5bd7";
  for (const p of pose.points.slice(0, -1)) {
    g.beginPath();
    g.arc(X(p.x), Y(p.y), 3.2, 0, Math.PI * 2);
    g.fill();
  }
}

function drawIo(g: CanvasRenderingContext2D, snap: DeviceSnapshot, w: number, h: number, dark: boolean): void {
  const items: { color: string; on: boolean }[] = [];
  for (const l of Object.values(snap.leds ?? {})) items.push({ color: ledHex(l.color), on: l.brightness > 0.05 });
  for (const b of Object.values(snap.buzzers ?? {})) items.push({ color: "#ffffff", on: b });
  for (const b of Object.values(snap.buttons ?? {})) items.push({ color: "#b4b4b4", on: b });
  const n = Math.max(1, items.length);
  const gap = Math.min(28, (w - 20) / n);
  items.forEach((it, i) => {
    const x = w / 2 - ((n - 1) * gap) / 2 + i * gap;
    const y = h / 2;
    if (it.on) {
      const grad = g.createRadialGradient(x, y, 0, x, y, 14);
      grad.addColorStop(0, it.color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, 14, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = it.on ? it.color : dark ? "#2a2a2a" : "#d9d9d9";
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
  });
}

function ledHex(c: string | undefined): string {
  const m: Record<string, string> = { red: "#ff3b30", green: "#3ddc97", blue: "#4da3ff", yellow: "#ffd43b", white: "#ffffff", orange: "#ff8a1f" };
  return (c && (m[c.toLowerCase()] ?? (c.startsWith("#") ? c : undefined))) ?? "#ff3b30";
}
