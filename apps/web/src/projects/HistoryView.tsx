import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Code2, Cpu, History, MonitorPlay, RotateCcw } from "lucide-react";
import { useJumper } from "../lib/app.ts";
import { STROKE } from "../shell/primitives.tsx";
import { NO_SERVER, actorLabel, ago, api, entityLabel, type VersionDetail, type VersionSummary } from "./api.ts";
import { useServer } from "./data.ts";
import { useProjectsUi } from "./store.ts";
import "./projects.css";

/**
 * History: every change to the project is a version (an action-log line that changed the circuit
 * or a file, C3). The scrubber shows the canvas at version N with the device state of the run that
 * followed it (lit LEDs, screens), what changed, who did it and why, and restores it as a new step.
 */
export function HistoryView() {
  const open = useProjectsUi((s) => s.history);
  const tick = useProjectsUi((s) => s.tick);
  const server = useServer();
  const projectName = useJumper((s) => s.project.name);
  const [versions, setVersions] = useState<VersionSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [n, setN] = useState<number | undefined>();
  const [detail, setDetail] = useState<VersionDetail | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const followLatest = useRef(true);

  useEffect(() => {
    if (!open) {
      followLatest.current = true;
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape") useProjectsUi.getState().setHistory(false);
      else if (t?.tagName !== "INPUT" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        followLatest.current = false;
        setN((v) => (v === undefined ? v : Math.max(1, v + (e.key === "ArrowLeft" ? -1 : 1))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // The version list: on open and whenever the project changes (an agent keeps building).
  useEffect(() => {
    if (!open || server !== "yes") return;
    let alive = true;
    api
      .history()
      .then((h) => {
        if (!alive) return;
        setVersions(h.versions);
        setError(undefined);
        setN((cur) => (followLatest.current || cur === undefined || cur > h.versions.length ? h.versions.length || undefined : cur));
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [open, server, tick]);

  // The selected version in full (debounced while scrubbing).
  useEffect(() => {
    if (!open || !n) return;
    let alive = true;
    const t = setTimeout(() => {
      api
        .version(n)
        .then((d) => alive && setDetail(d))
        .catch((e: Error) => alive && setError(e.message));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, n, versions?.length]);

  useEffect(() => setConfirming(false), [n]);

  const pick = useCallback(
    (v: number) => {
      followLatest.current = !!versions && v === versions.length;
      setN(v);
    },
    [versions],
  );

  if (!open) return null;
  const close = () => useProjectsUi.getState().setHistory(false);
  const total = versions?.length ?? 0;
  const current = n && versions ? versions[n - 1] : undefined;
  const latest = !!n && n === total;
  const shown = detail && detail.version === n ? detail : undefined;

  const restore = async () => {
    if (!n) return;
    setRestoring(true);
    try {
      const r = await api.restore(n, `restore version ${n}${current?.why ? ` ("${current.why}")` : ""}`);
      followLatest.current = true;
      useProjectsUi.getState().bump();
      useJumper.getState().toast({ kind: "info", title: r.step === null ? `Already at version ${n}` : `Restored version ${n}`, detail: r.step === null ? r.note : "It is a new version at the end of the timeline, so nothing was lost. Undo brings the newer state back." });
    } catch (e) {
      useJumper.getState().toast({ kind: "error", title: `Could not restore version ${n}`, detail: (e as Error).message });
    } finally {
      setRestoring(false);
      setConfirming(false);
    }
  };

  return (
    <div className="pj-history" role="dialog" aria-modal="true" aria-label="History" data-testid="history-view" data-version={n ?? 0} data-versions={total}>
      <header className="pj-history-head">
        <button type="button" className="pj-btn" onClick={close} data-testid="history-close">
          <ArrowLeft size={16} strokeWidth={STROKE} aria-hidden /> Canvas
        </button>
        <div className="pj-history-title">
          <History size={16} strokeWidth={STROKE} aria-hidden />
          <span>History</span>
          <span className="muted">
            {projectName}
            {total ? ` · ${total} version${total === 1 ? "" : "s"}` : ""}
          </span>
        </div>
      </header>

      {server === "no" ? (
        <p className="pj-callout pj-history-empty" data-testid="history-no-server">
          {NO_SERVER}
        </p>
      ) : error ? (
        <p className="pj-callout pj-callout-error pj-history-empty" role="alert">
          {error}
        </p>
      ) : versions && !total ? (
        <p className="pj-callout pj-history-empty" data-testid="history-empty">
          No versions yet. Every change (a part placed, a wire, a sketch saved) becomes a version here, whether you or an agent made it.
        </p>
      ) : (
        <div className="pj-history-main">
          <figure className="pj-history-stage" data-testid="history-preview">
            {n ? <img key={`${n}-${total}`} src={`/api/history/${n}/preview.svg?t=${total}`} alt={`The canvas at version ${n}`} /> : null}
            <figcaption>
              {shown?.frame ? (
                <>
                  <MonitorPlay size={13} strokeWidth={STROKE} aria-hidden /> The device as it ran at {(shown.frame.t_ms / 1000).toFixed(1)} s on this version
                  {shown.project.parts.some((p) => /tft|ili9341|st7735|gc9a01/.test(p.type)) ? <span className="muted"> (colour screens are not recorded in the history, so they show dark)</span> : null}
                </>
              ) : shown ? (
                "Not run at this version: lights and screens are shown off"
              ) : (
                " "
              )}
            </figcaption>
          </figure>
          <aside className="pj-history-side" data-testid="history-details">
            {current ? (
              <>
                <div className="pj-v-head">
                  <span className="pj-v-num" data-testid="history-version-label">
                    Version {current.version} of {total}
                  </span>
                  {latest ? <span className="pj-chip is-good">current</span> : null}
                </div>
                <div className="pj-v-who">
                  <span className={`pj-avatar pj-avatar-${current.actor}`} aria-hidden>
                    {actorLabel(current.actor, current.client).slice(0, 1)}
                  </span>
                  <span>
                    <b>{actorLabel(current.actor, current.client)}</b> <span className="muted">{ago(current.t)}</span>
                  </span>
                </div>
                {current.why ? <blockquote className="pj-v-why">{current.why}</blockquote> : null}
                {current.summary ? <p className="pj-v-summary mono">{current.summary}</p> : null}
                <h3>What changed</h3>
                <Changes changes={current.changes} />
                <h3>Firmware</h3>
                <p className="pj-v-fw">
                  <Cpu size={13} strokeWidth={STROKE} aria-hidden />{" "}
                  {current.firmwareHash ? (
                    <>
                      built <span className="mono">{current.firmwareHash.slice(0, 10)}</span>
                      {shown?.firmware ? null : <span className="muted"> (hex not kept)</span>}
                    </>
                  ) : current.firmwareBuilt ? (
                    <span className="muted">built (this history is older than kept builds, so its hex is not stored)</span>
                  ) : (
                    <span className="muted">not built at this version</span>
                  )}
                </p>
                <div className="pj-v-actions">
                  <button
                    type="button"
                    className="pj-btn"
                    disabled={!shown || !Object.keys(shown.files).length}
                    data-testid="history-view-code"
                    onClick={() => {
                      if (!shown) return;
                      const main = shown.project.firmware?.sketch ? `firmware/${shown.project.firmware.sketch}` : Object.keys(shown.files)[0];
                      useProjectsUi.getState().openCode(main, { version: shown.version, files: shown.files });
                    }}
                  >
                    <Code2 size={15} strokeWidth={STROKE} aria-hidden /> Code at this version
                  </button>
                  {confirming ? (
                    <div className="pj-confirm" role="group" aria-label="Confirm restore">
                      <span>Restore version {n}? It becomes a new version; nothing is lost.</span>
                      <button type="button" className="pj-btn pj-btn-primary" disabled={restoring} onClick={() => void restore()} data-testid="history-restore-confirm">
                        {restoring ? "Restoring…" : "Restore"}
                      </button>
                      <button type="button" className="pj-btn" onClick={() => setConfirming(false)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="pj-btn pj-btn-primary" disabled={latest} title={latest ? "This is the current version" : undefined} onClick={() => setConfirming(true)} data-testid="history-restore">
                      <RotateCcw size={15} strokeWidth={STROKE} aria-hidden /> Restore this version
                    </button>
                  )}
                </div>
              </>
            ) : null}
          </aside>
        </div>
      )}

      {total ? (
        <footer className="pj-timeline">
          <button type="button" className="icon-btn" aria-label="Previous version" disabled={!n || n <= 1} onClick={() => n && pick(n - 1)}>
            <ChevronLeft size={18} strokeWidth={STROKE} aria-hidden />
          </button>
          <div className="pj-track">
            <Ticks versions={versions!} current={n} onPick={pick} />
            <input type="range" min={1} max={total} step={1} value={n ?? total} aria-label="Version" aria-valuetext={current ? `Version ${current.version}: ${current.why ?? current.op}` : undefined} data-testid="history-scrubber" onChange={(e) => pick(Number(e.currentTarget.value))} />
          </div>
          <button type="button" className="icon-btn" aria-label="Next version" disabled={!n || n >= total} onClick={() => n && pick(n + 1)}>
            <ChevronRight size={18} strokeWidth={STROKE} aria-hidden />
          </button>
        </footer>
      ) : null}
    </div>
  );
}

function Ticks({ versions, current, onPick }: { versions: VersionSummary[]; current?: number; onPick(n: number): void }) {
  // One mark per version, coloured by who made it; at most ~200 drawn (long agent sessions).
  const every = Math.max(1, Math.ceil(versions.length / 200));
  const marks = useMemo(() => versions.filter((v, i) => i % every === 0 || i === versions.length - 1), [versions, every]);
  const span = Math.max(1, versions.length - 1);
  return (
    <div className="pj-ticks" aria-hidden>
      {marks.map((v) => (
        <span key={v.version} className={`pj-tick pj-tick-${v.actor}${v.version === current ? " is-current" : ""}${v.hasFrame ? " has-frame" : ""}`} style={{ left: `${((v.version - 1) / span) * 100}%` }} onClick={() => onPick(v.version)} title={`${v.version}: ${v.why ?? v.op}`} />
      ))}
    </div>
  );
}

function Changes({ changes }: { changes: VersionSummary["changes"] }) {
  const rows = [...changes.added.map((k) => ["added", k] as const), ...changes.removed.map((k) => ["removed", k] as const), ...changes.changed.map((k) => ["changed", k] as const)];
  if (!rows.length) return <p className="muted pj-v-none">Nothing in the circuit or files (a step was accepted, or the change was undone in the same op).</p>;
  return (
    <ul className="pj-changes" data-testid="history-changes">
      {rows.slice(0, 40).map(([how, key]) => {
        const { kind, id } = entityLabel(key);
        return (
          <li key={`${how}-${key}`} data-how={how}>
            <span className="pj-change-sign">{how === "added" ? "+" : how === "removed" ? "−" : "~"}</span>
            <span className="pj-change-kind">{kind}</span>
            <span className="mono">{id}</span>
          </li>
        );
      })}
      {rows.length > 40 ? <li className="muted">and {rows.length - 40} more</li> : null}
    </ul>
  );
}
