import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import type { Project } from "@jumper/project-format";
import { engine, useJumper } from "../lib/app.ts";
import { liveParams, noteStepActors, useAgentSteps, useLive, type LiveStep } from "./liveStore.ts";
import { expectProject, loadMainSketch, refreshCodeCard, switchProject } from "../projects/switch.ts";
import { FollowPlayer, ReplayPlayer, parseLog, type CanvasPort, type LogEntry, type LogFrame } from "./player.ts";
import { setLastColorFrames } from "../lib/colorFrames.ts"; // round 6 frames
import { PhysicsCanvas, drawArm, drawWorld } from "../renderers/physics/index.ts";
import { worldTracker } from "./worldTracker.ts";
import { useUi } from "../lib/ui.ts";
import { useInteract } from "../interact/store.ts";
import "./live.css";
import { agentLabel, feedAgentState, plural, useAgentState, type AgentState } from "./agentState.ts";
import { applyFirmwareToStore, autoRunEnabled, autoRunOnOpen, fetchFirmware, onAutoRun, onFirmwareEvent, onSketchWritten, runFollowed, setAutoRun } from "./followRun.ts";

/**
 * Follow mode (?follow=ws://127.0.0.1:7782, started by `jumper serve`) and replay mode
 * (?replay=<url of an actions.jsonl>, started by `jumper replay` / `jumper record`): the canvas shows
 * what an agent does through the MCP server or CLI, with an agent cursor, the step list with each
 * "why", accept / reject, live LEDs / displays / serial, and test results.
 */

const EMPTY: Project = { format: "jumper/1", name: "Waiting for the agent…", parts: [], wires: [], scenarios: [] };
const SPEEDS = [0.5, 1, 2, 4, 8];
/** Ops that change sketch files without logging their content (round 6: the code card re-reads). */
const FILE_REWRITING_OPS = new Set(["restore_version", "undo", "redo", "reject_step"]);

let replayPlayer: ReplayPlayer | undefined;
let socket: WebSocket | undefined;
let cmdSeq = 0;

function sendCommand(op: string, args: Record<string, unknown> = {}): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "command", id: ++cmdSeq, op, args }));
}

function usePort(): CanvasPort {
  const rf = useReactFlow();
  const fitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useRef<CanvasPort>({
    getProject: () => useJumper.getState().project,
    loadProject: (p) => {
      worldTracker.setProject(p);
      useLive.getState().set({ world: worldTracker.hasRobot ? "robot" : worldTracker.hasArm ? "arm" : undefined });
      useJumper.getState().loadProject(p);
      // The latest hex the server built (GET /api/firmware), so Run here runs the agent's firmware.
      applyFirmwareToStore();
    },
    showStates: (states, live, vt) => {
      engine.showExternal(states, live, vt);
      worldTracker.apply(states, vt);
    },
    resetStates: () => {
      engine.resetExternal();
      worldTracker.reset();
    },
    // While the device runs here, its own serial output owns the console.
    appendSerial: (t) => {
      if (!engine.isLocalRun) engine.appendSerial(t);
    },
    clearSerial: () => {
      if (!engine.isLocalRun) engine.clearSerial();
    },
    highlightNew: (parts, wires) => {
      if (!parts.length && !wires.length) return;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const els = [...parts.map((id) => document.querySelector(`[data-testid="part-${CSS.escape(id)}"]`)), ...wires.map((id) => document.querySelector(`[data-testid="wire-${CSS.escape(id)}"]`))];
          for (const el of els) {
            if (!el) continue;
            el.classList.remove("live-new");
            void (el as HTMLElement).getBoundingClientRect?.();
            el.classList.add("live-new");
            setTimeout(() => el.classList.remove("live-new"), 1200);
          }
        }),
      );
    },
    fit: () => {
      clearTimeout(fitTimer.current);
      // Fit the circuit into the space the overlays leave free (steps, tests, code, world cards), so
      // no card covers a part, least of all a display.
      const wide = typeof window !== "undefined" && window.innerWidth > 820;
      fitTimer.current = setTimeout(() => void rf.fitView({ padding: wide ? overlayPadding() : 0.12, duration: 450 }), 120);
    },
  }).current;
}

/**
 * fitView padding that keeps the circuit clear of the live overlays: each card reserves the side
 * of the canvas it hugs, choosing between its width (left/right) and its height (top/bottom),
 * whichever costs less canvas.
 */
