import { useMemo, useState, type DragEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import type { PartDefinition } from "@jumper/sim-core";
import { CATEGORY_LABEL, CATEGORY_ORDER, partDefinitions, svgDataUrl } from "../lib/parts.ts";
import { useJumper } from "../lib/app.ts";
import { PART_MIME } from "./Canvas.tsx";
import { Icon } from "./Icon.tsx";

function matches(def: PartDefinition, q: string): boolean {
  if (!q) return true;
  const hay = [def.spec.id, def.spec.name, def.spec.description, def.spec.category, ...(def.spec.tags ?? [])]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

export function PartsLibrary({ onPlaced }: { onPlaced?: () => void }) {
  const [q, setQ] = useState("");
  const { screenToFlowPosition } = useReactFlow();
  const thumbs = useMemo(() => new Map(partDefinitions.map((d) => [d.spec.id, svgDataUrl(d.svg)])), []);

  const groups = useMemo(() => {
    const out: { cat: (typeof CATEGORY_ORDER)[number]; defs: PartDefinition[] }[] = [];
    for (const cat of CATEGORY_ORDER) {
      const defs = partDefinitions.filter((d) => d.spec.category === cat && matches(d, q.trim()));
      if (defs.length) out.push({ cat, defs });
    }
    return out;
  }, [q]);

  /** Click / tap: drop the part in the middle of the visible canvas. */
  const place = (def: PartDefinition) => {
    const el = document.querySelector(".canvas")?.getBoundingClientRect();
    const center = el ? { x: el.left + el.width / 2, y: el.top + el.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
    const p = screenToFlowPosition(center);
    const n = useJumper.getState().project.parts.length % 5; // nudge repeated clicks apart
    const x = Math.round((p.x - def.spec.size.w / 2 + n * 20) / 10) * 10;
    const y = Math.round((p.y - def.spec.size.h / 2 + n * 20) / 10) * 10;
    useJumper.getState().addPart(def.spec.id, x, y);
    onPlaced?.();
  };

  const onDragStart = (e: DragEvent, def: PartDefinition) => {
    e.dataTransfer.setData(PART_MIME, def.spec.id);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <aside className="library" data-testid="parts-library" aria-label="Parts library">
      <div className="panel-head">
        <span className="eyebrow">Parts</span>
        <span className="eyebrow muted">{partDefinitions.length}</span>
      </div>
      <label className="search">
        <Icon name="search" size={16} />
        <input type="search" placeholder="Search parts" value={q} onChange={(e) => setQ(e.target.value)} data-testid="parts-search" />
      </label>
      <div className="library-scroll">
        {partDefinitions.length === 0 && (
          <p className="empty">
            The parts registry is empty. Add part folders under <code>packages/parts/src/parts</code> and run <code>pnpm gen</code>.
          </p>
        )}
        {partDefinitions.length > 0 && groups.length === 0 && <p className="empty">No part matches “{q}”.</p>}
        {groups.map((g) => (
          <section key={g.cat} className="lib-group">
            <h3 className="eyebrow">{CATEGORY_LABEL[g.cat]}</h3>
            <ul>
              {g.defs.map((def) => (
                <li key={def.spec.id}>
                  <button
                    className="lib-item"
                    draggable
                    onDragStart={(e) => onDragStart(e, def)}
                    onClick={() => place(def)}
                    data-testid={`library-${def.spec.id}`}
                    title={`${def.spec.description}\nClick to place, or drag onto the canvas.`}
                  >
                    <span className="lib-thumb">
                      <img src={thumbs.get(def.spec.id)} alt="" draggable={false} />
                    </span>
                    <span className="lib-text">
                      <span className="lib-name">{def.spec.name}</span>
                      <span className="lib-meta mono">
                        {def.spec.pins.length} pins · {def.fidelity.level}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
