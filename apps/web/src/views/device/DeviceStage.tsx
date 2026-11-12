// The 3D device stage: the project as the physical thing, running live, with a floating HUD.
// It reads the simulation through a DeviceSource and never steps it.
//   - case: the project's own designed case (Case view meshes), live screen in its window, caps
//     pressable at their openings, LEDs at their light pipes, rings at the grille
//   - handheld / pet (no case yet): generic shell, live screen, pressable buttons (mouse or keys 1-9), LEDs, buzzer rings
//   - rover: arena from jumper.json, modeled 2WD robot, sonar cone, trail, follow camera
//   - arm: servo arm on a table, targets light up when reached
//   - anything else: the board on a desk with its LEDs
import "./device.css";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import { Camera, ChevronDown, Crosshair, Maximize2, Palette, Pause, Play, X } from "lucide-react";
import { DeviceSourceContext, ReadoutsContext, type Readouts } from "./context.ts";
import type { DeviceSource } from "./source.ts";
import { caseLabel, classifyProject, lastSerialLine, serialStats, type DeviceKind } from "./classify.ts";
import { useDeviceCase, type CaseLoad } from "./caseModel.ts";
import { CaseDevice, type CaseFinish } from "./scene/CaseDevice.tsx";
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
  /** Opens the Case view (the HUD's "Design a case" / "Update case"). */
  onOpenCase?: (() => void) | undefined;
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

function cameraFor(kind: DeviceKind, source: DeviceSource, mobile: boolean, side = 0): { position: [number, number, number]; target: [number, number, number]; fov: number } {
  const k = mobile ? 1.55 : 1;
  // a designed case: a three-quarter view toward the side its first button is on, so the cap shows
  if (kind === "case") return { position: [(side === 0 ? 5.2 : 9.5 * side) * k, 7, 20.5 * k], target: [0, mobile ? 3.2 : 3.6, 0], fov: 30 };
  if (kind === "handheld") return { position: [5.2 * k, 7.4, 22 * k], target: [0, mobile ? 3.2 : 3.7, 0], fov: 30 };
  if (kind === "arm") return { position: [3.5 * k, 6.8, 19 * k], target: [0.6, 2.6, 0], fov: 32 };
  if (kind === "rover") {
    const w = (source.project().world as { arena?: { width?: number; height?: number } } | undefined)?.arena;
    const m = Math.max(w?.width ?? 300, (w?.height ?? 200) * 1.4) / 10;
    return { position: [m * 0.1, m * 0.8 * k, m * 0.82 * k], target: [0, 0, 0.6], fov: 34 };
  }
  return { position: [2.2 * k, 7.5, 10.5 * k], target: [0.5, 0, 0], fov: 30 };
}

const loadCaseOf = (source: DeviceSource) => (source.loadCase ? () => source.loadCase!() : undefined);

export function DeviceStage({ source, onClose, onOpenCase, capture = false, hud = true, camera: cameraInit = "track", finish: finishInit = "ceramic", bottomInset = 0 }: DeviceStageProps) {
  useSourceTick(source);
  const project = source.project();
  const loader = useMemo(() => loadCaseOf(source), [source]);
  const caseLoad = useDeviceCase(project, loader);
  const built = caseLoad.status === "ready" ? caseLoad.model : undefined;
  const layout = useMemo(() => classifyProject(project, built), [project, built]);
  const [caseFinish, setCaseFinish] = useState<CaseFinish>("design");
  // a case is on its way: show it rather than flash the generic handheld first
  const casePending = caseLoad.status === "loading" && layout.kind !== "rover" && layout.kind !== "arm";
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
    const n0 = layout.case?.buttons.find((b) => b.opening)?.opening?.n;
    const c = cameraFor(layout.kind, source, mobile, n0 && Math.abs(n0[0]) > 0.5 ? Math.sign(n0[0]) : 0);
    // Keep the device clear of a timeline under the stage: aim a little lower so it sits higher.
    if (bottomInset && layout.kind !== "rover") return { ...c, target: [c.target[0], c.target[1] - bottomInset / 110, c.target[2]] as [number, number, number] };
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.kind, source, mobile, bottomInset, layout.case?.model.hash]);

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
        <div className="dv-root" data-testid="device-stage" data-kind={layout.kind} data-case={caseLoad.status === "ready" ? (caseLoad.model.stale ? "stale" : "current") : caseLoad.status} data-dark={dark} style={{ ["--dv-bottom" as string]: `${bottomInset}px` }}>
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
              {layout.kind === "case" && layout.case ? (
                <>
                  <StudioFloor radius={22} color={floor} receiveShadow={false} />
                  <CaseDevice fit={layout.case} finish={caseFinish} onPressKey={(fn) => void (pressKey.current = fn)} />
                </>
              ) : null}
              {layout.kind === "handheld" && !casePending ? (
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
              {layout.kind === "board" && !casePending ? (
                <>
                  <StudioFloor radius={20} color={floor} receiveShadow={false} />
                  <BoardDesk layout={layout} />
                </>
              ) : null}
            </Suspense>
            <CameraTo position={cam.position} />
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
          {casePending ? (
            <div className="dv-empty" data-testid="device-case-loading">
              <strong>Loading the case…</strong>
              <span>The first time, Jumper tessellates the case the Case view built (a few seconds); then it is kept.</span>
            </div>
          ) : null}
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
              buttons={layout.kind === "handheld" || layout.kind === "case" ? layout.buttons.map((b) => b.id) : []}
              caseLoad={caseLoad}
              hasEnclosure={!!project.enclosure}
              caseFinish={caseFinish}
              setCaseFinish={setCaseFinish}
              onOpenCase={onOpenCase}
            />
          ) : null}
        </div>
      </ReadoutsContext.Provider>
    </DeviceSourceContext.Provider>
  );
}