type Px = `${number}px`;
function overlayPadding(): { top: Px; right: Px; bottom: Px; left: Px } {
  // With a World card the caption moves under the replay bar (live.css): keep a band for it.
  const pad = { top: document.querySelector(".live-world") ? 200 : 160, right: 48, bottom: 80, left: 92 };
  const canvas = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect();
  if (!canvas) return { top: "64px", right: "290px", bottom: "56px", left: "48px" };
  for (const el of document.querySelectorAll(".panel-column > *, .live-bar, .live-tests, .live-code, .live-world, .title-block, .top-actions, .rail, .ix-card")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const gap = 16;
    const left = r.right - canvas.left + gap;
    const right = canvas.right - r.left + gap;
    const top = r.bottom - canvas.top + gap;
    const bottom = canvas.bottom - r.top + gap;
    const horiz = Math.min(left, right);
    const vert = Math.min(top, bottom);
    // Lost canvas area if this card reserves a column vs a row.
    if (horiz * canvas.height <= vert * canvas.width) {
      if (left <= right) pad.left = Math.max(pad.left, left);
      else pad.right = Math.max(pad.right, right);
    } else if (top <= bottom) pad.top = Math.max(pad.top, top);
    else pad.bottom = Math.max(pad.bottom, bottom);
  }
  // Never squeeze the circuit below a third of the canvas in either direction.
  const fitAxis = (a: number, b: number, total: number): [number, number] => {
    const max = total * (2 / 3);
    if (a + b <= max) return [a, b];
    const k = max / (a + b);
    return [a * k, b * k];
  };
  const [l, r] = fitAxis(pad.left, pad.right, canvas.width);
  const [t, b] = fitAxis(pad.top, pad.bottom, canvas.height);
  const px = (v: number): Px => `${Math.round(v)}px`;
  return { top: px(t), right: px(r), bottom: px(b), left: px(l) };
}

export function LiveLayer() {
  const mode = useLive((s) => s.mode);
  const port = usePort();
  const tests = useLive((s) => s.tests);
  const fidelity = useLive((s) => s.fidelity);
  const hasCode = useLive((s) => !!s.code);
  // The live controls card appears when the device starts running here.
  const controls = useInteract((s) => s.active);
  // A card appearing (tests result, fidelity, firmware, live controls) changes the free space: fit again.
  useEffect(() => {
    if (mode !== "off" && (tests || fidelity || hasCode || controls)) port.fit();
  }, [mode, tests, fidelity, hasCode, controls, port]);

  useEffect(() => {
    const params = liveParams();
    if (params.mode === "off") return;
    useLive.getState().set({ mode: params.mode, source: params.url });
    // ?chrome=min hides the parts library (cleaner videos).
    if (new URLSearchParams(location.search).get("chrome") === "min") document.documentElement.dataset.liveChrome = "min";
    engine.setExternal(true);
    // The agent's steps and the serial output are what a follower watches: open both panels.
    useUi.setState({ panels: ["agent", "serial"], inspectorAuto: false });
    useJumper.getState().loadProject(EMPTY);
    useJumper.getState().setFirmware({ status: "none" });
    if (params.mode === "follow") {
      // Run on this page runs the project here (round 5), with the agent's latest firmware.
      engine.setFollowRunner(() => void runFollowed());
      useLive.getState().set({ autoRun: autoRunEnabled() });
      const stop = connectFollow(params.url, port);
      return () => {
        engine.setFollowRunner(undefined);
        stop();
      };
    }
    let cancelled = false;
    fetch(params.url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        const entries = parseLog(text);
        if (!entries.length) throw new Error(text.trimStart().startsWith("<") ? "the server answered with a web page, not a log (wrong path?)" : "it has no actions");
        replayPlayer = new ReplayPlayer(entries, port, params.speed);
        if (params.autoplay) setTimeout(() => replayPlayer?.play(), 900);
      })
      .catch((err: Error) => useLive.getState().set({ error: `Could not load the action log ${params.url}: ${err.message}. Fix: check the path (jumper replay <file> serves it for you).` }));
    return () => {
      cancelled = true;
      replayPlayer?.pause();
    };
  }, [port]);

  if (mode === "off") return null;
  return (
    <div className="live-layer" data-testid="live-layer" data-live-mode={mode}>
      <LiveBar />
      <AgentCursor />
      <CodeCard />
      <WorldPanel />
      <TestsCard />
      <Caption />
    </div>
  );
}

