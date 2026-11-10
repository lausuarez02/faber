/**
 * Round 7: the Case view's outline editor. A person draws the case's front outline (start from an
 * ellipse or a preset, drag the points, add one with a double-click or the button, remove the
 * selected one), sets W x H x D in mm (blank = auto), and sees at once, at real size, where the
 * parts would go inside it (red where one runs into the wall) and what to change when they do
 * not fit. The same view shows an outline an agent drew. Keyboard: Tab to a point, arrows move it
 * 1 mm (Shift: 5 mm), Delete removes it, Insert / "+" adds one after it.
 */
import { useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { FitResult } from "../../case/api.ts";
import { bounds, insertIndex, smoothClosed, STARTS, type Pt } from "../../case/outline.ts";

export interface SizeDraft {
  w?: number;
  h?: number;
  d?: number;
}

export function OutlineEditor({ points, onPoints, size, onSize, fit, fitBusy, fitError, onStart, onUseSize }: { points: Pt[]; onPoints(p: Pt[]): void; size: SizeDraft; onSize(s: SizeDraft): void; fit?: FitResult; fitBusy: boolean; fitError?: string; onStart(kind: string): void; onUseSize(s: SizeDraft): void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [sel, setSel] = useState<number | undefined>();
  const drag = useRef<number | undefined>(undefined);
  const curve = useMemo(() => smoothClosed(points), [points]);
  const b = useMemo(() => bounds(curve), [curve]);
  // drawn mm → shown at real size: a fixed W / H scales it (like the server does); auto uses the size the parts need
  const pw = fit?.size_mm.w;
  const ph = fit?.size_mm.h;
  const kx = size.w !== undefined ? size.w / b.w : size.h !== undefined ? size.h / b.h : pw ? pw / b.w : 1;
  const ky = size.h !== undefined ? size.h / b.h : size.w !== undefined ? size.w / b.w : ph && pw ? pw / b.w : kx;
  const toView = (p: Pt): Pt => [(p[0] - b.cx) * kx, (p[1] - b.cy) * ky];
  const fromView = (q: Pt): Pt => [Math.round((q[0] / kx + b.cx) * 10) / 10, Math.round((q[1] / ky + b.cy) * 10) / 10];
  const shown = curve.map(toView);
  const prev = fit?.preview;
  const ext = Math.max(20, ...shown.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1]))), ...(prev?.outline ?? []).map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1])))) + 6;
  const path = (P: Pt[]) => (P.length ? `M ${P.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join(" L ")} Z` : "");
  const at = (e: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = svg.getScreenCTM();
    const q = m ? pt.matrixTransform(m.inverse()) : pt;
    return [q.x, -q.y];
  };
  const move = (i: number, p: Pt) => onPoints(points.map((q, j) => (j === i ? p : q)));
  const add = (q: Pt) => {
    const i = insertIndex(points, q);
    const next = [...points.slice(0, i + 1), q, ...points.slice(i + 1)];
    onPoints(next);
    setSel(i + 1);
  };
  const addAfter = (i: number) => {
    const a = points[i]!;
    const c = points[(i + 1) % points.length]!;
    const mid: Pt = [Math.round(((a[0] + c[0]) / 2) * 10) / 10, Math.round(((a[1] + c[1]) / 2) * 10) / 10];
    onPoints([...points.slice(0, i + 1), mid, ...points.slice(i + 1)]);
    setSel(i + 1);
  };
  const remove = (i: number) => {
    if (points.length <= 4) return;
    onPoints(points.filter((_, j) => j !== i));
    setSel(Math.min(i, points.length - 2));
  };
  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() === "" || !Number.isFinite(n) ? undefined : n;
  };
  const sizeIn = (k: keyof SizeDraft, label: string, min: number, max: number) => (
    <label className="cv-size-in">
      <span>{label}</span>
      <input type="number" inputMode="decimal" min={min} max={max} step={0.5} placeholder="auto" aria-label={`${label} in mm (blank for auto)`} data-testid={`case-size-${k}`} value={size[k] ?? ""} onChange={(e) => onSize({ ...size, [k]: num(e.target.value) })} />
    </label>
  );
  const bigger = fit?.suggestions.find((s) => s.kind === "bigger");
  return (
    <section className="cv-outline" data-testid="case-outline">
      <div className="cv-label">Outline</div>
      <div className="cv-starts" role="group" aria-label="Start from">
        {STARTS.map((s) => (
          <button key={s.id} type="button" className="cv-chip" data-testid={`case-start-${s.id}`} onClick={() => onStart(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        className="cv-editor"
        data-testid="case-outline-svg"
        viewBox={`${-ext} ${-ext} ${2 * ext} ${2 * ext}`}
        role="img"
        aria-label={`Case outline, ${fit ? `${fit.size_mm.w} by ${fit.size_mm.h} mm` : `${b.w.toFixed(0)} by ${b.h.toFixed(0)} mm drawn`}${fit ? (fit.fits ? ", the parts fit" : `, ${fit.misses.length} parts do not fit`) : ""}`}
        onDoubleClick={(e) => add(fromView(at(e)))}
        onPointerMove={(e) => {
          if (drag.current === undefined) return;
          move(drag.current, fromView(at(e)));
        }}
        onPointerUp={() => (drag.current = undefined)}
        onPointerLeave={() => (drag.current = undefined)}
      >
        {/* 10 mm grid */}
        <g className="cv-grid">
          {Array.from({ length: Math.floor(ext / 10) * 2 + 1 }, (_, i) => (i - Math.floor(ext / 10)) * 10).map((v) => (
            <g key={v}>
              <line x1={v} y1={-ext} x2={v} y2={ext} />
              <line x1={-ext} y1={v} x2={ext} y2={v} />
            </g>
          ))}
        </g>
        {prev ? (
          <g data-testid="case-fit-preview">
            <path d={path(prev.outline)} className="cv-pv-outer" />
            <path d={path(prev.cavity)} className="cv-pv-cavity" />
            {prev.parts.map((p) => (
              <g key={p.id} className={p.collides ? "cv-pv-part is-bad" : "cv-pv-part"} data-testid={`case-fit-part-${p.id}`} data-collides={p.collides ? "1" : "0"}>
                <title>{`${p.id} (${p.type})${p.collides ? ": runs into the wall" : ""}`}</title>
                {p.shapes.map((s, i) => (s.shape === "round" ? <circle key={i} cx={s.c[0]} cy={-s.c[1]} r={s.r} /> : <rect key={i} x={s.min[0]} y={-s.max[1]} width={s.max[0] - s.min[0]} height={s.max[1] - s.min[1]} />))}
              </g>
            ))}
          </g>
        ) : null}
        <path d={path(shown)} className="cv-ed-curve" data-testid="case-outline-curve" />
        {points.map((p, i) => {
          const v = toView(p);
          return (
            <circle
              key={i}
              cx={v[0]}
              cy={-v[1]}
              r={Math.max(1.6, ext / 34)}
              className={sel === i ? "cv-ed-pt is-sel" : "cv-ed-pt"}
              tabIndex={0}
              role="button"
              aria-label={`Outline point ${i + 1} of ${points.length}, x ${p[0]} mm, y ${p[1]} mm. Arrows move it, Delete removes it, plus adds one after it.`}
              data-testid={`case-pt-${i}`}
              onFocus={() => setSel(i)}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as Element).setPointerCapture?.(e.pointerId);
                drag.current = i;
                setSel(i);
              }}
              onPointerUp={() => (drag.current = undefined)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 5 : 1;
                const d: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
                if (d[e.key]) {
                  e.preventDefault();
                  move(i, [Math.round((p[0] + d[e.key]![0] / kx) * 10) / 10, Math.round((p[1] + d[e.key]![1] / ky) * 10) / 10]);
                } else if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  remove(i);
                } else if (e.key === "Insert" || e.key === "+") {
                  e.preventDefault();
                  addAfter(i);
                }
              }}
            />
          );
        })}
      </svg>
      <div className="cv-ed-tools">
        <button type="button" className="cv-chip" data-testid="case-pt-add" onClick={() => addAfter(sel ?? points.length - 1)} aria-label="Add a point after the selected one">
          <Plus size={13} aria-hidden /> Point
        </button>
        <button type="button" className="cv-chip" data-testid="case-pt-remove" disabled={sel === undefined || points.length <= 4} onClick={() => sel !== undefined && remove(sel)} aria-label="Remove the selected point">
          <Minus size={13} aria-hidden /> Point
        </button>
        <span className="cv-faint">double-click to add · drag to shape</span>
      </div>
      <div className="cv-size-row">
        {sizeIn("w", "W", 15, 250)}
        {sizeIn("h", "H", 15, 250)}
        {sizeIn("d", "D", 6, 120)}
        <span className="cv-faint">mm</span>
      </div>
      <div className="cv-fit" data-testid="case-fit" aria-live="polite">
        {fitError ? (
          <div className="cv-error" role="alert" data-testid="case-fit-error">
            {fitError}
          </div>
        ) : fit ? (
          fit.fits ? (
            <div className="cv-fit-ok" data-testid="case-fit-status">
              Fits: {fit.size_mm.w} × {fit.size_mm.h} × {fit.size_mm.d} mm{size.w === undefined && size.h === undefined ? " (auto, the smallest that holds the parts)" : ""}
            </div>
          ) : (
            <>
              <div className="cv-fit-bad" data-testid="case-fit-status">
                Does not fit {fit.asked_mm ? `${fit.asked_mm.w ?? "auto"} × ${fit.asked_mm.h ?? "auto"} × ${fit.asked_mm.d ?? "auto"} mm` : "this size"}: the parts need {fit.needed_mm.w} × {fit.needed_mm.h} × {fit.needed_mm.d} mm.
              </div>
              <ul className="cv-misses" data-testid="case-fit-misses">
                {fit.misses.map((m, i) => (
                  <li key={i}>{m.message}</li>
                ))}
              </ul>
              {fit.suggestions.length ? (
                <>
                  <div className="cv-label">What would fit</div>
                  <ul className="cv-suggest" data-testid="case-fit-suggestions">
                    {fit.suggestions.map((s, i) => (
                      <li key={i} className={s.fits ? "is-ok" : ""}>
                        {s.message} {s.fits === true ? <b>Fits{s.size_mm ? ` (${s.size_mm.w} × ${s.size_mm.h} × ${s.size_mm.d} mm)` : ""}.</b> : s.fits === false ? <span className="cv-faint">Not enough alone.</span> : null}
                        {s.tradeoff ? <span className="cv-faint"> {s.tradeoff}.</span> : null}
                        {s.kind !== "bigger" && s.kind !== "finish" ? <span className="cv-faint"> Ask the agent to make this change (it rewires and updates the sketch).</span> : null}
                      </li>
                    ))}
                  </ul>
                  {bigger?.size_mm ? (
                    <button type="button" className="cv-secondary" data-testid="case-fit-use-size" onClick={() => onUseSize({ w: Math.ceil(bigger.size_mm!.w), h: Math.ceil(bigger.size_mm!.h), ...(size.d !== undefined ? { d: Math.ceil(bigger.size_mm!.d) } : {}) })}>
                      Use {Math.ceil(bigger.size_mm.w)} × {Math.ceil(bigger.size_mm.h)} mm
                    </button>
                  ) : null}
                </>
              ) : null}
            </>
          )
        ) : (
          <div className="cv-faint">{fitBusy ? "Checking the fit…" : "Draw the outline; the fit is checked as you go."}</div>
        )}
        {fit && fitBusy ? <div className="cv-faint">Checking again…</div> : null}
      </div>
    </section>
  );
}
