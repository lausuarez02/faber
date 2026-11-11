/**
 * Round 8 (view): how the parts go inside. Jumper works out by itself three ways to distribute the
 * parts in the case (POST /api/case/layouts): the thinnest, the smallest and a balanced one. Each
 * card draws it from the front (the outline, every part a labelled rectangle coloured by layer) and
 * in cross-section from the side (the layers stacked in depth, with mm), with its size, pocket
 * verdict, how full it is and why. Selecting one previews it in 3D (CaseView); "Use this layout"
 * builds it. In the big front view a part can be dragged (or moved with the arrow keys) to pin it
 * there: Jumper re-arranges the rest around it and shows the new size. Below, the parts advice:
 * parts the device may not need, with the mm they would save and, for a simple swap or removal,
 * an Apply button.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pin, RotateCcw, Sparkles } from "lucide-react";
import type { AdviceNote, CaseReport, LayoutProposal, LayoutsResult } from "../../case/api.ts";

export type Pins = Record<string, { x_mm?: number; y_mm?: number } | null>;

const POCKET = { fits: "fits a pocket", tight: "tight for a pocket", no: "bulky for a pocket" } as const;
const NAMES: Record<string, string> = { thinnest: "Thinnest", smallest: "Smallest", balanced: "Balanced" };
const BLURB: Record<string, string> = {
  thinnest: "as flat as the parts allow",
  smallest: "the least space overall",
  balanced: "Jumper's pick for holding it",
};

export interface LayoutTabProps {
  result?: LayoutsResult;
  busy: boolean;
  error?: string;
  /** The proposal shown (selected card). */
  selected: string;
  onSelect(id: string): void;
  /** The layout the built case uses ("auto" = Jumper's pick), and whether that case is up to date. */
  built?: { goal: string; size: CaseReport["size_mm"] };
  /** Build the case with this layout. */
  onUse(id: string): void;
  working: boolean;
  /** Parts the person placed by hand (null = unpinned, back to automatic). */
  pins: Pins;
  savedPins: Record<string, { x_mm?: number; y_mm?: number }>;
  onPin(id: string, at: { x_mm?: number; y_mm?: number } | null): void;
  /** A drop that cannot be kept (it lands on a part that stays put). */
  onBlocked(message: string): void;
  onClearPins(): void;
  /** Something says the built case is not what Jumper would now do. */
  stale?: string;
  onRedistribute(): void;
  advice?: AdviceNote[];
  adviceBusy?: string;
  adviceError?: string;
  adviceDone?: string;
  onApplyAdvice(id: string): void;
  /** A move that could not be kept, and why. */
  notice?: string;
}

/** One colour per part, the same in every card, the big view and the 3D preview. */
export const PART_COLORS = ["#4DA3FF", "#FF7A59", "#5CF2A1", "#F2E14A", "#B47CFF", "#FF4D8D", "#3DD6D0", "#FFB23F", "#9BE15D", "#E9EDF2", "#7A8CFF", "#FF9DCB"];
export function partColors(result?: LayoutsResult): (id: string) => string {
  const ids = [...new Set((result?.proposals ?? []).flatMap((q) => Object.keys(q.placements)))].sort();
  return (id: string) => PART_COLORS[Math.max(0, ids.indexOf(id)) % PART_COLORS.length]!;
}

