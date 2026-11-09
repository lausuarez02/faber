import { createContext, useContext } from "react";
import type { DeviceSource } from "./source.ts";

export const DeviceSourceContext = createContext<DeviceSource | null>(null);

export function useDeviceSource(): DeviceSource {
  const s = useContext(DeviceSourceContext);
  if (!s) throw new Error("Device view: no DeviceSource. Wrap the scene in <DeviceSourceContext.Provider value={source}>.");
  return s;
}

/** Live values the HUD shows, written by scene components each frame (no React state per frame). */
export interface Readouts {
  [key: string]: string;
}

export const ReadoutsContext = createContext<{ current: Readouts }>({ current: {} });