function connectFollow(url: string, port: CanvasPort): () => void {
  const player = new FollowPlayer(port);
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => useLive.getState().set({ connected: true, error: undefined });
    ws.onclose = () => {
      useLive.getState().set({ connected: false });
      if (!closed) retry = setTimeout(open, 1500);
    };
    ws.onmessage = (ev) => {
      let msg: { type: string; project?: Project; steps?: LiveStep[]; dir?: string; entries?: LogEntry[]; entry?: LogEntry; ok?: boolean; error?: string; state?: AgentState; hash?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        // Round 6 (switch): a hello for another folder is a project switch; every track resets its
        // per-project state (R8) and the old firmware never reaches the new board.
        let reason: "open" | "reload" = "reload";
        if (msg.project) {
          const project = msg.project;
          reason = switchProject(project, msg.dir ?? "", (p) => port.loadProject(p));
          port.fit();
        }
        const entries = msg.entries ?? [];
        useLive.getState().set({ steps: msg.steps ?? [], dir: msg.dir ?? "", stepActors: noteStepActors(entries, reason === "open" ? {} : useLive.getState().stepActors) });
        const last = [...entries].reverse().find((e) => e.frames?.length);
        const f: LogFrame | undefined = last?.frames?.at(-1);
        setLastColorFrames(last?.frames); // round 6 frames: the screens as the agent's last run left them
        if (f) port.showStates(f.states, f.live, f.vt);
        const code = [...entries].reverse().find((e) => e.file?.content);
        if (code?.file?.content) useLive.getState().set({ code: { path: code.file.path, content: code.file.content } });
        else if (reason === "open" && msg.project?.firmware) void loadMainSketch(msg.dir ?? "");
        // Ready to run here: the latest built hex (quietly; Run says why when there is none).
        void fetchFirmware().then(() => autoRunOnOpen());
      } else if (msg.type === "project") {
        // Sent just before the new project's hello (jumper serve switched projects).
        expectProject((msg as { id?: string }).id);
      } else if (msg.type === "action" && msg.entry) {
        player.apply(msg.entry);
        if (msg.entry.ok && msg.entry.op === "write_file") onSketchWritten();
        if (msg.entry.ok && FILE_REWRITING_OPS.has(msg.entry.op)) void refreshCodeCard();
      } else if (msg.type === "agent-state" && msg.state) {
        feedAgentState(msg.state);
      } else if (msg.type === "firmware" && msg.hash) {
        void onFirmwareEvent(msg.hash);
      } else if (msg.type === "auto-run") {
        void onAutoRun(msg.hash);
      } else if (msg.type === "result" && msg.ok === false) {
        useJumper.getState().toast({ kind: "error", title: "The session refused", detail: msg.error ?? "" });
      }
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
  };
}

