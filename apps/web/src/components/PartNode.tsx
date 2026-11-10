import { memo, useCallback } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { PartDefinition } from "@jumper/sim-core";
import type { Rotation } from "@jumper/project-format";
import { pinSide, rotatedPin, rotatedSize, type Side } from "../lib/parts.ts";
import { engine } from "../lib/app.ts";
import { categoryIcon } from "../shell/icons.ts";
import "./canvas.css";
import { ImuSurface, PartControl } from "../interact/PartControl.tsx";
import { controlOf, isImu } from "../interact/controls.ts";

export interface PartNodeData extends Record<string, unknown> {
  def: PartDefinition | undefined;
  type: string;
  rotation: Rotation;
}
export type PartFlowNode = Node<PartNodeData, "part">;

const SIDE_POS: Record<Side, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/** The inlined SVG never changes for a given part type, so React leaves its DOM alone. */
const PartSvg = memo(function PartSvg({ svg, w, h, rotation }: { svg: string; w: number; h: number; rotation: Rotation }) {
  const box = rotation === 90 || rotation === 270 ? { w: h, h: w } : { w, h };
  return (
    <div
      className="part-svg"
      style={{
        width: w,
        height: h,
        left: (box.w - w) / 2,
        top: (box.h - h) / 2,
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

function PartNodeImpl({ id, data, selected }: NodeProps<PartFlowNode>) {
  const { def, rotation } = data;
  const ref = useCallback((el: HTMLDivElement | null) => engine.registerPart(id, el), [id]);

  if (!def) {
    return (
      <div className="part part-unknown" data-testid={`part-${id}`} data-selected={selected} data-lit="false">
        <span className="mono">{id}</span>
        <span>unknown part type “{data.type}”</span>
      </div>
    );
  }
  const { spec } = def;
  const box = rotatedSize(spec, rotation);
  const CatIcon = categoryIcon(spec.category);
  // While the device runs, button caps press, switches flip, knobs turn and IMUs tilt; the rest of
  // the part (and its label, a drag handle) still selects and moves it.
  const control = controlOf(def);
  const imu = !control && isImu(def);
  return (
    <div
      ref={ref}
      className="part"
      data-testid={`part-${id}`}
      data-part-type={spec.id}
      data-category={spec.category}
      data-selected={selected}
      data-lit="false"
      style={{ width: box.w, height: box.h }}
    >
      {/* Round 6 (canvas): the canvas shows the short id only, never wider than the part, so labels
          never overlap; the full name is in the hover title and the Inspector. */}
      <div className="part-label" data-testid={`label-${id}`} title={`${id} · ${spec.name}`} style={{ maxWidth: Math.max(box.w + 12, 72) }}>
        <CatIcon size={12} strokeWidth={1.8} aria-hidden />
        <span className="part-label-id">{id}</span>
      </div>
      <PartSvg svg={def.svg} w={spec.size.w} h={spec.size.h} rotation={rotation} />
      {control ? <PartControl id={id} kind={control} box={box} name={spec.name} /> : null}
      {imu ? <ImuSurface id={id} name={spec.name} /> : null}
      {spec.pins.map((pin) => {
        const p = rotatedPin(spec, pin, rotation);
        return (
          <Handle
            key={pin.id}
            id={pin.id}
            type="source"
            position={SIDE_POS[pinSide(box, p)]}
            className={`pin pin-${pin.type}`}
            style={{ left: p.x, top: p.y }}
            data-testid={`pin-${id}-${pin.id}`}
            data-label={pin.protocols?.length ? `${pin.label} · ${pin.protocols.join(" ")}` : pin.label}
            aria-label={`${id} pin ${pin.label}`}
          />
        );
      })}
    </div>
  );
}

export const PartNode = memo(PartNodeImpl);
