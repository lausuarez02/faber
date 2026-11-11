import { useEffect, useState, useSyncExternalStore } from "react";
import { Globe, Code2, Cpu, Eraser, FileCode2, FlaskConical, Gauge, GraduationCap, Keyboard, MessagesSquare, SlidersHorizontal, SquareTerminal, Upload, CircleCheck, CircleDashed } from "lucide-react";
import { engine, useJumper } from "../lib/app.ts";
import { getDef } from "../lib/parts.ts";
import { PANEL_ORDER, useIsPhone, useUi, type PanelId } from "../lib/ui.ts";
import { useLive } from "../live/liveStore.ts";
import { StepsList } from "../live/LiveLayer.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { SerialConsole } from "../components/SerialConsole.tsx";
import { WorldPanel } from "../components/WorldPanel.tsx";
import { VisualTestReport } from "../views/tests/VisualTestReport.tsx";
import { NetworkPanel } from "../views/network/NetworkPanel.tsx";
import { DeviceNetworkBody } from "../views/network/DeviceNetworkPanel.tsx";
import { FloatingPanel, IconButton } from "./primitives.tsx";
import { boardOf, loadHexFile, pickFile } from "./actions.ts";
import { useFirmwareFiles } from "../projects/files.ts";
import { useProjectsUi } from "../projects/store.ts";

const BODIES: Record<PanelId, () => React.JSX.Element> = {
  agent: AgentPanel,
  inspector: InspectorPanel,
  serial: SerialPanel,
  tests: TestsPanel,
  network: DeviceNetworkPanel, // round 10 net
  firmware: FirmwarePanel,
  instruments: InstrumentsPanel,
  help: HelpPanel,
  learn: LearnPanel,
};

/**
 * The right column of floating panels (bottom sheet on phones). Panels stack in a fixed order;
 * the World card (robot projects) sits under the inspector.
 */
export function PanelColumn() {
  const panels = useUi((s) => s.panels);
  const open = PANEL_ORDER.filter((p) => panels.includes(p));
  return (
    <aside className="panel-column" data-testid="panel-column" data-count={open.length} aria-label="Panels">
      {open.map((id) => {
        const Body = BODIES[id];
        return <Body key={id} />;
      })}
      <WorldPanel />
      <NetworkCard />
    </aside>
  );
}

/** The sandbox Wi-Fi and pet AI, shown while a simulation with a Wi-Fi part (ESP-01) exists. */
function NetworkCard() {
  const net = useSyncExternalStore(engine.subscribeNetwork, engine.getNetwork, engine.getNetwork);
  const phone = useIsPhone();
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(false), [net]);
  // Phones show one sheet at a time; the network log would cover the circuit there.
  if (!net || hidden || phone) return null;
  return (
    <div className="network-card" data-testid="network-panel">
      <NetworkPanel net={net} onClose={() => setHidden(true)} />
    </div>
  );
}

/** Desktop: the inspector opens for a selection and closes when it clears (unless opened by hand). */
export function useAutoInspector(phone: boolean): void {
  useEffect(
    () =>
      useJumper.subscribe((s, prev) => {
        const n = s.selectedParts.length + s.selectedWires.length;
        const was = prev.selectedParts.length + prev.selectedWires.length;
        if (n === was && s.selectedParts === prev.selectedParts && s.selectedWires === prev.selectedWires) return;
        const ui = useUi.getState();
        if (n > 0 && !phone) ui.openPanel("inspector", { auto: !ui.panels.includes("inspector") || ui.inspectorAuto });
        else if (n === 0 && ui.inspectorAuto) ui.closePanel("inspector");
      }),
    [phone],
  );
}

function InspectorPanel() {
  return (
    <FloatingPanel id="inspector" title="Inspector" icon={SlidersHorizontal}>
      <Inspector />
    </FloatingPanel>
  );
}

function SerialPanel() {
  // arduino-pico's Serial is the USB port (Serial1/Serial2 are the UARTs on pins); AVR's is UART0.
  const project = useJumper((s) => s.project);
  const id = boardOf(project)?.id;
  const type = id ? project.parts.find((p) => p.id === id)?.type : undefined;
  const usb = !!type && getDef(type)?.spec.mcu?.backend === "rp2040js";
  return (
    <FloatingPanel id="serial" title="Serial" meta={usb ? "USB" : "UART0"} icon={SquareTerminal} actions={<IconButton icon={Eraser} iconSize={15} className="icon-btn-sm" label="Clear console" onClick={() => engine.clearSerial()} />}>
      <SerialConsole />
    </FloatingPanel>
  );
}

