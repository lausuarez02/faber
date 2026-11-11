/**
 * Device view: a full-canvas overlay that shows the project as the physical device, running live
 * in 3D (handheld with its screen and buttons, rover in its arena, arm on a table, or the board on
 * a desk). The canvas engine keeps stepping the simulation; this view only reads it and sends
 * button presses. Esc closes.
 *
 * Mount: {deviceOpen ? <DeviceView onClose={() => setDeviceOpen(false)} /> : null}
 */
import { useMemo } from "react";
import { engine, useJumper } from "../../lib/app.ts";
import { useCase } from "../../case/store.ts";
import { DeviceStage } from "./DeviceStage.tsx";
import { engineSource, type DeviceSource } from "./source.ts";

export function DeviceView({ onClose, source }: { onClose(): void; source?: DeviceSource }) {
  const fromEngine = useMemo(() => source ?? engineSource(engine, useJumper), [source]);
  return (
    <div className="device-view" data-testid="device-view" role="dialog" aria-modal="true" aria-label="Device view">
      <DeviceStage
        source={fromEngine}
        onClose={onClose}
        onOpenCase={() => {
          onClose();
          useCase.getState().setOpen(true);
        }}
      />
    </div>
  );
}

export { DeviceStage } from "./DeviceStage.tsx";
export { engineSource, ownedSimSource } from "./source.ts";
export type { DeviceSource } from "./source.ts";
