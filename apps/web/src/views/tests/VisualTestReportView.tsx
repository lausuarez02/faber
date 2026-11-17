// The visual test report: one row per scenario (pass / fail, time), and under it a filmstrip of
// what the device showed at every check (screen pixels, robot in the arena, arm pose) with the
// value the check saw. Clicking a frame opens the device at exactly that moment (ScrubView).
import "./tests.css";
import { useMemo, useState } from "react";
import { Check, ChevronRight, Film, X as XIcon } from "lucide-react";
import type { Project } from "@fabwright/project-format";
import type { VisualFrame, VisualReport, VisualScenario } from "./types.ts";
import { FrameThumb, useWorldSpec } from "./thumbs.tsx";
import { ScrubView } from "./ScrubView.tsx";

export interface VisualTestReportViewProps {
  report: VisualReport;
  project: Project;
  /** Firmware hex for scrubbing (the same build the report ran). */
  hex: string | undefined;
  /** Where the report came from ("examples/tamagotchi · static", "session · just now"). */
  sourceNote?: string;
  /** Scenario ids open at start (default: the failed ones, else the first). */
  open?: string[];
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")} min`;
}

/** The frames a filmstrip shows: every check, every failure, and the inputs (press / set) as small markers. */
export function stripFrames(s: VisualScenario): VisualFrame[] {
  return s.frames.filter((f) => f.kind.startsWith("expect") || !f.ok || f.kind === "press" || f.kind === "set" || f.kind === "inject_fault");
}

export function VisualTestReportView({ report, project, hex, sourceNote, open: openInit }: VisualTestReportViewProps) {
  const [open, setOpen] = useState<Set<string>>(() => {
    if (openInit) return new Set(openInit);
    const failed = report.scenarios.filter((s) => !s.passed).map((s) => s.id);
    if (failed.length) return new Set(failed);
    // Otherwise open the first scenario whose strip ends on something to see (a lit screen, a robot, an arm).
    const visible = report.scenarios.find((s) => {
      const st = s.frames[s.frames.length - 1]?.state;
      return !!st && (st.robot || st.arm || Object.values(st.displays ?? {}).some((d) => Number(d.state.lit) > 0));
    });
    return new Set([(visible ?? report.scenarios[0])?.id].filter((x): x is string => !!x));
  });
  const [scrub, setScrub] = useState<{ scenario: VisualScenario; t: number } | null>(null);
  const world = useWorldSpec(project);
  const checks = report.scenarios.reduce((n, s) => n + s.frames.filter((f) => f.kind.startsWith("expect")).length, 0);
  const allPassed = report.failed === 0;
  const toggle = (id: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="vt" data-testid="visual-test-report">
      <div className="vt-summary">
        <span className={`vt-badge ${allPassed ? "ok" : "fail"}`}>
          {allPassed ? <Check size={13} strokeWidth={2.2} /> : <XIcon size={13} strokeWidth={2.2} />}
          {report.passed}/{report.scenarios.length} passed
        </span>
        <span className="vt-muted">{checks} checks</span>
        {sourceNote ? <span className="vt-muted vt-source">{sourceNote}</span> : null}
      </div>
      {report.project !== project.name ? <p className="vt-note">This report is for "{report.project}", not the open project; scrubbing replays it on the open project.</p> : null}
      <ul className="vt-list">
        {report.scenarios.map((s) => (
          <ScenarioRow key={s.id} s={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} world={world} onFrame={(t) => setScrub({ scenario: s, t })} />
        ))}
      </ul>
      {scrub ? <ScrubView project={project} hex={hex} scenario={scrub.scenario} initialT={scrub.t} world={world} onClose={() => setScrub(null)} /> : null}
    </div>
  );
}

function ScenarioRow({ s, open, onToggle, world, onFrame }: { s: VisualScenario; open: boolean; onToggle: () => void; world: ReturnType<typeof useWorldSpec>; onFrame: (t: number) => void }) {
  const frames = useMemo(() => stripFrames(s), [s]);
  // Robot path up to each frame, from the keyframes (every ~1/24 of the run).
  const pathAt = (t: number) => (s.keyframes ?? []).filter((k) => k.t <= t && k.state.robot).map((k) => ({ x: k.state.robot!.x, y: k.state.robot!.y }));
  return (
    <li className={`vt-row ${s.passed ? "ok" : "fail"}`} data-scenario={s.id} data-passed={s.passed}>
      <button className="vt-row-head" onClick={onToggle} aria-expanded={open}>
        <span className={`vt-dot ${s.passed ? "ok" : "fail"}`} aria-label={s.passed ? "passed" : "failed"}>
          {s.passed ? <Check size={11} strokeWidth={2.6} /> : <XIcon size={11} strokeWidth={2.6} />}
        </span>
        <span className="vt-row-name">{s.name ?? s.id}</span>
        <span className="vt-row-meta">{fmtMs(s.t_ms)}</span>
        <ChevronRight size={14} strokeWidth={1.6} className="vt-chev" />
      </button>
      {!s.passed && s.reason ? <p className="vt-reason">{s.reason}</p> : null}
      {open ? (
        <div className="vt-strip" role="list" aria-label={`${s.id} frames`}>
          {frames.map((f) => {
            const input = !f.kind.startsWith("expect") && f.ok;
            return (
              <button
                key={f.step}
                role="listitem"
                className={`vt-frame ${f.ok ? "ok" : "fail"} ${input ? "input" : ""}`}
                onClick={() => onFrame(f.t)}
                title={`${f.label}${f.value ? `\n${f.value}` : ""}\nat ${f.t.toFixed(1)} ms · click to open the device at this moment`}
                data-step={f.step}
              >
                <FrameThumb snap={f.state} world={world} path={pathAt(f.t)} />
                <span className="vt-frame-label">
                  <i className={`vt-mini ${f.ok ? "ok" : "fail"}`} />
                  <span className="vt-mono">{f.label}</span>
                </span>
                {f.value ? <span className="vt-frame-value">{f.value}</span> : null}
                <span className="vt-frame-t vt-mono">{fmtMs(f.t)}</span>
              </button>
            );
          })}
          <button className="vt-frame vt-open" onClick={() => onFrame(0)} title="Open the device at t = 0 and scrub through the whole test">
            <span className="vt-open-in">
              <Film size={18} strokeWidth={1.5} />
              Scrub the whole run
            </span>
          </button>
        </div>
      ) : null}
    </li>
  );
}