/** Round 10: boards on Jumper's device network (requests, frames, Wi-Fi, faults); needs jumper serve. */
function DeviceNetworkPanel() {
  return (
    <FloatingPanel id="network" title="Network" icon={Globe} testId="panel-device-network">
      <DeviceNetworkBody />
    </FloatingPanel>
  );
}

function TestsPanel() {
  const scenarios = useJumper((s) => s.project.scenarios);
  const live = useLive((s) => s.tests);
  const results = new Map(live?.results.map((r) => [r.id, r]) ?? []);
  return (
    <FloatingPanel id="tests" title="Tests" icon={FlaskConical} actions={live ? <span className={`count-chip ${live.failed ? "is-bad" : "is-good"}`}>{live.passed}/{live.passed + live.failed}</span> : null}>
      <VisualTestReport />
      {scenarios.length === 0 ? (
        <p className="panel-empty">
          No scenarios yet. Ask the agent to <code>write_scenario</code>, or add one under <code>scenarios</code> in jumper.json, then run <code>jumper test -p &lt;dir&gt;</code>.
        </p>
      ) : (
        <ul className="test-list" data-testid="test-list">
          {scenarios.map((sc) => {
            const r = results.get(sc.id);
            return (
              <li key={sc.id} data-passed={r ? String(r.passed) : undefined}>
                {r ? r.passed ? <CircleCheck size={15} strokeWidth={1.8} className="ok" aria-label="passed" /> : <CircleDashed size={15} strokeWidth={1.8} className="bad" aria-label="failed" /> : <CircleDashed size={15} strokeWidth={1.6} className="idle" aria-label="not run" />}
                <span className="test-name">{sc.name ?? sc.id}</span>
                <span className="test-meta mono">{sc.steps.length} steps</span>
                {r?.reason ? <div className="test-reason">{r.reason}</div> : sc.description ? <div className="test-desc">{sc.description}</div> : null}
              </li>
            );
          })}
        </ul>
      )}
    </FloatingPanel>
  );
}

