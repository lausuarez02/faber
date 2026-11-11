import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { Search } from "lucide-react";
import type { PartCategory, PartDefinition } from "@jumper/sim-core";
import { CATEGORY_LABEL, CATEGORY_ORDER, partDefinitions, svgDataUrl } from "../lib/parts.ts";
import { useJumper } from "../lib/app.ts";
import { PART_MIME } from "./Canvas.tsx";

function matches(def: PartDefinition, q: string): boolean {
  if (!q) return true;
  const hay = [def.spec.id, def.spec.name, def.spec.description, def.spec.category, ...(def.spec.tags ?? [])].join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

/** The parts library: search, category chips and a grid of thumbnails. Click to place, or drag onto the canvas. */
export function PartsLibrary({ onPlaced }: { onPlaced?: () => void }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<PartCategory | "all">("all");
  const { screenToFlowPosition } = useReactFlow();
  const thumbs = useMemo(() => new Map(partDefinitions.map((d) => [d.spec.id, svgDataUrl(d.svg)])), []);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Phones would pop the keyboard over the sheet; desktop gets the cursor in the search field.
    if (typeof matchMedia === "function" && !matchMedia("(pointer: coarse)").matches) search.current?.focus();
  }, []);

  const cats = useMemo(() => CATEGORY_ORDER.filter((c) => partDefinitions.some((d) => d.spec.category === c)), []);
  const groups = useMemo(() => {
    const out: { cat: PartCategory; defs: PartDefinition[] }[] = [];
    for (const c of CATEGORY_ORDER) {
      if (cat !== "all" && c !== cat) continue;
      const defs = partDefinitions.filter((d) => d.spec.category === c && matches(d, q.trim()));
      if (defs.length) out.push({ cat: c, defs });
    }
    return out;
  }, [q, cat]);

  /** Click / tap: drop the part in the middle of the visible canvas. */
  const place = (def: PartDefinition) => {
    const p = screenToFlowPosition({ x: innerWidth / 2, y: innerHeight / 2 });
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
    <div className="library" data-testid="parts-library" aria-label="Parts library">
      <div className="library-head">
        <label className="search-field">
          <Search size={15} strokeWidth={1.6} aria-hidden />
          <input ref={search} type="search" placeholder={`Search ${partDefinitions.length} parts`} value={q} onChange={(e) => setQ(e.target.value)} data-testid="parts-search" />
        </label>
        <div className="chips" role="tablist" aria-label="Categories">
          <button type="button" role="tab" aria-selected={cat === "all"} className="chip" onClick={() => setCat("all")}>
            All
          </button>
          {cats.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={cat === c} className="chip" onClick={() => setCat(c)}>
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      </div>
      <div className="library-scroll">
        {partDefinitions.length === 0 && (
          <p className="empty">
            The parts registry is empty. Add part folders under <code>packages/parts/src/parts</code> and run <code>pnpm gen</code>.
          </p>
        )}
        {partDefinitions.length > 0 && groups.length === 0 && <p className="empty">No part matches “{q}”. Try a bus or pin name, e.g. “i2c”.</p>}
        {groups.map((g) => (
          <section key={g.cat} className="lib-group">
            <h3 className="lib-group-title">{CATEGORY_LABEL[g.cat]}</h3>
            <ul className="lib-grid">
              {g.defs.map((def) => {
                // Round 10: a board whose emulator support is not proven yet is shown, not placeable, with the reason.
                const planned = def.spec.availability?.status === "planned";
                const where = def.spec.mcu?.backend === "renode" ? " · runs in Renode (Docker, via jumper serve)" : "";
                return (
                  <li key={def.spec.id}>
                    <button
                      type="button"
                      className={planned ? "lib-item planned" : "lib-item"}
                      draggable={!planned}
                      disabled={planned}
                      aria-disabled={planned}
                      onDragStart={(e) => onDragStart(e, def)}
                      onClick={() => !planned && place(def)}
                      data-testid={`library-${def.spec.id}`}
                      title={planned ? `Planned, not placeable yet: ${def.spec.availability!.reason}` : `${def.spec.description}${where}\nClick to place, or drag onto the canvas.`}
                    >
                      <span className="lib-thumb">
                        <img src={thumbs.get(def.spec.id)} alt="" draggable={false} />
                      </span>
                      <span className="lib-name">{def.spec.name}</span>
                      <span className="lib-meta">{planned ? "Planned" : `${def.spec.pins.length} pins${def.spec.mcu?.backend === "renode" ? " · Renode" : ""}`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
