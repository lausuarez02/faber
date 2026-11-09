import { useCallback, useMemo, useRef, type DragEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import type { PartInstance, Wire } from "@jumper/project-format";
import { useJumper } from "../lib/app.ts";
import { getDef, rotatedSize } from "../lib/parts.ts";
import { PartNode, type PartFlowNode } from "./PartNode.tsx";
import { RouteObstacles, WireEdge, type WireFlowEdge } from "./WireEdge.tsx";
import type { RouteBox } from "@jumper/sim-core";

/** Above this many parts wires stay plain smooth-step curves (routing every wire on every drag frame costs too much). */
const ROUTE_MAX_PARTS = 60;

const nodeTypes = { part: PartNode };
const edgeTypes = { wire: WireEdge };
const SNAP = 10;
export const PART_MIME = "application/x-jumper-part";

const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/** React Flow nodes are derived from the project; node objects are reused while a part is unchanged. */
function useFlowNodes(parts: readonly PartInstance[], selected: readonly string[]): PartFlowNode[] {
  const cache = useRef(new Map<string, { part: PartInstance; selected: boolean; node: PartFlowNode }>());
  return useMemo(() => {
    const sel = new Set(selected);
    const next = new Map<string, { part: PartInstance; selected: boolean; node: PartFlowNode }>();
    const out: PartFlowNode[] = [];
    for (const part of parts) {
      const isSel = sel.has(part.id);
      const hit = cache.current.get(part.id);
      if (hit && hit.part === part && hit.selected === isSel) {
        next.set(part.id, hit);
        out.push(hit.node);
        continue;
      }
      const def = getDef(part.type);
      const size = def ? rotatedSize(def.spec, part.rotation) : { w: 160, h: 64 };
      const node: PartFlowNode = {
        id: part.id,
        type: "part",
        position: { x: part.x, y: part.y },
        data: { def, type: part.type, rotation: part.rotation },
        selected: isSel,
        width: size.w,
        height: size.h,
        measured: { width: size.w, height: size.h },
        // a board is big: only its title strip should not swallow pin drags
        dragHandle: undefined,
      };
      next.set(part.id, { part, selected: isSel, node });
      out.push(node);
    }
    cache.current = next;
    return out;
  }, [parts, selected]);
}

function useFlowEdges(wires: readonly Wire[], selected: readonly string[]): WireFlowEdge[] {
  return useMemo(() => {
    const sel = new Set(selected);
    return wires.map((w) => ({
      id: w.id,
      type: "wire" as const,
      source: w.from.part,
      sourceHandle: w.from.pin,
      target: w.to.part,
      targetHandle: w.to.pin,
      selected: sel.has(w.id),
      zIndex: 2000, // jumper wires lie on top of the parts, like on a real bench
      data: { color: w.color ?? "#FF4D2E" },
    }));
  }, [wires, selected]);
}

/** Fold React Flow "select" changes into the store's selection. */
function applySelect(changes: readonly (NodeChange | EdgeChange)[], kind: "parts" | "wires"): void {
  const sel = changes.filter((c): c is Extract<NodeChange | EdgeChange, { type: "select" }> => c.type === "select");
  if (!sel.length) return;
  const s = useJumper.getState();
  const cur = new Set(kind === "parts" ? s.selectedParts : s.selectedWires);
  for (const c of sel) {
    if (c.selected) cur.add(c.id);
    else cur.delete(c.id);
  }
  const list = [...cur];
  if (kind === "parts") s.select(list, s.selectedWires);
  else s.select(s.selectedParts, list);
}

export function Canvas() {
  const project = useJumper((s) => s.project);
  const selectedParts = useJumper((s) => s.selectedParts);
  const selectedWires = useJumper((s) => s.selectedWires);
  const nodes = useFlowNodes(project.parts, selectedParts);
  const edges = useFlowEdges(project.wires, selectedWires);
  const obstacles = useMemo<RouteBox[]>(() => {
    if (project.parts.length > ROUTE_MAX_PARTS) return [];
    return project.parts.map((p) => {
      const def = getDef(p.type);
      const size = def ? rotatedSize(def.spec, p.rotation) : { w: 160, h: 64 };
      return { id: p.id, x: p.x, y: p.y, w: size.w, h: size.h };
    });
  }, [project.parts]);
  const { screenToFlowPosition } = useReactFlow();

  const onNodesChange = useCallback((changes: NodeChange<PartFlowNode>[]) => {
    const moves = new Map<string, { x: number; y: number }>();
    for (const c of changes) {
      if (c.type === "position" && c.position) moves.set(c.id, { x: snap(c.position.x), y: snap(c.position.y) });
    }
    applySelect(changes, "parts");
    if (moves.size) {
      useJumper.getState().setLive((p) => {
        let changed = false;
        const parts = p.parts.map((part) => {
          const m = moves.get(part.id);
          if (!m || (m.x === part.x && m.y === part.y)) return part;
          changed = true;
          return { ...part, x: m.x, y: m.y };
        });
        return changed ? { ...p, parts } : p;
      });
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<WireFlowEdge>[]) => {
    applySelect(changes, "wires"); // removal goes through onDelete (one undo step)
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.sourceHandle || !c.targetHandle) return;
    useJumper.getState().connect({ part: c.source, pin: c.sourceHandle }, { part: c.target, pin: c.targetHandle });
  }, []);

  const onDelete = useCallback(({ nodes, edges }: { nodes: PartFlowNode[]; edges: WireFlowEdge[] }) => {
    useJumper.getState().removeItems(
      nodes.map((n) => n.id),
      edges.map((e) => e.id),
    );
  }, []);

  const onNodeDragStart = useCallback(() => useJumper.getState().checkpoint(), []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer.types.includes(PART_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = e.dataTransfer.getData(PART_MIME);
      if (!type) return;
      e.preventDefault();
      const def = getDef(type);
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const w = def?.spec.size.w ?? 0;
      const h = def?.spec.size.h ?? 0;
      useJumper.getState().addPart(type, snap(pos.x - w / 2), snap(pos.y - h / 2));
    },
    [screenToFlowPosition],
  );

  return (
    <div className="canvas" data-testid="canvas" onDragOver={onDragOver} onDrop={onDrop}>
      <RouteObstacles.Provider value={obstacles}>
        <ReactFlow<PartFlowNode, WireFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDelete={onDelete}
          onNodeDragStart={onNodeDragStart}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionLineStyle={{ stroke: "var(--wire)", strokeWidth: 3, strokeLinecap: "round" }}
          connectionRadius={14}
          snapToGrid
          snapGrid={[SNAP, SNAP]}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Shift", "Meta", "Control"]}
          fitView
          fitViewOptions={{ padding: 0.28, maxZoom: 1.4 }}
          minZoom={0.15}
          maxZoom={4}
          attributionPosition="top-right"
          elevateNodesOnSelect={false}
          defaultEdgeOptions={{ type: "wire" }}
        >
          <Background id="dots" variant={BackgroundVariant.Dots} gap={20} size={1.6} color="var(--grid-dot)" />
          <Controls showInteractive={false} position="bottom-left" className="canvas-controls" />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            className="canvas-minimap"
            style={{ width: 150, height: 100 }}
            nodeColor="var(--panel-2)"
            nodeStrokeColor="var(--line)"
            maskColor="color-mix(in srgb, var(--ink) 70%, transparent)"
          />
        </ReactFlow>
      </RouteObstacles.Provider>
    </div>
  );
}