function FirmwarePanel() {
  const fw = useJumper((s) => s.firmware);
  const project = useJumper((s) => s.project);
  const f = project.firmware;
  const board = boardOf(project);
  const files = useFirmwareFiles();
  const openCode = (path?: string) => useProjectsUi.getState().openCode(path);
  return (
    <FloatingPanel id="firmware" title="Firmware" icon={FileCode2}>
      <div data-testid="firmware-status" data-status={fw.status}>
        {f ? (
          <dl className="kv">
            <dt>board</dt>
            <dd className="mono">
              {f.board}
              {board ? <span className="muted"> · {board.name}</span> : null}
            </dd>
            <dt>sketch</dt>
            <dd className="mono">
              {f.sketch ? (
                <button type="button" className="link-btn mono" onClick={() => openCode(`firmware/${f.sketch}`)} data-testid="firmware-sketch" title="Open the code">
                  {f.sketch}
                </button>
              ) : (
                "—"
              )}
            </dd>
            <dt>artifact</dt>
            <dd className="mono">{f.artifact}</dd>
            <dt>status</dt>
            <dd>
              <span className={`state-chip state-${fw.status}`}>{fw.status === "ready" ? `loaded · ${fw.name.split("/").pop()}` : fw.status === "loading" ? "loading" : fw.status === "missing" ? "not built" : "none"}</span>
            </dd>
          </dl>
        ) : board ? (
          <p className="panel-empty">No sketch yet for {board.name}. Write one in the code editor, ask an agent to write it, or load a .hex.</p>
        ) : (
          <p className="panel-empty">No board yet. Add one (an Arduino Uno is a good start), then write its sketch in the code editor or let an agent do it.</p>
        )}
        {files.length ? (
          <ul className="fw-files" data-testid="firmware-files">
            {files.map((path) => (
              <li key={path}>
                <button type="button" className="fw-file" onClick={() => openCode(path)} data-testid={`firmware-file-${path}`}>
                  <FileCode2 size={14} strokeWidth={1.6} aria-hidden />
                  <span className="mono">{path.replace(/^firmware\//, "")}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {fw.status === "missing" ? (
          <p className="callout callout-warn">
            {fw.reason}. Fix: build it with <code>jumper run -p &lt;dir&gt;</code> (Docker, or natively after <code>jumper setup</code>), or load the .hex below.
          </p>
        ) : null}
        <div className="insp-row">
          <button type="button" className="btn" onClick={() => openCode()} data-testid="firmware-open-code">
            <Code2 size={15} strokeWidth={1.6} aria-hidden /> Code
          </button>
          <button type="button" className="btn" onClick={() => pickFile(".hex,text/plain", (file) => void loadHexFile(file))}>
            <Upload size={15} strokeWidth={1.6} aria-hidden /> Load .hex…
          </button>
        </div>
      </div>
    </FloatingPanel>
  );
}

/** Live voltages on the board's pins, polled 5× a second while the panel is open. */
function InstrumentsPanel() {
  const project = useJumper((s) => s.project);
  const run = useJumper((s) => s.run);
  const board = boardOf(project);
  const def = board ? getDef(project.parts.find((p) => p.id === board.id)!.type) : undefined;
  const pins = (def?.spec.pins ?? []).filter((p) => p.type === "digital" || p.type === "analog");
  const [v, setV] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!board) return;
    const read = () => {
      const sim = engine.simulation;
      if (!sim) return setV({});
      const next: Record<string, number> = {};
      for (const p of pins) {
        try {
          next[p.id] = sim.pinVoltage(board.id, p.id);
        } catch {
          // pin not in the netlist
        }
      }
      setV(next);
    };
    read();
    const t = setInterval(read, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?.id, run, pins.length]);
  return (
    <FloatingPanel id="instruments" title={board ? `Instruments · ${board.id}` : "Instruments"} icon={Gauge}>
      {!board ? (
        <p className="panel-empty">Place a board to read its pins.</p>
      ) : (
        <>
          <div className="pin-grid" data-testid="pin-grid">
            {pins.map((p) => {
              const volts = v[p.id];
              const high = volts !== undefined && volts > 2.5;
              return (
                <div key={p.id} className={`pin-cell ${high ? "is-high" : ""}`} title={`${p.label}: ${volts === undefined ? "no reading" : `${volts.toFixed(2)} V`}`}>
                  <span className="pin-cell-name mono">{p.label}</span>
                  <span className="pin-cell-v mono">{volts === undefined ? "—" : volts.toFixed(1)}</span>
                </div>
              );
            })}
          </div>
          <p className="panel-foot">{run === "idle" ? "Run the simulation to see live voltages." : "Volts at each pin; green is HIGH (> 2.5 V)."}</p>
        </>
      )}
    </FloatingPanel>
  );
}

function AgentPanel() {
  const mode = useLive((s) => s.mode);
  const steps = useLive((s) => s.steps);
  return (
    <FloatingPanel id="agent" title="Agent steps" icon={MessagesSquare} testId="panel-agent">
      {mode === "off" && steps.length === 0 ? (
        <div className="panel-empty">
          <p>No agent is attached to this canvas.</p>
          <p>
            Use <b>Install MCP</b> to connect Claude Code or Codex, then follow the session here: every step shows up with its <i>why</i>, and you accept or reject it.
          </p>
        </div>
      ) : (
        <StepsList />
      )}
    </FloatingPanel>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Space", "Run / pause"],
  ["V · H · W", "Select · hand · wire tool"],
  ["A", "Add part"],
  ["/", "Jump to a part"],
  ["R", "Rotate selection"],
  ["C", "Cycle wire color"],
  ["⌫", "Delete selection"],
  ["⌘Z · ⇧⌘Z", "Undo · redo"],
  ["⇧1", "Fit view"],
  ["I", "Inspector"],
  ["`", "Serial console"],
  ["Esc", "Close menus"],
];

function HelpPanel() {
  return (
    <FloatingPanel id="help" title="Keyboard shortcuts" icon={Keyboard}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, d]) => (
          <div key={k}>
            <dt>{d}</dt>
            <dd>
              {k.split(" · ").map((x) => (
                <kbd key={x}>{x}</kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </FloatingPanel>
  );
}

function LearnPanel() {
  return (
    <FloatingPanel id="learn" title="Learn Jumper" icon={GraduationCap}>
      <ol className="learn">
        <li>
          <b>Place parts.</b> The white <kbd>+</kbd> on the left opens the library; click a part or drag it onto the canvas.
        </li>
        <li>
          <b>Wire them.</b> Drag from pin to pin (or pick the wire tool and click two pins). Hover a pin to see its name.
        </li>
        <li>
          <b>Run.</b> The white Run pill compiles nothing in the browser: it runs the built firmware on a real AVR core. Serial and pin voltages update live.
        </li>
        <li>
          <b>Let an agent build it.</b> <i>Install MCP</i> connects Claude Code or Codex; they place, wire, write firmware and test with the same engine. Guide: <code>docs/agents.md</code>.
        </li>
      </ol>
      <p className="panel-foot">
        <Cpu size={13} strokeWidth={1.6} aria-hidden /> Examples are in the project menu (<kbd>…</kbd> next to the name).
      </p>
    </FloatingPanel>
  );
}
