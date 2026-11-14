// Standalone Device view (dev and headless renders). Runs an example (or any project handed in
// through window.__device.load) with the real parts, avr8js and Rapier, and shows the 3D stage.
//   pnpm --filter @jumper/web exec vite --port 5287
//   open http://localhost:5287/src/views/device/dev/index.html?example=tamagotchi
// Params: example=<name>, ms=<virtual ms to run before showing>, run=1 (keep running), hud=0,
//   camera=track|chase|arena, finish=ceramic|graphite|signal, theme=light, press=<part>@<ms>[,<part>@<ms>…] (held 120 ms).
// window.__device: { ready, step(ms), load(projectJson, hex), press(id), release(id), timeMs(), setFrame(id, frame) }.
// setFrame (tests): show this RGB565 frame for a display part instead of its model's (e.g. an e-paper
// with no firmware driving it), so the Device view's frame path is checked without a board build.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseProject, type Project } from "@jumper/project-format";
import { Simulation, type ColorFrame } from "@jumper/sim-core";
import { createSandboxNetwork } from "@jumper/ai-gateway";
import { hasWifiPart } from "../../network/webNetwork.ts";
import { backendFactory } from "@jumper/sim-backends";
import { registry } from "@jumper/parts";
import { attachPhysics, initPhysics } from "@jumper/physics";
import { loadExample, loadExampleFirmware } from "../../../lib/examples.ts";
import { DeviceStage } from "../DeviceStage.tsx";
import { ownedSimSource, type OwnedSimSource } from "../source.ts";
import type { ShellFinish } from "../scene/Handheld.tsx";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.setAttribute("data-theme", "light");

interface DeviceApi {
  ready: boolean;
  error?: string;
  step(ms: number): Promise<void>;
  load(projectJson: string, hex?: string, ms?: number): Promise<void>;
  press(id: string): void;
  release(id: string): void;
  timeMs(): number;
  setFrame(partId: string, frame: { width: number; height: number; rgb565: number[] } | null): void;
}

/** Frames set from a test script (setFrame), shown instead of the part model's own. */
const fixedFrames = new Map<string, ColorFrame>();

async function makeSource(project: Project, hex: string | undefined): Promise<OwnedSimSource> {
  if (project.world) await initPhysics();
  const sim = new Simulation({ project, registry, backendFactory, ...(hex ? { firmware: hex } : {}), ...(hasWifiPart(project) ? { services: { network: createSandboxNetwork() } } : {}) });
  const physics = project.world ? attachPhysics(sim, project.world) : undefined;
  const src = ownedSimSource({ project, sim, physics });
  const own = src.framebuffer?.bind(src);
  src.framebuffer = (id) => fixedFrames.get(id) ?? own?.(id);
  return src;
}

/** Run `ms` of virtual time, pressing buttons at the given times (held 120 ms). */
function advance(src: OwnedSimSource, ms: number, presses: { id: string; at: number }[]): void {
  const events: { t: number; fn: () => void }[] = [];
  for (const p of presses) {
    events.push({ t: p.at, fn: () => src.press(p.id) }, { t: p.at + 120, fn: () => src.release(p.id) });
  }
  events.sort((a, b) => a.t - b.t);
  for (const e of events) {
    if (e.t > ms) break;
    const now = src.timeMs();
    if (e.t > now) src.step(e.t - now);
    e.fn();
  }
  const now = src.timeMs();
  if (ms > now) src.step(ms - now);
}

function Harness() {
  const [source, setSource] = useState<OwnedSimSource | undefined>();
  const [err, setErr] = useState<string | undefined>();
  useEffect(() => {
    let cur: OwnedSimSource | undefined;
    let dead = false;
    const api: DeviceApi = {
      ready: false,
      step: async (ms) => {
        if (cur) cur.step(ms);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      },
      load: async (json, hex, ms = 0) => {
        api.ready = false;
        cur?.dispose();
        const project = parseProject(json);
        cur = await makeSource(project, hex);
        if (ms) cur.step(ms);
        setSource(cur);
        await new Promise((r) => setTimeout(r, 50));
        api.ready = true;
      },
      press: (id) => cur?.press(id),
      release: (id) => cur?.release(id),
      timeMs: () => cur?.timeMs() ?? 0,
      setFrame: (id, f) => {
        if (!f) return void fixedFrames.delete(id);
        const version = (fixedFrames.get(id)?.version ?? 0) + 1;
        fixedFrames.set(id, { width: f.width, height: f.height, data: Uint16Array.from(f.rgb565), version, on: true, inverted: false });
      },
    };
    (window as unknown as { __device: DeviceApi }).__device = api;
    const name = params.get("example");
    if (!name) {
      // Wait for load() from a script (headless render of any project).
      return;
    }
    void (async () => {
      try {
        const ex = loadExample(name);
        if (ex.issues) throw new Error(ex.issues.join(" "));
        const fw = await loadExampleFirmware(ex.example, ex.project);
        const made = await makeSource(ex.project, fw?.hex);
        if (dead) return made.dispose();
        cur = made;
        const ms = Number(params.get("ms") ?? 0);
        const presses = (params.get("press") ?? "")
          .split(",")
          .filter(Boolean)
          .map((s) => {
            const [id, at] = s.split("@");
            return { id: id!, at: Number(at ?? 0) };
          });
        if (ms > 0) advance(cur, ms, presses);
        setSource(cur);
        if (params.get("run") === "1") cur.run();
        setTimeout(() => (api.ready = true), 400);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        api.error = msg;
        setErr(msg);
      }
    })();
    return () => {
      dead = true;
      cur?.dispose();
    };
  }, []);
  if (err) return <pre style={{ color: "#ff6b5e", padding: 24, font: "13px ui-monospace" }}>Device view harness failed: {err}</pre>;
  if (!source) return null;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <DeviceStage
        source={source}
        capture={params.get("capture") === "1"}
        hud={params.get("hud") !== "0"}
        camera={(params.get("camera") as "track" | "chase" | "arena" | null) ?? "track"}
        finish={(params.get("finish") as ShellFinish | null) ?? "ceramic"}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
