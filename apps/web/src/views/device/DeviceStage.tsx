// The 3D device stage: the project as the physical thing, running live, with a floating HUD.
// It reads the simulation through a DeviceSource and never steps it.
//   - handheld / pet: shell, live screen, pressable buttons (mouse or keys 1-9), LEDs, buzzer rings
//   - rover: arena from jumper.json, modeled 2WD robot, sonar cone, trail, follow camera
//   - arm: servo arm on a table, targets light up when reached
//   - anything else: the board on a desk with its LEDs
import "./device.css";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import { Camera, ChevronDown, Crosshair, Maximize2, Palette, Pause, Play, X } from "lucide-react";
import { DeviceSourceContext, ReadoutsContext, type Readouts } from "./context.ts";
import type { DeviceSource } from "./source.ts";
import { classifyProject, lastSerialLine, serialStats, type DeviceKind } from "./classify.ts";
import { StudioFloor, StudioLights } from "./scene/Studio.tsx";
import { Handheld, SHELLS, type ShellFinish } from "./scene/Handheld.tsx";
import { Arena, CameraRig, RoverRobot, type RoverCamera, type RoverHandle } from "./scene/Rover.tsx";
import { ArmScene } from "./scene/Arm.tsx";
import { BoardDesk } from "./scene/BoardDesk.tsx";

export interface DeviceStageProps {
  source: DeviceSource;
  onClose?: (() => void) | undefined;
  /** Headless capture: keep the drawing buffer so the canvas can be read back (PNG / video frames). */
  capture?: boolean;
  /** Show the floating HUD (default true). */
  hud?: boolean;
  /** Rover camera: track (default), chase or arena. */
  camera?: RoverCamera;
  /** Shell finish for handhelds. */
  finish?: ShellFinish;
  /** Space kept free at the bottom (px) for a timeline under the stage. */
  bottomInset?: number;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

function readDark(): boolean {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light") return false;
  if (t === "dark") return true;
  return !window.matchMedia?.("(prefers-color-scheme: light)").matches;
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(readDark);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(readDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    const on = () => setDark(readDark());
    mq?.addEventListener("change", on);
    return () => {
      mo.disconnect();
      mq?.removeEventListener("change", on);
    };
  }, []);
  return dark;
}

function useSourceTick(source: DeviceSource): number {
  const ver = useRef(0);
  const sub = useCallback(
    (fn: () => void) =>
      source.subscribe(() => {
        ver.current++;
        fn();
      }),
    [source],
  );
  return useSyncExternalStore(sub, () => ver.current);
}

function cameraFor(kind: DeviceKind, source: DeviceSource, mobile: boolean): { position: [number, number, number]; target: [number, number, number]; fov: number } {
  const k = mobile ? 1.55 : 1;
  if (kind === "handheld") return { position: [5.2 * k, 7.4, 22 * k], target: [0, mobile ? 3.2 : 3.7, 0], fov: 30 };
  if (kind === "arm") return { position: [3.5 * k, 6.8, 19 * k], target: [0.6, 2.6, 0], fov: 32 };
  if (kind === "rover") {
    const w = (source.project().world as { arena?: { width?: number; height?: number } } | undefined)?.arena;
    const m = Math.max(w?.width ?? 300, (w?.height ?? 200) * 1.4) / 10;
    return { position: [m * 0.1, m * 0.8 * k, m * 0.82 * k], target: [0, 0, 0.6], fov: 34 };
  }
  return { position: [2.2 * k, 7.5, 10.5 * k], target: [0.5, 0, 0], fov: 30 };
}

