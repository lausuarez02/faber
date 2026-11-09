import type { PropSpec } from "@jumper/sim-core";
import type { PropValue } from "@jumper/project-format";
import { engine, useJumper } from "../lib/app.ts";
import { getDef } from "../lib/parts.ts";
import { WIRE_COLORS } from "../lib/store.ts";
import { RotateCw, Trash2 } from "lucide-react";

const NAMED_COLORS: Record<string, string> = {
  red: "#FF3B30",
  green: "#5CF2A1",
  blue: "#4DA3FF",
  yellow: "#FFD43B",
  white: "#FFFFFF",
  orange: "#FF8A1F",
};

export function Inspector() {
  const selectedParts = useJumper((s) => s.selectedParts);
  const selectedWires = useJumper((s) => s.selectedWires);
  const project = useJumper((s) => s.project);
  const simError = useJumper((s) => s.simError);

  const partId = selectedParts.length === 1 ? selectedParts[0] : undefined;
  const part = partId ? project.parts.find((p) => p.id === partId) : undefined;
  const wireId = !part && selectedWires.length === 1 ? selectedWires[0] : undefined;
  const wire = wireId ? project.wires.find((w) => w.id === wireId) : undefined;

  return (
    <div className="inspector" data-testid="inspector">
      {simError && (
        <div className="callout callout-error" data-testid="sim-error" role="alert">
          {simError}
        </div>
      )}
      {part ? <PartInspector partId={part.id} /> : wire ? <WireInspector wireId={wire.id} /> : <Overview />}
    </div>
  );
}

function Overview() {
  const project = useJumper((s) => s.project);
  const n = useJumper((s) => s.selectedParts.length + s.selectedWires.length);
  return (
    <div className="insp-body">
      {n > 1 ? (
        <p className="muted">{n} items selected. Delete removes them; R rotates parts.</p>
      ) : (
        <>
          <dl className="kv">
            <dt>project</dt>
            <dd>{project.name}</dd>
            <dt>parts</dt>
            <dd className="mono">{project.parts.length}</dd>
            <dt>wires</dt>
            <dd className="mono">{project.wires.length}</dd>
            {project.firmware && (
              <>
                <dt>board</dt>
                <dd className="mono">{project.firmware.board}</dd>
                <dt>sketch</dt>
                <dd className="mono">{project.firmware.sketch ?? project.firmware.artifact}</dd>
              </>
            )}
          </dl>
          <p className="hint">
            Select a part to edit it. Drag from pin to pin to wire. <kbd>R</kbd> rotate · <kbd>⌫</kbd> delete · <kbd>⌘Z</kbd> undo
          </p>
        </>
      )}
    </div>
  );
}