/** Moves the camera when the framing changes after the canvas exists (the case arrives after the first frame). */
function CameraTo({ position }: { position: [number, number, number] }) {
  const camera = useThree((s) => s.camera);
  const first = useRef(true);
  const key = position.join(",");
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    camera.position.set(position[0], position[1], position[2]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, camera]);
  return null;
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
  caseLoad: CaseLoad;
  hasEnclosure: boolean;
  caseFinish: CaseFinish;
  setCaseFinish: (f: CaseFinish) => void;
  onOpenCase: (() => void) | undefined;
}

/** The HUD's line about the case: out of date, none yet, or could not load. */
function CaseNote({ kind, caseLoad, hasEnclosure, onOpenCase }: { kind: DeviceKind; caseLoad: CaseLoad; hasEnclosure: boolean; onOpenCase: (() => void) | undefined }) {
  if (kind === "rover" || kind === "arm") return null;
  const open = (label: string) =>
    onOpenCase ? (
      <button type="button" className="dv-note-btn" onClick={onOpenCase} data-testid="device-open-case">
        {label}
      </button>
    ) : null;
  if (kind === "case" && caseLoad.status === "ready" && caseLoad.model.stale)
    return (
      <div className="dv-note is-warn" data-testid="device-case-note" title={`Shown as built: ${caseLoad.model.stale_reason ?? "the project changed since"}.`}>
        <span>Case out of date{caseLoad.model.stale_reason ? `: ${caseLoad.model.stale_reason}` : ""}</span>
        {open("Update case")}
      </div>
    );
  if (caseLoad.status === "error")
    return (
      <div className="dv-note is-warn" data-testid="device-case-note" title={caseLoad.error}>
        <span>The case could not load, showing a stand-in. {caseLoad.error.split(" Fix: ")[0]}</span>
        {open("Open the Case view")}
      </div>
    );
  if (!hasEnclosure && (kind === "handheld" || kind === "board"))
    return (
      <div className="dv-note" data-testid="device-case-note">
        <span>No case yet - design one in the Case view</span>
        {open("Design a case")}
      </div>
    );
  if (hasEnclosure && caseLoad.status === "none" && kind !== "case")
    return (
      <div className="dv-note" data-testid="device-case-note">
        <span>The case is not built yet - press Update case in the Case view</span>
        {open("Open the Case view")}
      </div>
    );
  return null;
}

function Hud({ source, kind, why, finish, setFinish, rcam, setRcam, readouts, onClose, buttons, caseLoad, hasEnclosure, caseFinish, setCaseFinish, onOpenCase }: HudProps) {
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
        <div className="dv-sub" data-testid="device-why">{why}</div>
        <CaseNote kind={kind} caseLoad={caseLoad} hasEnclosure={hasEnclosure} onOpenCase={onOpenCase} />
      </header>

      {kind === "rover" || kind === "handheld" || kind === "case" || onClose ? (
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
        {kind === "case" && caseLoad.status === "ready" ? (
          <>
            <Palette size={15} strokeWidth={1.6} className="dv-muted-icon" aria-hidden />
            <button className={`dv-swatch ${caseFinish === "design" ? "on" : ""}`} style={{ background: caseLoad.model.color ?? "#e7e5df" }} onClick={() => setCaseFinish("design")} title={`As designed (${caseLabel(caseLoad.model.shape)})`} aria-label="Case colour as designed" aria-pressed={caseFinish === "design"} data-testid="device-finish-design" />
            {(Object.keys(SHELLS) as ShellFinish[]).map((f) => (
              <button key={f} className={`dv-swatch ${caseFinish === f ? "on" : ""}`} style={{ background: SHELLS[f].color }} onClick={() => setCaseFinish(f)} title={SHELLS[f].label} aria-label={`${SHELLS[f].label} case`} aria-pressed={caseFinish === f} />
            ))}
          </>
        ) : null}
        {onClose ? (
          <>
            {kind === "rover" || kind === "handheld" || kind === "case" ? <span className="dv-div" /> : null}
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
