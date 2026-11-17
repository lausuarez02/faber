import { createContext, memo, useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { routePath, routeWire, type RouteBox } from "@faber/sim-core";
import { engine } from "../lib/app.ts";

/** Part bodies wires route around (empty: plain smooth-step wires, e.g. on very large canvases). */
export const RouteObstacles = createContext<readonly RouteBox[]>([]);

export interface WireEdgeData extends Record<string, unknown> {
  color: string;
}
export type WireFlowEdge = Edge<WireEdgeData, "wire">;

function WireEdgeImpl(props: EdgeProps<WireFlowEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props;
  const ref = useCallback((el: SVGGElement | null) => engine.registerWire(id, el), [id]);
  const obstacles = useContext(RouteObstacles);
  const path = useMemo(() => {
    if (obstacles.length) return routePath(routeWire({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, obstacles as RouteBox[], source, target));
    return getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 18 })[0];
  }, [obstacles, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);
  const color = data?.color ?? "var(--wire)";
  // The hit area stops 12px short of each end so a pin that already has a wire can start another.
  const hitRef = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    const el = hitRef.current;
    if (!el || typeof el.getTotalLength !== "function") return;
    const len = el.getTotalLength();
    el.style.strokeDasharray = len > 30 ? `0 12 ${len - 24} 12` : "0 1000000";
  }, [path]);
  return (
    <g ref={ref} className="wire" data-testid={`wire-${id}`} data-selected={selected} data-live="false" style={{ ["--wire-color" as string]: color }}>
      <path ref={hitRef} className="wire-hit" d={path} />
      <path className="wire-casing" d={path} />
      <path className="wire-core" d={path} />
      <path className="wire-signal" d={path} />
      <rect className="wire-tip" x={sourceX - 3} y={sourceY - 3} width={6} height={6} rx={1} />
      <rect className="wire-tip" x={targetX - 3} y={targetY - 3} width={6} height={6} rx={1} />
    </g>
  );
}

export const WireEdge = memo(WireEdgeImpl);
