// Standalone physics demo page (dev only): runs examples/rover or examples/robot-arm in the
// browser with the real parts, avr8js and Rapier, and paints the world. Used to record videos:
//   pnpm --filter @faber/web exec vite --port 5199
//   open http://localhost:5199/src/renderers/physics/demo/index.html?example=rover
// window.__faberDemo.step(ms) advances virtual time and repaints (deterministic frame capture);
// without ?manual the page runs at real time on its own.
import "@fontsource/bricolage-grotesque/600.css";
import "@fontsource/bricolage-grotesque/800.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../../../../../../brand/tokens.css";
import "./demo.css";
import { parseProject } from "@faber/project-format";
import { Simulation } from "@faber/sim-core";
import { backendFactory } from "@faber/sim-backends";
import { registry } from "@faber/parts";
import { armReach, attachPhysics, initPhysics, worldOf, type PhysicsBinding } from "@faber/physics";
import { drawArm, drawWorld, readPalette, type Ctx2D, type View } from "../paint.ts";
import roverJson from "../../../../../../examples/rover/faber.json?raw";
import roverHex from "../../../../../../examples/rover/firmware/rover.hex?raw";
import armJson from "../../../../../../examples/robot-arm/faber.json?raw";
import armHex from "../../../../../../examples/robot-arm/firmware/robot-arm.hex?raw";

const params = new URLSearchParams(location.search);
const which = params.get("example") === "arm" ? "arm" : "rover";
const raw = which === "arm" ? armJson : roverJson;
const hex = which === "arm" ? armHex : roverHex;
const project = parseProject(raw);

const root = document.getElementById("demo")!;
root.innerHTML = `
  <header><span class="mark">faber</span><span class="title">${project.name}</span><span class="sub">examples/${which === "arm" ? "robot-arm" : "rover"} · real firmware on avr8js · Rapier 2D physics</span></header>
  <section class="stage"><canvas id="view"></canvas></section>
  <aside id="side"></aside>`;
const canvas = document.getElementById("view") as HTMLCanvasElement;
const side = document.getElementById("side")!;
const ctx = canvas.getContext("2d") as unknown as Ctx2D & CanvasRenderingContext2D;

await initPhysics();
const sim = new Simulation({ project, registry, backendFactory, firmware: hex });
const phys: PhysicsBinding = attachPhysics(sim, worldOf(raw));

let view: View = { width: 800, height: 600 };
const resize = () => {
  const dpr = window.devicePixelRatio || 1;
  view = { width: canvas.clientWidth, height: canvas.clientHeight };
  canvas.width = Math.round(view.width * dpr);
  canvas.height = Math.round(view.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
};
resize();
const pal = readPalette(canvas);

const num = (id: string, k: string) => Number(sim.partState(id)?.[k] ?? 0);
const row = (label: string, value: string, cls = "") => `<div class="row ${cls}"><span>${label}</span><b>${value}</b></div>`;

function paintSide() {
  const t = (sim.timeMs / 1000).toFixed(2);
  let html = `<div class="clock">${t}<small> s virtual</small></div>`;
  if (which === "rover") {
    const st = phys.stats();
    const drv = sim.partState("drv")!;
    const sonar = sim.partState("sonar")!;
    const bat = sim.partState("bat")!;
    html += `<h3>World</h3>`;
    html += row("collisions", String(st.collisions), st.collisions ? "warn" : "live");
    html += row("closest gap", Number.isFinite(st.minClearanceCm) ? `${st.minClearanceCm.toFixed(1)} cm` : "–");
    html += row("travelled", `${(st.travelledCm / 100).toFixed(2)} m`);
    html += `<h3>Parts</h3>`;
    html += row("sonar", String(sonar.label), sonar.echo ? "live" : "");
    html += row("L298N A", String(drv.aLabel));
    html += row("L298N B", String(drv.bLabel));
    html += row("motor left", `${num("mL", "rpm").toFixed(0)} rpm`);
    html += row("motor right", `${num("mR", "rpm").toFixed(0)} rpm`);
    html += row("battery", String(bat.label));
    const pw = sim.pwm("drv", "ENA");
    if (pw) html += row("ENA (D5)", `${(pw.duty * 100).toFixed(0)} % @ ${pw.freqHz.toFixed(0)} Hz`);
  } else {
    html += `<h3>Parts</h3>`;
    html += row("pot A0", `${(num("potS", "position") * 100).toFixed(0)} %`);
    html += row("pot A1", `${(num("potE", "position") * 100).toFixed(0)} %`);
    html += row("shoulder", `${num("shoulder", "angle").toFixed(1)}°`, sim.partState("shoulder")?.moving ? "live" : "");
    html += row("elbow", `${num("elbow", "angle").toFixed(1)}°`, sim.partState("elbow")?.moving ? "live" : "");
    const pw = sim.pwm("shoulder", "SIG");
    if (pw) html += row("D9 pulse", `${pw.highUs.toFixed(0)} µs / ${(pw.periodUs / 1000).toFixed(0)} ms`);
  }
  const lines = sim.serialText().trim().split(/\r?\n/).slice(-6);
  html += `<h3>Serial</h3><pre>${lines.map((l) => l.replace(/</g, "&lt;")).join("\n")}</pre>`;
  side.innerHTML = html;
}

function paint() {
  const snap = phys.snapshot();
  if (which === "arm") drawArm(ctx, snap, view, pal);
  else drawWorld(ctx, snap, view, pal);
  paintSide();
}

/** Arm demo: someone turns the pots to a few poses (the servos then slew at 0.1 s/60°). */
const cup = phys.world.arm ? armReach(phys.world.arm, 15, 4) : undefined;
function armScript(tMs: number) {
  const keys: [number, number, number][] = [
    [0, 0.5, 0.5],
    [1200, 0.15, 0.95],
    [3000, 0.85, 0.3],
    [4800, 0.3, 0.15],
    [6600, (cup?.[0] ?? 117) / 180, (cup?.[1] ?? 40) / 180], // the cup
    [8400, 0.5, 0.5],
  ];
  let k = keys[0]!;
  for (const kk of keys) if (tMs >= kk[0]) k = kk;
  if (Math.abs(num("potS", "position") - k[1]) > 1e-6) sim.interact("potS", { kind: "set", value: k[1] });
  if (Math.abs(num("potE", "position") - k[2]) > 1e-6) sim.interact("potE", { kind: "set", value: k[2] });
}

function step(ms: number) {
  const chunk = 10;
  for (let t = 0; t < ms; t += chunk) {
    if (which === "arm") armScript(sim.timeMs);
    sim.runFor(Math.min(chunk, ms - t));
  }
  paint();
}

(window as unknown as { __faberDemo: unknown }).__faberDemo = { step, sim, phys, ready: true };
paint();
document.body.dataset.ready = "true";
if (!params.has("manual")) {
  let last = performance.now();
  const loop = (now: number) => {
    step(Math.min(50, now - last));
    last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