export function DeviceStage({ source, onClose, capture = false, hud = true, camera: cameraInit = "track", finish: finishInit = "ceramic", bottomInset = 0 }: DeviceStageProps) {
  useSourceTick(source);
  const project = source.project();
  const layout = useMemo(() => classifyProject(project), [project]);
  const world = source.world();
  const dark = useIsDark();
  const [finish, setFinish] = useState<ShellFinish>(finishInit);
  const [rcam, setRcam] = useState<RoverCamera>(cameraInit);
  const follow = layout.kind === "rover" && rcam === "chase";
  const [dpr, setDpr] = useState<number>(() => Math.min(2, window.devicePixelRatio || 1));
  const readouts = useRef<Readouts>({});
  const roverHandle = useRef<RoverHandle>({ pos: new THREE.Vector3(), yaw: 0 });
  const pressKey = useRef<((i: number, down: boolean) => void) | null>(null);
  const mobile = typeof window !== "undefined" && window.innerWidth < 640;
  const cam = useMemo(() => {
    const c = cameraFor(layout.kind, source, mobile);
    // Keep the device clear of a timeline under the stage: aim a little lower so it sits higher.
    if (bottomInset && layout.kind !== "rover") return { ...c, target: [c.target[0], c.target[1] - bottomInset / 110, c.target[2]] as [number, number, number] };
    return c;
  }, [layout.kind, source, mobile, bottomInset]);

  // Keys: Esc closes, Space runs / pauses, 1-9 press the device's buttons, F toggles follow.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (source.runState() === "running") source.pause();
        else source.run();
      } else if (/^[1-9]$/.test(e.key) && !e.repeat && !e.metaKey && !e.ctrlKey) {
        e.stopPropagation();
        pressKey.current?.(Number(e.key) - 1, true);
      } else if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey && layout.kind === "rover") {
        e.stopPropagation();
        setRcam((c) => (c === "track" ? "chase" : c === "chase" ? "arena" : "track"));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (/^[1-9]$/.test(e.key)) pressKey.current?.(Number(e.key) - 1, false);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [source, onClose, layout.kind]);

  const needsWorld = layout.kind === "rover" || layout.kind === "arm";
  const bg = dark ? "#0a0a0a" : "#f2f2f0";
  const floor = dark ? "#111111" : "#e6e6e2";

  return (
    <DeviceSourceContext.Provider value={source}>
      <ReadoutsContext.Provider value={readouts}>
        <div className="dv-root" data-testid="device-stage" data-kind={layout.kind} data-dark={dark} style={{ ["--dv-bottom" as string]: `${bottomInset}px` }}>
          <Canvas
            className="dv-canvas"
            shadows={{ type: THREE.PCFShadowMap }}
            dpr={capture ? Math.min(2, window.devicePixelRatio || 1) : dpr}
            gl={{ antialias: true, preserveDrawingBuffer: capture, powerPreference: "high-performance" }}
            camera={{ position: cam.position, fov: cam.fov, near: 0.1, far: 400 }}
            onCreated={({ gl }) => {
              gl.toneMapping = THREE.ACESFilmicToneMapping;
              gl.toneMappingExposure = 1.05;
              gl.domElement.dataset.ready = "true";
            }}
          >
            <color attach="background" args={[bg]} />
            <fog attach="fog" args={[bg, 45, 140]} />
            {!capture ? <PerformanceMonitor onDecline={() => setDpr((d) => Math.max(1, d - 0.5))} onIncline={() => setDpr((d) => Math.min(2, window.devicePixelRatio || 1, d + 0.25))} /> : null}
            <Suspense fallback={null}>
              {layout.kind === "rover" ? <StudioLights shadowSize={20} keyPos={[10, 24, 12]} /> : <StudioLights shadowSize={10} castShadow={layout.kind === "arm"} />}
              {layout.kind === "handheld" ? (
                <>
                  <StudioFloor radius={22} color={floor} receiveShadow={false} />
                  <Handheld layout={layout} finish={finish} onPressKey={(fn) => void (pressKey.current = fn)} />
                </>
              ) : null}
              {layout.kind === "rover" && world ? (
                <>
                  <Arena binding={world} />
                  <RoverRobot binding={world} layout={layout} handle={roverHandle} />
                  <CameraRig handle={roverHandle} mode={rcam} arena={world.world.arena} />
                </>
              ) : null}
              {layout.kind === "arm" && world?.world.arm ? (
                <>
                  <StudioFloor radius={26} y={-0.31} color={floor} receiveShadow={false} />
                  <ArmScene binding={world} />
                </>
              ) : null}
              {layout.kind === "board" ? (
                <>
                  <StudioFloor radius={20} color={floor} receiveShadow={false} />
                  <BoardDesk layout={layout} />
                </>
              ) : null}
            </Suspense>
            <OrbitControls
              makeDefault
              enabled={!follow}
              target={cam.target}
              enableDamping
              dampingFactor={0.08}
              minDistance={3}
              maxDistance={layout.kind === "rover" ? 70 : 32}
              maxPolarAngle={Math.PI * 0.49}
            />
          </Canvas>
          {needsWorld && !world ? (
            <div className="dv-empty" data-testid="device-empty">
              <strong>Press Run to build the world</strong>
              <span>The {layout.kind === "rover" ? "arena and robot appear" : "arm appears"} once the simulation starts (the physics engine loads with it).</span>
            </div>
          ) : null}
          {hud ? (
            <Hud
              source={source}
              kind={layout.kind}
              why={layout.why}
              finish={finish}
              setFinish={setFinish}
              rcam={rcam}
              setRcam={setRcam}
              readouts={readouts}
              onClose={onClose}
              buttons={layout.kind === "handheld" ? layout.buttons.map((b) => b.id) : []}
            />
          ) : null}
        </div>
      </ReadoutsContext.Provider>
    </DeviceSourceContext.Provider>
  );
}