function PartInspector({ partId }: { partId: string }) {
  const part = useJumper((s) => s.project.parts.find((p) => p.id === partId));
  if (!part) return null;
  const def = getDef(part.type);
  if (!def) return <div className="insp-body muted">Unknown part type “{part.type}”.</div>;
  const { spec, fidelity } = def;
  const interactive = spec.bindings?.some((b) => b.key === "pressed") || /button|switch/.test(spec.id);
  return (
    <div className="insp-body" data-testid="part-inspector">
      <div className="insp-title">
        <div>
          <div className="insp-name">{spec.name}</div>
          <div className="mono muted small">
            {part.id} · {spec.id}
          </div>
        </div>
        <span className={`fid fid-${fidelity.level}`} title={`Fidelity: ${fidelity.level}`}>
          {fidelity.level}
        </span>
      </div>
      <p className="small muted">{spec.description}</p>

      {interactive && (
        <div className="insp-actions">
          <button
            className="btn btn-press"
            data-testid="press-button"
            onPointerDown={() => engine.interact(part.id, "press")}
            onPointerUp={() => engine.interact(part.id, "release")}
            onPointerLeave={(e) => e.buttons && engine.interact(part.id, "release")}
          >
            Hold to press
          </button>
          <button className="btn" onClick={() => engine.interact(part.id, "press")}>
            Press
          </button>
          <button className="btn" onClick={() => engine.interact(part.id, "release")}>
            Release
          </button>
        </div>
      )}

      {spec.props?.map((prop) => (
        <PropField
          key={prop.id}
          prop={prop}
          value={part.props?.[prop.id] ?? prop.default}
          onChange={(v) => useJumper.getState().setPartProp(part.id, prop.id, v)}
        />
      ))}

      <div className="insp-row">
        <button className="btn" onClick={() => useJumper.getState().rotateSelected()}>
          <RotateCw size={15} strokeWidth={1.6} aria-hidden /> Rotate
        </button>
        <button className="btn btn-danger" onClick={() => useJumper.getState().removeItems([part.id], [])}>
          <Trash2 size={15} strokeWidth={1.6} aria-hidden /> Delete
        </button>
      </div>

      <details className="insp-pins">
        <summary className="insp-summary">Pins · {spec.pins.length}</summary>
        <ul className="pin-list mono">
          {spec.pins.map((p) => (
            <li key={p.id}>
              <span className={`pin-dot pin-${p.type}`} />
              {p.label}
              <span className="muted">{p.protocols?.join(" ") ?? p.type}</span>
            </li>
          ))}
        </ul>
      </details>
      {fidelity.doesNotEmulate.length > 0 && (
        <details className="insp-pins">
          <summary className="insp-summary">Not emulated</summary>
          <ul className="small muted">
            {fidelity.doesNotEmulate.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PropField({ prop, value, onChange }: { prop: PropSpec; value: PropValue; onChange: (v: PropValue) => void }) {
  const id = `prop-${prop.id}`;
  if (prop.type === "number") {
    const num = Number(value);
    const min = prop.min ?? 0;
    const max = prop.max ?? Math.max(100, num * 4);
    return (
      <div className="field">
        <label htmlFor={id}>
          {prop.label}
          <span className="mono">
            {fmtNum(num)}
            {prop.unit ? ` ${prop.unit}` : ""}
          </span>
        </label>
        <div className="field-num">
          <input
            id={id}
            type="range"
            min={min}
            max={max}
            step={prop.step ?? "any"}
            value={num}
            onChange={(e) => onChange(Number(e.target.value))}
            data-testid={`prop-${prop.id}`}
          />
          <input
            type="number"
            className="mono"
            min={prop.min}
            max={prop.max}
            step={prop.step ?? "any"}
            value={num}
            aria-label={`${prop.label} value`}
            onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))}
          />
        </div>
      </div>
    );
  }
  if (prop.type === "boolean") {
    return (
      <label className="field field-check">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {prop.label}
      </label>
    );
  }
  const options = (prop.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  if (prop.type === "color" && options.length === 0) {
    return (
      <div className="field">
        <label htmlFor={id}>{prop.label}</label>
        <input id={id} type="color" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{prop.label}</label>
      {prop.type === "color" ? (
        <div className="swatches" role="radiogroup" aria-label={prop.label}>
          {options.map((o) => (
            <button
              key={o.value}
              role="radio"
              aria-checked={o.value === value}
              className="swatch"
              title={o.label}
              style={{ background: NAMED_COLORS[o.value] ?? o.value }}
              onClick={() => onChange(o.value)}
            />
          ))}
        </div>
      ) : (
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${+(n / 1e3).toFixed(2)}k`;
  return String(+n.toFixed(3));
}

function WireInspector({ wireId }: { wireId: string }) {
  const wire = useJumper((s) => s.project.wires.find((w) => w.id === wireId));
  if (!wire) return null;
  return (
    <div className="insp-body" data-testid="wire-inspector">
      <div className="insp-title">
        <div>
          <div className="insp-name">Wire {wire.id}</div>
          <div className="mono muted small">
            {wire.from.part}.{wire.from.pin} → {wire.to.part}.{wire.to.pin}
          </div>
        </div>
      </div>
      <div className="field">
        <label>Color</label>
        <div className="swatches" role="radiogroup" aria-label="Wire color">
          {WIRE_COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={c.toLowerCase() === (wire.color ?? "").toLowerCase()}
              className="swatch"
              style={{ background: c }}
              onClick={() => useJumper.getState().setWireColor(wire.id, c)}
            />
          ))}
        </div>
        <p className="hint">
          <kbd>C</kbd> cycles colors
        </p>
      </div>
      <div className="insp-row">
        <button className="btn btn-danger" onClick={() => useJumper.getState().removeItems([], [wire.id])}>
          <Trash2 size={15} strokeWidth={1.6} aria-hidden /> Delete wire
        </button>
      </div>
    </div>
  );
}
