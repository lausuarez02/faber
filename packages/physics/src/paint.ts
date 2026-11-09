// Canvas 2D painters for the physics world (top view) and the robot arm (side view). Pure
// functions of a WorldSnapshot: no React, no simulation access, so they are cheap to call every
// animation frame and easy to test with a recording context.
import type { WorldSnapshot } from "./binding.ts";

/** Brand colours, read from the CSS tokens (brand/tokens.css) so light/dark themes just work. */
export interface Palette {
  bg: string;
  panel: string;
  line: string;
  grid: string;
  text: string;
  muted: string;
  wire: string;
  live: string;
  warn: string;
  data: string;
  mono: string;
}

const FALLBACK: Palette = {
  bg: "#0d0f12",
  panel: "#15181d",
  line: "#262b33",
  grid: "#2a3039",
  text: "#e9edf2",
  muted: "#8a93a0",
  wire: "#ff4d2e",
  live: "#5cf2a1",
  warn: "#ffb23f",
  data: "#4da3ff",
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

export function readPalette(el?: Element | null): Palette {
  if (!el || typeof getComputedStyle !== "function") return FALLBACK;
  const cs = getComputedStyle(el);
  const v = (name: string, d: string) => cs.getPropertyValue(name).trim() || d;
  return {
    bg: v("--bg", FALLBACK.bg),
    panel: v("--panel", FALLBACK.panel),
    line: v("--line", FALLBACK.line),
    grid: v("--grid-dot", FALLBACK.grid),
    text: v("--text", FALLBACK.text),
    muted: v("--muted", FALLBACK.muted),
    wire: v("--wire", FALLBACK.wire),
    live: v("--live", FALLBACK.live),
    warn: v("--warn", FALLBACK.warn),
    data: v("--data", FALLBACK.data),
    mono: v("--font-mono", FALLBACK.mono),
  };
}

/** The subset of CanvasRenderingContext2D the painters use (so tests can pass a recorder). */
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | "save" | "restore" | "translate" | "rotate" | "scale" | "beginPath" | "moveTo" | "lineTo" | "arc" | "rect" | "closePath"
  | "fill" | "stroke" | "fillRect" | "strokeRect" | "fillText" | "setLineDash"
> & {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  font: string;
  globalAlpha: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  /** Optional: used to keep text inside small views. */
  measureText?: (text: string) => { width: number };
};

export interface View {
  /** CSS pixels of the drawing area. */
  width: number;
  height: number;
}

/** World cm → canvas px transform that fits the arena with a margin. */
export function fitArena(arena: { width: number; height: number }, view: View, margin = 16): { scale: number; ox: number; oy: number } {
  // Room under the arena for the stats line (two lines in narrow views).
  const foot = view.width < 520 ? 34 : 20;
  const scale = Math.max(0.01, Math.min((view.width - 2 * margin) / arena.width, (view.height - 2 * margin - foot) / arena.height));
  return { scale, ox: (view.width - arena.width * scale) / 2, oy: (view.height - foot - arena.height * scale) / 2 };
}

/** Top view: floor grid, walls, obstacles, trail, sonar cone, robot, stats line. */
export function drawWorld(ctx: Ctx2D, snap: WorldSnapshot, view: View, pal: Palette = FALLBACK): void {
  const { scale: s, ox, oy } = fitArena(snap.arena, view);
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy + y * s;
  ctx.save();
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, view.width, view.height);

  // floor: 10 cm dot grid, like the canvas
  ctx.fillStyle = pal.panel;
  ctx.fillRect(X(0), Y(0), snap.arena.width * s, snap.arena.height * s);
  ctx.fillStyle = pal.grid;
  const step = 10;
  for (let x = step; x < snap.arena.width; x += step) for (let y = step; y < snap.arena.height; y += step) ctx.fillRect(X(x) - 0.75, Y(y) - 0.75, 1.5, 1.5);

  // walls
  ctx.strokeStyle = pal.muted;
  ctx.lineWidth = Math.max(2, snap.arena.wallThickness * s);
  if (snap.arena.enclosed) ctx.strokeRect(X(0), Y(0), snap.arena.width * s, snap.arena.height * s);
  for (const w of snap.walls) {
    ctx.lineWidth = Math.max(2, w.thickness * s);
    ctx.beginPath();
    ctx.moveTo(X(w.x1), Y(w.y1));
    ctx.lineTo(X(w.x2), Y(w.y2));
    ctx.stroke();
  }

  // obstacles (touched ones in --warn)
  const touching = new Set(snap.robot?.touching ?? []);
  snap.obstacles.forEach((o, i) => {
    const id = o.id ?? `obstacles[${i}]`;
    ctx.fillStyle = touching.has(id) ? pal.warn : pal.line;
    ctx.strokeStyle = touching.has(id) ? pal.warn : pal.muted;
    ctx.lineWidth = 1.5;
    if (o.shape === "circle") {
      ctx.beginPath();
      ctx.arc(X(o.x), Y(o.y), o.r * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.save();
      ctx.translate(X(o.x), Y(o.y));
      ctx.rotate((o.angle * Math.PI) / 180);
      ctx.fillRect((-o.w / 2) * s, (-o.h / 2) * s, o.w * s, o.h * s);
      ctx.strokeRect((-o.w / 2) * s, (-o.h / 2) * s, o.w * s, o.h * s);
      ctx.restore();
    }
  });

  // trail
  if (snap.trail.length > 1) {
    ctx.strokeStyle = pal.data;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    snap.trail.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.x), Y(p.y)) : ctx.lineTo(X(p.x), Y(p.y))));
    if (snap.robot) ctx.lineTo(X(snap.robot.pose.x), Y(snap.robot.pose.y));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const r = snap.robot;
  if (r) {
    // IR obstacle beams: thin, warm, solid when they see something
    for (const b of r.ir ?? []) {
      ctx.strokeStyle = pal.warn;
      ctx.lineWidth = 1;
      ctx.globalAlpha = b.distanceCm > 0 ? 0.9 : 0.35;
      ctx.beginPath();
      ctx.moveTo(X(b.from.x), Y(b.from.y));
      ctx.lineTo(X(b.to.x), Y(b.to.y));
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (b.distanceCm > 0) {
        ctx.fillStyle = pal.warn;
        ctx.beginPath();
        ctx.arc(X(b.to.x), Y(b.to.y), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // sonar cone + centre ray
    if (r.sonar) {
      const so = r.sonar;
      ctx.fillStyle = pal.live;
      ctx.globalAlpha = 0.12;
      ctx.beginPath();
      ctx.moveTo(X(so.from.x), Y(so.from.y));
      for (const p of so.rays) ctx.lineTo(X(p.x), Y(p.y));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.live;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(X(so.from.x), Y(so.from.y));
      ctx.lineTo(X(so.to.x), Y(so.to.y));
      ctx.stroke();
      ctx.setLineDash([]);
      if (so.distanceCm > 0) {
        ctx.fillStyle = pal.live;
        ctx.beginPath();
        ctx.arc(X(so.to.x), Y(so.to.y), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // body, wheels, front marker
    ctx.save();
    ctx.translate(X(r.pose.x), Y(r.pose.y));
    ctx.rotate((r.pose.heading * Math.PI) / 180);
    const L = r.length * s;
    const W = r.width * s;
    ctx.fillStyle = pal.panel;
    ctx.strokeStyle = r.touching.length ? pal.warn : pal.text;
    ctx.lineWidth = 2;
    ctx.fillRect(-L / 2, -W / 2, L, W);
    ctx.strokeRect(-L / 2, -W / 2, L, W);
    const wheelL = Math.max(4, 6.5 * s);
    const wheelW = Math.max(2, 2.6 * s);
    const ax = r.axleOffset * s;
    const half = (r.trackWidth / 2) * s;
    ctx.fillStyle = pal.muted;
    for (const sy of [-1, 1]) ctx.fillRect(ax - wheelL / 2, sy * half - wheelW / 2, wheelL, wheelW);
    ctx.fillStyle = pal.wire;
    ctx.beginPath();
    ctx.moveTo(L / 2, 0);
    ctx.lineTo(L / 2 - Math.max(5, 4 * s), -Math.max(4, 3 * s));
    ctx.lineTo(L / 2 - Math.max(5, 4 * s), Math.max(4, 3 * s));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // stats line
  const st = snap.stats;
  ctx.fillStyle = st.collisions > 0 ? pal.warn : pal.muted;
  ctx.font = `11px ${pal.mono}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const parts = [`t ${st.timeS.toFixed(1)} s`, `collisions ${st.collisions}`];
  if (Number.isFinite(st.minClearanceCm)) parts.push(`min gap ${st.minClearanceCm.toFixed(1)} cm`);
  parts.push(`travelled ${(st.travelledCm / 100).toFixed(2)} m`);
  if (r?.sonar) parts.push(`sonar ${r.sonar.distanceCm > 0 ? `${r.sonar.distanceCm.toFixed(0)} cm` : "no echo"}`);
  const bumped = (r?.bumpers ?? []).filter((b) => b.pressed).length;
  if (r?.bumpers?.length) parts.push(`bump ${bumped ? `${bumped} pressed` : "free"}`);
  // Small panels (the replay's World card): tighten the separators, then wrap onto two lines, so the
  // numbers are never cut off at the right edge.
  // Line the stats up with the arena's left edge, not the view's.
  const tx = Math.max(12, Math.round(ox));
  const room = view.width - tx - 12;
  const fits = (t: string) => !ctx.measureText || ctx.measureText(t).width <= room;
  const wide = parts.join("  ·  ");
  const tight = parts.join(" · ");
  if (fits(wide)) ctx.fillText(wide, tx, view.height - 8);
  else if (fits(tight)) ctx.fillText(tight, tx, view.height - 8);
  else {
    const half = Math.ceil(parts.length / 2);
    ctx.fillText(parts.slice(0, half).join(" · "), tx, view.height - 22);
    ctx.fillText(parts.slice(half).join(" · "), tx, view.height - 8);
  }
  ctx.restore();
}

/** Side view of a planar arm: table line, links, joints, gripper, targets, angles. */
export function drawArm(ctx: Ctx2D, snap: WorldSnapshot, view: View, pal: Palette = FALLBACK): void {
  const arm = snap.arm;
  ctx.save();
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, view.width, view.height);
  if (!arm) {
    ctx.restore();
    return;
  }
  const reach = arm.spec.links.reduce((a, b) => a + b, 0);
  // The arm sweeps a half disc above its base: fit 2.3 reaches across and 1.25 up.
  const s = Math.max(0.5, Math.min(view.width / (2.3 * reach), (view.height - 60) / (1.25 * reach + arm.spec.base.y)));
  const cx = view.width / 2 - arm.spec.base.x * s;
  const cy = view.height - 34;
  const X = (x: number) => cx + x * s;
  const Y = (y: number) => cy - y * s; // side view: y up

  // table + reach circle
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.arc(X(arm.spec.base.x), Y(arm.spec.base.y), reach * s, Math.PI, 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = pal.muted;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(8, Y(0));
  ctx.lineTo(view.width - 8, Y(0));
  ctx.stroke();

  // targets
  const reached = new Set(arm.pose.reached);
  for (const t of arm.spec.targets) {
    ctx.strokeStyle = reached.has(t.id) ? pal.live : pal.warn;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(X(t.x), Y(t.y), Math.max(4, t.r * s), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = pal.muted;
    ctx.font = `10px ${pal.mono}`;
    ctx.textAlign = "left";
    ctx.fillText(t.id, X(t.x) + Math.max(4, t.r * s) + 4, Y(t.y) + 4);
  }

  // base
  ctx.fillStyle = pal.line;
  ctx.fillRect(X(arm.spec.base.x) - 14, Y(arm.spec.base.y), 28, Math.max(4, arm.spec.base.y * s));

  // links
  const pts = arm.pose.points;
  ctx.strokeStyle = pal.text;
  ctx.lineWidth = Math.min(14, Math.max(4, 0.6 * s));
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.x), Y(p.y)) : ctx.lineTo(X(p.x), Y(p.y))));
  ctx.stroke();
  // joints
  pts.slice(0, -1).forEach((p, i) => {
    ctx.fillStyle = pal.panel;
    ctx.strokeStyle = pal.wire;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = pal.muted;
    ctx.font = `10px ${pal.mono}`;
    ctx.textAlign = "left";
    ctx.fillText(`${arm.spec.joints[i]?.servo ?? ""} ${Math.round(arm.servoAngles[i] ?? 0)}°`, X(p.x) + 10, Y(p.y) - 8);
  });
  // gripper
  const end = arm.pose.end;
  ctx.fillStyle = reached.size ? pal.live : pal.wire;
  ctx.beginPath();
  ctx.arc(X(end.x), Y(end.y), 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = pal.muted;
  ctx.font = `11px ${pal.mono}`;
  ctx.textAlign = "left";
  ctx.fillText(`gripper x ${end.x.toFixed(1)} cm  y ${end.y.toFixed(1)} cm${reached.size ? `  ·  reached ${[...reached].join(", ")}` : ""}`, 12, view.height - 8);
  ctx.restore();
}