export function fmtClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(t % 1000).padStart(3, "0")}`;
}

interface HudProps {
  source: DeviceSource;
  kind: DeviceKind;
  why: string;
  finish: ShellFinish;
  setFinish: (f: ShellFinish) => void;
  rcam: RoverCamera;
  setRcam: (c: RoverCamera) => void;
  readouts: React.MutableRefObject<Readouts>;
  onClose: (() => void) | undefined;
  buttons: string[];
}

function Hud({ source, kind, why, finish, setFinish, rcam, setRcam, readouts, onClose, buttons }: HudProps) {
  const clock = useRef<HTMLSpanElement>(null);
  const [vals, setVals] = useState<{ key: string; value: string }[]>([]);
  const [line, setLine] = useState("");
  const [speedOpen, setSpeedOpen] = useState(false);
  const running = source.runState() === "running";
  const project = source.project();

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (clock.current) clock.current.textContent = fmtClock(source.timeMs());
      if (now - last > 160) {
        last = now;
        const text = source.serialText();
        const fromScene = Object.entries(readouts.current).map(([key, value]) => ({ key, value }));
        const fromSerial = serialStats(text).filter((p) => !(p.key in readouts.current));
        const next = [...fromScene, ...fromSerial].slice(0, 9);
        setVals((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        const l = lastSerialLine(text);
        setLine((prev) => (prev === l ? prev : l));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [source, readouts]);

  return (
    <>
      <header className="dv-title">
        <div className="dv-title-row">
          <span className="dv-name">{project.name}</span>
          <span className="dv-chip">Device</span>
        </div>
        <div className="dv-sub">{why}</div>
      </header>

      {kind === "rover" || kind === "handheld" || onClose ? (
      <div className="dv-float dv-tools" role="toolbar" aria-label="View">
        {kind === "rover" ? (
          <>
            {(
              [
                ["track", Crosshair, "Track the robot (orbit around it)"],
                ["chase", Camera, "Chase camera"],
                ["arena", Maximize2, "Whole arena"],
              ] as const
            ).map(([m, Icon, label]) => (
              <button key={m} className={`dv-ghost ${rcam === m ? "on" : ""}`} onClick={() => setRcam(m)} aria-pressed={rcam === m} title={`${label} (F cycles)`} aria-label={label} data-testid={`device-cam-${m}`}>
                <Icon size={16} strokeWidth={1.6} />
              </button>
            ))}
          </>
        ) : null}
        {kind === "handheld" ? (
          <>
            <Palette size={15} strokeWidth={1.6} className="dv-muted-icon" aria-hidden />
            {(Object.keys(SHELLS) as ShellFinish[]).map((f) => (
              <button key={f} className={`dv-swatch ${finish === f ? "on" : ""}`} style={{ background: SHELLS[f].color }} onClick={() => setFinish(f)} title={SHELLS[f].label} aria-label={`${SHELLS[f].label} shell`} aria-pressed={finish === f} />
            ))}
          </>
        ) : null}
        {onClose ? (
          <>
            {kind === "rover" || kind === "handheld" ? <span className="dv-div" /> : null}
            <button className="dv-ghost" onClick={onClose} title="Back to canvas (Esc)" aria-label="Close device view" data-testid="device-close">
              <X size={16} strokeWidth={1.6} />
            </button>
          </>
        ) : null}
      </div>
      ) : null}

      {vals.length ? (
        <aside className="dv-float dv-readouts" aria-label="Readouts" data-testid="device-readouts">
          {vals.map((v) => (
            <div key={v.key} className="dv-ro">
              <span>{v.key}</span>
              <b>{v.value}</b>
            </div>
          ))}
        </aside>
      ) : null}

      <div className="dv-transport">
        {line ? (
          <div className="dv-serial" title="Last serial line" data-testid="device-serial">
            <span className="dv-serial-k">serial</span>
            <span className="dv-mono">{line}</span>
          </div>
        ) : null}
        <div className="dv-float dv-transport-in">
          <button className="dv-primary" onClick={() => (running ? source.pause() : source.run())} data-testid="device-run">
            {running ? <Pause size={14} strokeWidth={2.2} /> : <Play size={14} strokeWidth={2.2} />}
            {running ? "Pause" : "Run"}
          </button>
          <span className={`dv-status ${running ? "live" : ""}`}>
            <i />
            <span ref={clock} className="dv-mono">00:00.000</span>
          </span>
          {source.setSpeed ? (
            <div className="dv-speed">
              <button className="dv-outline" onClick={() => setSpeedOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={speedOpen} aria-label="Speed">
                <span className="dv-mono">{source.speed()}×</span>
                <ChevronDown size={14} strokeWidth={1.6} />
              </button>
              {speedOpen ? (
                <div className="dv-menu" role="listbox">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      role="option"
                      aria-selected={s === source.speed()}
                      className={s === source.speed() ? "on" : ""}
                      onClick={() => {
                        source.setSpeed?.(s);
                        setSpeedOpen(false);
                      }}
                    >
                      <span className="dv-mono">{s}×</span>
                      {s > 4 ? <em>best effort</em> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="dv-hint">
          {buttons.length ? (
            <>
              Press {buttons.slice(0, 9).map((_, i) => <kbd key={i}>{i + 1}</kbd>)} or click the buttons · drag to orbit
            </>
          ) : kind === "rover" ? (
            <>
              Drag to orbit · <kbd>F</kbd> cycles track / chase / arena
            </>
          ) : (
            <>Drag to orbit · scroll to zoom</>
          )}
        </div>
      </div>
    </>
  );
}
