// The device at any moment of a test: a fresh simulation replays the scenario's recorded inputs
// (exact virtual times) up to the chosen time and the 3D Device view shows it. The timeline marks
// every check (green / red) and input; drag it, click a mark, or use ←/→ to step between checks.
// Run continues live from that moment.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Project } from "@fabwright/project-format";
import type { WorldSpec } from "@fabwright/physics";
import { DeviceStage } from "../device/DeviceStage.tsx";
import { createScrubber, type Scrubber } from "./replay.ts";
import type { VisualScenario } from "./types.ts";
import { fmtMs, stripFrames } from "./VisualTestReportView.tsx";

export function ScrubView({ project, hex, scenario, initialT, onClose }: { project: Project; hex: string | undefined; scenario: VisualScenario; initialT: number; world?: WorldSpec | undefined; onClose: () => void }) {
  const [scrubber, setScrubber] = useState<Scrubber | undefined>();
  const [err, setErr] = useState<string | undefined>();
  const [t, setT] = useState(initialT);
  const timelineH = typeof window !== "undefined" && window.innerWidth < 640 ? 150 : 132;
  const [, force] = useState(0);
  const pending = useRef<number | undefined>(undefined);
  const end = Math.max(scenario.t_ms, ...scenario.frames.map((f) => f.t), 1);
  const marks = useMemo(() => stripFrames(scenario), [scenario]);
  const checks = useMemo(() => marks.filter((f) => f.kind.startsWith("expect") || !f.ok), [marks]);

  useEffect(() => {
    let live: Scrubber | undefined;
    let dead = false;
    createScrubber(project, hex, scenario.inputs).then(
      (s) => {
        if (dead) return s.dispose();
        live = s;
        s.seek(initialT);
        setScrubber(s);
      },
      (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      dead = true;
      live?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, hex, scenario]);

  const seek = useCallback(
    (to: number) => {
      const v = Math.max(0, Math.min(end, to));
      setT(v);
      if (!scrubber) return;
      scrubber.source.pause();
      // Coalesce slider drags into one replay per frame.
      if (pending.current !== undefined) cancelAnimationFrame(pending.current);
      pending.current = requestAnimationFrame(() => {
        pending.current = undefined;
        try {
          scrubber.seek(v);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
        force((n) => n + 1);
      });
    },
    [scrubber, end],
  );

  const current = useMemo(() => {
    let best = checks[0];
    for (const c of checks) if (c.t <= t + 0.5) best = c;
    return best;
  }, [checks, t]);
  const stepCheck = (dir: 1 | -1) => {
    const next = dir > 0 ? checks.find((c) => c.t > t + 0.5) : [...checks].reverse().find((c) => c.t < t - 0.5);
    if (next) seek(next.t);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        stepCheck(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepCheck(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const failedAt = scenario.failed_step !== undefined ? scenario.frames.find((f) => f.step === scenario.failed_step) : undefined;

  return (
    <div className="device-view vt-scrub" data-testid="scrub-view" role="dialog" aria-modal="true" aria-label={`Test ${scenario.id} at ${fmtMs(t)}`}>
      {scrubber ? <DeviceStage source={scrubber.source} onClose={onClose} bottomInset={timelineH} /> : <div className="vt-scrub-loading">{err ? `Could not replay the test: ${err}` : "Replaying the test…"}</div>}
      <div className="vt-timeline" style={{ ["--p" as string]: `${(t / end) * 100}%` }}>
        <div className="vt-tl-head">
          <span className={`vt-dot ${scenario.passed ? "ok" : "fail"}`} />
          <span className="vt-tl-name">{scenario.name ?? scenario.id}</span>
          <span className="vt-mono vt-tl-t">
            {fmtMs(t)} <span className="vt-muted">/ {fmtMs(end)}</span>
          </span>
          <span className="vt-tl-nav">
            <button className="vt-ghost" onClick={() => stepCheck(-1)} aria-label="Previous check" title="Previous check (←)">
              <ChevronLeft size={16} strokeWidth={1.6} />
            </button>
            <button className="vt-ghost" onClick={() => stepCheck(1)} aria-label="Next check" title="Next check (→)">
              <ChevronRight size={16} strokeWidth={1.6} />
            </button>
            <button className="vt-ghost" onClick={onClose} aria-label="Close" title="Close (Esc)">
              <X size={16} strokeWidth={1.6} />
            </button>
          </span>
        </div>
        <div className="vt-track">
          <input type="range" min={0} max={end} step={Math.max(1, end / 2000)} value={t} onChange={(e) => seek(Number(e.target.value))} aria-label="Test time" data-testid="scrub-range" />
          <div className="vt-track-line" aria-hidden />
          {marks.map((m) => (
            <button
              key={m.step}
              className={`vt-mark ${m.ok ? "ok" : "fail"} ${m.kind.startsWith("expect") ? "check" : "input"}`}
              style={{ left: `${(m.t / end) * 100}%` }}
              onClick={() => seek(m.t)}
              title={`${m.label} · ${fmtMs(m.t)}`}
              aria-label={`${m.label} at ${fmtMs(m.t)}`}
            />
          ))}
        </div>
        {current ? (
          <div className="vt-tl-now">
            <i className={`vt-mini ${current.ok ? "ok" : "fail"}`} />
            <span className="vt-mono">{current.label}</span>
            {current.value ? <span className="vt-muted vt-tl-val">{current.value}</span> : null}
          </div>
        ) : null}
        {failedAt && !scenario.passed ? <div className="vt-tl-fail">Failed at {fmtMs(failedAt.t)}: {scenario.reason}</div> : null}
        {scrubber && scrubber.skipped.length ? <div className="vt-tl-warn">Not replayed here: {scrubber.skipped.map((s) => `${s.kind} ${s.part ?? ""}`).join(", ")} (faults need the session; the agent's screenshot at_step shows them).</div> : null}
      </div>
    </div>
  );
}