export function LayoutTab(props: LayoutTabProps) {
  const { result, busy, error, selected, onSelect, built } = props;
  const colorOf = useMemo(() => partColors(result), [result]);
  const p = result?.proposals.find((q) => q.id === selected) ?? result?.proposals.find((q) => q.id === result.best);
  const pinned = { ...props.savedPins };
  for (const [k, v] of Object.entries(props.pins)) {
    if (v === null) delete pinned[k];
    else pinned[k] = v;
  }
  const pinnedIds = Object.keys(pinned).filter((k) => pinned[k]!.x_mm !== undefined || pinned[k]!.y_mm !== undefined);
  const movedHere = (id: string) => !!props.pins[id];
  return (
    <div className="cv-lt" data-testid="case-layouts">
      {props.stale ? (
        <div className="cv-stale" role="status" data-testid="case-layout-stale">
          <Sparkles size={15} aria-hidden />
          <div>
            <div>{props.stale}</div>
            <button type="button" className="cv-chip is-strong" disabled={props.working} data-testid="case-redistribute" onClick={props.onRedistribute}>
              Re-distribute
            </button>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="cv-lt-h">
        <div className="cv-label" id="cv-lt-h">
          How the parts go inside {busy ? <span className="cv-faint cv-working" data-testid="case-layouts-busy"><Loader2 size={11} className="spin" aria-hidden /> working it out…</span> : null}
        </div>
        {error ? (
          <div className="cv-error" role="alert">
            {error}
          </div>
        ) : null}
        {!result && !error ? <div className="cv-faint">Jumper tries the parts side by side first, then in layers, and proposes the best ways to fit them.</div> : null}
        {result ? (
          <div className="cv-faint cv-lt-intro">
            The parts take {result.parts_volume_cm3} cm³. Jumper found {result.proposals.length} ways to fit them. Pick one to see it in 3D.
          </div>
        ) : null}
        <div className="cv-cards" role="radiogroup" aria-label="Ways to fit the parts">
          {result?.proposals.map((q) => (
            <Card key={q.id} p={q} color={colorOf} on={p?.id === q.id} pick={q.id === result.best} isBuilt={built?.goal === q.id && sameSize(built.size, q.size_mm)} onSelect={() => onSelect(q.id)} />
          ))}
        </div>
        {p ? (
          <div className="cv-use">
            {built?.goal === p.id && sameSize(built.size, p.size_mm) && !pinnedChanged(props.pins) ? (
              <div className="cv-faint" data-testid="case-layout-built-note">
                The case is built this way.
              </div>
            ) : (
              <button type="button" className="cv-primary" disabled={props.working || !!p.misses.length} data-testid="case-layout-use" onClick={() => props.onUse(p.id)}>
                {props.working ? "Building…" : `Use ${NAMES[p.id] ?? p.label} (${fmt(p.size_mm)})`}
              </button>
            )}
          </div>
        ) : null}
      </section>

      {p?.views ? (
        <section aria-labelledby="cv-move-h">
          <div className="cv-label" id="cv-move-h">
            Move a part
          </div>
          <div className="cv-faint cv-lt-intro">Drag a part (or select it and use the arrow keys) to put it where you want. Jumper keeps it there and arranges the rest around it.</div>
          <FrontEditor p={p} pinned={pinned} busy={busy} onPin={props.onPin} onBlocked={props.onBlocked} color={colorOf} />
          {props.notice ? (
            <div className="cv-lt-notice" role="alert" data-testid="case-layout-notice">
              {props.notice}
            </div>
          ) : null}
          <div className="cv-newsize" data-testid="case-layout-newsize" aria-live="polite">
            {busy ? (
              <>
                <Loader2 size={12} className="spin" aria-hidden /> Re-arranging…
              </>
            ) : (
              <>
                {NAMES[p.id]}: <b>{fmt(p.size_mm)}</b> <span className={`cv-pocket is-${p.pocket}`}>{POCKET[p.pocket]}</span>
              </>
            )}
          </div>
          {pinnedIds.length ? (
            <ul className="cv-pins" data-testid="case-pins">
              {pinnedIds.map((id) => (
                <li key={id}>
                  <Pin size={12} aria-hidden /> <b>{id}</b> {movedHere(id) ? "moved by you" : "kept where it was put"}
                  <button type="button" className="cv-chip" onClick={() => props.onPin(id, null)} aria-label={`Let Jumper place ${id} again`}>
                    Let Jumper place it
                  </button>
                </li>
              ))}
              {pinnedIds.length > 1 ? (
                <li>
                  <button type="button" className="cv-chip" onClick={props.onClearPins} data-testid="case-pins-clear">
                    <RotateCcw size={12} aria-hidden /> Let Jumper place them all
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
          {p.misses.length ? (
            <div className="cv-error" role="alert" data-testid="case-layout-misses">
              Does not fit: {p.misses.join("; ")}. Move the part elsewhere, or let Jumper place it.
            </div>
          ) : null}
          {p.warnings.length ? <div className="cv-lt-warn">{p.warnings.map((w) => <div key={w}>{w}</div>)}</div> : null}
        </section>
      ) : null}

      <Advice notes={props.advice} busy={props.adviceBusy} error={props.adviceError} done={props.adviceDone} onApply={props.onApplyAdvice} />
    </div>
  );
}

const fmt = (s: { w: number; h: number; d: number }) => `${s.w} × ${s.h} × ${s.d} mm`;
const sameSize = (a: { w: number; h: number; d: number }, b: { w: number; h: number; d: number }) => Math.abs(a.w - b.w) <= 0.6 && Math.abs(a.h - b.h) <= 0.6 && Math.abs(a.d - b.d) <= 0.6;
const pinnedChanged = (pins: Pins) => Object.keys(pins).length > 0;

function Card({ p, color, on, pick, isBuilt, onSelect }: { p: LayoutProposal; color(id: string): string; on: boolean; pick: boolean; isBuilt: boolean; onSelect(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
    // arrows move between the cards, like any radio group
    if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) {
      e.preventDefault();
      const all = [...(ref.current?.parentElement?.querySelectorAll<HTMLElement>("[role=radio]") ?? [])];
      const i = all.indexOf(ref.current!);
      const next = all[(i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
      next?.focus();
      next?.click();
    }
  };
  return (
    <div ref={ref} role="radio" tabIndex={on ? 0 : -1} aria-checked={on} aria-label={`${NAMES[p.id] ?? p.label}: ${fmt(p.size_mm)}, ${POCKET[p.pocket]}`} className={`cv-card ${on ? "is-on" : ""}`} data-testid={`case-layout-${p.id}`} onClick={onSelect} onKeyDown={onKey}>
      <div className="cv-card-head">
        <b>{NAMES[p.id] ?? p.label}</b>
        <span className="cv-faint">{BLURB[p.id]}</span>
        <span className="cv-card-tags">
          {isBuilt ? <span className="cv-tag is-built">built</span> : null}
          {pick ? <span className="cv-tag">Jumper's pick</span> : null}
        </span>
      </div>
      <div className="cv-card-body">
      {p.views ? <Drawing p={p} color={color} /> : null}
      <div className="cv-card-info">
      <div className="cv-card-stats">
        <span className="cv-card-d" data-testid={`case-layout-thick-${p.id}`}>
          {p.size_mm.d} mm <span className="cv-faint">thick</span>
        </span>
        <span className={`cv-pocket is-${p.pocket}`}>{POCKET[p.pocket]}</span>
      </div>
      <div className="cv-card-size cv-faint" data-testid={`case-layout-size-${p.id}`}>
        {fmt(p.size_mm)} · {p.layers.length} {p.layers.length === 1 ? "layer" : "layers"} · parts fill {Math.round(p.fill_ratio * 100)} % of the inside
      </div>
      </div>
      </div>
      <ul className="cv-why">
        {(on ? p.why : p.why.slice(0, 1)).map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      {p.misses.length ? <div className="cv-layout-miss">Does not fit: {p.misses.join("; ")}</div> : null}
    </div>
  );
}

/** Front view (left) and the side cross-section (right) at one scale, with the sizes in mm. */
function Drawing({ p, color }: { p: LayoutProposal; color(id: string): string }) {
  const v = p.views!;
  const xs = v.front.outline.map((q) => q[0]);
  const ys = v.front.outline.map((q) => q[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys, v.side.y[0]);
  const y1 = Math.max(...ys, v.side.y[1]);
  const gap = Math.max(10, (x1 - x0) * 0.16);
  const D = v.side.z[1] - v.side.z[0];
  const lab = 9; // room for the size labels under the drawings
  const W = x1 - x0 + gap + D;
  const H = y1 - y0 + lab;
  const fx = (x: number) => x - x0;
  const fy = (y: number) => y1 - y;
  const sz = (z: number) => x1 - x0 + gap + (z - v.side.z[0]);
  const pts = (P: [number, number][]) => P.map(([x, y]) => `${fx(x).toFixed(1)},${fy(y).toFixed(1)}`).join(" ");
  const fs = Math.max(3.2, Math.min(5.5, (y1 - y0) / 18));
  const parts = [...v.front.parts].sort((a, b) => b.layer - a.layer);
  return (
    <svg className="cv-card-svg" viewBox={`-2 -2 ${(W + 4).toFixed(1)} ${(H + 4).toFixed(1)}`} role="img" aria-label={`${NAMES[p.id] ?? p.label} seen from the front and in cross-section from the side: ${p.layers.map((l) => `layer ${l.index + 1}: ${l.parts.join(", ")}`).join("; ")}`}>
      <polygon points={pts(v.front.outline)} className="cv-ls-shell" />
      <polygon points={pts(v.front.cavity)} className="cv-ls-cavity" />
      {parts.map((q) => (
        <g key={q.id}>
          <rect x={fx(q.min[0])} y={fy(q.max[1])} width={q.max[0] - q.min[0]} height={q.max[1] - q.min[1]} rx={0.6} fill={color(q.id)} fillOpacity={q.layer ? 0.28 : 0.62} stroke={color(q.id)} strokeDasharray={q.layer ? "2 1.5" : undefined} strokeWidth={0.5} />
          {q.max[0] - q.min[0] > fs * 2.2 && q.max[1] - q.min[1] > fs * 1.2 ? (
            <text x={fx((q.min[0] + q.max[0]) / 2)} y={fy((q.min[1] + q.max[1]) / 2) + fs * 0.35} className="cv-ls-label" style={{ fontSize: fs }}>
              {q.label}
            </text>
          ) : null}
        </g>
      ))}
      {/* side: the case in cross-section, the parts by layer */}
      <rect x={sz(v.side.z[0])} y={fy(v.side.y[1])} width={D} height={v.side.y[1] - v.side.y[0]} rx={Math.min(4, D / 3)} className="cv-ls-shell" />
      {[...v.side.parts]
        .sort((a, b) => a.layer - b.layer)
        .map((q) => (
          <rect key={q.id} x={sz(q.z[0])} y={fy(q.y[1])} width={q.z[1] - q.z[0]} height={q.y[1] - q.y[0]} fill={color(q.id)} fillOpacity={0.55} stroke={color(q.id)} strokeWidth={0.4} />
        ))}
      {/* sizes */}
      <g className="cv-ls-dim" style={{ fontSize: fs }}>
        <line x1={fx(x0)} x2={fx(x1)} y1={H - lab * 0.55} y2={H - lab * 0.55} />
        <text x={fx((x0 + x1) / 2)} y={H + 0.6}>
          {p.size_mm.w} mm
        </text>
        <line x1={sz(v.side.z[0])} x2={sz(v.side.z[1])} y1={H - lab * 0.55} y2={H - lab * 0.55} />
        <text x={sz((v.side.z[0] + v.side.z[1]) / 2)} y={H + 0.6}>
          {p.size_mm.d} mm
        </text>
      </g>
      <text x={sz(v.side.z[1]) + 1} y={fy(v.side.y[1]) + fs} className="cv-ls-note" style={{ fontSize: fs * 0.8 }}>
        front
      </text>
    </svg>
  );
}

/** The big front view: drag a part (pointer) or move the focused one with the arrow keys to pin it. */
function FrontEditor({ p, pinned, busy, onPin, onBlocked, color }: { p: LayoutProposal; pinned: Record<string, { x_mm?: number; y_mm?: number }>; busy: boolean; onPin(id: string, at: { x_mm?: number; y_mm?: number }): void; onBlocked(message: string): void; color(id: string): string }) {
  const v = p.views!.front;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; sx: number; sy: number; dx: number; dy: number } | undefined>();
  // a keyboard move waits a moment so a few presses make one request
  const [nudge, setNudge] = useState<{ id: string; dx: number; dy: number } | undefined>();
  const [focus, setFocus] = useState<string | undefined>();
  // a part let go stays where it was dropped until the re-arranged proposal arrives
  const [held, setHeld] = useState<{ id: string; dx: number; dy: number } | undefined>();
  const box = useMemo(() => {
    const xs = v.outline.map((q) => q[0]);
    const ys = v.outline.map((q) => q[1]);
    return { x0: Math.min(...xs) - 3, x1: Math.max(...xs) + 3, y0: Math.min(...ys) - 3, y1: Math.max(...ys) + 3 };
  }, [v.outline]);
  const fx = (x: number) => x - box.x0;
  const fy = (y: number) => box.y1 - y;
  const pts = (P: [number, number][]) => P.map(([x, y]) => `${fx(x).toFixed(1)},${fy(y).toFixed(1)}`).join(" ");
  const fs = Math.max(3, Math.min(5, (box.y1 - box.y0) / 26));
  const toMm = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const k = (box.x1 - box.x0) / r.width;
    const ky = (box.y1 - box.y0) / r.height;
    const s = Math.max(k, ky); // preserveAspectRatio meet: one scale
    return [e.clientX * s, -e.clientY * s] as const;
  };
  /** A part that stays put (kept where it was put) that the moved part would land on, in the same depth. */
  const landsOn = (id: string, dx: number, dy: number): string | undefined => {
    const a = v.parts.find((q) => q.id === id);
    const az = p.views!.side.parts.find((q) => q.id === id)?.z;
    if (!a || !az) return undefined;
    for (const b of v.parts) {
      if (b.id === id || !pinned[b.id] || (pinned[b.id]!.x_mm === undefined && pinned[b.id]!.y_mm === undefined)) continue;
      const bz = p.views!.side.parts.find((q) => q.id === b.id)?.z;
      if (bz && (bz[1] <= az[0] + 0.2 || az[1] <= bz[0] + 0.2)) continue; // one behind the other
      if (a.min[0] + dx < b.max[0] - 0.2 && b.min[0] < a.max[0] + dx - 0.2 && a.min[1] + dy < b.max[1] - 0.2 && b.min[1] < a.max[1] + dy - 0.2) return b.id;
    }
    return undefined;
  };
  const commit = (id: string, dx: number, dy: number): boolean => {
    const pl = p.placements[id];
    if (!pl || (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3)) return false;
    const hit = landsOn(id, dx, dy);
    if (hit) {
      onBlocked(`${id} would land on ${hit}, which is kept where it was put. Drop ${id} somewhere free, or let Jumper place ${hit} first.`);
      return false;
    }
    const pin = pl.pin ?? { x_mm: pl.x_mm, y_mm: pl.y_mm, x_sign: 1 as const };
    onPin(id, { ...(pin.x_mm !== undefined ? { x_mm: round1(pin.x_mm + pin.x_sign * dx) } : {}), ...(pin.y_mm !== undefined ? { y_mm: round1(pin.y_mm + dy) } : {}) });
    return true;
  };
  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => {
      if (commit(nudge.id, nudge.dx, nudge.dy)) setHeld(nudge);
      setNudge(undefined);
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge]);
  // a new proposal (after the re-arrange) starts from where the parts now are
  useEffect(() => {
    setDrag(undefined);
    setHeld(undefined);
  }, [p]);
  const axes = (id: string) => {
    const pin = p.placements[id]?.pin;
    return { x: !pin || pin.x_mm !== undefined, y: !pin || pin.y_mm !== undefined };
  };
  const parts = [...v.parts].sort((a, b) => b.layer - a.layer);
  return (
    <svg
      ref={svgRef}
      className={`cv-front ${busy ? "is-busy" : ""}`}
      data-testid="case-front-editor"
      viewBox={`0 0 ${(box.x1 - box.x0).toFixed(1)} ${(box.y1 - box.y0).toFixed(1)}`}
      role="group"
      aria-label={`The case from the front, ${p.size_mm.w} by ${p.size_mm.h} mm. Each part can be moved.`}
      onPointerMove={(e) => {
        if (!drag) return;
        const [mx, my] = toMm(e);
        const a = axes(drag.id);
        setDrag({ ...drag, dx: a.x ? mx - drag.sx : 0, dy: a.y ? my - drag.sy : 0 });
      }}
      onPointerUp={() => {
        if (!drag) return;
        if (commit(drag.id, drag.dx, drag.dy)) setHeld(drag);
        setDrag(undefined);
      }}
      onPointerCancel={() => setDrag(undefined)}
    >
      <polygon points={pts(v.outline)} className="cv-ls-shell" />
      <polygon points={pts(v.cavity)} className="cv-ls-cavity" />
      {parts.map((q) => {
        const d = drag?.id === q.id ? drag : nudge?.id === q.id ? nudge : held?.id === q.id ? held : undefined;
        const isPinned = !!pinned[q.id] && (pinned[q.id]!.x_mm !== undefined || pinned[q.id]!.y_mm !== undefined);
        const a = axes(q.id);
        const w = q.max[0] - q.min[0];
        const h = q.max[1] - q.min[1];
        const where = a.x && a.y ? "" : a.x ? ", slides left and right along its wall" : ", slides up and down along its wall";
        return (
          <g
            key={q.id}
            className={`cv-fp ${d ? "is-drag" : ""} ${focus === q.id ? "is-focus" : ""}`}
            data-testid={`case-part-${q.id}`}
            transform={d ? `translate(${d.dx.toFixed(2)} ${(-d.dy).toFixed(2)})` : undefined}
            tabIndex={0}
            role="button"
            aria-label={`${q.label}, ${isPinned ? "kept where it was put" : "placed by Jumper"}${q.layer ? `, layer ${q.layer + 1} (behind)` : ""}${where}. Arrow keys move it 1 mm, with Shift 5 mm.`}
            onFocus={() => setFocus(q.id)}
            onBlur={() => setFocus(undefined)}
            onPointerDown={(e) => {
              e.preventDefault();
              (e.currentTarget as SVGGElement).focus();
              svgRef.current?.setPointerCapture(e.pointerId);
              const [mx, my] = toMm(e);
              setDrag({ id: q.id, sx: mx, sy: my, dx: 0, dy: 0 });
            }}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 5 : 1;
              const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
              if (!k) return;
              e.preventDefault();
              const cur = nudge?.id === q.id ? nudge : held?.id === q.id ? held : { id: q.id, dx: 0, dy: 0 };
              setNudge({ id: q.id, dx: cur.dx + (a.x ? k[0]! : 0), dy: cur.dy + (a.y ? k[1]! : 0) });
            }}
          >
            <rect x={fx(q.min[0])} y={fy(q.max[1])} width={w} height={h} rx={0.8} fill={color(q.id)} fillOpacity={q.layer ? 0.3 : 0.6} stroke={isPinned ? "#ffffff" : color(q.id)} strokeWidth={isPinned ? 0.9 : 0.5} strokeDasharray={q.layer ? "2 1.5" : undefined} />
            {w > fs * 2 && h > fs * 1.1 ? (
              <text x={fx((q.min[0] + q.max[0]) / 2)} y={fy((q.min[1] + q.max[1]) / 2) + fs * 0.35} className="cv-ls-label" style={{ fontSize: fs }}>
                {q.label}
              </text>
            ) : null}
            {isPinned ? <circle cx={fx(q.max[0]) - 1.6} cy={fy(q.max[1]) + 1.6} r={1.1} className="cv-pin-dot" /> : null}
          </g>
        );
      })}
    </svg>
  );
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function Advice({ notes, busy, error, done, onApply }: { notes?: AdviceNote[]; busy?: string; error?: string; done?: string; onApply(id: string): void }) {
  if (!notes?.length && !done && !error) return null;
  return (
    <section aria-labelledby="cv-adv-h" data-testid="case-advice">
      <div className="cv-label" id="cv-adv-h">
        Parts you may not need
      </div>
      {done ? (
        <div className="cv-adv-done" role="status" data-testid="case-advice-done">
          {done} Undo on the canvas takes it back.
        </div>
      ) : null}
      {error ? (
        <div className="cv-error" role="alert">
          {error}
        </div>
      ) : null}
      <ul className="cv-adv">
        {notes?.map((n) => (
          <li key={n.id} data-testid={`case-advice-${n.code}`}>
            <div className="cv-adv-title">{n.title}</div>
            <div className="cv-adv-save">{saves(n.saves)}</div>
            <details>
              <summary>Why</summary>
              <div className="cv-faint">{n.why}</div>
            </details>
            {n.apply ? (
              <button type="button" className="cv-chip is-strong" disabled={!!busy} data-testid={`case-advice-apply-${n.code}`} onClick={() => onApply(n.id)}>
                {busy === n.id ? <Loader2 size={12} className="spin" aria-hidden /> : null} {n.apply.label}
              </button>
            ) : (
              <div className="cv-faint cv-adv-ask">Ask your agent to make this change.</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function saves(s: AdviceNote["saves"]): string {
  const out: string[] = [];
  if (s.area_mm2) out.push(`${s.area_mm2} mm² of room`);
  if (s.depth_mm) out.push(`${s.depth_mm} mm of thickness`);
  if (s.mass_g) out.push(`${s.mass_g} g`);
  return out.length ? `Saves ${out.join(", ")}` : "";
}