function LiveBar() {
  const { mode, connected, dir, replay, autoRun, firmwareStale } = useLive();
  const agent = useAgentState();
  const run = useJumper((s) => s.run);
  if (mode === "follow") {
    const here = engine.isLocalRun && run !== "idle";
    return (
      <div className="live-bar" data-testid="live-bar">
        <span className={`live-dot ${connected ? "on" : ""}`} />
        <span className="live-bar-title">{connected ? "Live" : "Reconnecting…"}</span>
        <span className="live-bar-dim">
          <span className="live-follow-dir">following {dir ? dir.split("/").slice(-2).join("/") : "agent session"} · </span>
          <span data-testid="live-actions" title="Tool calls made by agents on this server (ok or failed)">
            {agent.status === "none" ? "no agent yet" : `${plural(agent.actions, "agent action")}`}
          </span>
        </span>
        {here ? (
          <span className="live-chip-run" data-testid="live-running-here" title="The device runs in this page with the agent's latest firmware; press its buttons, turn its knobs">
            {run === "running" ? "running here" : "paused here"}
          </span>
        ) : null}
        {firmwareStale ? (
          <span className="live-bar-dim" data-testid="live-stale" title="The agent changed the sketch after the last build; the device here runs the last build until the agent builds again">
            · sketch changed, not built yet
          </span>
        ) : null}
        <label className="live-autorun" title="Start the device here after the agent builds, runs or tests">
          <input type="checkbox" data-testid="autorun-toggle" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
          Auto-run
        </label>
      </div>
    );
  }
  return (
    <div className="live-bar" data-testid="live-bar">
      <span className="live-dot replay on" />
      <span className="live-bar-title">Replay</span>
      <button className="live-btn" aria-label="Restart" onClick={() => replayPlayer?.restart()}>
        ⏮
      </button>
      <button className="live-btn" aria-label={replay.playing ? "Pause" : "Play"} data-testid="replay-play" onClick={() => (replay.playing ? replayPlayer?.pause() : replayPlayer?.play())}>
        {replay.playing ? "❚❚" : "▶"}
      </button>
      <select className="live-speed" aria-label="Replay speed" value={replay.speed} onChange={(e) => replayPlayer?.setSpeed(Number(e.target.value))}>
        {[...new Set([...SPEEDS, replay.speed])].sort((a, b) => a - b).map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <span className="live-progress">
        <span style={{ width: `${replay.total ? (replay.index / replay.total) * 100 : 0}%` }} />
      </span>
      <span className="live-bar-dim" data-testid="replay-index">
        {replay.index}/{replay.total}
        {replay.done ? " · done" : ""}
      </span>
    </div>
  );
}

const STATUS_LABEL: Record<LiveStep["status"], string> = { pending: "pending", accepted: "accepted", rejected: "rejected", undone: "undone" };

/** The agent's steps with each "why", accept / reject (follow mode). Rendered in the Agent steps panel. */
export function StepsList() {
  const mode = useLive((s) => s.mode);
  // Round 6 (switch): the person's own edits are not agent steps to accept.
  const steps = useAgentSteps();
  const shown = steps.slice(-12);
  const pending = steps.filter((s) => s.status === "pending").length;
  const agent = useAgentState();
  if (!shown.length)
    return (
      <div className="live-steps" data-testid="live-steps" data-agent-status={agent.status}>
        <p className="panel-empty" data-testid="agent-steps-state">
          {agent.status === "none"
            ? "No agent yet. Connect one (Install MCP, or Connect next to the agent pill) and ask it to build something; its steps appear here with each reason."
            : agent.status === "building"
              ? `${agentLabel(agent)}. Its changes appear here as steps.`
              : `${agentLabel(agent)}. It has not changed the project yet.`}
        </p>
      </div>
    );
  return (
    <div className="live-steps" data-testid="live-steps" data-agent-status={agent.status} aria-label="Agent steps">
      <header>
        <span>
          {steps.length} step{steps.length === 1 ? "" : "s"}
          {pending ? ` · ${pending} pending` : ""}
        </span>
        {mode === "follow" && pending > 0 ? (
          <button className="live-btn small" onClick={() => steps.filter((s) => s.status === "pending").forEach((s) => sendCommand("accept_step", { step: s.id }))}>
            Accept all
          </button>
        ) : null}
      </header>
      <ol>
        {shown.map((s) => (
          <li key={s.id} data-status={s.status}>
            <div className="live-step-why">{s.why}</div>
            <div className="live-step-ops">
              {s.ops.slice(-3).join(" · ")}
              {s.ops.length > 3 ? ` +${s.ops.length - 3}` : ""}
            </div>
            <div className="live-step-foot">
              <span className={`live-chip ${s.status}`}>{STATUS_LABEL[s.status]}</span>
              {mode === "follow" && (s.status === "pending" || s.status === "accepted") ? (
                <span className="live-step-actions">
                  {s.status === "pending" ? (
                    <button className="live-btn small" onClick={() => sendCommand("accept_step", { step: s.id })}>
                      Accept
                    </button>
                  ) : null}
                  <button className="live-btn small danger" onClick={() => sendCommand("reject_step", { step: s.id })}>
                    Reject
                  </button>
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AgentCursor() {
  const cursor = useLive((s) => s.cursor);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    if (!cursor) return;
    setVisible(true);
    let raf = 0;
    const until = performance.now() + 900;
    const place = () => {
      const el = ref.current;
      const stage = el?.closest(".stage");
      const target =
        (cursor.pin && document.querySelector(`[data-testid="pin-${CSS.escape(cursor.part)}-${CSS.escape(cursor.pin)}"]`)) ||
        document.querySelector(`[data-testid="part-${CSS.escape(cursor.part)}"]`);
      if (el && stage && target) {
        const s = stage.getBoundingClientRect();
        const t = target.getBoundingClientRect();
        const x = cursor.pin ? t.left + t.width / 2 - s.left : t.left + Math.min(t.width * 0.7, t.width - 10) - s.left;
        const y = cursor.pin ? t.top + t.height / 2 - s.top : t.top + Math.min(t.height * 0.35, 60) - s.top;
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      }
      if (performance.now() < until) raf = requestAnimationFrame(place);
    };
    raf = requestAnimationFrame(place);
    const hide = setTimeout(() => setVisible(false), 4000);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hide);
    };
  }, [cursor]);
  return (
    <div ref={ref} className={`live-cursor ${visible && cursor ? "on" : ""}`} data-testid="agent-cursor" aria-hidden>
      <svg width="22" height="22" viewBox="0 0 22 22">
        <path d="M2 2 L19 9 L11 11 L9 19 Z" fill="#4DA3FF" stroke="#0D0F12" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      {cursor ? <span className="live-cursor-label">{cursor.label}</span> : null}
    </div>
  );
}

function CodeCard() {
  const code = useLive((s) => s.code);
  const tests = useLive((s) => s.tests);
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(true), [code]);
  // Once tests have run the code is old news: fold it so the circuit (and its screen) has room.
  useEffect(() => {
    if (tests) setOpen(false);
  }, [tests]);
  if (!code) return null;
  const lines = code.content.split("\n");
  return (
    <section className={`live-code ${open ? "" : "closed"}`} data-testid="live-code" aria-label="Firmware written by the agent">
      <header onClick={() => setOpen((o) => !o)}>
        <span className="mono">{code.path}</span>
        <span className="live-bar-dim">{lines.length} lines</span>
      </header>
      {open ? (
        <pre>
          {lines.slice(0, 80).map((l, i) => (
            <div key={i}>
              <span className="ln">{i + 1}</span>
              {l || " "}
            </div>
          ))}
        </pre>
      ) : null}
    </section>
  );
}

function TestsCard() {
  const tests = useLive((s) => s.tests);
  const fidelity = useLive((s) => s.fidelity);
  if (!tests && !fidelity) return null;
  return (
    <section className="live-tests" data-testid="live-tests" data-failed={tests?.failed ?? 0}>
      {tests ? (
        <>
          <header>
            Tests <b className={tests.failed ? "bad" : "good"}>{tests.passed}/{tests.passed + tests.failed} passed</b>
          </header>
          <ul>
            {tests.results.map((r) => (
              <li key={r.id} data-passed={r.passed}>
                <span className="live-test-mark">{r.passed ? "✓" : "✗"}</span> {r.id}
                {r.reason ? <div className="live-test-reason">{r.reason}</div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {fidelity ? (
        <div className="live-fidelity" data-testid="live-fidelity">
          <header>Fidelity: what the simulation does not prove</header>
          <div className="live-fidelity-areas">
            {fidelity.areas.map((a) => (
              <span key={a.name} data-level={a.level}>
                {a.name} <b>{a.level}</b>
              </span>
            ))}
          </div>
          {fidelity.realDevice.length ? (
            <>
              <div className="live-fidelity-count">{fidelity.realDevice.length} checks for the real device, e.g.</div>
              <ul>
                {fidelity.realDevice.slice(0, 3).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Caption() {
  const caption = useLive((s) => s.caption);
  const error = useLive((s) => s.error);
  if (!caption && !error) return null;
  const c = caption ?? { title: "Error", detail: error, ok: false };
  return (
    <div className={`live-caption ${c.ok ? "" : "bad"}`} data-testid="live-caption" key={`${c.title}|${c.detail ?? ""}`}>
      <div className="live-caption-title">{c.title}</div>
      {c.detail ? <div className="live-caption-detail">{c.detail}</div> : null}
    </div>
  );
}

function WorldPanel() {
  const world = useLive((s) => s.world);
  if (!world) return null;
  return (
    <section className="live-world" data-testid="live-world" aria-label={world === "robot" ? "Robot arena" : "Robot arm"}>
      <PhysicsCanvas getSnapshot={worldTracker.snapshot} paint={world === "robot" ? drawWorld : drawArm} label={world === "robot" ? "Robot arena, top view" : "Robot arm, side view"} />
    </section>
  );
}
