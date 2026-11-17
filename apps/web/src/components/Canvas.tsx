import { useCallback, useMemo, useRef, type DragEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import type { PartInstance, Wire } from "@faber/project-format";
import { useFaber } from "../lib/app.ts";
import { getDef, rotatedSize } from "../lib/parts.ts";
import { PartNode, type PartFlowNode } from "./PartNode.tsx";
import { RouteObstacles, WireEdge, type WireFlowEdge } from "./WireEdge.tsx";
import type { RouteBox } from "@faber/sim-core";
import { useIsPhone, useUi } from "../lib/ui.ts";
import { chromePadding, fitNow, keepView, setFlow } from "../shell/actions.ts";

/** Above this many parts wires stay plain smooth-step curves (routing every wire on every drag frame costs too much). */
const ROUTE_MAX_PARTS = 60;

const nodeTypes = { part: PartNode };
const edgeTypes = { wire: WireEdge };
const SNAP = 10;
/** Height of the "icon id · type" label that floats above every part. */
const LABEL_ROOM = 24;
export const PART_MIME = "application/x-faber-part";

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
  const s = useFaber.getState();
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
  const project = useFaber((s) => s.project);
  const selectedParts = useFaber((s) => s.selectedParts);
  const selectedWires = useFaber((s) => s.selectedWires);
  const nodes = useFlowNodes(project.parts, selectedParts);
  const edges = useFlowEdges(project.wires, selectedWires);
  const obstacles = useMemo<RouteBox[]>(() => {
    if (project.parts.length > ROUTE_MAX_PARTS) return [];
    return project.parts.map((p) => {
      const def = getDef(p.type);
      const size = def ? rotatedSize(def.spec, p.rotation) : { w: 160, h: 64 };
      // The label above each part counts as part of its body, so wires never run through it.
      return { id: p.id, x: p.x, y: p.y - LABEL_ROOM, w: size.w, h: size.h + LABEL_ROOM };
    });
  }, [project.parts]);
  const { screenToFlowPosition } = useReactFlow();
  const tool = useUi((s) => s.tool);
  const phone = useIsPhone();
  const editable = tool === "select";

  const onNodesChange = useCallback((changes: NodeChange<PartFlowNode>[]) => {
    const moves = new Map<string, { x: number; y: number }>();
    for (const c of changes) {
      if (c.type === "position" && c.position) moves.set(c.id, { x: snap(c.position.x), y: snap(c.position.y) });
    }
    applySelect(changes, "parts");
    if (moves.size) {
      useFaber.getState().setLive((p) => {
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
    useFaber.getState().connect({ part: c.source, pin: c.sourceHandle }, { part: c.target, pin: c.targetHandle });
  }, []);

  const onDelete = useCallback(({ nodes, edges }: { nodes: PartFlowNode[]; edges: WireFlowEdge[] }) => {
    useFaber.getState().removeItems(
      nodes.map((n) => n.id),
      edges.map((e) => e.id),
    );
  }, []);

  const onNodeDragStart = useCallback(() => useFaber.getState().checkpoint(), []);
  // A pointer-down on the empty canvas starts a "move" too: only a real change of the view counts.
  const moveFrom = useRef<Viewport | undefined>(undefined);
  const onMoveStart = useCallback((_e: MouseEvent | TouchEvent | null, vp: Viewport) => {
    moveFrom.current = vp;
  }, []);
  const onMove = useCallback((event: MouseEvent | TouchEvent | null, vp: Viewport) => {
    const a = moveFrom.current;
    if (event && a && (Math.abs(a.x - vp.x) > 1 || Math.abs(a.y - vp.y) > 1 || Math.abs(a.zoom - vp.zoom) > 1e-3)) keepView(true);
  }, []);

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
      useFaber.getState().addPart(type, snap(pos.x - w / 2), snap(pos.y - h / 2));
    },
    [screenToFlowPosition],
  );

  return (
    <div
      className="canvas"
      data-testid="canvas"
      data-tool={tool}
      onDragOver={onDragOver}
      onDrop={onDrop}
      // Round 6: the minimap and zoom controls move the view programmatically; they are the person too.
      onPointerDownCapture={(e) => {
        if ((e.target as Element).closest?.(".react-flow__minimap, .react-flow__controls")) keepView(true);
      }}
      onWheelCapture={(e) => {
        if ((e.target as Element).closest?.(".react-flow__minimap")) keepView(true);
      }}
    >
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
          // Round 6: a pan / zoom gesture (wheel, drag, pinch) makes the view the person's: automatic
          // refits on save, build and run leave it alone (shell/actions.ts isViewKept).
          onMoveStart={onMoveStart}
          onMove={onMove}
          nodeDragThreshold={4}
          onInit={(i) => {
            setFlow(i);
            requestAnimationFrame(() => fitNow(0));
          }}
          nodesDraggable={editable}
          nodesConnectable={tool !== "hand"}
          elementsSelectable={tool !== "hand"}
          selectionKeyCode={tool === "hand" ? null : "Shift"}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionLineStyle={{ stroke: "var(--wire)", strokeWidth: 2.4, strokeLinecap: "round" }}
          connectionRadius={14}
          snapToGrid
          snapGrid={[SNAP, SNAP]}
          deleteKeyCode={["Backspace", "Delete"]}
          multiSelectionKeyCode={["Shift", "Meta", "Control"]}
          fitView
          fitViewOptions={{ padding: chromePadding(), maxZoom: 1.25 }}
          minZoom={0.15}
          maxZoom={4}
          attributionPosition="bottom-center"
          elevateNodesOnSelect={false}
          defaultEdgeOptions={{ type: "wire" }}
        >
          <Background id="dots" variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--dot)" />
          {phone ? null : (
            <MiniMap
              pannable
              zoomable
              position="bottom-left"
              className="canvas-minimap"
              ariaLabel="Minimap"
              style={{ width: 264, height: 144 }}
              nodeColor="var(--minimap-node)"
              nodeStrokeColor="transparent"
              nodeBorderRadius={4}
              maskColor="var(--minimap-mask)"
              maskStrokeColor="var(--border)"
              maskStrokeWidth={1}
            />
          )}
        </ReactFlow>
      </RouteObstacles.Provider>
    </div>
  );
}
