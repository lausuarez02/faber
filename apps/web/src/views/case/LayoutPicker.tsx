/**
 * Round 8: how the parts go inside. Jumper proposes three distributions (POST /api/case/layouts):
 * thinnest, smallest and balanced. Each card draws the case from the front (the outline, the parts
 * as labelled rectangles, the ones further back dashed) and from the side (the layers), with its
 * size, pocket verdict and why; picking one sets enclosure.layout for the next Update case.
 */
import type { LayoutProposal, LayoutsResult } from "../../case/api.ts";

const POCKET = { fits: "fits a pocket", tight: "tight for a pocket", no: "bulky for a pocket" } as const;

export function LayoutPicker({ result, busy, error, value, onPick }: { result?: LayoutsResult; busy: boolean; error?: string; value: string; onPick(id: string): void }) {
  const chosen = value === "auto" ? (result?.best ?? "balanced") : value;
  return (
    <section className="cv-layouts" data-testid="case-layouts" aria-label="How the parts go inside">
      <div className="cv-label">
        How the parts go inside {busy ? <span className="cv-faint">working it out…</span> : result ? <span className="cv-faint">{result.ms} ms</span> : null}
      </div>
      {error ? (
        <div className="cv-error" role="alert">
          {error}
        </div>
      ) : null}
      {!result && !error ? <div className="cv-faint">Jumper lays the parts out flat first, then in layers, and proposes the best ways.</div> : null}
      <div className="cv-layout-list" role="radiogroup" aria-label="Layout">
        {result?.proposals.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={chosen === p.id} className={`cv-layout ${chosen === p.id ? "is-on" : ""}`} data-testid={`case-layout-${p.id}`} onClick={() => onPick(p.id)} title={p.why.join(" ")}>
            <div className="cv-layout-head">
              <b>{p.label}</b>
              {p.id === result.best ? <span className="cv-faint"> (auto)</span> : null}
            </div>
            {p.views ? <LayoutDrawing p={p} /> : null}
            <div className="cv-layout-size" data-testid={`case-layout-size-${p.id}`}>
              {p.size_mm.w} × {p.size_mm.h} × {p.size_mm.d} mm · {p.layers.length} {p.layers.length === 1 ? "layer" : "layers"}
            </div>
            <div className={`cv-pocket is-${p.pocket}`}>{POCKET[p.pocket]}</div>
            <div className="cv-layout-why">{p.why[0]}</div>
            {p.misses.length ? <div className="cv-layout-miss">Does not fit: {p.misses.join("; ")}</div> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Front view (left) and side view (right) at one scale. */
function LayoutDrawing({ p }: { p: LayoutProposal }) {
  const v = p.views!;
  const xs = v.front.outline.map((q) => q[0]);
  const ys = v.front.outline.map((q) => q[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys, v.side.y[0]);
  const y1 = Math.max(...ys, v.side.y[1]);
  const gap = 8;
  const W = x1 - x0 + gap + (v.side.z[1] - v.side.z[0]);
  const H = y1 - y0;
  const fx = (x: number) => x - x0;
  const fy = (y: number) => y1 - y;
  const sz = (z: number) => x1 - x0 + gap + (z - v.side.z[0]);
  const pts = (P: [number, number][]) => P.map(([x, y]) => `${fx(x).toFixed(1)},${fy(y).toFixed(1)}`).join(" ");
  return (
    <svg className="cv-layout-svg" viewBox={`-2 -2 ${(W + 4).toFixed(1)} ${(H + 4).toFixed(1)}`} role="img" aria-label={`${p.label}: the parts seen from the front and from the side`}>
      <polygon points={pts(v.front.outline)} className="cv-ls-shell" />
      <polygon points={pts(v.front.cavity)} className="cv-ls-cavity" />
      {v.front.parts.map((q) => (
        <g key={q.id}>
          <rect x={fx(q.min[0])} y={fy(q.max[1])} width={q.max[0] - q.min[0]} height={q.max[1] - q.min[1]} fill={q.color} fillOpacity={q.layer ? 0.3 : 0.7} stroke={q.color} strokeDasharray={q.layer ? "2 1.5" : undefined} strokeWidth={0.5} />
          {q.max[0] - q.min[0] > 9 && q.max[1] - q.min[1] > 5 ? (
            <text x={fx((q.min[0] + q.max[0]) / 2)} y={fy((q.min[1] + q.max[1]) / 2) + 1.5} className="cv-ls-label">
              {q.label}
            </text>
          ) : null}
        </g>
      ))}
      <rect x={sz(v.side.z[0])} y={fy(v.side.y[1])} width={v.side.z[1] - v.side.z[0]} height={v.side.y[1] - v.side.y[0]} rx={Math.min(4, (v.side.z[1] - v.side.z[0]) / 3)} className="cv-ls-shell" />
      {v.side.parts.map((q) => (
        <rect key={q.id} x={sz(q.z[0])} y={fy(q.y[1])} width={q.z[1] - q.z[0]} height={q.y[1] - q.y[0]} fill={q.color} fillOpacity={0.6} stroke={q.color} strokeWidth={0.4} />
      ))}
    </svg>
  );
}
